export const QGRID_PROVIDER_NAME = "qgrid";

export const DEFAULT_QGRID_SERVER_URL = "http://localhost:44900";
export const DEFAULT_QGRID_EFFORT = "low";

// 만료된 대화 좌표는 조회 시 lazy 폐기한다.
export const THREAD_COORD_TTL_MS = 10 * 60_000;

export const TEXT_STREAM_ID_PREFIX = "text";

export const TOP_LEVEL_SCHEMA_WARNING =
  'qgrid server-enforced structured output requires "object". Falling back to client-side parsing.';

export const PENDING_TOOL_RESULTS_WARNING =
  "[qgrid] tool results did not match any pending qgrid run; sending request without runContext";
