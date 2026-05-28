export type QgridProviderConfig = {
  serverUrl?: string;
  defaultEffort?: string;
};

/**
 * codex app-server가 지원하는 OpenAI provider options.
 *
 * AI SDK의 openai provider options 중 codex가 처리할 수 있는 subset만 정의.
 * 여기에 없는 옵션(temperature, maxOutputTokens 등)은 codex가 무시합니다.
 *
 * @see https://ai-sdk.dev/providers/ai-sdk-providers/openai#provider-options
 */
type QgridOpenAIProviderOptions = {
  /** reasoning 모델의 추론 깊이. 기본값은 qgrid config의 defaultEffort. */
  reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
  /** reasoning 모델의 추론 요약 출력 방식. Responses API 전용. */
  reasoningSummary?: "auto" | "concise" | "detailed" | "none";
  /** 응답 텍스트의 상세도. */
  textVerbosity?: "low" | "medium" | "high";
};

/**
 * {@link QgridOpenAIProviderOptions}
 */
export type QgridProviderOptions = {
  openai?: QgridOpenAIProviderOptions;
};

export type QgridSupportedModel =
  | "openai/gpt-5.5"
  | "openai/gpt-5.4"
  | "openai/gpt-5.2"
  | "openai/gpt-5.4-mini"
  | "openai/gpt-5.3-codex"
  | "openai/gpt-5.3-codex-spark"
  | "anthropic/claude-haiku-4-5"
  | "anthropic/claude-sonnet-4"
  | "anthropic/claude-sonnet-4-5"
  | "anthropic/claude-sonnet-4-6"
  | "anthropic/claude-sonnet-4-7"
  | "anthropic/claude-opus-4"
  | "anthropic/claude-opus-4-1"
  | "anthropic/claude-opus-4-5"
  | "anthropic/claude-opus-4-6"
  | "anthropic/claude-opus-4-7";

// 아래 타입들은 Qgrid에서 생성된 type을 그대로 가져와서 사용합니다.
export type QueryOutput = {
  text: string;
  content?: Array<
    | { type: "text"; text: string }
    | { type: "tool-call"; toolCallId: string; toolName: string; input: string }
  >;
  finishReason?: "stop" | "tool-calls";
  model: string;
  tokenName?: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
  };
  durationMs: number;
  costUsd: number;
  runContext?: { requestLogId: number };
};

export type CreateRunInput = {
  userPrompt: string;
  systemPrompt?: string;
  modelName?: string;
  effort?: string;
  projectName?: string;
};

export type AppendStepInput = {
  requestLogId: number;
  stepIndex: number;
  type: "generate" | "tool_call";
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  durationMs?: number;
  finishReason?: string;
  reasoningText?: string;
  reasoningTokens?: number;
  toolCallIndex?: number;
  toolCallId?: string;
  toolName?: string;
  toolArgs?: string;
  toolResult?: string;
  toolDurationMs?: number;
  error?: string;
};

export type QgridLoggerConfig = {
  /** qgrid 서버 주소. 기본값: QGRID_URL 환경변수 또는 http://localhost:44900 */
  serverUrl?: string;
  projectName?: string;
  tokenName?: string;
  /**
   * Fallback timeout for runs that receive onStart but never receive onFinish.
   * AI SDK TelemetryIntegration does not expose an error hook, so provider
   * failures before a final step can otherwise leave request logs running.
   *
   * Set to 0 to disable. Defaults to 30 minutes, or the AI SDK total timeout
   * plus a short grace period when one is provided.
   */
  staleRunTimeoutMs?: number;
  /**
   * Receives qgrid logging failures. When reusing one logger integration across
   * overlapping AI SDK calls, pass a unique `metadata.qgridRunId` per call so
   * lifecycle events can be attributed to the correct run.
   */
  onLogError?: (error: Error) => void;
};

export type FinishRunInput = {
  requestLogId: number;
  status: "succeeded" | "error" | "aborted";
  response?: string;
  tokenName?: string;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalCacheReadTokens?: number;
  totalCacheCreationTokens?: number;
  totalDurationMs?: number;
  history?: string;
  errorMessage?: string;
};
