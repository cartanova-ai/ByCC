/**
 * @generated
 * 직접 수정하지 마세요.
 */

/* oxlint-disable */

import { zArrayable, SonamuQueryMode, ApplySonamuFilter } from "sonamu";
import { z } from "zod";

// CustomScalar: HistoryItems
const HistoryItems = z.array(
  z.object({
    type: z.string(),
    role: z.string().optional(),
    content: z.unknown().optional(),
    name: z.string().optional(),
    arguments: z.string().optional(),
    call_id: z.string().optional(),
    output: z.string().optional(),
  }),
);
type HistoryItems = z.infer<typeof HistoryItems>;

// CustomScalar: TokenCredentials
const TokenCredentials = z.union([
  z.object({
    accessToken: z.string(),
    refreshToken: z.string(),
    expiresAt: z.number(),
    accountUuid: z.string(),
  }),
  z.object({
    accessToken: z.string(),
    refreshToken: z.string(),
    idToken: z.string().optional(),
    accessTokenExpiresAt: z.number(),
    idTokenExpiresAt: z.number().optional(),
    accountId: z.string(),
    planType: z.string().optional(),
  }),
]);
type TokenCredentials = z.infer<typeof TokenCredentials>;

// CustomScalar: ToolDefinitions
const ToolDefinitions = z.array(
  z.object({
    name: z.string(),
    description: z.string().optional(),
    inputSchema: z.unknown(),
  }),
);
type ToolDefinitions = z.infer<typeof ToolDefinitions>;

// Enums: RequestLog
export const RequestLogOrderBy = z
  .enum([
    "id-desc",
    "id-asc",
    "created_at-desc",
    "created_at-asc",
    "ttft_ms-desc",
    "ttft_ms-asc",
    "duration_ms-desc",
    "duration_ms-asc",
    "input_tokens-desc",
    "input_tokens-asc",
    "output_tokens-desc",
    "output_tokens-asc",
    "cache_read_tokens-desc",
    "cache_read_tokens-asc",
    "cache_creation_tokens-desc",
    "cache_creation_tokens-asc",
    "cost_usd-desc",
    "cost_usd-asc",
  ])
  .describe("RequestLogOrderBy");
export type RequestLogOrderBy = z.infer<typeof RequestLogOrderBy>;
export const RequestLogOrderByLabel = {
  "id-desc": "ID최신순",
  "id-asc": "ID오래된순",
  "created_at-desc": "등록일시최신순",
  "created_at-asc": "등록일시오래된순",
  "ttft_ms-desc": "TTFT긴순",
  "ttft_ms-asc": "TTFT짧은순",
  "duration_ms-desc": "소요시간긴순",
  "duration_ms-asc": "소요시간짧은순",
  "input_tokens-desc": "입력토큰많은순",
  "input_tokens-asc": "입력토큰적은순",
  "output_tokens-desc": "출력토큰많은순",
  "output_tokens-asc": "출력토큰적은순",
  "cache_read_tokens-desc": "캐시읽기많은순",
  "cache_read_tokens-asc": "캐시읽기적은순",
  "cache_creation_tokens-desc": "캐시생성많은순",
  "cache_creation_tokens-asc": "캐시생성적은순",
  "cost_usd-desc": "비용높은순",
  "cost_usd-asc": "비용낮은순",
};
export const RequestLogSearchField = z
  .enum(["id", "token_name", "user_prompt"])
  .describe("RequestLogSearchField");
export type RequestLogSearchField = z.infer<typeof RequestLogSearchField>;
export const RequestLogSearchFieldLabel = {
  id: "ID",
  token_name: "토큰이름",
  user_prompt: "사용자 프롬프트",
};
export const RequestLogStatus = z
  .enum(["running", "succeeded", "error", "aborted"])
  .describe("RequestLogStatus");
export type RequestLogStatus = z.infer<typeof RequestLogStatus>;
export const RequestLogStatusLabel = {
  running: "실행 중",
  succeeded: "성공",
  error: "에러",
  aborted: "중단",
};

// Enums: RequestLogStep
export const RequestLogStepType = z.enum(["generate", "tool_call"]).describe("RequestLogStepType");
export type RequestLogStepType = z.infer<typeof RequestLogStepType>;
export const RequestLogStepTypeLabel = { generate: "LLM 생성", tool_call: "Tool 호출" };
export const RequestLogStepOrderBy = z.enum(["id-asc"]).describe("RequestLogStepOrderBy");
export type RequestLogStepOrderBy = z.infer<typeof RequestLogStepOrderBy>;
export const RequestLogStepOrderByLabel = { "id-asc": "ID순" };
export const RequestLogStepSearchField = z.enum(["id"]).describe("RequestLogStepSearchField");
export type RequestLogStepSearchField = z.infer<typeof RequestLogStepSearchField>;
export const RequestLogStepSearchFieldLabel = { id: "ID" };

// Enums: Setting
export const SettingOrderBy = z.enum(["key-asc"]).describe("SettingOrderBy");
export type SettingOrderBy = z.infer<typeof SettingOrderBy>;
export const SettingOrderByLabel = { "key-asc": "키순" };
export const SettingSearchField = z.enum(["key"]).describe("SettingSearchField");
export type SettingSearchField = z.infer<typeof SettingSearchField>;
export const SettingSearchFieldLabel = { key: "키" };

// Enums: Token
export const TokenOrderBy = z.enum(["id-desc", "ord-asc"]).describe("TokenOrderBy");
export type TokenOrderBy = z.infer<typeof TokenOrderBy>;
export const TokenOrderByLabel = { "id-desc": "ID최신순", "ord-asc": "순서순" };
export const TokenSearchField = z.enum(["id", "name"]).describe("TokenSearchField");
export type TokenSearchField = z.infer<typeof TokenSearchField>;
export const TokenSearchFieldLabel = { id: "ID", name: "이름" };

// BaseSchema: RequestLog
export const RequestLogBaseSchema = z.object({
  id: z.int(),
  created_at: z.date(),
  token_name: z.string().max(100).nullable(),
  project_name: z.string().max(50).nullable(),
  model_name: z.string().max(255).nullable(),
  requested_model_name: z.string().max(255).nullable(),
  fallback_count: z.int().nullable(),
  user_prompt: z.string().nullable(),
  system_prompt: z.string().nullable(),
  response: z.string(),
  input_tokens: z.int(),
  output_tokens: z.int(),
  cache_read_tokens: z.int(),
  cache_creation_tokens: z.int(),
  cache_creation_5m_tokens: z.int().nullable(),
  cache_creation_1h_tokens: z.int().nullable(),
  duration_ms: z.int(),
  ttft_ms: z.int(),
  cost_usd: z.int().nullable(),
  cost_source: z.string().max(20).nullable(),
  image_cost_usd: z.int().nullable(),
  image_cost_method: z.string().max(100).nullable(),
  effort: z.string().max(10).nullable(),
  history: HistoryItems.nullable(),
  tools: ToolDefinitions.nullable(),
  status: RequestLogStatus,
  error_message: z.string().nullable(),
  tool_call_count: z.int(),
  is_image_generation: z.boolean(),
});
export type RequestLogBaseSchema = z.infer<typeof RequestLogBaseSchema> & {
  readonly __hasDefault__: readonly [
    "created_at",
    "token_name",
    "project_name",
    "model_name",
    "requested_model_name",
    "fallback_count",
    "user_prompt",
    "system_prompt",
    "response",
    "input_tokens",
    "output_tokens",
    "cache_read_tokens",
    "cache_creation_tokens",
    "cache_creation_5m_tokens",
    "cache_creation_1h_tokens",
    "duration_ms",
    "ttft_ms",
    "cost_usd",
    "cost_source",
    "image_cost_usd",
    "image_cost_method",
    "effort",
    "history",
    "tools",
    "status",
    "error_message",
    "tool_call_count",
    "is_image_generation",
    "id",
  ];
};

// BaseSchema: RequestLogStep
export const RequestLogStepBaseSchema = z.object({
  id: z.int(),
  created_at: z.date(),
  request_log_id: z.int(),
  step_index: z.int(),
  type: RequestLogStepType,
  model_name: z.string().max(255).nullable(),
  requested_model_name: z.string().max(255).nullable(),
  fallback_count: z.int().nullable(),
  input_tokens: z.int().nullable(),
  output_tokens: z.int().nullable(),
  cache_read_tokens: z.int().nullable(),
  cache_creation_tokens: z.int().nullable(),
  cache_creation_5m_tokens: z.int().nullable(),
  cache_creation_1h_tokens: z.int().nullable(),
  cost_usd: z.int().nullable(),
  cost_source: z.string().max(20).nullable(),
  duration_ms: z.int().nullable(),
  ttft_ms: z.int().nullable(),
  finish_reason: z.string().max(20).nullable(),
  reasoning_text: z.string().nullable(),
  reasoning_tokens: z.int().nullable(),
  tool_call_index: z.int().nullable(),
  tool_call_id: z.string().max(100).nullable(),
  tool_name: z.string().max(100).nullable(),
  tool_args: z.string().nullable(),
  tool_result: z.string().nullable(),
  tool_duration_ms: z.int().nullable(),
  error: z.string().nullable(),
});
export type RequestLogStepBaseSchema = z.infer<typeof RequestLogStepBaseSchema> & {
  readonly __hasDefault__: readonly [
    "created_at",
    "model_name",
    "requested_model_name",
    "fallback_count",
    "input_tokens",
    "output_tokens",
    "cache_read_tokens",
    "cache_creation_tokens",
    "cache_creation_5m_tokens",
    "cache_creation_1h_tokens",
    "cost_usd",
    "cost_source",
    "duration_ms",
    "ttft_ms",
    "finish_reason",
    "reasoning_text",
    "reasoning_tokens",
    "tool_call_index",
    "tool_call_id",
    "tool_name",
    "tool_args",
    "tool_result",
    "tool_duration_ms",
    "error",
    "id",
  ];
};

// BaseSchema: Setting
export const SettingBaseSchema = z.object({
  id: z.int(),
  created_at: z.date(),
  key: z.string().max(100),
  value: z.string(),
  updated_at: z.date().nullable(),
});
export type SettingBaseSchema = z.infer<typeof SettingBaseSchema> & {
  readonly __hasDefault__: readonly ["created_at", "updated_at", "id"];
};

// BaseSchema: Token
export const TokenBaseSchema = z.object({
  id: z.int(),
  created_at: z.date(),
  provider: z.string().max(20),
  credentials: TokenCredentials,
  name: z.string(),
  active: z.boolean(),
  ord: z.int(),
  quota_threshold: z.int().nullable(),
  weight: z.int(),
});
export type TokenBaseSchema = z.infer<typeof TokenBaseSchema> & {
  readonly __hasDefault__: readonly [
    "created_at",
    "active",
    "ord",
    "quota_threshold",
    "weight",
    "id",
  ];
};

// BaseListParams: RequestLog
export const RequestLogBaseListParams = z
  .object({
    num: z.number().int().nonnegative(),
    page: z.number().int().min(1),
    search: RequestLogSearchField,
    keyword: z.string(),
    orderBy: RequestLogOrderBy,
    queryMode: SonamuQueryMode,
    id: zArrayable(z.number().int().positive()),
    sonamuFilter: z.custom<ApplySonamuFilter<RequestLogBaseSchema, never, never>>(),
    token_name: z.string().max(100).nullable(),
    project_name: z.string().max(50).nullable(),
    model_name: z.string().max(255).nullable(),
  })
  .partial();
export type RequestLogBaseListParams = z.infer<typeof RequestLogBaseListParams>;

// BaseListParams: RequestLogStep
export const RequestLogStepBaseListParams = z
  .object({
    num: z.number().int().nonnegative(),
    page: z.number().int().min(1),
    search: RequestLogStepSearchField,
    keyword: z.string(),
    orderBy: RequestLogStepOrderBy,
    queryMode: SonamuQueryMode,
    id: zArrayable(z.number().int().positive()),
    sonamuFilter: z.custom<ApplySonamuFilter<RequestLogStepBaseSchema, never, never>>(),
    request_log_id: z.int(),
  })
  .partial();
export type RequestLogStepBaseListParams = z.infer<typeof RequestLogStepBaseListParams>;

// BaseListParams: Setting
export const SettingBaseListParams = z
  .object({
    num: z.number().int().nonnegative(),
    page: z.number().int().min(1),
    search: SettingSearchField,
    keyword: z.string(),
    orderBy: SettingOrderBy,
    queryMode: SonamuQueryMode,
    id: zArrayable(z.number().int().positive()),
    sonamuFilter: z.custom<ApplySonamuFilter<SettingBaseSchema, never, never>>(),
    key: z.string().max(100),
  })
  .partial();
export type SettingBaseListParams = z.infer<typeof SettingBaseListParams>;

// BaseListParams: Token
export const TokenBaseListParams = z
  .object({
    num: z.number().int().nonnegative(),
    page: z.number().int().min(1),
    search: TokenSearchField,
    keyword: z.string(),
    orderBy: TokenOrderBy,
    queryMode: SonamuQueryMode,
    id: zArrayable(z.number().int().positive()),
    sonamuFilter: z.custom<ApplySonamuFilter<TokenBaseSchema, never, never>>(),
  })
  .partial();
export type TokenBaseListParams = z.infer<typeof TokenBaseListParams>;

// Subsets: RequestLog
export const RequestLogSubsetA = z.object({
  id: z.int(),
  created_at: z.date(),
  token_name: z.string().max(100).nullable(),
  project_name: z.string().max(50).nullable(),
  model_name: z.string().max(255).nullable(),
  requested_model_name: z.string().max(255).nullable(),
  fallback_count: z.int().nullable(),
  user_prompt: z.string().nullable(),
  system_prompt: z.string().nullable(),
  response: z.string(),
  input_tokens: z.int(),
  output_tokens: z.int(),
  cache_read_tokens: z.int(),
  cache_creation_tokens: z.int(),
  cache_creation_5m_tokens: z.int().nullable(),
  cache_creation_1h_tokens: z.int().nullable(),
  duration_ms: z.int(),
  ttft_ms: z.int(),
  cost_usd: z.int().nullable(),
  cost_source: z.string().max(20).nullable(),
  image_cost_usd: z.int().nullable(),
  image_cost_method: z.string().max(100).nullable(),
  effort: z.string().max(10).nullable(),
  history: HistoryItems.nullable(),
  tools: ToolDefinitions.nullable(),
  status: RequestLogStatus,
  error_message: z.string().nullable(),
  tool_call_count: z.int(),
  is_image_generation: z.boolean(),
});
export type RequestLogSubsetA = z.infer<typeof RequestLogSubsetA>;
export const RequestLogSubsetP = z.object({
  id: z.int(),
  created_at: z.date(),
  token_name: z.string().max(100).nullable(),
  project_name: z.string().max(50).nullable(),
  model_name: z.string().max(255).nullable(),
  requested_model_name: z.string().max(255).nullable(),
  fallback_count: z.int().nullable(),
  input_tokens: z.int(),
  output_tokens: z.int(),
  cache_read_tokens: z.int(),
  cache_creation_tokens: z.int(),
  cache_creation_5m_tokens: z.int().nullable(),
  cache_creation_1h_tokens: z.int().nullable(),
  duration_ms: z.int(),
  ttft_ms: z.int(),
  cost_usd: z.int().nullable(),
  cost_source: z.string().max(20).nullable(),
  image_cost_usd: z.int().nullable(),
  image_cost_method: z.string().max(100).nullable(),
  effort: z.string().max(10).nullable(),
  status: RequestLogStatus,
  tool_call_count: z.int(),
  is_image_generation: z.boolean(),
});
export type RequestLogSubsetP = z.infer<typeof RequestLogSubsetP>;
export const RequestLogSubsetC = z.object({
  id: z.int(),
  token_name: z.string().max(100).nullable(),
  model_name: z.string().max(255).nullable(),
  input_tokens: z.int(),
  output_tokens: z.int(),
  cache_read_tokens: z.int(),
  cache_creation_tokens: z.int(),
  cache_creation_5m_tokens: z.int().nullable(),
  cache_creation_1h_tokens: z.int().nullable(),
  cost_usd: z.int().nullable(),
  cost_source: z.string().max(20).nullable(),
});
export type RequestLogSubsetC = z.infer<typeof RequestLogSubsetC>;
export type RequestLogSubsetMapping = {
  A: RequestLogSubsetA;
  P: RequestLogSubsetP;
  C: RequestLogSubsetC;
};
export const RequestLogSubsetKey = z.enum(["A", "P", "C"]);
export type RequestLogSubsetKey = z.infer<typeof RequestLogSubsetKey>;

// Subsets: RequestLogStep
export const RequestLogStepSubsetA = z.object({
  id: z.int(),
  created_at: z.date(),
  step_index: z.int(),
  type: RequestLogStepType,
  model_name: z.string().max(255).nullable(),
  requested_model_name: z.string().max(255).nullable(),
  fallback_count: z.int().nullable(),
  input_tokens: z.int().nullable(),
  output_tokens: z.int().nullable(),
  cache_read_tokens: z.int().nullable(),
  cache_creation_tokens: z.int().nullable(),
  cache_creation_5m_tokens: z.int().nullable(),
  cache_creation_1h_tokens: z.int().nullable(),
  cost_usd: z.int().nullable(),
  cost_source: z.string().max(20).nullable(),
  duration_ms: z.int().nullable(),
  ttft_ms: z.int().nullable(),
  finish_reason: z.string().max(20).nullable(),
  reasoning_text: z.string().nullable(),
  reasoning_tokens: z.int().nullable(),
  tool_call_index: z.int().nullable(),
  tool_call_id: z.string().max(100).nullable(),
  tool_name: z.string().max(100).nullable(),
  tool_args: z.string().nullable(),
  tool_result: z.string().nullable(),
  tool_duration_ms: z.int().nullable(),
  error: z.string().nullable(),
});
export type RequestLogStepSubsetA = z.infer<typeof RequestLogStepSubsetA>;
export const RequestLogStepSubsetT = z.object({
  id: z.int(),
  created_at: z.date(),
  step_index: z.int(),
  type: RequestLogStepType,
  model_name: z.string().max(255).nullable(),
  requested_model_name: z.string().max(255).nullable(),
  fallback_count: z.int().nullable(),
  input_tokens: z.int().nullable(),
  output_tokens: z.int().nullable(),
  cache_read_tokens: z.int().nullable(),
  cache_creation_tokens: z.int().nullable(),
  cache_creation_5m_tokens: z.int().nullable(),
  cache_creation_1h_tokens: z.int().nullable(),
  cost_usd: z.int().nullable(),
  cost_source: z.string().max(20).nullable(),
  duration_ms: z.int().nullable(),
  ttft_ms: z.int().nullable(),
  finish_reason: z.string().max(20).nullable(),
  reasoning_tokens: z.int().nullable(),
  tool_call_index: z.int().nullable(),
  tool_call_id: z.string().max(100).nullable(),
  tool_name: z.string().max(100).nullable(),
  tool_duration_ms: z.int().nullable(),
  error: z.string().nullable(),
});
export type RequestLogStepSubsetT = z.infer<typeof RequestLogStepSubsetT>;
export const RequestLogStepSubsetI = z.object({
  id: z.int(),
  tool_args: z.string().nullable(),
});
export type RequestLogStepSubsetI = z.infer<typeof RequestLogStepSubsetI>;
export type RequestLogStepSubsetMapping = {
  A: RequestLogStepSubsetA;
  T: RequestLogStepSubsetT;
  I: RequestLogStepSubsetI;
};
export const RequestLogStepSubsetKey = z.enum(["A", "T", "I"]);
export type RequestLogStepSubsetKey = z.infer<typeof RequestLogStepSubsetKey>;

// Subsets: Setting
export const SettingSubsetA = z.object({
  id: z.int(),
  created_at: z.date(),
  key: z.string().max(100),
  value: z.string(),
  updated_at: z.date().nullable(),
});
export type SettingSubsetA = z.infer<typeof SettingSubsetA>;
export type SettingSubsetMapping = {
  A: SettingSubsetA;
};
export const SettingSubsetKey = z.enum(["A"]);
export type SettingSubsetKey = z.infer<typeof SettingSubsetKey>;

// Subsets: Token
export const TokenSubsetA = z.object({
  id: z.int(),
  created_at: z.date(),
  provider: z.string().max(20),
  credentials: TokenCredentials,
  name: z.string(),
  active: z.boolean(),
  ord: z.int(),
  quota_threshold: z.int().nullable(),
  weight: z.int(),
});
export type TokenSubsetA = z.infer<typeof TokenSubsetA>;
export type TokenSubsetMapping = {
  A: TokenSubsetA;
};
export const TokenSubsetKey = z.enum(["A"]);
export type TokenSubsetKey = z.infer<typeof TokenSubsetKey>;
