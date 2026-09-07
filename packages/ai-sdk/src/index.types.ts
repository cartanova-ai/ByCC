/**
 * OpenAI 경로(ChatGPT 구독 Codex 백엔드)의 reasoning effort. 백엔드 모델 카탈로그의
 * supported_reasoning_levels 합집합이며, 공개 OpenAI API 의 `none`/`minimal` 은 이 경로에 없다.
 * GPT-6 Astra와 GPT-5.6 Sol/Terra는 `ultra`, Luna는 `max`까지 지원한다.
 * 모델이 지원하지 않는 값은 서버가 조용히 무시한다.
 */
export type QgridOpenAIEffort = "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
/**
 * Anthropic 경로(Claude Code `--effort`)의 reasoning effort. 모델별 상한(예: Sonnet 4.6 은 `xhigh`
 * 없음)은 Claude Code 가 처리하고, 이 집합 밖의 값은 서버가 조용히 무시한다.
 */
export type QgridAnthropicEffort = "low" | "medium" | "high" | "xhigh" | "max";

export type QgridOpenAIModel = Extract<QgridSupportedModel, `openai/${string}`>;
export type QgridAnthropicModel = Extract<QgridSupportedModel, `anthropic/${string}`>;

type QgridCommonProviderConfig = {
  serverUrl?: string;
  /** request_logs.project_name. default: process.env.QGRID_PROJECT_NAME */
  projectName?: string;
};
export type QgridOpenAIProviderConfig = QgridCommonProviderConfig & {
  defaultEffort?: QgridOpenAIEffort;
};
export type QgridAnthropicProviderConfig = QgridCommonProviderConfig & {
  defaultEffort?: QgridAnthropicEffort;
};
/** `qgrid()` 는 모델 ID prefix 로 오버로드되므로 보통 provider 별 타입이 추론된다. */
export type QgridProviderConfig = QgridOpenAIProviderConfig | QgridAnthropicProviderConfig;

type QgridCommonProviderOptions = {
  /**
   * 이 요청을 처리할 활성 qgrid 토큰 이름. provider prefix를 포함해야 하며 다른 토큰으로 fallback하지 않는다.
   */
  tokenName?: string;
  /**
   * qgrid request log 저장 여부. 기본값은 true.
   * false여도 client tool 실행과 multi-step 연결은 계속 동작한다.
   */
  logger?: boolean;
  /**
   * @todo 향후 qgrid 서버 fallback routing에 사용할 후보 모델 목록.
   * Claude Code가 처리하는 Fable safety-refusal fallback과는 무관하다.
   */
  fallbackModels?: string[];
};

/** `providerOptions.qgrid` — OpenAI(Codex) 모델용. */
export type QgridOpenAIProviderOptions = QgridCommonProviderOptions & {
  /**
   * 멀티턴 프롬프트 캐시 어피니티용 대화 식별자, 호출자가 자기 도메인 ID(예: 게임 세션 ID) 하나만 넘기면
   * provider가 model+sessionKey에서 opaque cache affinity를 결정적으로 파생해 회송한다.
   * 원문 sessionKey는 서버에 전송하지 않으며 좌표는 model+sessionKey 별로 격리된다.
   */
  sessionKey?: string;
  /** reasoning 깊이. 기본값은 qgrid config의 defaultEffort. 모델이 지원하지 않는 값은 서버가 무시한다. */
  effort?: QgridOpenAIEffort;
  /** 응답 텍스트의 상세도. */
  verbosity?: "low" | "medium" | "high";
  /** reasoning 요약 출력 방식. */
  reasoningSummary?: "auto" | "concise" | "detailed" | "none";
  /** Codex service tier. */
  serviceTier?: string;
  /**
   * OpenAI Responses image_generation tool 을 켠다. non-stream 전용.
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

/** `providerOptions.qgrid` — Anthropic(Claude Code) 모델용. */
export type QgridAnthropicProviderOptions = QgridCommonProviderOptions & {
  /** reasoning 깊이. 기본값은 qgrid config의 defaultEffort. 집합 밖의 값은 서버가 무시한다. */
  effort?: QgridAnthropicEffort;
  /**
   * qgrid 서버의 provider 실행 제한(ms). Claude Code 프로세스 타이머로 사용되며, SDK의 non-stream
   * 요청별 HTTP headers/body timeout은 이 값보다 60초 길게 설정된다. AI SDK 표준 timeout은
   * provider에 숫자를 전달하지 않고 abortSignal로 변환되므로, 서버 측 제한을 바꾸려면 이 옵션을
   * 사용한다. 양의 정수만 허용하며 최대 30분, 기본 240초다.
   */
  timeoutMs?: number;
};

/**
 * `providerOptions.qgrid` 의 공용 타입. AI SDK 의 providerOptions 는 모델과 연결되지 않은 JSON
 * 레코드라 여기서는 두 provider 타입의 union 이다. provider 를 아는 호출자는
 * `QgridOpenAIProviderOptions` / `QgridAnthropicProviderOptions` 를 직접 쓰는 편이 정확하다.
 */
export type QgridProviderOptions = QgridOpenAIProviderOptions | QgridAnthropicProviderOptions;

/** SDK 내부용: 어느 provider 옵션이든 읽을 수 있게 합친 형태. 패키지 밖으로 내보내지 않는다. */
export type QgridResolvedProviderOptions = Omit<QgridOpenAIProviderOptions, "effort"> &
  Omit<QgridAnthropicProviderOptions, "effort"> & { effort?: string };

/**
 * OpenAI cache affinity 좌표(구 codex thread 좌표)
 * epoch=-1은 direct provider cache affinity 좌표다. workerId는 preferred token ID이고,
 * threadId는 opaque cache key다. epoch>=0은 이전 서버와의 wire compatibility를 위해 유지한다.
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
  | "openai/gpt-6-astra"
  | "openai/gpt-5.6-sol"
  | "openai/gpt-5.6-terra"
  | "openai/gpt-5.6-luna"
  | "openai/gpt-5.5"
  | "openai/gpt-5.4"
  | "openai/gpt-5.2"
  | "openai/gpt-5.4-mini"
  | "openai/gpt-5.3-codex"
  | "openai/gpt-5.3-codex-spark"
  | "anthropic/claude-fable-5-1"
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
  | "anthropic/claude-opus-4-8"
  | "anthropic/claude-opus-5";

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
    reasoning_tokens?: number;
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
  isStructured?: boolean;
  jsonSchema?: string | null;
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
  responseJsonOk?: boolean;
};
