import { describe, expect, it } from "vitest";

import { CALLER_SCHEMA_LIMITS } from "../../utils/providers/common/schema-validation";
import { type QgridTool } from "./qgrid.types";
import { applyToolCallEmulation, ToolCallEmulationError } from "./tool-emulation";

const baseResult = {
  text: "",
  tokenName: "token",
  model: "gpt-5.6-terra",
  usage: {
    input_tokens: 1,
    output_tokens: 1,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  },
  durationMs: 10,
  ttftMs: 0,
  costUsd: 0,
  costSource: "pricing_table" as const,
};

describe("applyToolCallEmulation image parts", () => {
  const img = { data: "iVBORw0KGgoBAgM", revisedPrompt: "a red circle" };

  it("appends an image part after text when images are present (no tools)", () => {
    const out = applyToolCallEmulation({ ...baseResult, text: "here is your image" }, undefined, {
      images: [img],
      answerKind: "text",
    });
    expect(out.content).toEqual([
      { type: "text", text: "here is your image" },
      { type: "image", data: "iVBORw0KGgoBAgM", revisedPrompt: "a red circle" },
    ]);
    // 이미지는 finishReason 과 직교 — 여전히 stop.
    expect(out.finishReason).toBe("stop");
  });

  it("appends multiple images preserving order", () => {
    const out = applyToolCallEmulation({ ...baseResult, text: "here is your image" }, undefined, {
      answerKind: "text",
      images: [
        { data: "iVBORw0KGgoAAA", revisedPrompt: "one" },
        { data: "iVBORw0KGgoBBB", revisedPrompt: "two" },
      ],
    });
    const images = out.content.filter((c) => c.type === "image");
    expect(images).toHaveLength(2);
    expect(images.map((c) => (c.type === "image" ? c.revisedPrompt : null))).toEqual(["one", "two"]);
  });

  it("leaves content unchanged when no images are passed (regression guard)", () => {
    const out = applyToolCallEmulation({ ...baseResult, text: "here is your image" }, undefined, {
      answerKind: "text",
    });
    expect(out.content).toEqual([{ type: "text", text: "here is your image" }]);
  });
});

describe("applyToolCallEmulation envelope validation", () => {
  const tools: QgridTool[] = [
    {
      name: "lookup",
      inputSchema: {
        type: "object",
        properties: { key: { type: "string" } },
        required: ["key"],
      },
    },
  ];

  function applyEnvelope(result: unknown, answerKind: "text" | "json" = "json") {
    return applyToolCallEmulation({ ...baseResult, text: JSON.stringify({ result }) }, tools, {
      answerKind,
    });
  }

  it("returns a text answer verbatim without JSON quoting", () => {
    const out = applyEnvelope({ action: "answer", answer: "done", toolCalls: null }, "text");

    expect(out.text).toBe("done");
    expect(out.content).toEqual([{ type: "text", text: "done" }]);
    expect(out.finishReason).toBe("stop");
  });

  it.each([
    [{ translated: "완료" }, '{"translated":"완료"}'],
    [["first", 2, true], '["first",2,true]'],
    ["scalar", '"scalar"'],
    [42, "42"],
    [false, "false"],
  ])("serializes json answer %j as JSON text", (answer, expected) => {
    const out = applyEnvelope({ action: "answer", answer, toolCalls: null });

    expect(out.text).toBe(expected);
    expect(out.content).toEqual([{ type: "text", text: expected }]);
    expect(out.finishReason).toBe("stop");
  });

  it("preserves prototype-sensitive keys in a json answer", () => {
    const out = applyToolCallEmulation(
      {
        ...baseResult,
        text: String.raw`{"result":{"action":"answer","answer":{"__proto__":"kept","nested":{"__proto__":1}},"toolCalls":null}}`,
      },
      tools,
      { answerKind: "json" },
    );

    expect(out.text).toBe(String.raw`{"__proto__":"kept","nested":{"__proto__":1}}`);
  });

  it("maps a coherent non-empty tool_call branch", () => {
    const out = applyEnvelope({
      action: "tool_call",
      answer: null,
      toolCalls: [{ toolName: "lookup", args: '{"key":"value"}' }],
    });

    expect(out.content).toEqual([
      expect.objectContaining({
        type: "tool-call",
        toolName: "lookup",
        input: '{"key":"value"}',
      }),
    ]);
    expect(out.finishReason).toBe("tool-calls");
  });

  // 퇴화 조합 전수 거부 — 과거 관용 디코더가 이들을 조용히 통과시켜 envelope 원문이
  // 최종 답변으로 흘러나간 실사고(2026-07 medpath 13.5k 건)가 있었다. 관용 폴백 금지.
  it.each([
    [{ action: "answer", answer: null, toolCalls: null }],
    [{ action: "answer", toolCalls: [] }],
    [{ action: "answer", answer: "done", toolCalls: [] }],
    [{ action: "unexpected", answer: "done", toolCalls: null }],
    [{ answer: "done", toolCalls: null }],
    [{ action: "tool_call", answer: null, toolCalls: null }],
    [{ action: "tool_call", answer: null, toolCalls: [] }],
    [{ action: "tool_call", answer: "mixed", toolCalls: [{ toolName: "lookup", args: "{}" }] }],
    [{ action: "tool_call", answer: null, toolCalls: [{ toolName: "lookup" }] }],
    [{ action: "answer", answer: { ok: true }, toolCalls: null, extra: true }],
    [
      {
        action: "tool_call",
        answer: null,
        toolCalls: [{ toolName: "lookup", args: "{}", extra: true }],
      },
    ],
    [42],
    [["not", "an", "object"]],
  ])("rejects degenerate envelope %j in json mode", (result) => {
    expect(() => applyEnvelope(result)).toThrowError(ToolCallEmulationError);
  });

  it.each([
    [{ action: "answer", answer: null, toolCalls: null }],
    [{ action: "answer", answer: { ok: true }, toolCalls: null }],
    [{ action: "tool_call", answer: null, toolCalls: [] }],
  ])("rejects degenerate envelope %j in text mode too", (result) => {
    expect(() => applyEnvelope(result, "text")).toThrowError(ToolCallEmulationError);
  });

  it("rejects an envelope missing the result wrapper", () => {
    expect(() =>
      applyToolCallEmulation(
        { ...baseResult, text: '{"action":"answer","answer":"done","toolCalls":null}' },
        tools,
        { answerKind: "text" },
      ),
    ).toThrowError(ToolCallEmulationError);
  });

  it("rejects unknown tools after decoding a tool call", () => {
    expect(() =>
      applyEnvelope({
        action: "tool_call",
        answer: null,
        toolCalls: [{ toolName: "missing", args: "{}" }],
      }),
    ).toThrowError(/unknown emulated tool/);
  });

  it.each(["text", "json"] as const)(
    "fails malformed outer JSON explicitly in %s mode (no text rescue)",
    (answerKind) => {
      expect(() =>
        applyToolCallEmulation({ ...baseResult, text: "not-json" }, tools, { answerKind }),
      ).toThrowError(ToolCallEmulationError);
    },
  );

  it("rejects a deeply nested envelope without overflowing the stack", () => {
    let answer: unknown = 0;
    for (let depth = 0; depth < CALLER_SCHEMA_LIMITS.maxDepth + 5; depth += 1) {
      answer = [answer];
    }

    try {
      applyEnvelope({ action: "answer", answer, toolCalls: null });
      throw new Error("expected the envelope to be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(ToolCallEmulationError);
      expect(error).not.toBeInstanceOf(RangeError);
      expect((error as Error).message).toContain("depth limit");
    }
  });

  it("rejects envelopes above the node budget", () => {
    expect(() =>
      applyEnvelope({
        action: "answer",
        answer: Array.from({ length: CALLER_SCHEMA_LIMITS.maxNodes }, () => 0),
        toolCalls: null,
      }),
    ).toThrowError(/exceeds node limit/);
  });

  it("rejects envelopes above the UTF-8 byte budget before parsing", () => {
    const text = JSON.stringify({
      result: {
        action: "answer",
        answer: "x".repeat(CALLER_SCHEMA_LIMITS.maxUtf8Bytes),
        toolCalls: null,
      },
    });

    expect(() =>
      applyToolCallEmulation({ ...baseResult, text }, tools, { answerKind: "json" }),
    ).toThrowError(/exceeds UTF-8 byte limit/);
  });

  it("preserves images after a json final answer", () => {
    const out = applyToolCallEmulation(
      {
        ...baseResult,
        text: '{"result":{"action":"answer","answer":{"ok":true},"toolCalls":null}}',
      },
      tools,
      {
        images: [{ data: "image-data", revisedPrompt: "revised" }],
        answerKind: "json",
      },
    );

    expect(out.content).toEqual([
      { type: "text", text: '{"ok":true}' },
      { type: "image", data: "image-data", revisedPrompt: "revised" },
    ]);
  });

  it.each([
    '{"result":{"action":"answer","answer":1e400,"toolCalls":null}}',
    '{"result":{"action":"answer","answer":{"nested":1e400},"toolCalls":null}}',
  ])("rejects non-finite JSON numbers: %s", (text) => {
    expect(() =>
      applyToolCallEmulation({ ...baseResult, text }, tools, { answerKind: "json" }),
    ).toThrowError(/answer must be valid JSON/);
  });
});
