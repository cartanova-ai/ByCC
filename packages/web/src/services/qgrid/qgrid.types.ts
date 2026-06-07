/**
 * @generated
 * API에서 동기화된 파일입니다. 직접 수정하지 마세요.
 */

import { z } from "zod";

// ─── Query ───

export const Effort = z.enum(["low", "medium", "high"]);
export type Effort = z.infer<typeof Effort>;

export const QgridTool = z.object({
  name: z.string(),
  description: z.string().optional(),
  inputSchema: z.unknown(),
});
export type QgridTool = z.infer<typeof QgridTool>;

export const QgridContent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text"),
    text: z.string(),
  }),
  z.object({
    type: z.literal("tool-call"),
    toolCallId: z.string(),
    toolName: z.string(),
    input: z.string(),
  }),
]);
export type QgridContent = z.infer<typeof QgridContent>;

export const FinishReason = z.enum(["stop", "tool-calls"]);
export type FinishReason = z.infer<typeof FinishReason>;

export const Verbosity = z.enum(["low", "medium", "high"]);
export type Verbosity = z.infer<typeof Verbosity>;

export const ReasoningSummary = z.enum(["auto", "concise", "detailed", "none"]);
export type ReasoningSummary = z.infer<typeof ReasoningSummary>;

export const ServiceTier = z.enum(["fast", "flex"]);
export type ServiceTier = z.infer<typeof ServiceTier>;

// ─── Run Lifecycle Context (SDK ↔ Server contract) ───

export const QgridLogMode = z.enum(["auto", "run", "none"]);
export type QgridLogMode = z.infer<typeof QgridLogMode>;

// codex thread 좌표. thread 재사용으로 conversation_id(=prompt_cache_key)를 고정해
// OpenAI prompt caching 을 살리기 위한 핸들. 서버가 발급하고 클라가 다음 요청에 그대로 회송한다.
// 핸들 미전송 시 기존 "매 turn 새 thread + history inject" 동작으로 폴백(QgridRunContext 참조).
export const QgridThreadCoord = z.object({
  workerId: z.number(), // 고정 라우팅 (thread 는 worker 프로세스 메모리에만 존재)
  threadId: z.string(), // codex conversation_id = prompt_cache_key
  epoch: z.number(), // worker spawn 카운터. restart 로 thread 증발 감지
  systemHash: z.string(), // system_prompt 해시. 다른 대화 오접속 방지
});
export type QgridThreadCoord = z.infer<typeof QgridThreadCoord>;

export const QgridRunContext = z.object({
  // run lifecycle(logMode="run") 에서만 발급. auto 모드(예: IF)는 threadCoord 만 왕복.
  requestLogId: z.number().optional(),
  threadCoord: QgridThreadCoord.optional(),
});
export type QgridRunContext = z.infer<typeof QgridRunContext>;

export const QgridToolResultInput = z.object({
  toolCallId: z.string(),
  toolName: z.string().optional(),
  output: z.string(),
  isError: z.boolean().optional(),
});
export type QgridToolResultInput = z.infer<typeof QgridToolResultInput>;

export const QueryInput = z.object({
  system: z.string().optional(),
  prompt: z.string(),
  model: z.string().optional(),
  timeout: z.number().optional(),
  jsonSchema: z.string().optional(),
  tools: z.array(QgridTool).optional(),
  effort: z.string().optional(),
  verbosity: Verbosity.optional(),
  reasoningSummary: ReasoningSummary.optional(),
  serviceTier: ServiceTier.optional(),
  history: z.string().optional(),
  projectName: z.string().optional(),
  isStep: z.boolean().optional(),
  logMode: QgridLogMode.optional(),
  runContext: QgridRunContext.optional(),
  toolResults: z.array(QgridToolResultInput).optional(),
});
export type QueryInput = z.infer<typeof QueryInput>;

export const QueryOutput = z.object({
  text: z.string(),
  content: z.array(QgridContent),
  finishReason: FinishReason,
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
  runContext: QgridRunContext.optional(),
});
export type QueryOutput = z.infer<typeof QueryOutput>;

// ─── Stream Events ───

export const StreamEvents = z.object({
  delta: z.object({ text: z.string() }),
  toolCall: z.object({
    toolCallId: z.string(),
    toolName: z.string(),
    input: z.string(),
  }),
  done: z.object({
    text: z.string(),
    model: z.string().optional(),
    tokenName: z.string().optional(),
    finishReason: FinishReason,
    usage: z.object({
      input_tokens: z.number(),
      output_tokens: z.number(),
      cache_creation_input_tokens: z.number(),
      cache_read_input_tokens: z.number(),
    }),
    durationMs: z.number(),
    costUsd: z.number(),
    content: z.array(QgridContent),
    runContext: QgridRunContext.optional(),
  }),
  error: z.object({ message: z.string() }),
});
export type StreamEvents = z.infer<typeof StreamEvents>;

// ─── Run Lifecycle ───

export const CreateRunInput = z.object({
  userPrompt: z.string(),
  systemPrompt: z.string().optional(),
  modelName: z.string().optional(),
  effort: z.string().optional(),
  projectName: z.string().optional(),
  history: z.string().optional(),
});
export type CreateRunInput = z.infer<typeof CreateRunInput>;

export const AppendStepInput = z.object({
  requestLogId: z.number(),
  stepIndex: z.number(),
  type: z.enum(["generate", "tool_call"]),
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  cacheReadTokens: z.number().optional(),
  cacheCreationTokens: z.number().optional(),
  durationMs: z.number().optional(),
  finishReason: z.string().optional(),
  reasoningText: z.string().optional(),
  reasoningTokens: z.number().optional(),
  toolCallIndex: z.number().optional(),
  toolCallId: z.string().optional(),
  toolName: z.string().optional(),
  toolArgs: z.string().optional(),
  toolResult: z.string().optional(),
  toolDurationMs: z.number().optional(),
  error: z.string().optional(),
});
export type AppendStepInput = z.infer<typeof AppendStepInput>;

export const FinishRunInput = z.object({
  requestLogId: z.number(),
  status: z.enum(["succeeded", "error", "aborted"]),
  response: z.string().optional(),
  tokenName: z.string().optional(),
  totalInputTokens: z.number().optional(),
  totalOutputTokens: z.number().optional(),
  totalCacheReadTokens: z.number().optional(),
  totalCacheCreationTokens: z.number().optional(),
  totalDurationMs: z.number().optional(),
  history: z.string().optional(),
  errorMessage: z.string().optional(),
});
export type FinishRunInput = z.infer<typeof FinishRunInput>;

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
