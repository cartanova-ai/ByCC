import { describe, expect, it } from "vitest";

import { type JsonValue } from "../../../codex-protocol/serde_json/JsonValue";
import { type UserInput } from "../../../codex-protocol/v2/UserInput";
import {
  buildStreamJsonInput,
  type ClaudeStreamJsonLine,
  serializeStreamJsonInput,
} from "./stream-json-adapter";

function userText(text: string): Array<UserInput> {
  return [{ type: "text", text, text_elements: [] }];
}

// 실행 가능한 user 줄 개수 — 항상 정확히 1이어야 함 (codex P0-1/P0-2 핵심 불변식).
function userLineCount(lines: Array<ClaudeStreamJsonLine>): number {
  return lines.filter((l) => l.type === "user").length;
}

describe("buildStreamJsonInput", () => {
  it("happy: 단일 user input → user 1줄", () => {
    const lines = buildStreamJsonInput({ input: userText("안녕"), isResume: false });
    expect(lines).toHaveLength(1);
    expect(userLineCount(lines)).toBe(1);
    expect(lines[0]).toEqual({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "안녕" }] },
    });
  });

  it("멀티턴 cold: history 는 단일 assistant context 로 평탄화, 실행 user 는 1줄만 (P0-1/P0-2)", () => {
    const coldHistory: Array<JsonValue> = [
      { type: "message", role: "user", content: [{ type: "input_text", text: "비밀번호는 PURPLE" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "기억할게" }] },
    ];
    const lines = buildStreamJsonInput({
      coldHistory,
      input: userText("비밀번호 뭐였지?"),
      isResume: false,
    });
    // assistant context 1줄 + 실행 user 1줄
    expect(lines).toHaveLength(2);
    // 실행 가능한 user 줄은 정확히 1개 (과거 user 가 재실행되지 않음)
    expect(userLineCount(lines)).toBe(1);
    expect(lines[0]!.type).toBe("assistant");
    expect(lines[0]!.message.content[0]!.text).toContain("User: 비밀번호는 PURPLE");
    expect(lines[0]!.message.content[0]!.text).toContain("Assistant: 기억할게");
    expect(lines[1]!).toEqual({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "비밀번호 뭐였지?" }] },
    });
  });

  it("resume: reuseInput(delta) user 1줄만, history 미포함", () => {
    const lines = buildStreamJsonInput({
      coldHistory: [
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "이전 답변" }] },
      ],
      input: userText("다음 질문"),
      isResume: true,
    });
    expect(lines).toHaveLength(1);
    expect(userLineCount(lines)).toBe(1);
    expect(lines[0]).toEqual({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "다음 질문" }] },
    });
  });

  it("정규화: content 는 항상 block 배열 (KTD5 구현계약)", () => {
    const lines = buildStreamJsonInput({ input: userText("x"), isResume: false });
    expect(Array.isArray(lines[0]!.message.content)).toBe(true);
    expect(lines[0]!.message.content[0]).toHaveProperty("type", "text");
  });

  it("tool history(KTD10): function_call/output 도 assistant context 로 평탄화, 실행 user 1줄만", () => {
    const coldHistory: Array<JsonValue> = [
      { type: "function_call", name: "rollDice", arguments: '{"sides":20}', call_id: "tu_1" },
      { type: "function_call_output", call_id: "tu_1", output: "17" },
    ];
    const lines = buildStreamJsonInput({ coldHistory, input: userText("결과는?"), isResume: false });
    // assistant context 1줄 + 실행 user 1줄
    expect(lines).toHaveLength(2);
    expect(userLineCount(lines)).toBe(1); // tool output 이 user 로 재실행되지 않음 (P0-2)
    expect(lines[0]!.type).toBe("assistant");
    const ctx = lines[0]!.message.content[0]!.text;
    expect(ctx).toContain("Tool call: rollDice");
    expect(ctx).toContain("Tool result: 17");
    // native tool_use / tool_result 블록이 없어야 함 (text 만)
    for (const line of lines) {
      expect(line.message.content.every((c) => c.type === "text")).toBe(true);
    }
  });

  it("edge: 빈 coldHistory → user 1줄만 (assistant context 안 만듦)", () => {
    const lines = buildStreamJsonInput({ coldHistory: [], input: userText("단발"), isResume: false });
    expect(lines).toHaveLength(1);
    expect(lines[0]!.type).toBe("user");
    expect(lines[0]!.message.content[0]!.text).toBe("단발");
  });

  it("edge: assistant 만 연속인 history → assistant context 1줄 + user 1줄", () => {
    const coldHistory: Array<JsonValue> = [
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "a1" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "a2" }] },
    ];
    const lines = buildStreamJsonInput({ coldHistory, input: userText("q"), isResume: false });
    expect(lines).toHaveLength(2);
    expect(userLineCount(lines)).toBe(1);
    expect(lines[0]!.type).toBe("assistant");
    expect(lines[0]!.message.content[0]!.text).toContain("a1");
    expect(lines[0]!.message.content[0]!.text).toContain("a2");
  });

  it("불변식: cold 경로에서도 실행 user 줄은 절대 1개 초과 금지", () => {
    const coldHistory: Array<JsonValue> = [
      { type: "message", role: "user", content: [{ type: "input_text", text: "u1" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "a1" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "u2" }] },
      { type: "function_call_output", call_id: "x", output: "out" },
    ];
    const lines = buildStreamJsonInput({ coldHistory, input: userText("final"), isResume: false });
    expect(userLineCount(lines)).toBe(1);
    expect(lines[lines.length - 1]!.message.content[0]!.text).toBe("final");
  });
});

describe("serializeStreamJsonInput", () => {
  it("JSONL 한 줄당 하나 + 마지막 개행", () => {
    const lines = buildStreamJsonInput({ input: userText("hi"), isResume: false });
    const out = serializeStreamJsonInput(lines);
    expect(out.endsWith("\n")).toBe(true);
    const parsed = out
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.message.role).toBe("user");
  });
});
