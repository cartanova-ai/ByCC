export const QGRID_PROVIDER_NAME = "qgrid";

export const DEFAULT_QGRID_SERVER_URL = "http://localhost:44900";
export const DEFAULT_QGRID_EFFORT = "low";

// 서버 codex-worker 의 thread idle TTL(10분)과 맞춤. 만료 엔트리는 조회 시 lazy 폐기한다.
export const THREAD_COORD_TTL_MS = 10 * 60_000;

export const TEXT_STREAM_ID_PREFIX = "text";

export const TOP_LEVEL_SCHEMA_WARNING =
  'OpenAI structured output requires "object". Falling back to client-side parsing.';

export const PENDING_TOOL_RESULTS_WARNING =
  "[qgrid] pending tool results not found in prompt, clearing client run state";
