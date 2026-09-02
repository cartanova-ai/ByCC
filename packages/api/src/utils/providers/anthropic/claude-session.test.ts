import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { ANTHROPIC_CONFIG_DIR_BASE, anthropicConfigDir } from "./anthropic-constants";
import {
  applyOneMillionSuffix,
  buildClaudeArgs,
  decorateAndSerialize,
  ensureConfigDir,
  makeAnthropicWorkerId,
  oneMillionEnv,
  runClaudeSession,
  shouldPinStructuredRetries,
  structuredOutputRetriesEnv,
  thinkingEnv,
  SYSTEM_PROMPT_ARGV_MAX_BYTES,
  withSessionLock,
} from "./claude-session";
import { buildStreamJsonInput } from "./stream-json-adapter";

describe("makeAnthropicWorkerId (coord 매핑 P0-2)", () => {
  it("tokenId 기반 안정 합성", () => {
    expect(makeAnthropicWorkerId(7)).toBe(7);
    expect(makeAnthropicWorkerId(42)).toBe(42);
  });
});

describe("anthropicConfigDir (R10 토큰 격리 계약 — U6 구조 검증)", () => {
  it("tokenId 별로 다른 config dir", () => {
    expect(anthropicConfigDir(1)).not.toBe(anthropicConfigDir(2));
  });

  it("격리 단위는 tokenId — session-id 와 무관하게 토큰별로 config dir 이 갈린다 (transcript 안 섞임)", () => {
    // CLAUDE_CONFIG_DIR 은 session-id 가 아니라 tokenId 로만 결정된다(이 함수는 session-id 를 입력으로
    // 받지도 않는다). 따라서 두 토큰이 우연히 같은 claude session-id 를 쓰더라도 transcript 저장
    // 위치(config dir)가 토큰별로 분리되어 오염되지 않는다 — tokenId 가 격리 단위.
    const dirForToken1 = anthropicConfigDir(1);
    const dirForToken2 = anthropicConfigDir(2);
    expect(dirForToken1).not.toBe(dirForToken2);
  });

  it("base 하위 경로 + tokenId 안정", () => {
    expect(anthropicConfigDir(7)).toBe(`${ANTHROPIC_CONFIG_DIR_BASE}/7`);
    expect(anthropicConfigDir(7)).toBe(anthropicConfigDir(7)); // 결정적
  });
});

describe("ensureConfigDir (R10 격리 seed self-healing)", () => {
  it("이미 ensure 한 tokenId 라도 seed 파일을 매 호출 복구한다", () => {
    const tokenId = -990001;
    const dir = anthropicConfigDir(tokenId);
    rmSync(dir, { recursive: true, force: true });

    try {
      expect(ensureConfigDir(tokenId)).toBe(dir);
      expect(readFileSync(`${dir}/.claude.json`, "utf8")).toBe("{}");
      expect(readFileSync(`${dir}/settings.json`, "utf8")).toBe("{}");

      writeFileSync(`${dir}/.claude.json`, '{"mutated":true}');
      writeFileSync(`${dir}/settings.json`, '{"hooks":{"UserPromptSubmit":[{}]}}');
      ensureConfigDir(tokenId);
      expect(readFileSync(`${dir}/.claude.json`, "utf8")).toBe("{}");
      expect(readFileSync(`${dir}/settings.json`, "utf8")).toBe("{}");

      rmSync(dir, { recursive: true, force: true });
      ensureConfigDir(tokenId);
      expect(existsSync(`${dir}/.claude.json`)).toBe(true);
      expect(existsSync(`${dir}/settings.json`)).toBe(true);
      expect(readFileSync(`${dir}/settings.json`, "utf8")).toBe("{}");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("withSessionLock (per-session 락 P0-3)", () => {
  it("같은 session-id 의 동시 호출은 직렬화된다", async () => {
    const order: Array<string> = [];
    const slow = async (tag: string, ms: number) => {
      order.push(`${tag}:start`);
      await new Promise((r) => setTimeout(r, ms));
      order.push(`${tag}:end`);
      return tag;
    };
    // 같은 세션으로 두 turn 을 동시에 던짐. 직렬화되면 A 가 끝난 뒤 B 가 시작.
    const p1 = withSessionLock("sess-1", () => slow("A", 30));
    const p2 = withSessionLock("sess-1", () => slow("B", 5));
    await Promise.all([p1, p2]);
    // A 가 먼저 완료된 뒤 B 가 시작 (겹치지 않음)
    expect(order).toEqual(["A:start", "A:end", "B:start", "B:end"]);
  });

  it("다른 session-id 는 병렬 허용 (겹쳐도 됨)", async () => {
    const events: Array<string> = [];
    const p1 = withSessionLock("a", async () => {
      events.push("a:start");
      await new Promise((r) => setTimeout(r, 20));
      events.push("a:end");
    });
    const p2 = withSessionLock("b", async () => {
      events.push("b:start");
      await new Promise((r) => setTimeout(r, 5));
      events.push("b:end");
    });
    await Promise.all([p1, p2]);
    // 다른 세션이라 b 가 a 보다 먼저 끝남 (병렬)
    expect(events.indexOf("b:end")).toBeLessThan(events.indexOf("a:end"));
  });

  it("앞 turn 이 throw 해도 다음 turn 은 실행된다", async () => {
    const ran: Array<string> = [];
    const p1 = withSessionLock("s", async () => {
      ran.push("1");
      throw new Error("boom");
    }).catch(() => {});
    const p2 = withSessionLock("s", async () => {
      ran.push("2");
    });
    await Promise.all([p1, p2]);
    expect(ran).toEqual(["1", "2"]);
  });
});

describe("buildClaudeArgs (멀티턴/격리/structured)", () => {
  it("applyOneMillionSuffix: 필요한 모델에만 [1m] suffix 를 단일 부착", () => {
    expect(applyOneMillionSuffix("claude-sonnet-4-6", true)).toBe("claude-sonnet-4-6[1m]");
    expect(applyOneMillionSuffix("claude-sonnet-4-6[1m]", true)).toBe("claude-sonnet-4-6[1m]");
    expect(applyOneMillionSuffix("claude-opus-4-8", false)).toBe("claude-opus-4-8");
  });

  it("oneMillionEnv: 지원 모델은 DISABLE_1M 을 제거하고 미지원은 유지", () => {
    expect(oneMillionEnv(true)).toEqual({});
    expect(oneMillionEnv(false)).toEqual({ CLAUDE_CODE_DISABLE_1M_CONTEXT: "1" });
  });

  it("thinkingEnv: Fable 5/5.1/Opus 5 는 adaptive thinking 을 보존하고 나머지는 비활성화", () => {
    expect(thinkingEnv("claude-fable-5-1")).toEqual({});
    expect(thinkingEnv("anthropic/claude-fable-5-1")).toEqual({});
    expect(thinkingEnv("claude-fable-5")).toEqual({});
    expect(thinkingEnv("anthropic/claude-fable-5")).toEqual({});
    expect(thinkingEnv("claude-opus-5")).toEqual({});
    expect(thinkingEnv("anthropic/claude-opus-5")).toEqual({});
    expect(thinkingEnv("claude-opus-4-8")).toEqual({
      CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING: "1",
      MAX_THINKING_TOKENS: "0",
    });
  });

  // SON-495: structured output retry 를 1 로 고정한다.
  it("structuredOutputRetriesEnv: 미설정/비정상 값은 1 로 기본 고정", () => {
    expect(structuredOutputRetriesEnv(undefined)).toEqual({ MAX_STRUCTURED_OUTPUT_RETRIES: "1" });
    expect(structuredOutputRetriesEnv("")).toEqual({ MAX_STRUCTURED_OUTPUT_RETRIES: "1" });
    expect(structuredOutputRetriesEnv("abc")).toEqual({ MAX_STRUCTURED_OUTPUT_RETRIES: "1" });
  });

  it("structuredOutputRetriesEnv: 1 미만(0, 음수)은 1 로 클램프", () => {
    expect(structuredOutputRetriesEnv("0")).toEqual({ MAX_STRUCTURED_OUTPUT_RETRIES: "1" });
    expect(structuredOutputRetriesEnv("-3")).toEqual({ MAX_STRUCTURED_OUTPUT_RETRIES: "1" });
  });

  it("structuredOutputRetriesEnv: 1 이상 값은 그대로 유지", () => {
    expect(structuredOutputRetriesEnv("1")).toEqual({ MAX_STRUCTURED_OUTPUT_RETRIES: "1" });
    expect(structuredOutputRetriesEnv("5")).toEqual({ MAX_STRUCTURED_OUTPUT_RETRIES: "5" });
  });

  // SON-495 의 retry 고정 사유(스트림 retry = wall-clock 2배)는 스트리밍에만 성립한다.
  // 논스트림 generate 까지 묶으면 1회 reject 가 곧 실패라 Claude 계열 structured 실패율이 치솟는다.
  it("shouldPinStructuredRetries: structured + 스트리밍일 때만 retry 를 고정한다", () => {
    expect(shouldPinStructuredRetries({ useStructured: true, includePartialMessages: true })).toBe(
      true,
    );
    // 논스트림 structured: CC 기본 retry 허용
    expect(shouldPinStructuredRetries({ useStructured: true, includePartialMessages: false })).toBe(
      false,
    );
    expect(shouldPinStructuredRetries({ useStructured: true })).toBe(false);
    // text 모드는 스트리밍 여부와 무관하게 영향 없음
    expect(shouldPinStructuredRetries({ useStructured: false, includePartialMessages: true })).toBe(
      false,
    );
    expect(shouldPinStructuredRetries({ useStructured: false })).toBe(false);
  });

  it("cold-only: 항상 --session-id 를 사용하고 continuation flag 는 쓰지 않는다", () => {
    const args = buildClaudeArgs({ model: "m", sessionId: "uuid-1" });
    const continuationFlag = "--resume";
    expect(args).toContain("--session-id");
    expect(args).toContain("uuid-1");
    expect(args).not.toContain(continuationFlag);
    expect(args).not.toContain("--include-partial-messages");
    // 멀티턴 필수: --no-session-persistence 없어야 함
    expect(args).not.toContain("--no-session-persistence");
    // 입력 포맷
    expect(args).toContain("--input-format");
    expect(args[args.indexOf("--input-format") + 1]).toBe("stream-json");
  });

  it("stream 호출: partial message delta 를 포함한다", () => {
    const args = buildClaudeArgs({
      model: "m",
      sessionId: "uuid-1",
      includePartialMessages: true,
    });
    expect(args).toContain("--include-partial-messages");
  });

  it("runClaudeSession: 이미 abort 된 signal 은 spawn 전에 실패한다", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      runClaudeSession(
        {
          tokenId: 999,
          token: "sk-ant-oat01-test",
          model: "haiku",
          timeoutMs: 1_000,
          input: [{ type: "text", text: "hi", text_elements: [] }],
          abortSignal: controller.signal,
        },
        () => {},
      ),
    ).rejects.toThrow("aborted");
  });

  it("structured(jsonSchema 있음): --allowed-tools StructuredOutput + --json-schema (P2-7)", () => {
    const args = buildClaudeArgs({
      model: "m",
      sessionId: "u",
      jsonSchema: '{"type":"object"}',
    });
    expect(args).toContain("--allowed-tools");
    expect(args).toContain("StructuredOutput");
    expect(args).toContain("--json-schema");
    expect(args).not.toContain("--max-turns");
  });

  it("argv 안전 한도를 넘는 structured schema를 spawn 전에 거부한다", () => {
    expect(() =>
      buildClaudeArgs({
        model: "m",
        sessionId: "u",
        jsonSchema: "x".repeat(SYSTEM_PROMPT_ARGV_MAX_BYTES + 1),
      }),
    ).toThrow("Anthropic dispatch schema exceeds argv UTF-8 byte limit");
  });

  it("1M suffix 는 CLI --model 인자에만 반영된다", () => {
    const args = buildClaudeArgs({
      model: "claude-sonnet-4-6",
      sessionId: "u",
      needsOneMillionSuffix: true,
    });
    expect(args[args.indexOf("--model") + 1]).toBe("claude-sonnet-4-6[1m]");
  });

  it("1M 기본 지원 모델은 CLI --model 에 suffix 를 붙이지 않는다", () => {
    const args = buildClaudeArgs({
      model: "claude-opus-5",
      sessionId: "u",
      needsOneMillionSuffix: false,
    });
    expect(args[args.indexOf("--model") + 1]).toBe("claude-opus-5");
  });

  it("Fable 5/5.1 은 항상 켜진 adaptive thinking 을 끄지 않고 effort 만 전달한다", () => {
    for (const model of ["claude-fable-5", "claude-fable-5-1"]) {
      const args = buildClaudeArgs({
        model,
        sessionId: "u",
        effort: "low",
      });
      expect(args[args.indexOf("--model") + 1]).toBe(model);
      expect(args).not.toContain("--thinking");
      expect(args[args.indexOf("--effort") + 1]).toBe("low");
    }
  });

  it("Opus 5 는 adaptive thinking 을 보존해 xhigh/max effort 조합도 거부되지 않게 한다", () => {
    for (const effort of ["xhigh", "max"]) {
      const args = buildClaudeArgs({
        model: "claude-opus-5",
        sessionId: "u",
        effort,
      });
      expect(args[args.indexOf("--model") + 1]).toBe("claude-opus-5");
      expect(args).not.toContain("--thinking");
      expect(args[args.indexOf("--effort") + 1]).toBe(effort);
    }
  });

  it("기존 Anthropic 모델은 thinking disabled 계약을 유지한다", () => {
    const args = buildClaudeArgs({ model: "claude-opus-4-8", sessionId: "u" });
    expect(args[args.indexOf("--thinking") + 1]).toBe("disabled");
  });

  it("non-structured(jsonSchema 없음): --allowed-tools 미부여 (P2-7)", () => {
    const args = buildClaudeArgs({ model: "m", sessionId: "u" });
    expect(args).not.toContain("--allowed-tools");
    expect(args).not.toContain("--json-schema");
    expect(args).not.toContain("--max-turns");
    // 단 --tools "" 로 전체 차단은 유지
    expect(args).toContain("--tools");
  });

  it("inline [System] 금지: --system-prompt 정식 채널 사용 (R7)", () => {
    const args = buildClaudeArgs({
      model: "m",
      system: "you are X",
      sessionId: "u",
    });
    expect(args).toContain("--system-prompt");
    expect(args[args.indexOf("--system-prompt") + 1]).toBe("you are X");
  });

  // E2BIG 회피: 대형 시스템 프롬프트는 파일 경로로 넘겨 Linux argv 한계(128KB)를 피한다.
  it("systemPromptFile 이 오면 --system-prompt-file 을 쓰고 inline --system-prompt 는 안 쓴다", () => {
    const args = buildClaudeArgs({
      model: "m",
      systemPromptFile: "/cfg/7/system-prompt-u.txt",
      sessionId: "u",
    });
    expect(args).toContain("--system-prompt-file");
    expect(args[args.indexOf("--system-prompt-file") + 1]).toBe("/cfg/7/system-prompt-u.txt");
    expect(args).not.toContain("--system-prompt");
  });

  it("systemPromptFile 이 inline system 보다 우선한다 (둘 다 와도 file 경로만)", () => {
    const args = buildClaudeArgs({
      model: "m",
      system: "ignored inline",
      systemPromptFile: "/cfg/7/sp.txt",
      sessionId: "u",
    });
    expect(args).toContain("--system-prompt-file");
    expect(args).not.toContain("--system-prompt");
    expect(args).not.toContain("ignored inline");
  });

  it("임계값(64KB)을 넘는 시스템 프롬프트가 argv 에 통째로 들어가지 않는다 (E2BIG 회귀 방지)", () => {
    const huge = "x".repeat(SYSTEM_PROMPT_ARGV_MAX_BYTES + 1);
    // 실제 호출부(runClaudeSession)는 huge 를 파일로 빼고 systemPromptFile 만 넘긴다.
    const args = buildClaudeArgs({
      model: "m",
      systemPromptFile: "/cfg/7/sp.txt",
      sessionId: "u",
    });
    // 어떤 단일 인자도 임계값을 넘지 않아야 한다(=거대 프롬프트가 argv 에 없음).
    for (const a of args) {
      expect(Buffer.byteLength(a, "utf8")).toBeLessThanOrEqual(SYSTEM_PROMPT_ARGV_MAX_BYTES);
    }
    expect(args).not.toContain(huge);
  });
});

describe("decorateAndSerialize (envelope, U2 P1-#3 위임분)", () => {
  it("각 라인에 session_id/uuid/parent_tool_use_id:null 부착 + message 보존", () => {
    const lines = buildStreamJsonInput({
      input: [{ type: "text", text: "hi", text_elements: [] }],
    });
    const out = decorateAndSerialize(lines, "sess-xyz");
    const parsed = out
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(parsed).toHaveLength(1);
    const line = parsed[0]!;
    // 최종 직렬화 shape (codex U2 리뷰가 U4에 요구한 것)
    expect(line.type).toBe("user");
    expect(line.session_id).toBe("sess-xyz");
    expect(typeof line.uuid).toBe("string");
    expect(line.uuid.length).toBeGreaterThan(0);
    expect(line.parent_tool_use_id).toBeNull();
    expect(line.message).toEqual({ role: "user", content: [{ type: "text", text: "hi" }] });
  });

  it("JSONL: 줄당 하나 + 마지막 개행", () => {
    const lines = buildStreamJsonInput({
      coldHistory: [
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "prev" }] },
      ],
      input: [{ type: "text", text: "now", text_elements: [] }],
    });
    const out = decorateAndSerialize(lines, "s");
    expect(out.endsWith("\n")).toBe(true);
    // assistant context 1줄 + user 1줄
    expect(out.trim().split("\n")).toHaveLength(2);
  });

  it("각 라인 uuid 는 서로 다름", () => {
    const lines = buildStreamJsonInput({
      coldHistory: [
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "a" }] },
      ],
      input: [{ type: "text", text: "b", text_elements: [] }],
    });
    const parsed = decorateAndSerialize(lines, "s")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(parsed[0]!.uuid).not.toBe(parsed[1]!.uuid);
  });
});

describe("effort 어휘 해석 (Claude Code --effort 기준)", () => {
  it("허용값은 그대로, OpenAI 전용·옛 어휘는 조용히 qgrid 기본(low)으로 바꾼다", () => {
    const effortOf = (effort: string) => {
      const args = buildClaudeArgs({ model: "claude-opus-5", sessionId: "u", effort });
      return args[args.indexOf("--effort") + 1];
    };
    expect(effortOf("max")).toBe("max");
    expect(effortOf("xhigh")).toBe("xhigh");
    expect(effortOf("ultra")).toBe("low");
    expect(effortOf("minimal")).toBe("low");
  });
});
