import { type JsonValue } from "../../codex-protocol/serde_json/JsonValue";
import { type QgridContent, type QgridTool, type QueryOutput } from "./qgrid.types";

type ToolCallResponse = {
  action: "answer" | "tool_call";
  answer?: string | null;
  toolCalls?: Array<{ toolName: string; args: string }> | null;
};

export function buildToolCallSchema(tools: QgridTool[]): JsonValue {
  const toolDescriptions = tools
    .map((tool) => {
      const schema = JSON.stringify(tool.inputSchema);
      return `- ${tool.name}: ${tool.description ?? ""}\n  inputSchema: ${schema}`;
    })
    .join("\n");

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
                  enum: tools.map((tool) => tool.name),
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

export function applyToolCallEmulation(
  result: Omit<QueryOutput, "content" | "finishReason">,
  tools?: QgridTool[],
): QueryOutput {
  if (!tools?.length) {
    const content: QgridContent[] = [{ type: "text", text: result.text }];
    return { ...result, content, finishReason: "stop" };
  }

  let parsed: ToolCallResponse;
  try {
    parsed = JSON.parse(result.text) as ToolCallResponse;
  } catch (e) {
    throw new Error(`tool-call emulation parse failed: ${(e as Error).message}`, { cause: e });
  }

  if (parsed.action === "tool_call") {
    const toolCalls = parsed.toolCalls ?? [];
    const content: QgridContent[] = toolCalls.map((toolCall) => {
      if (!tools.some((tool) => tool.name === toolCall.toolName)) {
        throw new Error(`unknown emulated tool: ${toolCall.toolName}`);
      }

      return {
        type: "tool-call",
        toolCallId: `call_${Math.random().toString(36).slice(2, 10)}`,
        toolName: toolCall.toolName,
        input: toolCall.args,
      };
    });
    return { ...result, content, finishReason: "tool-calls" };
  }

  const text = parsed.answer ?? result.text;
  return {
    ...result,
    text,
    content: [{ type: "text", text }],
    finishReason: "stop",
  };
}
