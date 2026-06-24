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
import { strictify } from "../../utils/providers/common/strictifier";
import { type OpenAIDispatcher } from "../../utils/providers/openai/openai-dispatcher";
import { type TokenSubsetA } from "../sonamu.generated";
import { decideConvRouting, issueConvContext } from "./conv-routing";
import { type QueryInput, type QueryOutput, type TokenStats } from "./qgrid.types";
import { maskToken, ProcessError, QuotaError } from "./qgrid.types";
import { type TokenSubscriber } from "./token-subscriber";
import { applyToolCallEmulation, buildToolCallSchema } from "./tool-emulation";

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

  async query(input: QueryInput, timeoutMs?: number): Promise<QueryOutput> {
    void timeoutMs;

    if (input.tools?.length && input.jsonSchema) {
      throw new ProcessError("tools and jsonSchema cannot be used together");
    }

    const outputSchema = buildStrictOutputSchema(input);
    const route = parseProviderRoute(input.model);

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
      });

      return applyToolCallEmulation(
        toEmulationResult(result),
        input.tools,
        issueConvContext(result.threadCoord, decision),
      );
    } else if (route.provider === "anthropic") {
      // Anthropic — AnthropicDispatcher(멀티턴 session resume) 경로
      if (!this.anthropicDispatcher) throw new QuotaError("Anthropic dispatcher not initialized");

      const decision = decideConvRouting(input);
      const result = await this.anthropicDispatcher.generate({
        // AnthropicDispatcher 가 provider prefix 를 canonical model 로 정규화한다.
        model: input.model,
        systemPrompt: input.system,
        outputSchema,
        effort: input.effort,
        coldInput: decision.coldInput,
        coldHistory: decision.coldHistory,
        reuse: decision.reuse,
        reuseInput: decision.reuseInput,
      });

      return applyToolCallEmulation(
        toEmulationResult(result),
        input.tools,
        issueConvContext(result.threadCoord, decision),
      );
    }

    throw directLlmApiFallbackNotImplemented(input);
  }

  async queryStream(
    input: QueryInput,
    cb: StreamCallbacks<QueryOutput>,
    abortSignal?: AbortSignal,
  ): Promise<void> {
    const outputSchema = buildStrictOutputSchema(input);
    const route = parseProviderRoute(input.model);

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
        },
        {
          onDelta: cb.onDelta,
          onThreadId: cb.onThreadId,
          onTurnId: cb.onTurnId,
          onComplete: (turnResult) => {
            cb.onComplete(
              applyToolCallEmulation(
                toEmulationResult(turnResult),
                input.tools,
                issueConvContext(turnResult.threadCoord, decision),
              ),
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
          reuse: decision.reuse,
          reuseInput: decision.reuseInput,
          abortSignal,
        },
        {
          onDelta: cb.onDelta,
          onThreadId: cb.onThreadId,
          onComplete: (turnResult) => {
            const issuedCoord = issueConvContext(turnResult.threadCoord, decision);
            cb.onComplete(
              applyToolCallEmulation(toEmulationResult(turnResult), input.tools, issuedCoord),
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

export function buildStrictOutputSchema(
  input: Pick<QueryInput, "tools" | "jsonSchema">,
): JsonValue | undefined {
  const outputSchema = input.tools?.length
    ? buildToolCallSchema(input.tools)
    : input.jsonSchema
      ? (JSON.parse(input.jsonSchema) as JsonValue)
      : undefined;

  return outputSchema
    ? (strictify(outputSchema as Parameters<typeof strictify>[0]) as JsonValue)
    : undefined;
}

// GenerateResult(provider dispatcher 응답)를 applyToolCallEmulation 입력 shape 로 매핑한다.
// OpenAI/Anthropic, query/queryStream 4 경로가 동일하게 쓴다.
// Anthropic adapter 는 cache creation 을 inputTokens 에 포함해 표준화하고, 별도 필드에도 보존한다.
// per-request cost 는 provider 가 준 값을 우선 사용하고, 없으면 공통 cost 함수를 쓴다.
function toEmulationResult(
  result: GenerateResult,
): Omit<QueryOutput, "content" | "finishReason" | "runContext"> {
  return {
    text: result.text,
    tokenName: result.tokenName,
    model: result.model,
    usage: {
      input_tokens: result.usage.inputTokens,
      output_tokens: result.usage.outputTokens,
      cache_creation_input_tokens: result.usage.cacheCreationInputTokens ?? 0,
      cache_read_input_tokens: result.usage.cachedInputTokens,
    },
    durationMs: result.durationMs,
    costUsd:
      result.costUsd !== undefined && result.costUsd > 0
        ? result.costUsd
        : calculateCostUsd(result.model, {
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
            cachedInputTokens: result.usage.cachedInputTokens,
            cacheCreationInputTokens: result.usage.cacheCreationInputTokens ?? 0,
          }),
  };
}

export const QgridDispatcher = new QgridDispatcherClass();
