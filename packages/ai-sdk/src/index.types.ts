export type QgridProviderConfig = {
  serverUrl?: string;
  defaultEffort?: string;
  /** request_logs.project_name. default: process.env.QGRID_PROJECT_NAME */
  projectName?: string;
};

/**
 * qgrid provider options.
 * providerOptions.qgrid 로 전달한다.
 */
export type QgridProviderOptions = {
  /**
   * 멀티턴 시 codex thread reuse를 위한 대화 식별자, 호출자가 자기 도메인 ID(예: 게임 세션 ID) 하나만 넘기면
   * provider가 같은 sessionKey 의 thread 좌표를 내부에서 회송해 prompt cache 를 적중시킨다
   * 좌표는 sessionKey 별로 격리된다.
   */
  sessionKey?: string;
  /** reasoning 모델의 추론 깊이. 기본값은 qgrid config의 defaultEffort. */
  effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  /** 응답 텍스트의 상세도. OpenAI/codex route에서만 적용된다. */
  verbosity?: "low" | "medium" | "high";
  /** reasoning 모델의 추론 요약 출력 방식. OpenAI/codex route에서만 적용된다. */
  reasoningSummary?: "auto" | "concise" | "detailed" | "none";
  /** OpenAI/codex service tier. OpenAI/codex route에서만 적용된다. */
  serviceTier?: string;
  /**
   * @todo 향후 qgrid 서버 fallback routing에 사용할 후보 모델 목록.
   * Claude Code가 처리하는 Fable 5 safety-refusal fallback과는 무관하다.
   */
  fallbackModels?: string[];
  /**
   * codex 내장 image_generation tool 을 켠다. OpenAI/codex route + non-stream 전용.
   * generateText 결과의 files 로 이미지를 받는다. streaming(streamText)에서는 거부된다.
   */
  imageGeneration?: boolean;
  /**
   * Image generation hint and cost-estimation basis. The image model is fixed
   * to gpt-image-2; qgrid accepts supported quality/size pairs from OpenAI's
   * public calculator table.
   */
  imageGenerationOptions?: {
    quality?: "low" | "medium" | "high";
    size?: "1024x1024" | "1024x1536" | "1536x1024";
  };
};

/**
 * codex thread 좌표
 * 멀티턴 대화에서 같은 대화를 같은 codex thread 로 라우팅 → conversation_id 고정 → 캐시 적중
 * provider 내부 threadCoordStore 가 sessionKey 별로 관리
 */
export type QgridThreadCoord = {
  workerId: number;
  threadId: string;
  epoch: number;
  systemHash: string;
};

export type QgridInputPart =
  | { type: "text"; text: string; text_elements: [] }
  | { type: "image"; url: string };

export type QgridSupportedModel =
  | "openai/gpt-5.6-sol"
  | "openai/gpt-5.6-terra"
  | "openai/gpt-5.6-luna"
  | "openai/gpt-5.5"
  | "openai/gpt-5.4"
  | "openai/gpt-5.2"
  | "openai/gpt-5.4-mini"
  | "openai/gpt-5.3-codex"
  | "openai/gpt-5.3-codex-spark"
  | "anthropic/claude-fable-5"
  | "anthropic/claude-haiku-4-5"
  | "anthropic/claude-sonnet-4"
  | "anthropic/claude-sonnet-4-5"
  | "anthropic/claude-sonnet-4-6"
  | "anthropic/claude-sonnet-4-7"
  | "anthropic/claude-sonnet-5"
  | "anthropic/claude-opus-4"
  | "anthropic/claude-opus-4-1"
  | "anthropic/claude-opus-4-5"
  | "anthropic/claude-opus-4-6"
  | "anthropic/claude-opus-4-7"
  | "anthropic/claude-opus-4-8";

// 아래 타입들은 Qgrid에서 생성된 type을 그대로 가져와서 사용합니다.
export type QueryOutput = {
  text: string;
  content?: Array<
    | { type: "text"; text: string }
    | { type: "tool-call"; toolCallId: string; toolName: string; input: string }
    | { type: "image"; data: string; revisedPrompt?: string | null }
  >;
  finishReason?: "stop" | "tool-calls";
  model: string;
  requestedModel?: string;
  modelFallbacks?: Array<{
    trigger: "refusal";
    fromModel: string;
    toModel: string;
    category?: string;
    explanation?: string;
  }>;
  tokenName?: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_creation_5m_input_tokens?: number;
    cache_creation_1h_input_tokens?: number;
    cache_read_input_tokens: number;
  };
  durationMs: number;
  costUsd: number;
  costSource: "provider" | "pricing_table" | "mixed";
  runContext?: { requestLogId?: number; threadCoord?: QgridThreadCoord };
};

export type CreateRunInput = {
  userPrompt: string;
  systemPrompt?: string;
  modelName?: string;
  effort?: string;
  projectName?: string;
  history?: string;
};

export type AppendStepInput = {
  requestLogId: number;
  stepIndex: number;
  type: "generate" | "tool_call";
  modelName?: string;
  requestedModelName?: string;
  fallbackCount?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  cacheCreation5mTokens?: number;
  cacheCreation1hTokens?: number;
  costUsd?: number;
  costSource?: "provider" | "pricing_table" | "mixed";
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
  /** qgrid 서버 주소. default: process.env.QGRID_URL, 없으면 기본값은 "http://localhost:44900" */
  serverUrl?: string;
  /**
   * 프로젝트 이름. default: process.env.QGRID_PROJECT_NAME, 없으면 기본값은 ""
   */
  projectName?: string;
  /**
   * 토큰 이름. 외부에서 호출할경우 기본값은 "external"
   */
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
  modelName?: string;
  requestedModelName?: string;
  fallbackCount?: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalCacheReadTokens?: number;
  totalCacheCreationTokens?: number;
  totalCacheCreation5mTokens?: number;
  totalCacheCreation1hTokens?: number;
  costUsd?: number;
  costSource?: "provider" | "pricing_table" | "mixed";
  totalDurationMs?: number;
  history?: string;
  errorMessage?: string;
};
