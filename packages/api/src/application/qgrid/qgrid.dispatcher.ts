/**
 * QgridDispatcher — provider dispatcher 라우팅 + 토큰 캐시/통계 싱글턴.
 *
 * - 메모리 캐시 (Map<id, TokenSubsetA>) 는 TokenSubscriber 가 pg LISTEN/NOTIFY 로 갱신
 * - OpenAI/Anthropic 요청은 각 provider dispatcher 로만 실행
 * - QuotaError 는 그대로 상위 전파
 * - dispatcher 미준비는 기동 중(503)/초기화 실패(500)로 구분해 던진다
 */

import { InternalServerErrorException, ServiceUnavailableException } from "sonamu";

import { SD } from "../../i18n/sd.generated";
import { type AnthropicDispatcher } from "../../utils/providers/anthropic/anthropic-dispatcher";
import { createFenceStripTransform } from "../../utils/providers/anthropic/fence-strip";
import { getAccessToken } from "../../utils/providers/common/credentials";
import { calculateCostUsd } from "../../utils/providers/common/model-cost";
import {
  type GenerateResult,
  type StreamCallbacks,
} from "../../utils/providers/common/provider-dispatcher";
import { type JsonValue } from "../../utils/providers/common/provider-types";
import {
  parseAndValidateCallerSchemas,
  serializeAndValidateDispatchSchema,
} from "../../utils/providers/common/schema-validation";
import { strictify } from "../../utils/providers/common/strictifier";
import { type OpenAIDispatcher } from "../../utils/providers/openai/openai-dispatcher";
import { type TokenSubsetA } from "../sonamu.generated";
import { decideConvRouting, issueConvContext } from "./conv-routing";
import {
  maskToken,
  ProcessError,
  type ProviderStartupState,
  type QueryInput,
  type QueryOutput,
  type TokenStats,
} from "./qgrid.types";
import { composeSystemWithSchemaContract } from "./schema-prompt";
import { type TokenSubscriber } from "./token-subscriber";
import { applyToolCallEmulation } from "./tool-emulation";
import { buildToolCallSchema } from "./tool-emulation-schema";

export type InternalQueryInput = QueryInput & { preferredTokenId?: number };

export class QgridDispatcherClass {
  tokens = new Map<number, TokenSubsetA>();

  // TokenStats shape 보존용. 실제 provider 요청 카운팅은 각 dispatcher 로 이동했다.
  requestCounts = new Map<string, number>();

  // sonamu.config onStart 에서 처리하는 변수
  subscriber: TokenSubscriber | null = null;
  openaiDispatcher: OpenAIDispatcher | null = null;
  anthropicDispatcher: AnthropicDispatcher | null = null;

  /**
   * provider 별 기동 상태. dispatcher 가 없는 이유를 구분하기 위해 필요하다 —
   * HTTP 리스닝은 dispatcher 준비보다 먼저 열리므로(sonamu.config onStart),
   * 그 사이 들어온 요청은 "잠시 후 되는" 상태와 "재시도해도 안 되는" 상태가 다르다.
   *
   * - `starting`: 워커 spawn 중. dev0 기준 25 워커 × 500ms 간격이라 1~2분 걸린다 → 재시도 가능
   * - `ready`: 정상
   * - `failed`: start() 가 예외로 끝남 → 재시도해도 같은 결과
   */
  startupState: Record<"openai" | "anthropic", ProviderStartupState> = {
    openai: "starting",
    anthropic: "starting",
  };

  /**
   * dispatcher 가 준비되지 않았을 때 던질 예외를 만든다.
   *
   * 기동 중이면 503(+Retry-After) 으로 재시도 가능함을 알리고, 초기화가 실패로 끝났으면
   * 500 으로 재시도가 무의미함을 알린다. 이전에는 둘 다 QuotaError 였는데, 쿼터 소진이
   * 아닌 상태를 그렇게 표현하면 호출자가 토큰 문제로 오해하고 재시도 판단도 못 한다.
   */
  private notReadyError(provider: "openai" | "anthropic"): Error {
    const label = provider === "openai" ? "OpenAI" : "Anthropic";
    return this.startupState[provider] === "failed"
      ? new InternalServerErrorException(SD("qgrid.dispatcherFailed")(label))
      : new ServiceUnavailableException(SD("qgrid.dispatcherStarting")(label));
  }

  countOf(name: string): number {
    return this.requestCounts.get(name) ?? 0;
  }

  // TokenSubscriber 콜백 — 캐시 mutation
  upsertCache(id: number, row: TokenSubsetA): void {
    this.tokens.set(id, row);
  }

  removeCache(id: number): void {
    this.tokens.delete(id);
  }

  replaceCache(rows: TokenSubsetA[]): void {
    this.tokens = new Map(rows.map((r) => [r.id, r]));
  }

  getStats(): TokenStats[] {
    return [...this.tokens.values()].map((r) => ({
      token: maskToken(getAccessToken(r.credentials)),
      name: r.name,
      provider: r.provider,
      requests: this.countOf(r.name),
    }));
  }

  async query(input: InternalQueryInput, abortSignal?: AbortSignal): Promise<QueryOutput> {
    const route = parseProviderRoute(input.model);
    const outputSchema = buildAndValidateStrictOutputSchema(input, route.provider);
    // answer 인코딩 판정: jsonSchema 있으면 사용자 스키마 JSON, 없으면 평문 string. 4개 방출 지점이 공유.
    const answerKind = input.jsonSchema ? ("json" as const) : ("text" as const);

    // provider prefix routing: 'openai/gpt-5.4' → OpenAIDispatcher
    if (route.provider === "openai") {
      if (!this.openaiDispatcher) throw this.notReadyError("openai");

      const decision = decideConvRouting(input, {
        directOpenAI: true,
        modelNamespace: `openai/${route.model}`,
      });
      const result = await this.openaiDispatcher.generate({
        model: route.model,
        systemPrompt: input.system,
        outputSchema,
        effort: input.effort,
        verbosity: input.verbosity,
        reasoningSummary: input.reasoningSummary,
        serviceTier: input.serviceTier,
        timeoutMs: input.timeout,
        coldInput: decision.coldInput,
        coldHistory: decision.coldHistory,
        promptCacheKey: input.imageGeneration ? undefined : decision.promptCacheKey,
        preferredTokenId: input.imageGeneration ? undefined : decision.preferredTokenId,
        abortSignal,
        imageGeneration: input.imageGeneration,
        imageGenerationOptions: input.imageGenerationOptions,
      });

      // 이미지 요청은 cold-only(R8)라 재사용 좌표를 발급하지 않는다. 좌표를 실으면
      // sessionKey 소비자의 warm 좌표를 죽은 좌표로 덮어써 다음 텍스트 turn 이 cold 로 떨어진다.
      const coord = input.imageGeneration
        ? undefined
        : issueConvContext(result.threadCoord, decision, result.threadCoord.workerId);

      return applyToolCallEmulation(toEmulationResult(result), input.tools, {
        threadCoord: coord,
        images: result.images,
        answerKind,
      });
    } else if (route.provider === "anthropic") {
      if (!this.anthropicDispatcher) throw this.notReadyError("anthropic");

      const decision = decideConvRouting(input);
      const result = await this.anthropicDispatcher.generate({
        // AnthropicDispatcher 내부에서 알아서 provider prefix 를 canonical model 로 정규화함
        model: input.model,
        // 스키마/envelope 계약은 --json-schema 대신 system 말미의 텍스트로 안내한다(SON-532).
        // outputSchema 는 전달하지 않는다 — anthropic 에서 항상 undefined(U1)이며,
        // CC 로 가는 --json-schema 채널 자체가 닫혀 있음을 여기서 명시한다.
        systemPrompt: composeSystemWithSchemaContract(input.system, input),
        effort: input.effort,
        timeoutMs: input.timeout,
        abortSignal,
        coldInput: decision.coldInput,
        coldHistory: decision.coldHistory,
        preferredTokenId: input.preferredTokenId,
        imageGeneration: input.imageGeneration,
        imageGenerationOptions: input.imageGenerationOptions,
      });

      return applyToolCallEmulation(toEmulationResult(result), input.tools, {
        threadCoord: issueConvContext(result.threadCoord, decision),
        answerKind,
      });
    }

    throw directLlmApiFallbackNotImplemented(input);
  }

  async queryStream(
    input: InternalQueryInput,
    cb: StreamCallbacks<QueryOutput>,
    abortSignal?: AbortSignal,
  ): Promise<void> {
    const route = parseProviderRoute(input.model);
    const outputSchema = buildAndValidateStrictOutputSchema(input, route.provider);
    // answer 인코딩 판정: jsonSchema 있으면 사용자 스키마 JSON, 없으면 평문 string. 4개 방출 지점이 공유.
    const answerKind = input.jsonSchema ? ("json" as const) : ("text" as const);

    if (route.provider === "openai") {
      if (!this.openaiDispatcher) throw this.notReadyError("openai");

      const decision = decideConvRouting(input, {
        directOpenAI: true,
        modelNamespace: `openai/${route.model}`,
      });
      await this.openaiDispatcher.generateStream(
        {
          model: route.model,
          systemPrompt: input.system,
          outputSchema,
          effort: input.effort,
          verbosity: input.verbosity,
          reasoningSummary: input.reasoningSummary,
          serviceTier: input.serviceTier,
          timeoutMs: input.timeout,
          coldInput: decision.coldInput,
          coldHistory: decision.coldHistory,
          promptCacheKey: decision.promptCacheKey,
          preferredTokenId: decision.preferredTokenId,
          abortSignal,
          // 이미지 플래그를 전달해야 generateStream 의 non-stream 전용 거부(R2)가 발동한다.
          imageGeneration: input.imageGeneration,
          imageGenerationOptions: input.imageGenerationOptions,
        },
        {
          onDelta: cb.onDelta,
          onThreadId: cb.onThreadId,
          onTurnId: cb.onTurnId,
          onComplete: (turnResult) => {
            cb.onComplete(
              applyToolCallEmulation(toEmulationResult(turnResult), input.tools, {
                threadCoord: issueConvContext(
                  turnResult.threadCoord,
                  decision,
                  turnResult.threadCoord.workerId,
                ),
                answerKind,
              }),
            );
          },
          onError: cb.onError,
        },
      );
      return;
    } else if (route.provider === "anthropic") {
      if (!this.anthropicDispatcher) throw this.notReadyError("anthropic");

      // 계약(스키마/envelope)이 주입된 요청의 델타에서 코드펜스를 벗긴다(SON-532).
      // 비스트림 최종 텍스트는 stream-json-adapter 의 stripFences 가 같은 시맨틱으로
      // 처리하므로 델타 연결과 done.text 가 어긋나지 않는다. 일반 텍스트 요청은 무변경.
      const hasSchemaContract = input.jsonSchema !== undefined || Boolean(input.tools?.length);
      const fenceStrip = hasSchemaContract ? createFenceStripTransform() : undefined;
      const emitDelta = fenceStrip
        ? (text: string) => {
            const safe = fenceStrip.push(text);
            if (safe) cb.onDelta(safe);
          }
        : cb.onDelta;

      const decision = decideConvRouting(input);
      await this.anthropicDispatcher.generateStream(
        {
          model: input.model,
          // 스키마/envelope 계약은 --json-schema 대신 system 말미의 텍스트로 안내한다(SON-532)
          systemPrompt: composeSystemWithSchemaContract(input.system, input),
          effort: input.effort,
          coldInput: decision.coldInput,
          coldHistory: decision.coldHistory,
          preferredTokenId: input.preferredTokenId,
          timeoutMs: input.timeout,
          abortSignal,
          imageGeneration: input.imageGeneration,
          imageGenerationOptions: input.imageGenerationOptions,
        },
        {
          onDelta: emitDelta,
          onThreadId: cb.onThreadId,
          onComplete: (turnResult) => {
            // 홀드백 잔여(닫는 펜스가 아니었던 tail)를 done 전에 마저 방출한다 —
            // 델타를 조립하는 클라이언트(EnvelopeStreamParser 등)의 무손실 보장.
            const rest = fenceStrip?.flush();
            if (rest) cb.onDelta(rest);

            const issuedCoord = issueConvContext(turnResult.threadCoord, decision);
            cb.onComplete(
              applyToolCallEmulation(toEmulationResult(turnResult), input.tools, {
                threadCoord: issuedCoord,
                answerKind,
              }),
            );
          },
          onError: cb.onError,
        },
      );
      return;
    }

    throw directLlmApiFallbackNotImplemented(input);
  }
}

function parseProviderRoute(model: string | undefined): { provider?: string; model: string } {
  if (!model?.includes("/")) {
    return { model: model ?? "" };
  }

  const [provider, routedModel] = model.split("/", 2);
  if (!provider || !routedModel) throw new ProcessError("unknown model");
  return { provider, model: routedModel };
}

// qgrid provider dispatcher 에서 처리하지 않는 모델은 향후 직접 LLM API 호출 지점으로 보낸다.
function directLlmApiFallbackNotImplemented(input: QueryInput): ProcessError {
  return new ProcessError(
    `Direct LLM API fallback not implemented for model: ${input.model ?? "<default>"}`,
  );
}

// 모든 provider(OpenAI/Anthropic)가 동일하게 strict output schema 를 쓴다.
//
// SON-495 교훈: 한때 Anthropic route 만 required 를 제거(optionalize)해 partial/rejected attempt 가
// 섞여도 통과하게 했으나, 실측 결과 그게 오히려 "모델이 비는 필드를 키째 생략"하도록 유도했다
// (required 살린 schema 는 누락 0, loose 는 누락 다발). strict 로 두면 모델이 빠짐없이 채우고,
// 드물게 어겨 provider retry 예산을 소진한 비정상 종료도 정직한 에러로 받아준다.
export function buildStrictOutputSchema(
  input: Pick<QueryInput, "tools" | "jsonSchema">,
  provider?: string,
): JsonValue | undefined {
  const outputSchema = buildRawOutputSchema(input);

  return outputSchema
    ? (strictify(outputSchema as Parameters<typeof strictify>[0], { provider }) as JsonValue)
    : undefined;
}

export function buildAndValidateStrictOutputSchema(
  input: Pick<QueryInput, "model" | "tools" | "jsonSchema">,
  provider = parseProviderRoute(input.model).provider,
): JsonValue | undefined {
  // anthropic(SON-532): CC 에 --json-schema 를 전달하지 않는다 — 강제 없는 사후 채점이
  // 소비자 의도(nullish 생략 등)와 충돌해 CC 내부 재시도 루프를 발화시켰다(왕복 2~4회,
  // 4.7~9.1배 출력 청구 실측). 스키마/envelope 계약은 프롬프트 텍스트로 안내하고 판정은
  // 소비자(zod)/parseEnvelope 가 맡는다. 따라서 strict 변환·argv 64KiB 제한 없이 수신
  // 원형의 구문·복잡도(전역 512KiB 한도)만 검증해 caller-fault 를 조기에 돌려준다.
  if (provider === "anthropic") {
    parseAndValidateCallerSchemas(input);
    return undefined;
  }

  const outputSchema = buildStrictOutputSchema(input, provider);
  serializeAndValidateDispatchSchema(outputSchema, provider);
  return outputSchema;
}

function buildRawOutputSchema(
  input: Pick<QueryInput, "tools" | "jsonSchema">,
): JsonValue | undefined {
  const callerOutputSchema = parseAndValidateCallerSchemas(input);

  return input.tools?.length
    ? buildToolCallSchema(input.tools, callerOutputSchema)
    : callerOutputSchema;
}

// GenerateResult(provider dispatcher 응답)를 applyToolCallEmulation 입력 shape 로 매핑한다.
// OpenAI/Anthropic, query/queryStream 4 경로가 동일하게 쓴다.
// Anthropic adapter 는 cache creation 을 inputTokens 에 포함해 표준화하고, 별도 필드에도 보존한다.
// per-request cost 는 provider 가 준 값을 우선 사용하고, 없으면 공통 cost 함수를 쓴다.
function toEmulationResult(
  result: GenerateResult,
): Omit<QueryOutput, "content" | "finishReason" | "runContext"> {
  const hasProviderCost = result.costUsd !== undefined && result.costUsd > 0;
  return {
    text: result.text,
    tokenName: result.tokenName,
    model: result.model,
    requestedModel: result.requestedModel,
    modelFallbacks: result.modelFallbacks,
    usage: {
      input_tokens: result.usage.inputTokens,
      output_tokens: result.usage.outputTokens,
      reasoning_tokens: result.usage.reasoningOutputTokens,
      cache_creation_input_tokens: result.usage.cacheCreationInputTokens ?? 0,
      cache_creation_5m_input_tokens: result.usage.cacheCreationInputTokens5m,
      cache_creation_1h_input_tokens: result.usage.cacheCreationInputTokens1h,
      cache_read_input_tokens: result.usage.cachedInputTokens,
    },
    durationMs: result.durationMs,
    ttftMs: result.ttftMs ?? 0,
    costUsd: hasProviderCost
      ? result.costUsd!
      : calculateCostUsd(result.model, {
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          cachedInputTokens: result.usage.cachedInputTokens,
          cacheCreationInputTokens: result.usage.cacheCreationInputTokens ?? 0,
          cacheCreationInputTokens5m: result.usage.cacheCreationInputTokens5m,
          cacheCreationInputTokens1h: result.usage.cacheCreationInputTokens1h,
        }),
    costSource: hasProviderCost ? "provider" : "pricing_table",
  };
}

export const QgridDispatcher = new QgridDispatcherClass();
