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

type QueryResponse = {
  text: string;
  model: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
  };
  durationMs: number;
  costUsd: number;
};

type ToolCallResponse = {
  action: "answer" | "tool_call";
  answer?: string | null;
  toolCalls?: Array<{ toolName: string; args: string }> | null;
};

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

      const { prompt, system, history } = extractPromptAndHistory(options.prompt);
      const res = await fetch(`${serverUrl}/api/qgrid/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          args: {
            prompt,
            model: modelId,
            system,
            effort,
            ...(outputSchema ? { jsonSchema: JSON.stringify(outputSchema) } : {}),
            ...(history.length > 0 ? { history: JSON.stringify(history) } : {}),
            ...(isToolCallMode ? { logMode: "none" } : {}),
          },
        }),
        signal: options.abortSignal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`qgrid ${res.status}: ${text}`);
      }

      const data = (await res.json()) as QueryResponse;
      const content: LanguageModelV3Content[] = [];
      let finishReason: LanguageModelV3FinishReason = {
        unified: "stop",
        raw: "stop",
      };

      if (isToolCallMode) {
        try {
          const parsed = JSON.parse(data.text) as ToolCallResponse;
          if (parsed.action === "tool_call" && parsed.toolCalls) {
            for (const tc of parsed.toolCalls) {
              content.push({
                type: "tool-call",
                toolCallId: `call_${Math.random().toString(36).slice(2, 10)}`,
                toolName: tc.toolName,
                input: tc.args,
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
  const toolDescriptions = tools.map((t) => `- ${t.name}: ${t.description ?? ""}`).join("\n");

  return {
    type: "object",
    properties: {
      action: { type: "string", enum: ["answer", "tool_call"] },
      answer: { anyOf: [{ type: "string" }, { type: "null" }] },
      toolCalls: {
        anyOf: [
          {
            type: "array",
            items: {
              type: "object",
              properties: {
                toolName: {
                  type: "string",
                  enum: tools.map((t) => t.name),
                  description: toolDescriptions,
                },
                args: { type: "string", description: "Tool arguments as JSON string" },
              },
              required: ["toolName", "args"],
              additionalProperties: false,
            },
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

function extractPromptAndHistory(messages: LanguageModelV3Message[]): {
  prompt: string;
  system: string | undefined;
  history: unknown[];
} {
  let system: string | undefined;
  const nonSystem: LanguageModelV3Message[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      system = extractTextFromContent(msg.content);
    } else {
      nonSystem.push(msg);
    }
  }

  if (nonSystem.length === 0) return { prompt: "", system, history: [] };
  if (nonSystem.length === 1 && nonSystem[0].role === "user") {
    return { prompt: extractTextFromContent(nonSystem[0].content), system, history: [] };
  }

  const last = nonSystem[nonSystem.length - 1];
  const prompt = last.role === "user" ? extractTextFromContent(last.content) : "";
  const historyEnd = last.role === "user" ? nonSystem.length - 1 : nonSystem.length;

  const history: unknown[] = [];
  for (let i = 0; i < historyEnd; i++) {
    const msg = nonSystem[i];
    if (msg.role === "user") {
      history.push({
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: extractTextFromContent(msg.content) }],
      });
    } else if (msg.role === "assistant") {
      for (const part of msg.content) {
        if ("text" in part && typeof part.text === "string") {
          history.push({
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: part.text }],
          });
        } else if ("toolName" in part && part.type === "tool-call") {
          history.push({
            type: "function_call",
            name: part.toolName,
            arguments: typeof part.input === "string" ? part.input : JSON.stringify(part.input),
            call_id: part.toolCallId,
          });
        }
      }
    } else if (msg.role === "tool") {
      for (const part of msg.content) {
        if ("toolName" in part && part.type === "tool-result") {
          const output = part.output;
          const text =
            "value" in output
              ? typeof output.value === "string"
                ? output.value
                : JSON.stringify(output.value)
              : JSON.stringify(output);
          history.push({
            type: "function_call_output",
            call_id: ("toolCallId" in part ? part.toolCallId : "") ?? "",
            output: text,
          });
        }
      }
    }
  }

  return { prompt, system, history };
}

function extractTextFromContent(content: LanguageModelV3Message["content"]): string {
  if (typeof content === "string") return content;
  const parts: string[] = [];
  for (const part of content) {
    if ("text" in part && typeof part.text === "string") parts.push(part.text);
  }
  return parts.join("\n");
}

export default qgrid;
