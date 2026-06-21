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
  cacheCreationInputTokens?: number;
  /**
   * long-context 할증. 전체 입력 토큰(input_tokens, cache_read 포함)이 threshold 초과 시
   * 초과분만이 아니라 요청 전체(full session)에 배율 적용.
   */
  longContext?: {
    threshold: number;
    inputMultiplier: number;
    cachedInputMultiplier: number;
    outputMultiplier: number;
  };
}

// ── OpenAI — codex app-server 에서 사용 가능한 모델 ─────────────────
//
// 가격 출처: https://openai.com/api/pricing (2026-06-11 확인)
// 신모델 출시마다 단가가 바뀌므로(5.2→5.4→5.5) 모델 추가 시 반드시 공식 페이지 재확인해야함

// GPT-5.4에서 처음 도입된 long-context 할증 (5.2/5.3-codex는 해당 없음, 5.4-mini/nano는 공식 표에서 long-context 단가 없음)
// 272K 초과 시 input 2x / cached 2x / output 1.5x — 초과분만이 아닌 세션 전체에 적용됨
// @see https://developers.openai.com/api/docs/models/gpt-5.5 ("prompts with >272K input tokens")
const LONG_CONTEXT_272K: NonNullable<ModelCosts["longContext"]> = {
  threshold: 272_000,
  inputMultiplier: 2,
  cachedInputMultiplier: 2,
  outputMultiplier: 1.5,
};

const OPENAI_COSTS: Record<string, ModelCosts> = {
  // https://openai.com/index/introducing-gpt-5-5/ (2026-04 출시)
  "gpt-5.5": {
    inputTokens: 5,
    outputTokens: 30,
    cachedInputTokens: 0.5,
    longContext: LONG_CONTEXT_272K,
  },
  // https://openai.com/index/introducing-gpt-5-4/ (2026-03 출시)
  "gpt-5.4": {
    inputTokens: 2.5,
    outputTokens: 15,
    cachedInputTokens: 0.25,
    longContext: LONG_CONTEXT_272K,
  },
  "gpt-5.4-mini": { inputTokens: 0.75, outputTokens: 4.5, cachedInputTokens: 0.075 },
  // gpt-5.2와 동일 단가 (cached = input의 10%)
  "gpt-5.3-codex": { inputTokens: 1.75, outputTokens: 14, cachedInputTokens: 0.175 },
  // https://openai.com/index/introducing-gpt-5-2/ (cached input 90% 할인 명시)
  "gpt-5.2": { inputTokens: 1.75, outputTokens: 14, cachedInputTokens: 0.175 },
};

// ── Anthropic ───────────────────────────────────────────────────────

const ANTHROPIC_COSTS: Record<string, ModelCosts> = {
  // Claude Code 는 별도 ttl:"1h" 옵션 없이 실행되므로 fallback 가격표는 5분 cache write(1.25x)를 기준으로 둔다.
  // 1시간 cache write 는 input 2x 이지만 현재 qgrid 실행 경로의 기본값이 아니다.
  sonnet: {
    inputTokens: 3,
    outputTokens: 15,
    cachedInputTokens: 0.3,
    cacheCreationInputTokens: 3.75,
  },
  "claude-3-5-haiku": {
    inputTokens: 0.8,
    outputTokens: 4,
    cachedInputTokens: 0.08,
    cacheCreationInputTokens: 1,
  },
  "claude-haiku-4-5": {
    inputTokens: 1,
    outputTokens: 5,
    cachedInputTokens: 0.1,
    cacheCreationInputTokens: 1.25,
  },
  "claude-3-5-sonnet": {
    inputTokens: 3,
    outputTokens: 15,
    cachedInputTokens: 0.3,
    cacheCreationInputTokens: 3.75,
  },
  "claude-3-7-sonnet": {
    inputTokens: 3,
    outputTokens: 15,
    cachedInputTokens: 0.3,
    cacheCreationInputTokens: 3.75,
  },
  "claude-sonnet-4": {
    inputTokens: 3,
    outputTokens: 15,
    cachedInputTokens: 0.3,
    cacheCreationInputTokens: 3.75,
  },
  "claude-sonnet-4-5": {
    inputTokens: 3,
    outputTokens: 15,
    cachedInputTokens: 0.3,
    cacheCreationInputTokens: 3.75,
  },
  "claude-sonnet-4-6": {
    inputTokens: 3,
    outputTokens: 15,
    cachedInputTokens: 0.3,
    cacheCreationInputTokens: 3.75,
  },
  "claude-sonnet-4-7": {
    inputTokens: 3,
    outputTokens: 15,
    cachedInputTokens: 0.3,
    cacheCreationInputTokens: 3.75,
  },
  "claude-opus-4": {
    inputTokens: 15,
    outputTokens: 75,
    cachedInputTokens: 1.5,
    cacheCreationInputTokens: 18.75,
  },
  "claude-opus-4-1": {
    inputTokens: 15,
    outputTokens: 75,
    cachedInputTokens: 1.5,
    cacheCreationInputTokens: 18.75,
  },
  "claude-opus-4-5": {
    inputTokens: 5,
    outputTokens: 25,
    cachedInputTokens: 0.5,
    cacheCreationInputTokens: 6.25,
  },
  "claude-opus-4-6": {
    inputTokens: 5,
    outputTokens: 25,
    cachedInputTokens: 0.5,
    cacheCreationInputTokens: 6.25,
  },
  "claude-opus-4-7": {
    inputTokens: 5,
    outputTokens: 25,
    cachedInputTokens: 0.5,
    cacheCreationInputTokens: 6.25,
  },
  "claude-opus-4-8": {
    inputTokens: 5,
    outputTokens: 25,
    cachedInputTokens: 0.5,
    cacheCreationInputTokens: 6.25,
  },
};

const DEFAULT_COSTS: ModelCosts = { inputTokens: 3, outputTokens: 15, cachedInputTokens: 0.3 };

export function getModelCosts(model: string): ModelCosts {
  return OPENAI_COSTS[model] ?? ANTHROPIC_COSTS[model] ?? DEFAULT_COSTS;
}

export function calculateCostUsd(
  model: string,
  usage: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
    cacheCreationInputTokens?: number;
  },
): number {
  const costs = getModelCosts(model);
  const cachedInput = usage.cachedInputTokens ?? 0;
  const cacheCreationInput = usage.cacheCreationInputTokens ?? 0;
  const nonCachedInput = Math.max(usage.inputTokens - cachedInput - cacheCreationInput, 0);

  // long-context 할증: 전체 입력(input_tokens, cache 포함)이 threshold 초과 시 요청 전체에 배율 적용
  const lc = costs.longContext;
  const isLongContext = lc !== undefined && usage.inputTokens > lc.threshold;
  const inputRate = costs.inputTokens * (isLongContext ? lc.inputMultiplier : 1);
  const cachedRate = costs.cachedInputTokens * (isLongContext ? lc.cachedInputMultiplier : 1);
  const cacheCreationRate =
    (costs.cacheCreationInputTokens ?? costs.inputTokens) *
    (isLongContext ? lc.inputMultiplier : 1);
  const outputRate = costs.outputTokens * (isLongContext ? lc.outputMultiplier : 1);

  return (
    (nonCachedInput / 1_000_000) * inputRate +
    (usage.outputTokens / 1_000_000) * outputRate +
    (cachedInput / 1_000_000) * cachedRate +
    (cacheCreationInput / 1_000_000) * cacheCreationRate
  );
}
