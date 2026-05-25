import { type LanguageModelV3FunctionTool, type LanguageModelV3Message } from "@ai-sdk/provider";

import { type AppendStepInput, type CreateRunInput, type FinishRunInput } from "./index.types";

// API helpers
export async function createRun(
  serverUrl: string,
  body: CreateRunInput,
): Promise<{ requestLogId: number }> {
  const res = await fetch(`${serverUrl}/api/qgrid/createRun`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input: body }),
  });
  return res.json() as Promise<{ requestLogId: number }>;
}

export async function appendStep(
  serverUrl: string,
  body: AppendStepInput,
): Promise<{ stepId: number }> {
  const res = await fetch(`${serverUrl}/api/qgrid/appendStep`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input: body }),
  });
  return res.json() as Promise<{ stepId: number }>;
}

export async function finishRun(serverUrl: string, body: FinishRunInput): Promise<{ ok: boolean }> {
  const res = await fetch(`${serverUrl}/api/qgrid/finishRun`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input: body }),
  });
  return res.json() as Promise<{ ok: boolean }>;
}

// Tool helpers
export function toQgridTool(tool: LanguageModelV3FunctionTool): {
  name: string;
  description?: string;
  inputSchema: unknown;
} {
  const source = tool as LanguageModelV3FunctionTool & {
    inputSchema?: unknown;
    parameters?: unknown;
  };
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: source.inputSchema ?? source.parameters ?? {},
  };
}

type ToolCallWithResult = {
  callId: string;
  toolName: string;
  args: string;
  result: string;
};

export function extractToolResultsFromHistory(
  messages: LanguageModelV3Message[],
): ToolCallWithResult[] {
  const calls = new Map<string, { toolName: string; args: string }>();
  const results = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role === "assistant") {
      for (const part of msg.content) {
        if ("type" in part && part.type === "tool-call") {
          calls.set(part.toolCallId, {
            toolName: part.toolName,
            args: typeof part.input === "string" ? part.input : JSON.stringify(part.input),
          });
        }
      }
    } else if (msg.role === "tool") {
      for (const part of msg.content) {
        if ("type" in part && part.type === "tool-result") {
          const id = "toolCallId" in part ? part.toolCallId : "";
          const output = part.output;
          const text =
            "value" in output
              ? typeof output.value === "string"
                ? output.value
                : JSON.stringify(output.value)
              : JSON.stringify(output);
          results.set(id, text);
        }
      }
    }
  }

  const out: ToolCallWithResult[] = [];
  for (const [callId, call] of calls) {
    if (results.has(callId)) {
      out.push({ callId, toolName: call.toolName, args: call.args, result: results.get(callId)! });
    }
  }
  return out;
}

// SSE parser
export type SSEEvent = { type: string; data: Record<string, unknown> };

export async function* parseSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<SSEEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventType = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (line.startsWith("event: ")) {
        eventType = line.slice(7).trim();
      } else if (line.startsWith("data: ")) {
        const raw = line.slice(6);
        try {
          yield { type: eventType || "message", data: JSON.parse(raw) };
        } catch {}
        eventType = "";
      }
    }
  }
}

// Prompt helpers
export function extractPromptAndHistory(messages: LanguageModelV3Message[]): {
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

// --- shared helpers (used by both index.ts and logger.ts) ---

export function safeStringify(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? String(value) : json;
  } catch {
    return String(value);
  }
}

export function getRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  const parts: string[] = [];
  if (Array.isArray(content)) {
    for (const part of content) {
      if (part && typeof part === "object" && "type" in part) {
        if (part.type === "text" && "text" in part && typeof part.text === "string") {
          parts.push(part.text);
        }
      }
    }
  }
  return parts.join("\n");
}

export function getErrorMessage(value: unknown): string {
  if (value instanceof Error) return String(value);
  if (value === undefined || value === null) return "unknown error";
  return String(value);
}

export function extractUserPrompt(prompt: unknown, messages: unknown): string {
  if (typeof prompt === "string") return prompt;
  const messageList = Array.isArray(messages) ? messages : Array.isArray(prompt) ? prompt : [];
  for (let i = messageList.length - 1; i >= 0; i--) {
    const msg = getRecord(messageList[i]);
    if (msg?.role === "user") {
      return extractTextContent(msg.content);
    }
  }
  return "";
}

export function extractSystemPrompt(system: unknown): string | undefined {
  if (typeof system === "string") return system;
  if (system && typeof system === "object" && "content" in system) {
    const content = (system as { content: unknown }).content;
    if (typeof content === "string") return content;
  }
  return undefined;
}

export function serializeHistory(messages: unknown): string | undefined {
  if (!Array.isArray(messages) || messages.length === 0) return undefined;
  const lastRecord = getRecord(messages[messages.length - 1]);
  const sliced = lastRecord?.role === "user" ? messages.slice(0, -1) : messages;
  const history: Array<Record<string, unknown>> = [];
  for (const msg of sliced) {
    const record = getRecord(msg);
    if (record?.role !== "user" && record?.role !== "assistant") continue;
    const text = extractTextContent(record.content);
    if (text.length === 0) continue;
    history.push({
      type: "message",
      role: record.role,
      content: [{ type: record.role === "user" ? "input_text" : "output_text", text }],
    });
  }
  if (history.length === 0) return undefined;
  return safeStringify(history);
}

export function filterHistoryForStorage(history: unknown[]): string | undefined {
  const filtered = history.filter((item) => {
    if (!item || typeof item !== "object") return false;
    const record = item as Record<string, unknown>;
    return record.type === "message" && (record.role === "user" || record.role === "assistant");
  });
  return filtered.length > 0 ? JSON.stringify(filtered) : undefined;
}
