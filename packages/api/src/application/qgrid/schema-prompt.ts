/**
 * output schema / tool envelope 계약의 프롬프트 렌더링 (SON-532).
 *
 * anthropic 경로는 CC 에 --json-schema 를 전달하지 않는다 — 강제 없는 사후 채점(AJV)이
 * 소비자 의도와 충돌해 내부 재시도 루프를 만들었기 때문. 대신 여기서 계약을 텍스트로
 * 렌더해 system prompt 말미에 주입하고, 판정은 소비자 zod(스키마) / parseEnvelope
 * (envelope, tool-emulation.ts)가 맡는다.
 *
 * 원칙:
 * - user 스키마는 수신 원형 그대로 안내한다 — strictify(전 필드 required 강제,
 *   additionalProperties:false)를 거치지 않아 소비자의 nullish/optional 의도가 보존된다.
 * - envelope 은 buildToolCallSchema(tool-emulation-schema.ts)처럼 user 스키마를 $defs 로
 *   합성하지 않는다. 텍스트 안내라 `$ref` 문서 루트 충돌이 없어 rebase 가 불필요하고,
 *   그 덕에 rebase 가 거절하던 형태(named anchor $ref 등)도 그대로 통과한다.
 * - 렌더된 계약은 parseEnvelope 의 zod 계약({"result": ...} 한 겹, 상호배타 변형)과
 *   정확히 일치해야 한다 — 교차 테스트(schema-prompt.test.ts)가 드리프트를 막는다.
 */
import { type QgridTool, type QueryInput } from "./qgrid.types";

/**
 * system prompt 말미에 계약을 덧붙인다. anthropic 은 cold-only(매 턴 CC 재스폰 + system
 * 재전송)라 멀티턴에도 계약이 매 턴 일관되게 주입된다. system 이 argv 64KB 를 넘으면
 * claude-session 의 --system-prompt-file 분기가 흡수한다.
 */
export function composeSystemWithSchemaContract(
  system: string | undefined,
  input: Pick<QueryInput, "tools" | "jsonSchema">,
): string | undefined {
  const contract = renderSchemaContractPrompt(input);
  if (contract === undefined) return system;
  return system ? `${system}\n\n${contract}` : contract;
}

/** 요청에 스키마/tools 가 없으면 undefined — 계약 주입 없이 평범한 텍스트 요청이다. */
export function renderSchemaContractPrompt(
  input: Pick<QueryInput, "tools" | "jsonSchema">,
): string | undefined {
  if (input.tools?.length) {
    return renderToolEnvelopePrompt(input.tools, input.jsonSchema);
  }
  if (input.jsonSchema !== undefined) {
    return renderOutputSchemaPrompt(input.jsonSchema);
  }
  return undefined;
}

// 1091748 실측(스키마 원문 + "펜스·설명 없이 JSON 만" 지시)에서 검증된 형식을 따른다.
export function renderOutputSchemaPrompt(jsonSchema: string): string {
  return [
    "## Output Format",
    "",
    "Your entire reply must be a single JSON object that conforms to the JSON Schema below.",
    "Output raw JSON only — no code fences, no prose before or after the JSON.",
    "Start your reply with { and end it with }.",
    "",
    "<output-json-schema>",
    jsonSchema,
    "</output-json-schema>",
  ].join("\n");
}

/**
 * envelope 예시 JSON. 렌더 문구와 parseEnvelope 계약의 드리프트를 교차 테스트로 잡기
 * 위해 분리 export 한다 — 예시가 실제 파서를 통과하지 못하면 안내문이 틀린 것이다.
 */
export function buildEnvelopeExamples(tools: QgridTool[]): {
  toolCallExample: string;
  textAnswerExample: string;
} {
  const firstToolName = tools[0]?.name ?? "toolName";
  return {
    toolCallExample: JSON.stringify({
      result: {
        action: "tool_call",
        answer: null,
        toolCalls: [{ toolName: firstToolName, args: "{}" }],
      },
    }),
    textAnswerExample: JSON.stringify({
      result: { action: "answer", answer: "your final answer", toolCalls: null },
    }),
  };
}

// envelope 계약 문구는 buildToolCallSchema 의 description 들과 같은 표현을 쓴다
// ("Do not invoke ... as native Claude Code tools" 등) — 모델이 structured/프롬프트
// 어느 안내를 받아도 같은 규칙을 읽게 한다.
export function renderToolEnvelopePrompt(tools: QgridTool[], jsonSchema?: string): string {
  const { toolCallExample, textAnswerExample } = buildEnvelopeExamples(tools);

  const toolList = tools
    .map((tool) => {
      const description = tool.description ? ` — ${tool.description}` : "";
      return `- ${tool.name}${description}\n  inputSchema: ${JSON.stringify(tool.inputSchema)}`;
    })
    .join("\n");

  const answerShape =
    jsonSchema === undefined
      ? ['- "answer" must be a plain string with your final answer.']
      : [
          '- "answer" must be a JSON value that conforms to the JSON Schema below.',
          "",
          "<answer-json-schema>",
          jsonSchema,
          "</answer-json-schema>",
        ];

  const answerExample =
    jsonSchema === undefined
      ? textAnswerExample
      : '{"result":{"action":"answer","answer":<JSON conforming to the answer schema>,"toolCalls":null}}';

  return [
    "## Client Tool Protocol",
    "",
    "The client-side tools listed below are executed by the client, which returns each result",
    "in a follow-up turn. Do not invoke them as native Claude Code tools.",
    "",
    'Your entire reply must be a single JSON object of the form {"result": ...} —',
    "raw JSON only, no code fences, no prose before or after the JSON.",
    'The "result" value is exactly one of the two variants:',
    "",
    "1. Request client-side tool execution:",
    toolCallExample,
    '- "toolCalls" must contain at least one entry.',
    '- "toolName" must be one of the client tool names listed below.',
    '- "args" must be the tool arguments encoded as a JSON string (not an object), conforming to that tool\'s inputSchema.',
    '- "answer" must be null.',
    "",
    "2. Final answer — use only when no further client tool result is needed:",
    answerExample,
    '- "toolCalls" must be null.',
    '- "answer" must not be null.',
    ...answerShape,
    "",
    "Available client tools:",
    toolList,
  ].join("\n");
}
