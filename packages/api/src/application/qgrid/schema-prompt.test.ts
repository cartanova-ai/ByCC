import { describe, expect, it } from "vitest";

import {
  buildEnvelopeExamples,
  renderOutputSchemaPrompt,
  renderSchemaContractPrompt,
  renderToolEnvelopePrompt,
} from "./schema-prompt";

const TOOLS = [
  {
    name: "lookup",
    description: "Look up a value",
    inputSchema: {
      type: "object",
      properties: { key: { type: "string" } },
      required: ["key"],
    },
  },
  { name: "save", inputSchema: { type: "object" } },
];

// 소비자가 nullish 로 선언한 필드가 있는 원형 — strictify 를 거치면 required 로 굳는 형태.
const USER_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    title: { type: "string" },
    mood: { type: ["string", "null"], description: "생략 가능" },
  },
  required: ["title"],
});

describe("renderOutputSchemaPrompt", () => {
  it("스키마 원문을 재작성 없이 포함하고 raw JSON 지시를 담는다", () => {
    const rendered = renderOutputSchemaPrompt(USER_SCHEMA);

    expect(rendered).toContain(USER_SCHEMA);
    expect(rendered).toContain("no code fences");
    // strictify 흔적이 없어야 한다 — 원형에 없던 additionalProperties 강제가 생기면 안 된다.
    expect(rendered).not.toContain("additionalProperties");
  });

  it("$ref 를 포함한 스키마도 원문 그대로 둔다", () => {
    const schema = JSON.stringify({
      type: "object",
      properties: { answer: { $ref: "#named-anchor" } },
    });

    expect(renderOutputSchemaPrompt(schema)).toContain('"$ref":"#named-anchor"');
  });
});

describe("renderToolEnvelopePrompt", () => {
  it("envelope 계약({\"result\": ...} 래퍼·상호배타·native tool 금지)을 안내한다", () => {
    const rendered = renderToolEnvelopePrompt(TOOLS);

    expect(rendered).toContain('{"result": ...}');
    expect(rendered).toContain("Do not invoke them as native Claude Code tools");
    expect(rendered).toContain('"answer" must be null');
    expect(rendered).toContain('"toolCalls" must be null');
    expect(rendered).toContain("at least one entry");
    // tool 목록과 inputSchema 원문
    expect(rendered).toContain("- lookup — Look up a value");
    expect(rendered).toContain('"required":["key"]');
    expect(rendered).toContain("- save");
  });

  it("tools+스키마면 answer 자리에 user 스키마를 원형 그대로 안내한다", () => {
    const rendered = renderToolEnvelopePrompt(TOOLS, USER_SCHEMA);

    expect(rendered).toContain("<answer-json-schema>");
    expect(rendered).toContain(USER_SCHEMA);
    expect(rendered).toContain("conforms to the JSON Schema below");
    // raw-JSON-only 규칙을 예시가 스스로 어기면 안 된다 — 자리표시자 섞인 비 JSON 예시 금지
    expect(rendered).not.toContain("<JSON conforming");
  });

  it("tool_call 예시의 args 가 그 tool 의 required 필드를 채운 유효 JSON 이다", () => {
    const { toolCallExample } = buildEnvelopeExamples(TOOLS);
    const envelope = JSON.parse(toolCallExample) as {
      result: { toolCalls: Array<{ toolName: string; args: string }> };
    };
    const call = envelope.result.toolCalls[0]!;

    expect(call.toolName).toBe("lookup");
    const args = JSON.parse(call.args) as Record<string, unknown>;
    // lookup inputSchema: required ["key"] (string)
    expect(typeof args.key).toBe("string");
  });

  it("tools 만이면 answer 는 평문 string 안내다", () => {
    const rendered = renderToolEnvelopePrompt(TOOLS);

    expect(rendered).toContain("plain string");
    expect(rendered).not.toContain("<answer-json-schema>");
  });
});

describe("renderSchemaContractPrompt", () => {
  it("tools 가 있으면 envelope, 스키마만 있으면 output format, 둘 다 없으면 undefined", () => {
    expect(renderSchemaContractPrompt({ tools: TOOLS, jsonSchema: USER_SCHEMA })).toContain(
      "Client Tool Protocol",
    );
    expect(renderSchemaContractPrompt({ jsonSchema: USER_SCHEMA })).toContain("Output Format");
    expect(renderSchemaContractPrompt({})).toBeUndefined();
    expect(renderSchemaContractPrompt({ tools: [] })).toBeUndefined();
  });
});

// 예시 JSON 이 실제 parseEnvelope 를 통과하는 교차 계약 테스트는 tool-emulation.test.ts 에
// 있다("schema-prompt 예시 ↔ envelope 교차 계약") — 이 파일은 렌더러만 import 해 가볍게
// 유지한다(isolate:false 공유 레지스트리에서 실모듈 로드가 mock 파일을 오염시키는 것 방지).
describe("envelope 예시 문자열", () => {
  it("렌더 문서에 실리는 예시 문자열이 실제로 그 문서 안에 있다", () => {
    const { toolCallExample, textAnswerExample } = buildEnvelopeExamples(TOOLS);

    expect(renderToolEnvelopePrompt(TOOLS)).toContain(toolCallExample);
    expect(renderToolEnvelopePrompt(TOOLS)).toContain(textAnswerExample);
    // json answer 변형은 유효한 리터럴 예시를 만들 수 없으므로 예시 없이 프로즈로만 —
    // text answer 예시(string)가 json 모드 문서에 섞이면 모델이 string 을 베낀다.
    expect(renderToolEnvelopePrompt(TOOLS, USER_SCHEMA)).not.toContain(textAnswerExample);
  });
});
