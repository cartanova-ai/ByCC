/**
 * @generated
 * API에서 동기화된 파일입니다. 직접 수정하지 마세요.
 */
import { z } from "zod";

// ─── Query ───

export const QueryInput = z.object({
  system: z.string().optional(),
  prompt: z.string(),
  timeout: z.number().optional(),
});
export type QueryInput = z.infer<typeof QueryInput>;

export const CliResult = z.object({
  text: z.string(),
  usage: z.object({
    input_tokens: z.number(),
    output_tokens: z.number(),
    cache_creation_input_tokens: z.number(),
    cache_read_input_tokens: z.number(),
  }),
  durationMs: z.number(),
  costUsd: z.number(),
});
export type CliResult = z.infer<typeof CliResult>;

// ─── Pool Config ───

export const PoolConfig = z.object({
  tokens: z.array(z.string()),
  size: z.number().optional(),
  model: z.string().optional(),
  timeout: z.number().optional(),
  cwd: z.string().optional(),
  maxCalls: z.number().optional(),
});
export type PoolConfig = z.infer<typeof PoolConfig>;

// ─── Token Management ───

export const AddTokenInput = z.object({
  token: z.string(),
  name: z.string().optional(),
});
export type AddTokenInput = z.infer<typeof AddTokenInput>;

export const RemoveTokenInput = z.object({
  token: z.string(),
});
export type RemoveTokenInput = z.infer<typeof RemoveTokenInput>;

export const TokenStats = z.object({
  token: z.string(),
  name: z.string().optional(),
  requests: z.number(),
  active: z.boolean(),
});
export type TokenStats = z.infer<typeof TokenStats>;

// ─── Health ───

export const HealthResponse = z.object({
  status: z.string(),
  workers: z.number(),
  activeTokens: z.number(),
  tokenDir: z.string(),
});
export type HealthResponse = z.infer<typeof HealthResponse>;

// ─── Errors ───

export class QuotaError extends Error {
  readonly code = "QUOTA_EXHAUSTED" as const;
}
export class TimeoutError extends Error {
  readonly code = "TIMEOUT" as const;
}
export class ProcessError extends Error {
  readonly code = "PROCESS_ERROR" as const;
}

// ─── Utils ───

export function maskToken(token: string): string {
  return token.length > 4 ? `...${token.slice(-4)}` : token;
}
