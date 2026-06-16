/**
 * Anthropic(Claude) provider 상수.
 *
 * 기존 qgrid.dispatcher.ts 의 executeClaude 플래그/env 와 정합을 맞추되, 멀티턴용으로 조정한다:
 *  - `--no-session-persistence` 제거 (멀티턴 필수).
 *  - `--input-format stream-json` 추가 (stdin 으로 입력 어댑터 JSONL 흘림).
 *  - `--session-id` / `--resume` 로 세션 소유.
 */

// CC --model 플래그가 받는 official model id (alias "sonnet" 가 아니라 정확한 식별자로 고정).
// claude-api 스킬 확인: Sonnet 4.6 official id = "claude-sonnet-4-6" (날짜 suffix 없음).
// model-cost 테이블에도 "claude-sonnet-4-6" 키 존재. (owner 지시)
export const ANTHROPIC_DEFAULT_MODEL = "claude-sonnet-4-6";
export const ANTHROPIC_DEFAULT_EFFORT = "high";

// project scope cwd (settings.json 격리). 토큰별 격리는 CLAUDE_CONFIG_DIR 로 한다.
export const ANTHROPIC_CLAUDE_CWD = "/tmp/qgrid-anthropic";

// per-token CLAUDE_CONFIG_DIR 의 베이스. 실제 경로는 `${BASE}/${tokenId}` (R10 격리).
export const ANTHROPIC_CONFIG_DIR_BASE = "/tmp/qgrid-anthropic-config";

// CC 가 자동 활성화하는 deferred 도구 — 토큰 최적화 위해 차단(기존 executeClaude 와 동일).
export const ANTHROPIC_DISALLOWED_TOOLS = ["Monitor", "PushNotification", "RemoteTrigger"] as const;
