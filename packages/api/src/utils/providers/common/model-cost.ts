/**
 * 모델별 토큰 가격 테이블 + cost 계산.
 *
 * claude code 와 동일 패턴: 클라이언트에서 가격 테이블로 직접 계산.
 * 가격 단위: USD per 1M tokens.
 *
 * OpenAI 모델 목록은 OpenAI 모델 문서와 현재 지원 목록을 기준으로 관리한다.
 *
 * @see https://platform.openai.com/docs/pricing
 * @see https://platform.claude.com/docs/en/about-claude/pricing
 */

export interface ModelCosts {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  /** TTL breakdown 이 없는 usage 에 적용할 cache write fallback 단가. */
  cacheCreationInputTokens?: number;
  cacheCreationInputTokens5m?: number;
  cacheCreationInputTokens1h?: number;
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

// ── OpenAI ─────────────────────────────────────────────────────────
//
// 가격 출처: https://developers.openai.com/api/docs/models (2026-07-18 확인)
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
  // GPT-5.6 Sol, Terra, Luna. cache write 단가는 외부 logger/manual usage 입력을 위해
  // 유지한다. 현재 OpenAI 응답 usage 에 cache write 토큰 필드가 없으면 비용은 0으로 계산된다.
  // @see https://developers.openai.com/api/docs/models/gpt-5.6-sol
  // @see https://developers.openai.com/api/docs/models/gpt-5.6-terra
  // @see https://developers.openai.com/api/docs/models/gpt-5.6-luna
  "gpt-5.6-sol": {
    inputTokens: 5,
    outputTokens: 30,
    cachedInputTokens: 0.5,
    cacheCreationInputTokens: 6.25,
    longContext: LONG_CONTEXT_272K,
  },
  "gpt-5.6-terra": {
    inputTokens: 2.5,
    outputTokens: 15,
    cachedInputTokens: 0.25,
    cacheCreationInputTokens: 3.125,
    longContext: LONG_CONTEXT_272K,
  },
  "gpt-5.6-luna": {
    inputTokens: 1,
    outputTokens: 6,
    cachedInputTokens: 0.1,
    cacheCreationInputTokens: 1.25,
    longContext: LONG_CONTEXT_272K,
  },
  // https://openai.com/index/introducing-gpt-5-5/ (2026-04 출시)
  "gpt-5.5": {
    inputTokens: 5,
    outputTokens: 30,
    cachedInputTokens: 0.5,
    longContext: LONG_CONTEXT_272K,
  },
  // 아래 gpt-5.4 / gpt-5.4-mini / gpt-5.3-codex / gpt-5.2 는 qgrid 가 쓰는 ChatGPT 구독 Codex 경로에서
  // 더 이상 제공되지 않는다(5.4 계열은 2026-08-31 retired, 대체 gpt-5.6-terra / gpt-5.6-luna).
  // 과거 request log 재산정(cost_source 없는 legacy 행)에 필요하므로 단가 행은 유지한다.
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

function anthropicCosts(
  inputTokens: number,
  outputTokens: number,
  overrides: Pick<Partial<ModelCosts>, "cachedInputTokens"> = {},
): ModelCosts {
  return {
    inputTokens,
    outputTokens,
    // 표준 cache read 는 base input 의 0.1x. Fable 5.1 처럼 공식 특례 단가가 있으면 override 한다.
    cachedInputTokens: overrides.cachedInputTokens ?? inputTokens / 10,
    // Claude Code subscription OAuth 는 1h TTL 을 자동 선택한다. 구버전처럼 응답에
    // TTL breakdown 이 없을 때만 이 1h 단가를 fallback 으로 사용한다.
    cacheCreationInputTokens: inputTokens * 2,
    cacheCreationInputTokens5m: inputTokens * 1.25,
    cacheCreationInputTokens1h: inputTokens * 2,
  };
}

// 가격 출처: https://platform.claude.com/docs/en/about-claude/pricing (2026-09-02 확인)
const ANTHROPIC_COSTS: Record<string, ModelCosts> = {
  // Fable 5.1 (2026-09-01 출시): input/output 은 Fable 5 와 같고 cache read 만 0.025x($0.25) 특례.
  // @see https://platform.claude.com/docs/en/models/fable-5-1/overview
  "claude-fable-5-1": anthropicCosts(10, 50, { cachedInputTokens: 0.25 }),
  "claude-fable-5": anthropicCosts(10, 50),
  sonnet: anthropicCosts(3, 15),
  "claude-3-5-haiku": anthropicCosts(0.8, 4),
  "claude-haiku-4-5": anthropicCosts(1, 5),
  "claude-3-5-sonnet": anthropicCosts(3, 15),
  "claude-3-7-sonnet": anthropicCosts(3, 15),
  "claude-sonnet-4": anthropicCosts(3, 15),
  "claude-sonnet-4-5": anthropicCosts(3, 15),
  "claude-sonnet-4-6": anthropicCosts(3, 15),
  "claude-sonnet-4-7": anthropicCosts(3, 15),
  "claude-opus-4": anthropicCosts(15, 75),
  "claude-opus-4-1": anthropicCosts(15, 75),
  "claude-opus-4-5": anthropicCosts(5, 25),
  "claude-opus-4-6": anthropicCosts(5, 25),
  "claude-opus-4-7": anthropicCosts(5, 25),
  "claude-opus-4-8": anthropicCosts(5, 25),
  "claude-opus-5": anthropicCosts(5, 25),
  // Sonnet 5 의 introductory $2/$10 이 정식 단가로 확정됐다. 2026-09-01 에 예정됐던 $3/$15 인상은
  // 취소됐으므로 날짜 분기 없이 고정 단가로 계산한다.
  "claude-sonnet-5": anthropicCosts(2, 10),
};

// gpt-5.3-codex-spark 는 research preview 로 공식 token 단가가 아직 final 이 아니다.
// 지원 타입은 유지하되, 공식 단가가 공개될 때까지 아래 generic estimate 로 계산한다.
// @see https://help.openai.com/en/articles/20001106-codex-rate-card
const DEFAULT_COSTS: ModelCosts = { inputTokens: 3, outputTokens: 15, cachedInputTokens: 0.3 };

export function getModelCosts(model: string): ModelCosts {
  const normalizedModel = (model.split("/").pop() ?? model).replace(/\[1m\]$/i, "");
  return OPENAI_COSTS[normalizedModel] ?? ANTHROPIC_COSTS[normalizedModel] ?? DEFAULT_COSTS;
}

export function calculateCostUsd(
  model: string,
  usage: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
    cacheCreationInputTokens?: number;
    cacheCreationInputTokens5m?: number;
    cacheCreationInputTokens1h?: number;
  },
): number {
  const costs = getModelCosts(model);
  const cachedInput = usage.cachedInputTokens ?? 0;
  const cacheCreationInput5m = Math.max(usage.cacheCreationInputTokens5m ?? 0, 0);
  const cacheCreationInput1h = Math.max(usage.cacheCreationInputTokens1h ?? 0, 0);
  const cacheCreationInput = Math.max(
    usage.cacheCreationInputTokens ?? 0,
    cacheCreationInput5m + cacheCreationInput1h,
  );
  const classifiedCacheCreationInput5m = Math.min(cacheCreationInput5m, cacheCreationInput);
  const classifiedCacheCreationInput1h = Math.min(
    cacheCreationInput1h,
    cacheCreationInput - classifiedCacheCreationInput5m,
  );
  const unclassifiedCacheCreationInput =
    cacheCreationInput - classifiedCacheCreationInput5m - classifiedCacheCreationInput1h;
  const nonCachedInput = Math.max(usage.inputTokens - cachedInput - cacheCreationInput, 0);

  // long-context 할증: 전체 입력(input_tokens, cache 포함)이 threshold 초과 시 요청 전체에 배율 적용
  const lc = costs.longContext;
  const isLongContext = lc !== undefined && usage.inputTokens > lc.threshold;
  const inputRate = costs.inputTokens * (isLongContext ? lc.inputMultiplier : 1);
  const cachedRate = costs.cachedInputTokens * (isLongContext ? lc.cachedInputMultiplier : 1);
  const cacheCreationFallbackRate =
    (costs.cacheCreationInputTokens ?? costs.inputTokens) *
    (isLongContext ? lc.inputMultiplier : 1);
  const cacheCreation5mRate =
    (costs.cacheCreationInputTokens5m ?? costs.cacheCreationInputTokens ?? costs.inputTokens) *
    (isLongContext ? lc.inputMultiplier : 1);
  const cacheCreation1hRate =
    (costs.cacheCreationInputTokens1h ?? costs.cacheCreationInputTokens ?? costs.inputTokens) *
    (isLongContext ? lc.inputMultiplier : 1);
  const outputRate = costs.outputTokens * (isLongContext ? lc.outputMultiplier : 1);

  return (
    (nonCachedInput / 1_000_000) * inputRate +
    (usage.outputTokens / 1_000_000) * outputRate +
    (cachedInput / 1_000_000) * cachedRate +
    (unclassifiedCacheCreationInput / 1_000_000) * cacheCreationFallbackRate +
    (classifiedCacheCreationInput5m / 1_000_000) * cacheCreation5mRate +
    (classifiedCacheCreationInput1h / 1_000_000) * cacheCreation1hRate
  );
}
