import { getLogger } from "@logtape/logtape";

import { type JsonValue } from "../../codex-protocol/serde_json/JsonValue";
import {
  type QgridContent,
  type QgridThreadCoord,
  type QgridTool,
  type QueryOutput,
} from "./qgrid.types";

const logger = getLogger(["qgrid", "tool-emulation"]);

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
    description:
      "Use this schema only through StructuredOutput. Do not invoke listed client tools as native Claude Code tools. To request client-side tool execution, set action to tool_call and include toolCalls. Use action answer only when no further client tool result is needed.",
    properties: {
      action: {
        type: "string",
        enum: ["answer", "tool_call"],
        description:
          "Use tool_call to request client-side tool execution through this structured output. Use answer only for a final answer.",
      },
      answer: { anyOf: [{ type: "string" }, { type: "null" }] },
      toolCalls: {
        description:
          "Client-side tool calls requested through structured output. Do not call these tools as native Claude Code tools.",
        anyOf: [
          {
            type: "array",
            items: {
              type: "object",
              properties: {
                toolName: {
                  type: "string",
                  enum: tools.map((tool) => tool.name),
                  description: `Client-side tool name to request through structured output. Do not call this as a native Claude Code tool.\n${toolDescriptions}`,
                },
                args: {
                  type: "string",
                  description: "Tool arguments as a JSON string for the client-side tool.",
                },
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
  result: Omit<QueryOutput, "content" | "finishReason" | "runContext">,
  tools?: QgridTool[],
  threadCoord?: QgridThreadCoord,
): QueryOutput {
  // thread 재사용 좌표를 runContext 로 실어 올린다 (auto 모드는 requestLogId 없이 threadCoord 만).
  const runContext = threadCoord ? { threadCoord } : undefined;

  if (!tools?.length) {
    const content: QgridContent[] = [{ type: "text", text: result.text }];
    return { ...result, content, finishReason: "stop", runContext };
  }

  let parsed: ToolCallResponse;
  try {
    parsed = JSON.parse(result.text) as ToolCallResponse;
  } catch (e) {
    logger.warn(`tool-call emulation parse failed, falling back to text: ${(e as Error).message}`);
    return {
      ...result,
      content: [{ type: "text", text: result.text }],
      finishReason: "stop",
      runContext,
    };
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
    return { ...result, content, finishReason: "tool-calls", runContext };
  }

  const text = parsed.answer ?? result.text;
  return {
    ...result,
    text,
    content: [{ type: "text", text }],
    finishReason: "stop",
    runContext,
  };
}
