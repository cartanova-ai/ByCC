import os from "node:os";

import { type OpenAIEffort } from "../common/effort";

export const CHATGPT_CODEX_RESPONSES_URL =
  "https://chatgpt.com/backend-api/codex/responses" as const;

export const CODEX_CLI_ORIGINATOR = "codex_cli_rs" as const;
export const CODEX_CLI_VERSION = "0.147.0" as const;

export interface CodexUserAgentPlatform {
  osType: string;
  osVersion: string;
  architecture: string;
  terminal: string;
}

function codexPlatform(): CodexUserAgentPlatform {
  const names: Partial<Record<NodeJS.Platform, string>> = {
    darwin: "Mac OS",
    linux: "Linux",
    win32: "Windows",
  };
  const terminal = process.env.TERM_PROGRAM;
  const terminalVersion = process.env.TERM_PROGRAM_VERSION;
  return {
    osType: names[process.platform] ?? process.platform,
    osVersion: os.release(),
    architecture: process.arch,
    terminal: terminal ? `${terminal}${terminalVersion ? `/${terminalVersion}` : ""}` : "unknown",
  };
}

/** Matches the platform/terminal suffix emitted by the pinned Rust Codex CLI. */
export function codexCliUserAgent(platform: CodexUserAgentPlatform = codexPlatform()): string {
  return `codex_cli_rs/${CODEX_CLI_VERSION} (${platform.osType} ${platform.osVersion}; ${platform.architecture}) ${platform.terminal}`;
}

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/** Raw Responses API items. Keeping these opaque preserves the complete conversation history. */
export type OpenAIResponseItem = Record<string, unknown>;

export interface OpenAIOutputSchema {
  name?: string;
  schema: JsonValue;
}

export interface OpenAIResponsesOptions {
  model: string;
  instructions?: string;
  history: readonly OpenAIResponseItem[];
  tools?: readonly OpenAIResponseItem[];
  toolChoice?: string | OpenAIResponseItem;
  parallelToolCalls?: boolean;
  reasoning?: {
    effort?: OpenAIEffort;
    summary?: "auto" | "concise" | "detailed";
  };
  verbosity?: "low" | "medium" | "high";
  serviceTier?: string;
  promptCacheKey?: string;
  outputSchema?: OpenAIOutputSchema;
  imageGeneration?: boolean | OpenAIResponseItem;
}

export interface OpenAIResponsesRequest {
  model: string;
  instructions?: string;
  input: OpenAIResponseItem[];
  tools?: OpenAIResponseItem[];
  tool_choice: string | OpenAIResponseItem;
  parallel_tool_calls: boolean;
  reasoning: OpenAIResponsesOptions["reasoning"] | null;
  store: false;
  stream: true;
  include: string[];
  service_tier?: string;
  prompt_cache_key?: string;
  text?: {
    verbosity?: "low" | "medium" | "high";
    format?: {
      type: "json_schema";
      strict: true;
      schema: JsonValue;
      name: string;
    };
  };
}

export function buildOpenAIResponsesRequest(
  options: OpenAIResponsesOptions,
): OpenAIResponsesRequest {
  const tools = options.tools ? [...options.tools] : [];
  if (options.imageGeneration) {
    tools.push(
      options.imageGeneration === true
        ? { type: "image_generation" }
        : { type: "image_generation", ...options.imageGeneration },
    );
  }

  const text =
    options.verbosity || options.outputSchema
      ? {
          ...(options.verbosity ? { verbosity: options.verbosity } : {}),
          ...(options.outputSchema
            ? {
                format: {
                  type: "json_schema" as const,
                  strict: true as const,
                  schema: options.outputSchema.schema,
                  name: options.outputSchema.name ?? "codex_output_schema",
                },
              }
            : {}),
        }
      : undefined;

  return {
    model: options.model,
    ...(options.instructions ? { instructions: options.instructions } : {}),
    // Copy the array, not its items: raw items must arrive byte-for-byte equivalent.
    input: [...options.history],
    ...(tools.length ? { tools } : {}),
    tool_choice: options.toolChoice ?? "auto",
    parallel_tool_calls: options.parallelToolCalls ?? true,
    reasoning: options.reasoning ?? null,
    store: false,
    stream: true,
    include: ["reasoning.encrypted_content"],
    ...(options.serviceTier ? { service_tier: options.serviceTier } : {}),
    ...(options.promptCacheKey ? { prompt_cache_key: options.promptCacheKey } : {}),
    ...(text ? { text } : {}),
  };
}

export function buildCodexIdentityHeaders(
  accessToken: string,
  accountId: string,
  correlation?: { sessionId?: string; threadId?: string; clientRequestId?: string },
): Record<string, string> {
  return {
    Accept: "text/event-stream",
    Authorization: `Bearer ${accessToken}`,
    "ChatGPT-Account-ID": accountId,
    "Content-Type": "application/json",
    originator: CODEX_CLI_ORIGINATOR,
    "User-Agent": codexCliUserAgent(),
    ...(correlation?.sessionId ? { "session-id": correlation.sessionId } : {}),
    ...(correlation?.threadId ? { "thread-id": correlation.threadId } : {}),
    ...(correlation?.clientRequestId ? { "x-client-request-id": correlation.clientRequestId } : {}),
  };
}

export interface OpenAIUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
}

export type OpenAINormalizedEvent =
  | { type: "created"; responseId?: string }
  | { type: "text-delta"; text: string }
  | { type: "image"; id?: string; base64: string; mimeType: "image/png"; revisedPrompt?: string }
  | { type: "output-item"; item: OpenAIResponseItem }
  | { type: "completed"; responseId: string; usage?: OpenAIUsage; model?: string }
  | { type: "error"; error: OpenAIProtocolError };

export class OpenAIProtocolError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
    public readonly status?: number,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "OpenAIProtocolError";
  }
}

function usageFrom(value: unknown): OpenAIUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const usage = value as Record<string, unknown>;
  const inputDetails = (usage.input_tokens_details ?? {}) as Record<string, unknown>;
  const outputDetails = (usage.output_tokens_details ?? {}) as Record<string, unknown>;
  return {
    inputTokens: Number(usage.input_tokens ?? 0),
    cachedInputTokens: Number(inputDetails.cached_tokens ?? 0),
    outputTokens: Number(usage.output_tokens ?? 0),
    reasoningTokens: Number(outputDetails.reasoning_tokens ?? 0),
    totalTokens: Number(usage.total_tokens ?? 0),
  };
}

export function normalizeOpenAIEvent(raw: unknown): OpenAINormalizedEvent | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const event = raw as Record<string, unknown>;
  const type = String(event.type ?? "");
  if (type === "response.created") {
    const response = event.response as Record<string, unknown> | undefined;
    return { type: "created", ...(response?.id ? { responseId: String(response.id) } : {}) };
  }
  if (type === "response.output_text.delta" && typeof event.delta === "string") {
    return { type: "text-delta", text: event.delta };
  }
  if (
    (type === "response.output_item.added" || type === "response.output_item.done") &&
    event.item &&
    typeof event.item === "object"
  ) {
    const item = event.item as OpenAIResponseItem;
    if (item.type === "image_generation_call" && typeof item.result === "string") {
      return {
        type: "image",
        ...(typeof item.id === "string" ? { id: item.id } : {}),
        base64: item.result,
        mimeType: "image/png",
        ...(typeof item.revised_prompt === "string"
          ? { revisedPrompt: item.revised_prompt }
          : typeof item.revisedPrompt === "string"
            ? { revisedPrompt: item.revisedPrompt }
            : {}),
      };
    }
    return { type: "output-item", item };
  }
  if (type === "response.completed") {
    const response = (event.response ?? {}) as Record<string, unknown>;
    return {
      type: "completed",
      responseId: String(response.id ?? ""),
      ...(response.usage ? { usage: usageFrom(response.usage) } : {}),
      ...(typeof response.model === "string" ? { model: response.model } : {}),
    };
  }
  if (type === "error" || type === "response.failed" || type === "response.incomplete") {
    const source = (event.error ?? event.response ?? event) as Record<string, unknown>;
    const nested = (source.error ?? source) as Record<string, unknown>;
    return {
      type: "error",
      error: new OpenAIProtocolError(
        String(nested.message ?? `OpenAI stream ended with ${type}`),
        typeof nested.code === "string" ? nested.code : undefined,
      ),
    };
  }
  return undefined;
}
