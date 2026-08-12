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

// envelope 는 {result: <union>} 한 겹 구조 — 스키마 근거는 tool-emulation-schema.ts 참조.
// answer 타입만 요청 형태에 따라 다르다: tools-only 는 string(그대로 반환),
// tools+jsonSchema 는 사용자 스키마의 JSON 값(JSON.stringify 로 반환).
function buildEnvelopeSchema(answerKind: AnswerKind) {
  return z.strictObject({
    result: z.discriminatedUnion("action", [
      z.strictObject({
        action: z.literal("answer"),
        answer:
          answerKind === "text"
            ? z.string()
            : z.json().refine((answer) => answer !== null, {
                message: "answer must be non-null",
              }),
        toolCalls: z.null(),
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
    ]),
  });
}

const TEXT_ENVELOPE = buildEnvelopeSchema("text");
const JSON_ENVELOPE = buildEnvelopeSchema("json");
type EnvelopeResponse = z.infer<typeof JSON_ENVELOPE>["result"];

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

// answer 인코딩 종류. envelope 디코더는 한 벌이고 이 값은 answer 브랜치의 타입과
// 최종 직렬화(text: 그대로 / json: JSON.stringify)만 가른다.
export type AnswerKind = "text" | "json";

interface ToolCallEmulationOptions {
  threadCoord?: QgridThreadCoord;
  images?: EmulationImage[];
  // 필수: 호출부가 answer 인코딩을 항상 명시해야 한다 (input.jsonSchema 유무로 판정).
  answerKind: AnswerKind;
}

export function applyToolCallEmulation(
  result: EmulationResult,
  tools: QgridTool[] | undefined,
  options: ToolCallEmulationOptions,
): QueryOutput {
  const { threadCoord, images, answerKind } = options;
  const runContext = threadCoord ? { threadCoord } : undefined;

  if (!tools?.length) {
    return answerOutput(result, result.text, images, runContext);
  }

  const parsed = parseEnvelope(result.text, tools, answerKind);
  if (parsed.action === "tool_call") {
    return toolCallOutput(result, parsed.toolCalls, images, runContext);
  }

  return answerOutput(
    result,
    answerKind === "text" ? (parsed.answer as string) : JSON.stringify(parsed.answer),
    images,
    runContext,
  );
}

function parseEnvelope(text: string, tools: QgridTool[], answerKind: AnswerKind) {
  if (Buffer.byteLength(text, "utf8") > STRUCTURED_ENVELOPE_LIMITS.maxUtf8Bytes) {
    throw new ToolCallEmulationError(
      `tool envelope exceeds UTF-8 byte limit of ${STRUCTURED_ENVELOPE_LIMITS.maxUtf8Bytes}`,
    );
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    // 관용 폴백 없음. openai 는 envelope 이 structured output 으로 강제되므로 여기 도달한
    // 비 JSON 은 버그다. anthropic 은 계약을 프롬프트로만 안내하므로(SON-532) 비 JSON 이
    // "예상 가능한 모델 실패"지만, 그래도 구제하지 않는다 — 과거의 텍스트 구제는 퇴화
    // 봉투를 답변으로 흘려보내 조용한 오염을 만들었다(2026-07 medpath, 13.5k 건).
    // 정직한 실패가 보여야 소비자가 재시도하거나 근본 원인을 고친다.
    // 진단에는 위반 원문의 머리가 필요하다(SON-495 전례) — parse 에러 위치만으로는
    // "프로즈로 답했는지 / 펜스가 남았는지 / JSON 이 잘렸는지"를 구분할 수 없다.
    const head = JSON.stringify(text.slice(0, 200));
    logger.warn(`tool envelope parse failed: ${(error as Error).message}; head=${head}`);
    throw new ToolCallEmulationError(
      `invalid tool envelope (response is not JSON — the model ignored the envelope contract; retry is the caller's decision): ${(error as Error).message}; response head: ${head}`,
    );
  }

  assertStructuredEnvelopeComplexity(value);
  const schema = answerKind === "text" ? TEXT_ENVELOPE : JSON_ENVELOPE;
  const validation = schema.safeParse(value);
  if (!validation.success) {
    const issue = validation.error.issues[0];
    const path = issue && issue.path.length > 0 ? ` at ${issue.path.join(".")}` : "";
    const detail = issue?.message ?? "unknown validation issue";
    logger.warn(`tool envelope validation failed${path}: ${detail}`);
    throw new ToolCallEmulationError(`invalid tool envelope${path}: ${detail}`);
  }

  // Zod clones JSON objects and drops own "__proto__" keys. The parsed JSON is safe to return
  // after validation and preserves the caller's exact structured value.
  const response = (value as { result: EnvelopeResponse }).result;
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
