import { Buffer } from "node:buffer";

import { getLogger } from "@logtape/logtape";
import { z } from "zod";

// 응답(모델 출력) envelope 의 자원 한도. caller 스키마 전처리 한도(CALLER_SCHEMA_LIMITS)와 값이
// 같아 보여도 서로 다른 자원을 지키는 독립 상수다 — 스키마 깊이는 인스턴스 깊이를 bound 하지
// 않으므로(재귀 $ref 허용) 캘러 한도를 조정해도 응답 수용 기준이 따라 움직여선 안 된다.
const STRUCTURED_ENVELOPE_LIMITS = {
  maxUtf8Bytes: 512 * 1024,
  maxNodes: 20_000,
  maxDepth: 132,
} as const;
import {
  type QgridContent,
  type QgridThreadCoord,
  type QgridTool,
  type QueryOutput,
} from "./qgrid.types";

const logger = getLogger(["qgrid", "tool-emulation"]);

type EmulationResult = Omit<QueryOutput, "content" | "finishReason" | "runContext">;
type ToolCall = { toolName: string; args: string };
type LegacyToolCallResponse = {
  action?: "answer" | "tool_call";
  answer?: string | null;
  toolCalls?: ToolCall[] | null;
};

const StructuredToolCallResponse = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("answer"),
    answer: z.json().refine((answer) => answer !== null, {
      message: "answer must be non-null",
    }),
    toolCalls: z.union([z.null(), z.tuple([])]),
  }),
  z.strictObject({
    action: z.literal("tool_call"),
    answer: z.null(),
    toolCalls: z
      .array(
        z.strictObject({
          toolName: z.string(),
          args: z.string(),
        }),
      )
      .min(1),
  }),
]);
type StructuredResponse = z.infer<typeof StructuredToolCallResponse>;

export class ToolCallEmulationError extends Error {
  constructor(message: string) {
    super(`tool-call emulation: ${message}`);
    this.name = "ToolCallEmulationError";
  }
}

// dispatcher 가 넘기는 이미지 결과. qgrid 는 base64 payload 만 전달하고 포맷은 보장하지 않는다.
interface EmulationImage {
  data: string;
  revisedPrompt?: string | null;
}

interface ToolCallEmulationOptions {
  threadCoord?: QgridThreadCoord;
  images?: EmulationImage[];
  // 필수: 호출부가 디코드 모드를 항상 명시해야 한다. 기본값을 두면 새 호출부가
  // 옵션을 빠뜨렸을 때 조용히 관용 디코더로 떨어져 에러가 숨는다.
  answerMode: "legacy" | "structured";
}

export function applyToolCallEmulation(
  result: EmulationResult,
  tools: QgridTool[] | undefined,
  options: ToolCallEmulationOptions,
): QueryOutput {
  const { threadCoord, images, answerMode } = options;
  const runContext = threadCoord ? { threadCoord } : undefined;

  if (!tools?.length) {
    return answerOutput(result, result.text, images, runContext);
  }

  if (answerMode === "legacy") {
    return applyLegacyResponse(result, tools, images, runContext);
  }

  const parsed = parseStructuredResponse(result.text, tools);
  if (parsed.action === "tool_call") {
    return toolCallOutput(result, parsed.toolCalls, images, runContext);
  }

  return answerOutput(result, JSON.stringify(parsed.answer), images, runContext);
}

/**
 * Tools-only requests keep the permissive 2.5.3 contract. Structured-output requests use the
 * strict decoder below because their outer action envelope is an internal server contract.
 */
function applyLegacyResponse(
  result: EmulationResult,
  tools: QgridTool[],
  images: EmulationImage[] | undefined,
  runContext: QueryOutput["runContext"],
): QueryOutput {
  let parsed: LegacyToolCallResponse;
  try {
    parsed = JSON.parse(result.text) as LegacyToolCallResponse;
  } catch (error) {
    logger.warn(
      `tool-call emulation parse failed, falling back to text: ${(error as Error).message}`,
    );
    return answerOutput(result, result.text, images, runContext);
  }

  if (parsed.action === "tool_call") {
    const toolCalls = parsed.toolCalls ?? [];
    const unknownTool = findUnknownTool(toolCalls, tools);
    if (unknownTool !== undefined) throw new Error(`unknown emulated tool: ${unknownTool}`);
    return toolCallOutput(result, toolCalls, images, runContext);
  }

  return answerOutput(result, parsed.answer ?? result.text, images, runContext);
}

function parseStructuredResponse(text: string, tools: QgridTool[]) {
  if (Buffer.byteLength(text, "utf8") > STRUCTURED_ENVELOPE_LIMITS.maxUtf8Bytes) {
    throw new ToolCallEmulationError(
      `structured-output envelope exceeds UTF-8 byte limit of ${STRUCTURED_ENVELOPE_LIMITS.maxUtf8Bytes}`,
    );
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new ToolCallEmulationError(
      `invalid structured-output envelope: ${(error as Error).message}`,
    );
  }

  assertStructuredEnvelopeComplexity(value);
  const validation = StructuredToolCallResponse.safeParse(value);
  if (!validation.success) {
    const issue = validation.error.issues[0];
    const path = issue && issue.path.length > 0 ? ` at ${issue.path.join(".")}` : "";
    const detail = issue?.message ?? "unknown validation issue";
    throw new ToolCallEmulationError(`invalid structured-output envelope${path}: ${detail}`);
  }

  // Zod clones JSON objects and drops own "__proto__" keys. The parsed JSON is safe to return
  // after validation and preserves the caller's exact structured value.
  const response = value as StructuredResponse;
  if (response.action === "tool_call") {
    const unknownTool = findUnknownTool(response.toolCalls, tools);
    if (unknownTool !== undefined) {
      throw new ToolCallEmulationError(`unknown emulated tool: ${unknownTool}`);
    }
  }
  return response;
}

function toolCallOutput(
  result: EmulationResult,
  toolCalls: ToolCall[],
  images: EmulationImage[] | undefined,
  runContext: QueryOutput["runContext"],
): QueryOutput {
  return {
    ...result,
    content: appendImages(
      toolCalls.map((toolCall) => ({
        type: "tool-call",
        toolCallId: `call_${Math.random().toString(36).slice(2, 10)}`,
        toolName: toolCall.toolName,
        input: toolCall.args,
      })),
      images,
    ),
    finishReason: "tool-calls",
    runContext,
  };
}

function answerOutput(
  result: EmulationResult,
  text: string,
  images: EmulationImage[] | undefined,
  runContext: QueryOutput["runContext"],
): QueryOutput {
  return {
    ...result,
    text,
    content: appendImages([{ type: "text", text }], images),
    finishReason: "stop",
    runContext,
  };
}

function findUnknownTool(toolCalls: ToolCall[], tools: QgridTool[]): string | undefined {
  const knownToolNames = new Set(tools.map((tool) => tool.name));
  return toolCalls.find((toolCall) => !knownToolNames.has(toolCall.toolName))?.toolName;
}

function appendImages(content: QgridContent[], images?: EmulationImage[]): QgridContent[] {
  if (!images?.length) return content;
  return [
    ...content,
    ...images.map(
      (image): QgridContent => ({
        type: "image",
        data: image.data,
        revisedPrompt: image.revisedPrompt ?? null,
      }),
    ),
  ];
}

function assertStructuredEnvelopeComplexity(root: unknown): void {
  const maxDepth = STRUCTURED_ENVELOPE_LIMITS.maxDepth;
  const stack = [{ value: root, depth: 0 }];
  let nodes = 0;

  while (stack.length > 0) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > STRUCTURED_ENVELOPE_LIMITS.maxNodes) {
      throw new ToolCallEmulationError(
        `structured-output envelope exceeds node limit of ${STRUCTURED_ENVELOPE_LIMITS.maxNodes}`,
      );
    }
    if (current.depth > maxDepth) {
      throw new ToolCallEmulationError(
        `structured-output envelope exceeds depth limit of ${maxDepth}`,
      );
    }
    if (typeof current.value === "number" && !Number.isFinite(current.value)) {
      throw new ToolCallEmulationError("answer must be valid JSON");
    }
    if (current.value === null || typeof current.value !== "object") continue;

    for (const value of Object.values(current.value)) {
      stack.push({ value, depth: current.depth + 1 });
    }
  }
}
