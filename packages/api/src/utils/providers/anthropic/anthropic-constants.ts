/**
 * Anthropic(Claude) provider 상수.
 *
 * Claude Code CLI 플래그/env 계약을 Anthropic dispatcher 용으로 고정한다:
 *  - `--no-session-persistence` 제거 (멀티턴 필수).
 *  - `--input-format stream-json` 추가 (stdin 으로 입력 어댑터 JSONL 흘림).
 *  - Anthropic 경로는 매 호출 `--session-id` 로 fresh session 을 발급한다.
 */

// CC --model 플래그가 받는 official model id (alias "sonnet" 가 아니라 정확한 식별자로 고정).
// claude-api 스킬 확인: Sonnet 4.6 official id = "claude-sonnet-4-6" (날짜 suffix 없음).
// model-cost 테이블에도 "claude-sonnet-4-6" 키 존재
export const ANTHROPIC_DEFAULT_MODEL = "claude-sonnet-4-6";
// OpenAI provider 기본값(openai-dispatcher DEFAULT_EFFORT)과 맞춘다. 클라가 effort 미지정 시 안전망.
export const ANTHROPIC_DEFAULT_EFFORT = "low";
// project scope cwd (settings.json 격리). 토큰별 격리는 CLAUDE_CONFIG_DIR 로 한다.
export const ANTHROPIC_CLAUDE_CWD = "/tmp/qgrid-anthropic";
// per-token CLAUDE_CONFIG_DIR 의 베이스. 실제 경로는 `${BASE}/${tokenId}` (R10 격리).
export const ANTHROPIC_CONFIG_DIR_BASE = "/tmp/qgrid-anthropic-config";
// CC 가 자동 활성화하는 deferred 도구 — 토큰 최적화 위해 dispatcher 경로에서 차단.
export const ANTHROPIC_DISALLOWED_TOOLS = ["Monitor", "PushNotification", "RemoteTrigger"] as const;
const ONE_MILLION_SUFFIX_RE = /\[1m\]$/i;

// 토큰별 CLAUDE_CONFIG_DIR 경로 규칙(R10 격리 계약). tokenId 별로 분리되어, 같은 claude session-id
// 라도 다른 토큰이면 다른 config dir → transcript 가 섞이지 않는다. 부수효과 없는 순수 함수라
// 격리 계약을 단위 테스트로 고정할 수 있다(U6 R10 구조 검증). 실제 dir 생성은 ensureConfigDir 가 한다.
export function anthropicConfigDir(tokenId: number): string {
  return `${ANTHROPIC_CONFIG_DIR_BASE}/${tokenId}`;
}

// model id 를 canonical(provider prefix 없는 CLI/cost 키) 로 정규화
// ai-sdk 는 'anthropic/claude-*' 형태로 보내는데, prefix 가 calculateCostUsd 에 새면 cost 가
// default 단가로 오계산된다. `[1m]` suffix 도 CLI emit 전용이라
// base canonical 에서는 제거한다. 미지정이면 default.
export function canonicalAnthropicModel(model?: string): string {
  const raw = model || ANTHROPIC_DEFAULT_MODEL;
  const withoutProvider = raw.includes("/") ? raw.split("/").pop()! : raw;
  return withoutProvider.replace(ONE_MILLION_SUFFIX_RE, "");
}

export function hasOneMillionSuffix(model?: string): boolean {
  return model !== undefined && ONE_MILLION_SUFFIX_RE.test(model);
}

// 1M 지원 여부는 Claude Code 내부의 광범위한 prefix 판정이 아니라 qgrid에서 확인한 exact set 으로
// 고정한다. opus-4-7 은 실측 전까지 미포함. 새 모델 추가 시 공식 사양과 실제 CLI 동작을 확인한다.
const ONE_MILLION_CONTEXT_MODELS = new Set([
  "claude-fable-5",
  "claude-opus-5",
  "claude-sonnet-5",
  "claude-sonnet-4-6",
  "claude-opus-4-6",
  "claude-opus-4-8",
]);

const CLI_ONE_MILLION_SUFFIX_MODELS = new Set(["claude-sonnet-4-6", "claude-opus-4-6"]);
// Fable 5 는 adaptive thinking 이 유일한 모드다. Opus 5 는 disabled 를 high 이하에서 지원하지만,
// 공식 기본값·권장 동작인 adaptive thinking 을 유지한다. qgrid 기본 effort=low 가 비용/지연 제어를
// 맡으며, 이 정책은 disabled+xhigh/max 400 오류와 disabled 시 tool/XML 출력 오염도 피한다.
const ADAPTIVE_THINKING_MODELS = new Set(["claude-fable-5", "claude-opus-5"]);

// 불변 계약: suffix 가 필요한 모델은 반드시 1M 지원 모델의 부분집합이어야 한다. 역방향 불일치(suffix
// 대상인데 지원 집합엔 없음)면 needsCli1mSuffix=true·supports1MContext=false 가 동시에 나서
// `--model [1m]` 과 DISABLE_1M env 가 모순되게 붙는다. 새 모델을 한쪽 Set 에만 넣는 실수를 모듈
// 로드 시점에 잡는다.
for (const model of CLI_ONE_MILLION_SUFFIX_MODELS) {
  if (!ONE_MILLION_CONTEXT_MODELS.has(model)) {
    throw new Error(`[invariant] CLI 1M suffix model not in context set: ${model}`);
  }
}

export function supports1MContext(model?: string): boolean {
  return ONE_MILLION_CONTEXT_MODELS.has(canonicalAnthropicModel(model));
}

export function needsCli1mSuffix(model?: string): boolean {
  return CLI_ONE_MILLION_SUFFIX_MODELS.has(canonicalAnthropicModel(model));
}

// qgrid 가 adaptive thinking 을 보존하는 모델인지 판별한다. 나머지 모델은 기존
// 저비용/비추론 경로를 유지한다.
export function usesAdaptiveThinking(model?: string): boolean {
  return ADAPTIVE_THINKING_MODELS.has(canonicalAnthropicModel(model));
}

export function assertSupportedOneMillionSuffix(model?: string): void {
  if (!hasOneMillionSuffix(model)) return;
  const canonical = canonicalAnthropicModel(model);
  if (!supports1MContext(canonical)) {
    throw new Error(`Unsupported Anthropic 1M model suffix: ${model}`);
  }
}
