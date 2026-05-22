export type QgridProviderConfig = {
  serverUrl?: string;
  defaultEffort?: string;
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
  | "anthropic/claude-sonnet-4.5"
  | "anthropic/claude-sonnet-4.6"
  | "anthropic/claude-sonnet-4.7"
  | "anthropic/claude-opus-4"
  | "anthropic/claude-opus-4.1"
  | "anthropic/claude-opus-4.5"
  | "anthropic/claude-opus-4.6"
  | "anthropic/claude-opus-4.7"
  | (string & {});

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
  serverUrl: string;
  projectName?: string;
  tokenName?: string;
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
