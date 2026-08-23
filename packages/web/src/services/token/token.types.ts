/**
 * @generated
 * API에서 동기화된 파일입니다. 직접 수정하지 마세요.
 */

import { z } from "zod";

import { TokenBaseListParams, TokenBaseSchema } from "../sonamu.generated";

// ── Credentials JSONB schema (Sonamu json prop 의 id: "TokenCredentials" 가 참조) ──

export const AnthropicCredentials = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresAt: z.number(),
  accountUuid: z.string(),
});
export type AnthropicCredentials = z.infer<typeof AnthropicCredentials>;

export const OpenAICredentials = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  idToken: z.string().optional(),
  accessTokenExpiresAt: z.number(),
  idTokenExpiresAt: z.number().optional(),
  accountId: z.string(),
  planType: z.string().optional(),
});
export type OpenAICredentials = z.infer<typeof OpenAICredentials>;

export const TokenCredentials = z.union([AnthropicCredentials, OpenAICredentials]);
export type TokenCredentials = z.infer<typeof TokenCredentials>;

// Token - ListParams
export const TokenListParams = TokenBaseListParams;
export type TokenListParams = z.infer<typeof TokenListParams>;

const TokenQuotaThreshold = z.int().min(1).max(100).nullable();
const TokenWeight = z.int().min(1).max(100);

// Token - SaveParams
export const TokenSaveParams = TokenBaseSchema.partial({
  id: true,
  created_at: true,
  active: true,
  ord: true,
  quota_threshold: true,
  weight: true,
  keepalive_enabled: true,
}).extend({
  quota_threshold: TokenQuotaThreshold.optional(),
  weight: TokenWeight.optional(),
});
export type TokenSaveParams = z.infer<typeof TokenSaveParams>;
