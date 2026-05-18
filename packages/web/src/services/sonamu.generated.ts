/**
 * @generated
 * API에서 동기화된 파일입니다. 직접 수정하지 마세요.
 */

/* oxlint-disable */

import { z } from "zod";

import { zArrayable, SonamuQueryMode, ApplySonamuFilter } from "./sonamu.shared";

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

// Enums: RequestLog
export const RequestLogOrderBy = z.enum(["id-desc"]).describe("RequestLogOrderBy");
export type RequestLogOrderBy = z.infer<typeof RequestLogOrderBy>;
export const RequestLogOrderByLabel = { "id-desc": "ID최신순" };
export const RequestLogSearchField = z
  .enum(["id", "token_name", "user_prompt"])
  .describe("RequestLogSearchField");
export type RequestLogSearchField = z.infer<typeof RequestLogSearchField>;
export const RequestLogSearchFieldLabel = {
  id: "ID",
  token_name: "토큰이름",
  user_prompt: "사용자 프롬프트",
};

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
  token_name: z.string().max(100),
  project_name: z.string().max(50).nullable(),
  model_name: z.string().max(50).nullable(),
  user_prompt: z.string().nullable(),
  system_prompt: z.string().nullable(),
  response: z.string(),
  input_tokens: z.int(),
  output_tokens: z.int(),
  cache_read_tokens: z.int(),
  cache_creation_tokens: z.int(),
  duration_ms: z.int(),
  cost_usd: z.int().nullable(),
});
export type RequestLogBaseSchema = z.infer<typeof RequestLogBaseSchema> & {
  readonly __hasDefault__: readonly [
    "created_at",
    "project_name",
    "model_name",
    "user_prompt",
    "system_prompt",
    "cost_usd",
    "id",
  ];
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
});
export type TokenBaseSchema = z.infer<typeof TokenBaseSchema> & {
  readonly __hasDefault__: readonly ["created_at", "active", "ord", "id"];
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
    token_name: z.string().max(100),
    project_name: z.string().max(50).nullable(),
    model_name: z.string().max(50).nullable(),
  })
  .partial();
export type RequestLogBaseListParams = z.infer<typeof RequestLogBaseListParams>;

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
  token_name: z.string().max(100),
  project_name: z.string().max(50).nullable(),
  model_name: z.string().max(50).nullable(),
  user_prompt: z.string().nullable(),
  system_prompt: z.string().nullable(),
  response: z.string(),
  input_tokens: z.int(),
  output_tokens: z.int(),
  cache_read_tokens: z.int(),
  cache_creation_tokens: z.int(),
  duration_ms: z.int(),
  cost_usd: z.int().nullable(),
});
export type RequestLogSubsetA = z.infer<typeof RequestLogSubsetA>;
export const RequestLogSubsetP = z.object({
  id: z.int(),
  created_at: z.date(),
  token_name: z.string().max(100),
  project_name: z.string().max(50).nullable(),
  model_name: z.string().max(50).nullable(),
  input_tokens: z.int(),
  output_tokens: z.int(),
  cache_read_tokens: z.int(),
  cache_creation_tokens: z.int(),
  duration_ms: z.int(),
  cost_usd: z.int().nullable(),
});
export type RequestLogSubsetP = z.infer<typeof RequestLogSubsetP>;
export type RequestLogSubsetMapping = {
  A: RequestLogSubsetA;
  P: RequestLogSubsetP;
};
export const RequestLogSubsetKey = z.enum(["A", "P"]);
export type RequestLogSubsetKey = z.infer<typeof RequestLogSubsetKey>;

// Subsets: Token
export const TokenSubsetA = z.object({
  id: z.int(),
  created_at: z.date(),
  provider: z.string().max(20),
  credentials: TokenCredentials,
  name: z.string(),
  active: z.boolean(),
  ord: z.int(),
});
export type TokenSubsetA = z.infer<typeof TokenSubsetA>;
export type TokenSubsetMapping = {
  A: TokenSubsetA;
};
export const TokenSubsetKey = z.enum(["A"]);
export type TokenSubsetKey = z.infer<typeof TokenSubsetKey>;
