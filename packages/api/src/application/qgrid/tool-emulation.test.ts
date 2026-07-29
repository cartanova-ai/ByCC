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
    const out = applyToolCallEmulation(
      { ...baseResult, text: "here is your image" },
      undefined,
      { images: [img], answerMode: "legacy" },
    );
    expect(out.content).toEqual([
      { type: "text", text: "here is your image" },
      { type: "image", data: "iVBORw0KGgoBAgM", revisedPrompt: "a red circle" },
    ]);
    // 이미지는 finishReason 과 직교 — 여전히 stop.
    expect(out.finishReason).toBe("stop");
  });

  it("appends multiple images preserving order", () => {
    const out = applyToolCallEmulation(
      { ...baseResult, text: "here is your image" },
      undefined,
      {
        answerMode: "legacy",
        images: [
          { data: "iVBORw0KGgoAAA", revisedPrompt: "one" },
          { data: "iVBORw0KGgoBBB", revisedPrompt: "two" },
        ],
      },
    );
    const images = out.content.filter((c) => c.type === "image");
    expect(images).toHaveLength(2);
    expect(images.map((c) => (c.type === "image" ? c.revisedPrompt : null))).toEqual(["one", "two"]);
  });

  it("leaves content unchanged when no images are passed (regression guard)", () => {
    const out = applyToolCallEmulation({ ...baseResult, text: "here is your image" }, undefined, {
      answerMode: "legacy",
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

  function applyEnvelope(
    envelope: unknown,
    answerMode: "legacy" | "structured" = "structured",
  ) {
    return applyToolCallEmulation(
      { ...baseResult, text: JSON.stringify(envelope) },
      tools,
      { answerMode },
    );
  }

  it("preserves a legacy tools-only string answer", () => {
    const out = applyEnvelope(
      { action: "answer", answer: "done", toolCalls: null },
      "legacy",
    );

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
  ])("serializes structured answer %j as JSON text", (answer, expected) => {
    const out = applyEnvelope({ action: "answer", answer, toolCalls: null });

    expect(out.text).toBe(expected);
    expect(out.content).toEqual([{ type: "text", text: expected }]);
    expect(out.finishReason).toBe("stop");
  });

  it("preserves prototype-sensitive keys in a structured answer", () => {
    const out = applyToolCallEmulation(
      {
        ...baseResult,
        text: String.raw`{"action":"answer","answer":{"__proto__":"kept","nested":{"__proto__":1}},"toolCalls":null}`,
      },
      tools,
      { answerMode: "structured" },
    );

    expect(out.text).toBe(
      String.raw`{"__proto__":"kept","nested":{"__proto__":1}}`,
    );
  });

  it("accepts null or empty toolCalls on a structured answer branch", () => {
    for (const envelope of [
      { action: "answer", answer: { ok: true }, toolCalls: null },
      { action: "answer", answer: { ok: true }, toolCalls: [] },
    ]) {
      expect(applyEnvelope(envelope).text).toBe('{"ok":true}');
    }
  });

  it("keeps absent toolCalls compatible on a legacy answer branch", () => {
    expect(applyEnvelope({ action: "answer", answer: "done" }, "legacy").text).toBe("done");
  });

  it.each([
    [{ action: "answer", answer: null, toolCalls: null }, undefined],
    [{ action: "answer", toolCalls: [] }, undefined],
    [{ action: "unexpected", answer: "fallback answer", toolCalls: null }, "fallback answer"],
    [{ answer: "", toolCalls: null }, ""],
    [42, undefined],
  ])("preserves tolerant legacy final-answer fallback for %j", (envelope, expected) => {
    const outerText = JSON.stringify(envelope);
    const out = applyToolCallEmulation(
      { ...baseResult, text: outerText },
      tools,
      { answerMode: "legacy" },
    );

    expect(out.text).toBe(expected ?? outerText);
    expect(out.finishReason).toBe("stop");
  });

  it.each([
    { action: "tool_call", answer: null, toolCalls: null },
    { action: "tool_call", answer: null },
    { action: "tool_call", answer: null, toolCalls: [] },
  ])("preserves tolerant legacy empty tool_call envelopes: %j", (envelope) => {
    const out = applyEnvelope(envelope, "legacy");

    expect(out.content).toEqual([]);
    expect(out.finishReason).toBe("tool-calls");
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

  it.each([
    { action: "answer", answer: null, toolCalls: null },
    { action: "answer", answer: "done", toolCalls: [{}] },
    { action: "tool_call", answer: "mixed", toolCalls: [{}] },
    { action: "tool_call", answer: null, toolCalls: [] },
    { action: "tool_call", answer: null, toolCalls: [{ toolName: "lookup" }] },
    { action: "unexpected", answer: "done", toolCalls: null },
    ["not", "an", "object"],
    { action: "answer", answer: { ok: true } },
    { action: "answer", answer: { ok: true }, toolCalls: null, extra: true },
    {
      action: "tool_call",
      answer: null,
      toolCalls: [{ toolName: "lookup", args: "{}", extra: true }],
    },
  ])("rejects incoherent structured envelope %j", (envelope) => {
    expect(() => applyEnvelope(envelope)).toThrowError(ToolCallEmulationError);
  });

  it("rejects unknown tools after decoding a structured tool call", () => {
    expect(() =>
      applyEnvelope({
        action: "tool_call",
        answer: null,
        toolCalls: [{ toolName: "missing", args: "{}" }],
      }),
    ).toThrowError(/unknown emulated tool/);
  });

  it("does not apply the structured decoder to legacy responses", () => {
    const answer = { ok: true };
    const out = applyEnvelope(
      { action: "answer", answer, toolCalls: [{ ignored: true }] },
      "legacy",
    );

    expect(out.text).toEqual(answer);
  });

  it("fails malformed outer JSON explicitly in structured mode", () => {
    expect(() =>
      applyToolCallEmulation(
        { ...baseResult, text: "not-json" },
        tools,
        { answerMode: "structured" },
      ),
    ).toThrowError(ToolCallEmulationError);
  });

  it("rejects a deeply nested structured envelope without overflowing the stack", () => {
    let answer: unknown = 0;
    for (let depth = 0; depth < CALLER_SCHEMA_LIMITS.maxDepth + 5; depth += 1) {
      answer = [answer];
    }

    try {
      applyEnvelope({ action: "answer", answer, toolCalls: null });
      throw new Error("expected the structured envelope to be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(ToolCallEmulationError);
      expect(error).not.toBeInstanceOf(RangeError);
      expect((error as Error).message).toContain("depth limit");
    }
  });

  it("rejects structured envelopes above the node budget", () => {
    expect(() =>
      applyEnvelope({
        action: "answer",
        answer: Array.from({ length: CALLER_SCHEMA_LIMITS.maxNodes }, () => 0),
        toolCalls: null,
      }),
    ).toThrowError(/structured-output envelope exceeds node limit/);
  });

  it("rejects structured envelopes above the UTF-8 byte budget before parsing", () => {
    const text = JSON.stringify({
      action: "answer",
      answer: "x".repeat(CALLER_SCHEMA_LIMITS.maxUtf8Bytes),
      toolCalls: null,
    });

    expect(() =>
      applyToolCallEmulation(
        { ...baseResult, text },
        tools,
        { answerMode: "structured" },
      ),
    ).toThrowError(/structured-output envelope exceeds UTF-8 byte limit/);
  });

  it("preserves malformed outer JSON fallback in legacy mode", () => {
    const out = applyToolCallEmulation({ ...baseResult, text: "not-json" }, tools, {
      answerMode: "legacy",
    });

    expect(out.text).toBe("not-json");
    expect(out.content).toEqual([{ type: "text", text: "not-json" }]);
    expect(out.finishReason).toBe("stop");
  });

  it("preserves images after a structured final answer", () => {
    const out = applyToolCallEmulation(
      {
        ...baseResult,
        text: '{"action":"answer","answer":{"ok":true},"toolCalls":null}',
      },
      tools,
      {
        images: [{ data: "image-data", revisedPrompt: "revised" }],
        answerMode: "structured",
      },
    );

    expect(out.content).toEqual([
      { type: "text", text: '{"ok":true}' },
      { type: "image", data: "image-data", revisedPrompt: "revised" },
    ]);
  });

  it.each([
    '{"action":"answer","answer":1e400,"toolCalls":null}',
    '{"action":"answer","answer":{"nested":1e400},"toolCalls":null}',
  ])("rejects non-finite JSON numbers: %s", (text) => {
    expect(() =>
      applyToolCallEmulation({ ...baseResult, text }, tools, {
        answerMode: "structured",
      }),
    ).toThrowError(/answer must be valid JSON/);
  });
});
