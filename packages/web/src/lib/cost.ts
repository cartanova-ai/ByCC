// request_logs.cost_usd는 micro-USD(정수)로 저장. 표시는 소수 4자리 USD.
const MICRO_USD = 1_000_000;
const COST_DECIMALS = 4;

export function microUsdToUsd(microUsd: number): number {
  return microUsd / MICRO_USD;
}

export function formatUsd(usd: number): string {
  return `$${usd.toFixed(COST_DECIMALS)}`;
}

export function formatMicroUsd(microUsd: number): string {
  return formatUsd(microUsdToUsd(microUsd));
}

/**
 * prompt cache 적중률. input_tokens 는 cache_read 를 포함한 전체 입력 토큰(OpenAI/codex 표준,
 * 비용 계산도 input - cache_read = nonCached 로 전제). 따라서 분모는 input_tokens 단일값.
 * list/show 등 모든 화면이 이 함수를 써야 식이 갈려 잘못 표시되는 일을 막는다.
 * (과거 list 는 input+read+creation 으로 나눠 read 가 이중계산돼 94%→48%로 반토막났음.)
 */
export function cacheHitRate(input: { input_tokens: number; cache_read_tokens: number }): string {
  if (input.input_tokens <= 0) return "—";
  return `${Math.round((input.cache_read_tokens / input.input_tokens) * 100)}%`;
}
