/**
 * 모델별 토큰 가격 테이블 + cost 계산.
 *
 * claude code 와 동일 패턴: 클라이언트에서 가격 테이블로 직접 계산.
 * 가격 단위: USD per 1M tokens.
 *
 * OpenAI 모델 목록: codex app-server model/list RPC 로 실측 (2026-05-18)
 *
 * @see https://platform.openai.com/docs/pricing
 * @see https://platform.claude.com/docs/en/about-claude/pricing
 */

export interface ModelCosts {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}

// ── OpenAI — codex app-server 에서 사용 가능한 모델 ─────────────────

const OPENAI_COSTS: Record<string, ModelCosts> = {
  "gpt-5.5": { inputTokens: 2, outputTokens: 8, cachedInputTokens: 0.5 },
  "gpt-5.4": { inputTokens: 2, outputTokens: 8, cachedInputTokens: 0.5 },
  "gpt-5.4-mini": { inputTokens: 0.4, outputTokens: 1.6, cachedInputTokens: 0.1 },
  "gpt-5.3-codex": { inputTokens: 2, outputTokens: 8, cachedInputTokens: 0.5 },
  "gpt-5.2": { inputTokens: 2, outputTokens: 8, cachedInputTokens: 0.5 },
};

// ── Anthropic ───────────────────────────────────────────────────────

const ANTHROPIC_COSTS: Record<string, ModelCosts> = {
  sonnet: { inputTokens: 3, outputTokens: 15, cachedInputTokens: 0.3 },
  "claude-3-5-haiku": { inputTokens: 0.8, outputTokens: 4, cachedInputTokens: 0.08 },
  "claude-haiku-4-5": { inputTokens: 1, outputTokens: 5, cachedInputTokens: 0.1 },
  "claude-3-5-sonnet": { inputTokens: 3, outputTokens: 15, cachedInputTokens: 0.3 },
  "claude-3-7-sonnet": { inputTokens: 3, outputTokens: 15, cachedInputTokens: 0.3 },
  "claude-sonnet-4": { inputTokens: 3, outputTokens: 15, cachedInputTokens: 0.3 },
  "claude-sonnet-4-5": { inputTokens: 3, outputTokens: 15, cachedInputTokens: 0.3 },
  "claude-sonnet-4-6": { inputTokens: 3, outputTokens: 15, cachedInputTokens: 0.3 },
  "claude-sonnet-4-7": { inputTokens: 3, outputTokens: 15, cachedInputTokens: 0.3 },
  "claude-opus-4": { inputTokens: 15, outputTokens: 75, cachedInputTokens: 1.5 },
  "claude-opus-4-1": { inputTokens: 15, outputTokens: 75, cachedInputTokens: 1.5 },
  "claude-opus-4-5": { inputTokens: 5, outputTokens: 25, cachedInputTokens: 0.5 },
  "claude-opus-4-6": { inputTokens: 5, outputTokens: 25, cachedInputTokens: 0.5 },
  "claude-opus-4-7": { inputTokens: 5, outputTokens: 25, cachedInputTokens: 0.5 },
};

const DEFAULT_COSTS: ModelCosts = { inputTokens: 3, outputTokens: 15, cachedInputTokens: 0.3 };

export function getModelCosts(model: string): ModelCosts {
  return OPENAI_COSTS[model] ?? ANTHROPIC_COSTS[model] ?? DEFAULT_COSTS;
}

export function calculateCostUsd(
  model: string,
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens?: number },
): number {
  const costs = getModelCosts(model);
  const nonCachedInput = usage.inputTokens - (usage.cachedInputTokens ?? 0);
  return (
    (nonCachedInput / 1_000_000) * costs.inputTokens +
    (usage.outputTokens / 1_000_000) * costs.outputTokens +
    ((usage.cachedInputTokens ?? 0) / 1_000_000) * costs.cachedInputTokens
  );
}
