import type {
  LanguageModelV3FunctionTool,
  LanguageModelV3Message,
} from "@ai-sdk/provider";
import type { AppendStepInput, CreateRunInput, FinishRunInput } from "./index.types";

// API helpers
export async function createRun(serverUrl: string, body: CreateRunInput): Promise<{ requestLogId: number }> {
  const res = await fetch(`${serverUrl}/api/qgrid/createRun`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input: body }),
  });
  return res.json() as Promise<{ requestLogId: number }>;
}

export async function appendStep(serverUrl: string, body: AppendStepInput): Promise<{ stepId: number }> {
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
          const id = "toolCallId" in part ? (part.toolCallId as string) : "";
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
