import { z } from "zod";

// ─── Query ───

export const Effort = z.enum(["low", "medium", "high"]);
export type Effort = z.infer<typeof Effort>;

export const QueryInput = z.object({
  system: z.string().optional(),
  prompt: z.string(),
  model: z.string().optional(),
  timeout: z.number().optional(),
  jsonSchema: z.string().optional(),
  effort: Effort.optional(),
  history: z.string().optional(),
  projectName: z.string().optional(),
});
export type QueryInput = z.infer<typeof QueryInput>;

export const CliResult = z.object({
  text: z.string(),
  tokenName: z.string().optional(),
  model: z.string().optional(),
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

// ─── Token Management ───

export const AddTokenInput = z.object({
  token: z.string(),
  name: z.string(),
});
export type AddTokenInput = z.infer<typeof AddTokenInput>;

export const RemoveTokenInput = z.object({
  token: z.string(),
});
export type RemoveTokenInput = z.infer<typeof RemoveTokenInput>;

export const TokenStats = z.object({
  token: z.string(),
  name: z.string(),
  provider: z.string(),
  requests: z.number(),
});
export type TokenStats = z.infer<typeof TokenStats>;

// ─── OAuth ───

export const OAuthStartResult = z.object({
  authUrl: z.string(),
});
export type OAuthStartResult = z.infer<typeof OAuthStartResult>;

const RateWindow = z
  .object({
    utilization: z.number().nullable(),
    resetsAt: z.string().nullable(),
  })
  .nullable();

export const UsageResponse = z.object({
  error: z.string().optional(),
  provider: z.string().optional(),
  fiveHour: RateWindow.optional(),
  sevenDay: RateWindow.optional(),
});
export type UsageResponse = z.infer<typeof UsageResponse>;

// ─── Health ───

export const SubscriberStatus = z.object({
  connected: z.boolean(),
  connectedAt: z.date().nullable(),
  lastReconcileAt: z.date().nullable(),
  attempt: z.number(),
});
export type SubscriberStatus = z.infer<typeof SubscriberStatus>;

export const HealthResponse = z.object({
  status: z.string(),
  activeTokens: z.number(),
  subscriber: SubscriberStatus.nullable(),
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
