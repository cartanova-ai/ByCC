/**
 * ProviderDispatcher — provider 별 LLM 요청 실행 인터페이스.
 *
 * MVP 에서는 stream() 만. getRateLimits(), listModels() 는 future.
 */

import { type JsonValue } from "../../../codex-protocol/serde_json/JsonValue";
import { type TokenUsageBreakdown } from "../../../codex-protocol/v2/TokenUsageBreakdown";
import { type UserInput } from "../../../codex-protocol/v2/UserInput";

export interface GenerateRequest {
  model: string;
  input: Array<UserInput>;
  systemPrompt?: string;
  outputSchema?: JsonValue;
  effort?: string;
  verbosity?: string;
  reasoningSummary?: string;
  serviceTier?: string;
  history?: Array<JsonValue>;
  abortSignal?: AbortSignal;
}

export interface GenerateResult {
  text: string;
  tokenName: string;
  usage: TokenUsageBreakdown;
  durationMs: number;
  model: string;
}

export interface ProviderDispatcher {
  generate(req: GenerateRequest): Promise<GenerateResult>;
  start(): Promise<void>;
  stop(): Promise<void>;
}
