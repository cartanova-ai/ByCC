/**
 * ProviderDispatcher — provider 별 LLM 요청 실행 인터페이스.
 *
 * MVP 에서는 stream() 만. getRateLimits(), listModels() 는 future.
 */

export interface GenerateRequest {
  model: string;
  input: Array<{ type: string; text: string }>;
  systemPrompt?: string;
  outputSchema?: unknown;
  effort?: string;
  history?: unknown[];
  abortSignal?: AbortSignal;
}

export interface GenerateResult {
  text: string;
  tokenName: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    reasoningOutputTokens: number;
  };
  durationMs: number;
  model: string;
}

export interface ProviderDispatcher {
  generate(req: GenerateRequest): Promise<GenerateResult>;
  start(): Promise<void>;
  stop(): Promise<void>;
}
