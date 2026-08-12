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
 *
 * 예시는 스스로 계약을 지켜야 한다: args 는 첫 tool 의 inputSchema 를 실제로 만족하는
 * 인스턴스여야 한다. 생성기가 다루지 못하는 keyword(pattern/$ref/allOf 등)가 스키마에
 * 있으면 **fail-closed** — 위반 가능성이 있는 예시를 싣는 대신 예시 자체를 생략하고
 * 렌더러가 프로즈 서술로 대체한다 (`toolCallExample: undefined`).
 */
export function buildEnvelopeExamples(tools: QgridTool[]): {
  toolCallExample?: string;
  textAnswerExample: string;
} {
  const firstTool = tools[0];
  const args = firstTool ? exampleValueForSchema(firstTool.inputSchema) : { ok: true, value: {} };
  return {
    ...(args.ok
      ? {
          toolCallExample: JSON.stringify({
            result: {
              action: "tool_call",
              answer: null,
              toolCalls: [
                { toolName: firstTool?.name ?? "toolName", args: JSON.stringify(args.value) },
              ],
            },
          }),
        }
      : {}),
    textAnswerExample: JSON.stringify({
      result: { action: "answer", answer: "your final answer", toolCalls: null },
    }),
  };
}

type ExampleResult = { ok: true; value: unknown } | { ok: false };

/** 생성기가 값 선택에 반영하는 keyword. 어노테이션(description 등)은 값과 무관해 무시한다. */
const EXAMPLE_ANNOTATION_KEYWORDS = new Set([
  "description",
  "title",
  "default",
  "examples",
  "$comment",
  "deprecated",
  "readOnly",
  "writeOnly",
]);
const EXAMPLE_HANDLED_KEYWORDS = new Set([
  "type",
  "enum",
  "const",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "minItems",
  "maxItems",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "anyOf",
  "oneOf",
]);

/**
 * inputSchema 를 만족하는 예시 인스턴스 생성. 지원 keyword 집합 밖의 제약
 * (pattern/format/$ref/allOf/not/if/multipleOf/uniqueItems/...)을 만나면 값을
 * 지어내지 않고 { ok: false } 를 돌려준다 — 계약 위반 예시는 모델이 베낀다.
 */
function exampleValueForSchema(schema: unknown): ExampleResult {
  if (schema === true || schema === undefined) return { ok: true, value: {} };
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) return { ok: false };
  const node = schema as Record<string, unknown>;

  for (const keyword of Object.keys(node)) {
    if (!EXAMPLE_HANDLED_KEYWORDS.has(keyword) && !EXAMPLE_ANNOTATION_KEYWORDS.has(keyword)) {
      return { ok: false };
    }
  }

  if (Array.isArray(node.enum) && node.enum.length > 0) return { ok: true, value: node.enum[0] };
  if ("const" in node) return { ok: true, value: node.const };

  for (const kw of ["anyOf", "oneOf"] as const) {
    if (Array.isArray(node[kw])) {
      // oneOf 는 "정확히 하나"라 첫 브랜치 값이 다른 브랜치에도 매칭될 수 있다 —
      // 검증기 없이 확신할 수 없으므로 브랜치가 하나일 때만 생성한다.
      const list = node[kw] as unknown[];
      if (kw === "oneOf" && list.length > 1) return { ok: false };
      for (const branch of list) {
        const result = exampleValueForSchema(branch);
        if (result.ok) return result;
      }
      return { ok: false };
    }
  }

  const type = Array.isArray(node.type) ? node.type[0] : node.type;
  switch (type) {
    case "string": {
      const min = typeof node.minLength === "number" ? node.minLength : 0;
      if (min > 64) return { ok: false };
      const base = "example";
      const value = base.length >= min ? base : base.padEnd(min, "x");
      if (typeof node.maxLength === "number" && value.length > node.maxLength) {
        if (node.maxLength < min) return { ok: false };
        return { ok: true, value: value.slice(0, node.maxLength) };
      }
      return { ok: true, value };
    }
    case "number":
    case "integer": {
      let value = 0;
      if (typeof node.minimum === "number") value = node.minimum;
      else if (typeof node.exclusiveMinimum === "number") value = node.exclusiveMinimum + 1;
      if (typeof node.maximum === "number" && value > node.maximum) return { ok: false };
      if (typeof node.exclusiveMaximum === "number" && value >= node.exclusiveMaximum) {
        return { ok: false };
      }
      return { ok: true, value };
    }
    case "boolean":
      return { ok: true, value: false };
    case "null":
      return { ok: true, value: null };
    case "array": {
      const min = typeof node.minItems === "number" ? node.minItems : 0;
      if (min > 8) return { ok: false };
      if (typeof node.maxItems === "number" && node.maxItems < min) return { ok: false };
      if (min === 0) return { ok: true, value: [] };
      const item = exampleValueForSchema(node.items);
      if (!item.ok) return { ok: false };
      // 같은 값 반복이라 uniqueItems 와 충돌하지만, uniqueItems 는 지원 집합 밖이라
      // 위의 keyword 검사에서 이미 fail-closed 된다.
      return { ok: true, value: Array.from({ length: min }, () => item.value) };
    }
    case undefined:
    case "object": {
      const properties =
        node.properties && typeof node.properties === "object" && !Array.isArray(node.properties)
          ? (node.properties as Record<string, unknown>)
          : {};
      const required = Array.isArray(node.required)
        ? node.required.filter((k): k is string => typeof k === "string")
        : [];
      const entries: Array<[string, unknown]> = [];
      for (const key of required) {
        const child = exampleValueForSchema(properties[key]);
        if (!child.ok) return { ok: false };
        entries.push([key, child.value]);
      }
      return { ok: true, value: Object.fromEntries(entries) };
    }
    default:
      return { ok: false };
  }
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

  // 예시가 raw-JSON-only 규칙을 스스로 어기면 안 된다: json answer 는 스키마 종속이라
  // 유효한 리터럴 예시를 만들 수 없으므로 예시 없이 프로즈로만 서술한다 (자리표시자가
  // 섞인 비 JSON 예시를 모델이 그대로 베끼는 것 방지).
  const answerVariant =
    jsonSchema === undefined
      ? [
          "2. Final answer — use only when no further client tool result is needed:",
          textAnswerExample,
          '- "toolCalls" must be null.',
          '- "answer" must be a plain string with your final answer (not null).',
        ]
      : [
          "2. Final answer — use only when no further client tool result is needed:",
          '- Set "action" to "answer" and "toolCalls" to null.',
          '- "answer" must be a JSON value (not null, and not a string of JSON) that conforms to the JSON Schema below.',
          "",
          "<answer-json-schema>",
          jsonSchema,
          "</answer-json-schema>",
        ];

  // 예시 생성기가 다루지 못하는 inputSchema(fail-closed)면 구조 서술로 대체한다 —
  // 스키마를 위반할 수 있는 예시를 싣는 것보다 예시가 없는 편이 안전하다.
  const toolCallVariant = [
    toolCallExample !== undefined
      ? "1. Request client-side tool execution, for example:"
      : "1. Request client-side tool execution:",
    ...(toolCallExample !== undefined
      ? [toolCallExample]
      : [
          '- Set "action" to "tool_call" and "answer" to null.',
          '- "toolCalls" is an array of objects, each {"toolName": ..., "args": ...}.',
        ]),
    '- "toolCalls" must contain at least one entry.',
    '- "toolName" must be one of the client tool names listed below.',
    '- "args" must be the tool arguments encoded as a JSON string (not an object), conforming to that tool\'s inputSchema.',
    '- "answer" must be null.',
  ];

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
    ...toolCallVariant,
    "",
    ...answerVariant,
    "",
    "Available client tools:",
    toolList,
  ].join("\n");
}
