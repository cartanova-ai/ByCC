/**
 * QgridDispatcher — provider dispatcher 라우팅 + 토큰 캐시/통계 싱글턴.
 *
 * - 메모리 캐시 (Map<id, TokenSubsetA>) 는 TokenSubscriber 가 pg LISTEN/NOTIFY 로 갱신
 * - OpenAI/Anthropic 요청은 각 provider dispatcher 로만 실행
 * - QuotaError 는 그대로 상위 전파
 */

import { type JsonValue } from "../../codex-protocol/serde_json/JsonValue";
import { type AnthropicDispatcher } from "../../utils/providers/anthropic/anthropic-dispatcher";
import { getAccessToken } from "../../utils/providers/common/credentials";
import { calculateCostUsd } from "../../utils/providers/common/model-cost";
import {
  type GenerateResult,
  type StreamCallbacks,
} from "../../utils/providers/common/provider-dispatcher";
import {
  parseAndValidateCallerSchemas,
  serializeAndValidateDispatchSchema,
} from "../../utils/providers/common/schema-validation";
import { strictify } from "../../utils/providers/common/strictifier";
import { type OpenAIDispatcher } from "../../utils/providers/openai/openai-dispatcher";
import { type TokenSubsetA } from "../sonamu.generated";
import { decideConvRouting, issueConvContext } from "./conv-routing";
import { type QueryInput, type QueryOutput, type TokenStats } from "./qgrid.types";
import { maskToken, ProcessError, QuotaError } from "./qgrid.types";
import { type TokenSubscriber } from "./token-subscriber";
import { applyToolCallEmulation } from "./tool-emulation";
import { buildToolCallSchema } from "./tool-emulation-schema";

export class QgridDispatcherClass {
  tokens = new Map<number, TokenSubsetA>();

  // TokenStats shape 보존용. 실제 provider 요청 카운팅은 각 dispatcher 로 이동했다.
  requestCounts = new Map<string, number>();

  // sonamu.config onStart 에서 처리하는 변수
  subscriber: TokenSubscriber | null = null;
  openaiDispatcher: OpenAIDispatcher | null = null;
  anthropicDispatcher: AnthropicDispatcher | null = null;

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

  async query(input: QueryInput, abortSignal?: AbortSignal): Promise<QueryOutput> {
    const route = parseProviderRoute(input.model);
    const outputSchema = buildAndValidateStrictOutputSchema(input, route.provider);
    // tools+jsonSchema 합성 시 structured envelope 디코더를 쓴다. 4개 방출 지점이 공유하는 단일 판정.
    const answerMode = input.jsonSchema ? ("structured" as const) : ("legacy" as const);

    // provider prefix routing: 'openai/gpt-5.4' → OpenAIDispatcher
    if (route.provider === "openai") {
      if (!this.openaiDispatcher) throw new QuotaError("OpenAI dispatcher not initialized");

      const decision = decideConvRouting(input);
      const result = await this.openaiDispatcher.generate({
        model: route.model,
        systemPrompt: input.system,
        outputSchema,
        effort: input.effort,
        verbosity: input.verbosity,
        reasoningSummary: input.reasoningSummary,
        serviceTier: input.serviceTier,
        coldInput: decision.coldInput,
        coldHistory: decision.coldHistory,
        reuse: decision.reuse,
        reuseInput: decision.reuseInput,
        abortSignal,
        imageGeneration: input.imageGeneration,
        imageGenerationOptions: input.imageGenerationOptions,
      });

      // 이미지 요청은 cold-only(R8)라 재사용 좌표를 발급하지 않는다. 좌표를 실으면
      // sessionKey 소비자의 warm 좌표를 죽은 좌표로 덮어써 다음 텍스트 turn 이 cold 로 떨어진다.
      const coord = input.imageGeneration
        ? undefined
        : issueConvContext(result.threadCoord, decision);

      return applyToolCallEmulation(toEmulationResult(result), input.tools, {
        threadCoord: coord,
        images: result.images,
        answerMode,
      });
    } else if (route.provider === "anthropic") {
      if (!this.anthropicDispatcher) throw new QuotaError("Anthropic dispatcher not initialized");

      const decision = decideConvRouting(input);
      const result = await this.anthropicDispatcher.generate({
        // AnthropicDispatcher 내부에서 알아서 provider prefix 를 canonical model 로 정규화함
        model: input.model,
        systemPrompt: input.system,
        outputSchema,
        effort: input.effort,
        timeoutMs: input.timeout,
        abortSignal,
        coldInput: decision.coldInput,
        coldHistory: decision.coldHistory,
        imageGeneration: input.imageGeneration,
        imageGenerationOptions: input.imageGenerationOptions,
      });

      return applyToolCallEmulation(toEmulationResult(result), input.tools, {
        threadCoord: issueConvContext(result.threadCoord, decision),
        answerMode,
      });
    }

    throw directLlmApiFallbackNotImplemented(input);
  }

  async queryStream(
    input: QueryInput,
    cb: StreamCallbacks<QueryOutput>,
    abortSignal?: AbortSignal,
  ): Promise<void> {
    const route = parseProviderRoute(input.model);
    const outputSchema = buildAndValidateStrictOutputSchema(input, route.provider);
    // tools+jsonSchema 합성 시 structured envelope 디코더를 쓴다. 4개 방출 지점이 공유하는 단일 판정.
    const answerMode = input.jsonSchema ? ("structured" as const) : ("legacy" as const);

    if (route.provider === "openai") {
      if (!this.openaiDispatcher) throw new QuotaError("OpenAI dispatcher not initialized");

      const decision = decideConvRouting(input);
      await this.openaiDispatcher.generateStream(
        {
          model: route.model,
          systemPrompt: input.system,
          outputSchema,
          effort: input.effort,
          verbosity: input.verbosity,
          reasoningSummary: input.reasoningSummary,
          serviceTier: input.serviceTier,
          coldInput: decision.coldInput,
          coldHistory: decision.coldHistory,
          reuse: decision.reuse,
          reuseInput: decision.reuseInput,
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
                threadCoord: issueConvContext(turnResult.threadCoord, decision),
                answerMode,
              }),
            );
          },
          onError: cb.onError,
        },
      );
      return;
    } else if (route.provider === "anthropic") {
      if (!this.anthropicDispatcher) throw new QuotaError("Anthropic dispatcher not initialized");

      const decision = decideConvRouting(input);
      await this.anthropicDispatcher.generateStream(
        {
          model: input.model,
          systemPrompt: input.system,
          outputSchema,
          effort: input.effort,
          coldInput: decision.coldInput,
          coldHistory: decision.coldHistory,
          timeoutMs: input.timeout,
          abortSignal,
          imageGeneration: input.imageGeneration,
          imageGenerationOptions: input.imageGenerationOptions,
        },
        {
          onDelta: cb.onDelta,
          onThreadId: cb.onThreadId,
          onComplete: (turnResult) => {
            const issuedCoord = issueConvContext(turnResult.threadCoord, decision);
            cb.onComplete(
              applyToolCallEmulation(toEmulationResult(turnResult), input.tools, {
                threadCoord: issuedCoord,
                answerMode,
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
