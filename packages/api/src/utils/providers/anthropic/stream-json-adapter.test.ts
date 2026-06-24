import { describe, expect, it } from "vitest";

import { type JsonValue } from "../../../codex-protocol/serde_json/JsonValue";
import { type UserInput } from "../../../codex-protocol/v2/UserInput";
import {
  buildStreamJsonInput,
  type ClaudeStreamJsonState,
  type ClaudeStreamJsonLine,
  handleStreamJsonLine,
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
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "비밀번호는 PURPLE" }],
      },
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
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "이전 답변" }],
        },
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
    const lines = buildStreamJsonInput({
      coldHistory,
      input: userText("결과는?"),
      isResume: false,
    });
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
    const lines = buildStreamJsonInput({
      coldHistory: [],
      input: userText("단발"),
      isResume: false,
    });
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

// 출력 어댑터(U3): 라인을 onDelta 와 함께 흘려 delta 수집 + 최종 result 반환.
function runLines(
  lines: Array<string>,
  opts?: { structuredOutput?: boolean; state?: ClaudeStreamJsonState },
): {
  deltas: Array<string>;
  result: ReturnType<typeof handleStreamJsonLine>;
  state: ClaudeStreamJsonState;
} {
  const deltas: Array<string> = [];
  let result: ReturnType<typeof handleStreamJsonLine> = null;
  const state = opts?.state ?? {};
  for (const line of lines) {
    const r = handleStreamJsonLine(line, (t) => deltas.push(t), { ...opts, state });
    if (r) result = r;
  }
  return { deltas, result, state };
}

function streamEvent(deltaType: string, payload: Record<string, unknown>): string {
  return JSON.stringify({
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: deltaType, ...payload } },
  });
}

describe("handleStreamJsonLine (출력 어댑터)", () => {
  it("happy text: text_delta → onDelta×N, result → text 수집", () => {
    const { deltas, result } = runLines([
      streamEvent("text_delta", { text: "안" }),
      streamEvent("text_delta", { text: "녕" }),
      JSON.stringify({ type: "result", result: "안녕", usage: { output_tokens: 2 } }),
    ]);
    expect(deltas).toEqual(["안", "녕"]);
    expect(result!.text).toBe("안녕");
    expect(result!.isError).toBe(false);
    expect(result!.quotaExhausted).toBe(false);
  });

  it("streamObject(structured 모드): partial_json 조각 → onDelta, 누적 시 유효 JSON", () => {
    const { deltas, result } = runLines(
      [
        streamEvent("input_json_delta", { partial_json: '{"name":"Marg' }),
        streamEvent("input_json_delta", { partial_json: 'uerite","age":34}' }),
        JSON.stringify({
          type: "result",
          structured_output: { name: "Marguerite", age: 34 },
          usage: { output_tokens: 10 },
        }),
      ],
      { structuredOutput: true },
    );
    expect(deltas.join("")).toBe('{"name":"Marguerite","age":34}');
    expect(JSON.parse(result!.text)).toEqual({ name: "Marguerite", age: 34 });
  });

  it("streamObject 혼합(P0): structured 모드에서 자연어 text_delta 는 버리고 partial_json 만 onDelta", () => {
    const { deltas } = runLines(
      [
        // Claude 가 JSON 앞에 자연어를 흘리는 PoC 실패 모드 재현
        streamEvent("text_delta", { text: "Here is the JSON:" }),
        streamEvent("input_json_delta", { partial_json: '{"a":' }),
        streamEvent("text_delta", { text: " (thinking)" }),
        streamEvent("input_json_delta", { partial_json: "1}" }),
      ],
      { structuredOutput: true },
    );
    // 오직 JSON 조각만 — prose 가 섞이면 client streamObject 파서가 깨짐
    expect(deltas.join("")).toBe('{"a":1}');
    expect(deltas).not.toContain("Here is the JSON:");
    expect(deltas).not.toContain(" (thinking)");
  });

  it("structured tool-call: 첫 StructuredOutput은 보존하되 max_turns result는 error 유지", () => {
    const first = {
      action: "tool_call",
      answer: null,
      toolCalls: [{ toolName: "getWeather", args: '{"city":"Seoul"}' }],
    };
    const later = {
      action: "answer",
      answer: "tool unavailable",
      toolCalls: null,
    };
    const { result } = runLines(
      [
        JSON.stringify({
          type: "assistant",
          message: {
            content: [{ type: "tool_use", name: "StructuredOutput", input: first }],
          },
        }),
        JSON.stringify({
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                is_error: true,
                content: "Output does not match required schema",
              },
            ],
          },
        }),
        JSON.stringify({
          type: "assistant",
          message: {
            content: [{ type: "tool_use", name: "StructuredOutput", input: later }],
          },
        }),
        JSON.stringify({
          type: "result",
          subtype: "error_max_turns",
          terminal_reason: "max_turns",
          structured_output: later,
          usage: { input_tokens: 10, cache_creation_input_tokens: 20, output_tokens: 30 },
          duration_ms: 1234,
          total_cost_usd: 0.0042,
        }),
      ],
      { structuredOutput: true },
    );

    expect(JSON.parse(result!.text)).toEqual(first);
    expect(result!.isError).toBe(true);
    expect(result!.usage.inputTokens).toBe(30);
    expect(result!.usage.outputTokens).toBe(30);
    expect(result!.durationMs).toBe(1234);
    expect(result!.costUsd).toBe(0.0042);
  });

  it("text 모드: partial_json 이 와도 무시, text_delta 만", () => {
    const { deltas } = runLines(
      [
        streamEvent("text_delta", { text: "hello" }),
        streamEvent("input_json_delta", { partial_json: '{"x":1}' }),
      ],
      { structuredOutput: false },
    );
    expect(deltas).toEqual(["hello"]);
  });

  it("usage: 4 카테고리 → TokenUsageBreakdown (inputTokens 는 cache 포함 전체 입력)", () => {
    const { result } = runLines([
      JSON.stringify({
        type: "result",
        result: "ok",
        usage: {
          input_tokens: 10,
          cache_creation_input_tokens: 2274,
          cache_read_input_tokens: 14853,
          output_tokens: 111,
        },
      }),
    ]);
    expect(result!.usage).toEqual({
      totalTokens: 10 + 2274 + 14853 + 111,
      inputTokens: 10 + 2274 + 14853,
      cachedInputTokens: 14853,
      cacheCreationInputTokens: 2274,
      outputTokens: 111,
      reasoningOutputTokens: 0,
    });
  });

  it("structured_output 우선, 없으면 result(코드펜스 제거)", () => {
    const fenced = runLines([
      JSON.stringify({ type: "result", result: '```json\n{"a":1}\n```', usage: {} }),
    ]);
    expect(fenced.result!.text).toBe('{"a":1}');
  });

  it("stripCodeFence(P2): 앞뒤 공백/개행 있는 펜스도 깨끗이 제거", () => {
    const r = runLines([
      JSON.stringify({ type: "result", result: '\n```json\n{"b":2}\n```\n', usage: {} }),
    ]);
    expect(r.result!.text).toBe('{"b":2}');
  });

  it("error(P1): is_error / terminal model_error / error_* subtype → isError true", () => {
    const cases = [
      { is_error: true, result: "boom" },
      { terminal_reason: "model_error", result: "x" },
      { subtype: "error_during_execution", result: "x" },
      { subtype: "error_max_turns", result: "x" },
      { subtype: "error_max_budget_usd", result: "x" },
      { subtype: "error_max_structured_output_retries", result: "x" },
    ];
    for (const c of cases) {
      const { result } = runLines([JSON.stringify({ type: "result", usage: {}, ...c })]);
      expect(result!.isError, JSON.stringify(c)).toBe(true);
    }
  });

  it("success(P1): subtype==='success' 또는 subtype 없음 → isError false", () => {
    const ok1 = runLines([
      JSON.stringify({ type: "result", subtype: "success", result: "ok", usage: {} }),
    ]);
    expect(ok1.result!.isError).toBe(false);
    const ok2 = runLines([JSON.stringify({ type: "result", result: "ok", usage: {} })]);
    expect(ok2.result!.isError).toBe(false);
  });

  it("quota: result text가 'You've hit'로 시작 → quotaExhausted true", () => {
    const { result } = runLines([
      JSON.stringify({ type: "result", result: "You've hit your limit", usage: {} }),
    ]);
    expect(result!.quotaExhausted).toBe(true);
  });

  it("깨진 JSON 라인 / 빈 줄 → graceful skip (null)", () => {
    expect(handleStreamJsonLine("not json {{{", () => {})).toBeNull();
    expect(handleStreamJsonLine("", () => {})).toBeNull();
    expect(handleStreamJsonLine("   ", () => {})).toBeNull();
  });

  it("system/init 등 비-result/비-delta 이벤트 → null, delta 없음", () => {
    const deltas: Array<string> = [];
    const r = handleStreamJsonLine(
      JSON.stringify({ type: "system", subtype: "init", session_id: "x" }),
      (t) => deltas.push(t),
    );
    expect(r).toBeNull();
    expect(deltas).toHaveLength(0);
  });
});
