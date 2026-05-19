/**
 * @cartanova/qgrid-ai-sdk — AI SDK LanguageModelV3 provider for qgrid.
 *
 * Usage:
 *   import { qgrid } from "@cartanova/qgrid-ai-sdk";
 *   const result = await generateText({
 *     model: qgrid("openai/gpt-5.5"),
 *     prompt: "Hello",
 *   });
 */
import {
  type LanguageModelV3,
  type LanguageModelV3CallOptions,
  type LanguageModelV3Content,
  type LanguageModelV3FinishReason,
  type LanguageModelV3FunctionTool,
  type LanguageModelV3GenerateResult,
  type LanguageModelV3Message,
  type LanguageModelV3StreamPart,
  type LanguageModelV3StreamResult,
  type LanguageModelV3Usage,
} from "@ai-sdk/provider";

export interface QgridProviderConfig {
  serverUrl?: string;
  defaultEffort?: string;
}

const DEFAULT_SERVER_URL = "http://localhost:44900";
const DEFAULT_EFFORT = "low";

export function qgrid(modelId: string, config?: QgridProviderConfig): LanguageModelV3 {
  const serverUrl = config?.serverUrl ?? process.env.QGRID_URL ?? DEFAULT_SERVER_URL;
  const effort = config?.defaultEffort ?? DEFAULT_EFFORT;

  const model: LanguageModelV3 = {
    specificationVersion: "v3",
    provider: "qgrid",
    modelId,
    supportedUrls: {},

    async doGenerate(options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
      const tools = options.tools?.filter(
        (t): t is LanguageModelV3FunctionTool => t.type === "function",
      );

      let outputSchema: unknown;
      let isToolCallMode = false;

      if (tools && tools.length > 0) {
        outputSchema = buildToolCallSchema(tools);
        isToolCallMode = true;
      }

      const body = {
        prompt: promptToText(options.prompt),
        model: modelId,
        system: extractSystemPrompt(options.prompt),
        effort,
        ...(outputSchema ? { jsonSchema: JSON.stringify(outputSchema) } : {}),
      };

      const res = await fetch(`${serverUrl}/api/qgrid/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: options.abortSignal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`qgrid ${res.status}: ${text}`);
      }

      const data = (await res.json()) as {
        text: string;
        model: string;
        usage: {
          input_tokens: number;
          output_tokens: number;
          cache_creation_input_tokens: number;
          cache_read_input_tokens: number;
        };
        durationMs: number;
      };

      const content: LanguageModelV3Content[] = [];
      let finishReason: LanguageModelV3FinishReason = {
        unified: "stop",
        raw: "stop",
      };

      if (isToolCallMode) {
        try {
          const parsed = JSON.parse(data.text) as {
            action: string;
            answer?: string | null;
            toolCalls?: Array<{ toolName: string; args: Record<string, unknown> }> | null;
          };

          if (parsed.action === "tool_call" && parsed.toolCalls) {
            for (const tc of parsed.toolCalls) {
              content.push({
                type: "tool-call",
                toolCallId: `call_${Math.random().toString(36).slice(2, 10)}`,
                toolName: tc.toolName,
                input: JSON.stringify(tc.args),
              });
            }
            finishReason = { unified: "tool-calls", raw: "tool_call" };
          } else {
            content.push({ type: "text", text: parsed.answer ?? data.text });
          }
        } catch {
          content.push({ type: "text", text: data.text });
        }
      } else {
        content.push({ type: "text", text: data.text });
      }

      const usage: LanguageModelV3Usage = {
        inputTokens: {
          total: data.usage.input_tokens,
          noCache: data.usage.input_tokens - data.usage.cache_read_input_tokens,
          cacheRead: data.usage.cache_read_input_tokens,
          cacheWrite: data.usage.cache_creation_input_tokens,
        },
        outputTokens: {
          total: data.usage.output_tokens,
          text: data.usage.output_tokens,
          reasoning: undefined,
        },
      };

      return {
        content,
        finishReason,
        usage,
        warnings: [],
        response: { modelId: data.model },
      };
    },

    async doStream(options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
      const result = await model.doGenerate(options);

      const parts: LanguageModelV3StreamPart[] = [];
      for (const item of result.content) {
        if (item.type === "text") {
          const id = `text_${Math.random().toString(36).slice(2, 10)}`;
          parts.push({ type: "text-start", id });
          parts.push({ type: "text-delta", id, delta: item.text });
          parts.push({ type: "text-end", id });
        } else if (item.type === "tool-call") {
          const id = item.toolCallId;
          parts.push({ type: "tool-input-start", id, toolName: item.toolName });
          parts.push({ type: "tool-input-delta", id, delta: item.input });
          parts.push({ type: "tool-input-end", id });
        }
      }

      const stream = new ReadableStream<LanguageModelV3StreamPart>({
        start(controller) {
          for (const part of parts) {
            controller.enqueue(part);
          }
          controller.close();
        },
      });

      return {
        stream,
        response: result.response,
      };
    },
  };

  return model;
}

// ── Tool call emulation schema ──────────────────────────────────────

function buildToolCallSchema(tools: LanguageModelV3FunctionTool[]): Record<string, unknown> {
  const toolBranches = tools.map((tool) => ({
    type: "object" as const,
    properties: {
      toolName: { type: "string" as const, const: tool.name },
      args: tool.inputSchema ?? { type: "object" as const },
    },
    required: ["toolName", "args"],
    additionalProperties: false,
  }));

  return {
    type: "object",
    properties: {
      action: { type: "string", enum: ["answer", "tool_call"] },
      answer: { anyOf: [{ type: "string" }, { type: "null" }] },
      toolCalls: {
        anyOf: [
          {
            type: "array",
            items: toolBranches.length === 1 ? toolBranches[0] : { oneOf: toolBranches },
          },
          { type: "null" },
        ],
      },
    },
    required: ["action", "answer", "toolCalls"],
    additionalProperties: false,
  };
}

// ── Prompt helpers ──────────────────────────────────────────────────

function promptToText(prompt: LanguageModelV3Message[]): string {
  const parts: string[] = [];

  for (const msg of prompt) {
    if (msg.role === "system") continue;

    for (const part of msg.content) {
      if ("text" in part && typeof part.text === "string") {
        if (msg.role === "user") {
          parts.push(part.text);
        } else if (msg.role === "assistant") {
          parts.push(`[Assistant]: ${part.text}`);
        }
      } else if ("toolName" in part && part.type === "tool-call") {
        parts.push(`[Tool Call: ${part.toolName}(${JSON.stringify(part.input)})]`);
      } else if ("toolName" in part && part.type === "tool-result") {
        const output = part.output;
        let text: string;
        if ("value" in output) {
          text = typeof output.value === "string" ? output.value : JSON.stringify(output.value);
        } else {
          text = JSON.stringify(output);
        }
        parts.push(`[Tool Result: ${part.toolName}]: ${text}`);
      }
    }
  }

  return parts.join("\n\n");
}

function extractSystemPrompt(prompt: LanguageModelV3Message[]): string | undefined {
  for (const msg of prompt) {
    if (msg.role === "system") {
      if (typeof msg.content === "string") return msg.content;
      return (msg.content as Array<{ type: string; text?: string }>)
        .filter((p) => p.type === "text" && p.text)
        .map((p) => p.text!)
        .join("\n");
    }
  }
  return undefined;
}

export default qgrid;
