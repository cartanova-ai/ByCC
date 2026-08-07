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
  z.object({
    type: z.literal("image"),
    // Codex image_generation result base64. qgrid 는 포맷/확장자 책임을 지지 않는다.
    data: z.string(),
    revisedPrompt: z.string().nullish(),
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

export const ImageGenerationQuality = z.enum(["low", "medium", "high"]);
export type ImageGenerationQuality = z.infer<typeof ImageGenerationQuality>;

export const ImageGenerationSize = z.enum(["1024x1024", "1024x1536", "1536x1024"]);
export type ImageGenerationSize = z.infer<typeof ImageGenerationSize>;

export const ImageGenerationOptions = z.object({
  quality: ImageGenerationQuality.optional(),
  size: ImageGenerationSize.optional(),
});
export type ImageGenerationOptions = z.infer<typeof ImageGenerationOptions>;

export const QgridInputPart = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text"),
    text: z.string(),
    text_elements: z.array(z.never()).default([]),
  }),
  z.object({
    type: z.literal("image"),
    url: z.string(),
  }),
]);
export type QgridInputPart = z.infer<typeof QgridInputPart>;

export const MAX_QUERY_TIMEOUT_MS = 30 * 60_000;
export const QueryTimeoutMs = z.number().int().positive().max(MAX_QUERY_TIMEOUT_MS);

// ─── Run Lifecycle Context (SDK ↔ Server contract) ───

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
  // tool-call run을 계속할 때만 발급. 일반 대화는 threadCoord 만 왕복.
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

export const QueryInput = z.looseObject({
  system: z.string().optional(),
  prompt: z.string(),
  input: z.array(QgridInputPart).optional(),
  model: z.string().optional(),
  timeout: QueryTimeoutMs.optional(),
  jsonSchema: z.string().optional(),
  tools: z.array(QgridTool).optional(),
  effort: z.string().optional(),
  verbosity: Verbosity.optional(),
  reasoningSummary: ReasoningSummary.optional(),
  serviceTier: ServiceTier.optional(),
  history: z.string().optional(),
  projectName: z.string().optional(),
  // 생략하면 로깅한다. false는 request log 쓰기만 끄고 dispatch/thread는 유지한다.
  logger: z.boolean().optional(),
  runContext: QgridRunContext.optional(),
  toolResults: z.array(QgridToolResultInput).optional(),
  // codex 내장 image_generation tool 을 켠다(OpenAI 경로 전용, opt-in, non-stream).
  imageGeneration: z.boolean().optional(),
  // qgrid 가격 추정 및 Codex 이미지 요청 힌트. 이미지 모델은 gpt-image-2 로 고정 가정한다.
  imageGenerationOptions: ImageGenerationOptions.optional(),
});
export type QueryInput = z.infer<typeof QueryInput>;

export const ModelFallback = z.object({
  trigger: z.literal("refusal"),
  fromModel: z.string(),
  toModel: z.string(),
  category: z.string().optional(),
  explanation: z.string().optional(),
});
export type ModelFallback = z.infer<typeof ModelFallback>;

export const CostSource = z.enum(["provider", "pricing_table", "mixed"]);
export type CostSource = z.infer<typeof CostSource>;

export const QueryOutput = z.object({
  text: z.string(),
  content: z.array(QgridContent),
  finishReason: FinishReason,
  tokenName: z.string().optional(),
  model: z.string().optional(),
  requestedModel: z.string().optional(),
  modelFallbacks: z.array(ModelFallback).optional(),
  usage: z.object({
    input_tokens: z.number(),
    output_tokens: z.number(),
    cache_creation_input_tokens: z.number(),
    cache_creation_5m_input_tokens: z.number().optional(),
    cache_creation_1h_input_tokens: z.number().optional(),
    cache_read_input_tokens: z.number(),
  }),
  durationMs: z.number(),
  ttftMs: z.number(),
  costUsd: z.number(),
  costSource: CostSource,
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
    requestedModel: z.string().optional(),
    modelFallbacks: z.array(ModelFallback).optional(),
    tokenName: z.string().optional(),
    finishReason: FinishReason,
    usage: z.object({
      input_tokens: z.number(),
      output_tokens: z.number(),
      cache_creation_input_tokens: z.number(),
      cache_creation_5m_input_tokens: z.number().optional(),
      cache_creation_1h_input_tokens: z.number().optional(),
      cache_read_input_tokens: z.number(),
    }),
    durationMs: z.number(),
    ttftMs: z.number(),
    costUsd: z.number(),
    costSource: CostSource,
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
  modelName: z.string().optional(),
  requestedModelName: z.string().optional(),
  fallbackCount: z.number().optional(),
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  cacheReadTokens: z.number().optional(),
  cacheCreationTokens: z.number().optional(),
  cacheCreation5mTokens: z.number().optional(),
  cacheCreation1hTokens: z.number().optional(),
  costUsd: z.number().optional(),
  costSource: CostSource.optional(),
  durationMs: z.number().optional(),
  ttftMs: z.number().nullable().optional(),
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
  modelName: z.string().optional(),
  requestedModelName: z.string().optional(),
  fallbackCount: z.number().optional(),
  totalInputTokens: z.number().optional(),
  totalOutputTokens: z.number().optional(),
  totalCacheReadTokens: z.number().optional(),
  totalCacheCreationTokens: z.number().optional(),
  totalCacheCreation5mTokens: z.number().optional(),
  totalCacheCreation1hTokens: z.number().optional(),
  costUsd: z.number().optional(),
  costSource: CostSource.optional(),
  totalDurationMs: z.number().optional(),
  history: z.string().optional(),
  errorMessage: z.string().optional(),
});
export type FinishRunInput = z.infer<typeof FinishRunInput>;

// ─── Token Management ───

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
  // redirect: 브라우저 자동 복귀(루프백 접속). code: 콘솔 콜백 + 코드 붙여넣기(원격 접속).
  // OpenAI 경로는 codex 가 콜백을 처리하므로 항상 redirect 를 반환한다.
  mode: z.enum(["redirect", "code"]),
});
export type OAuthStartResult = z.infer<typeof OAuthStartResult>;

const RateWindow = z
  .object({
    utilization: z.number().nullable(),
    resetsAt: z.string().nullable(),
    windowDurationMins: z.number().nullable().optional(),
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
export class QuotaThresholdExceededError extends Error {
  readonly code = "QUOTA_THRESHOLD_EXCEEDED" as const;
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
