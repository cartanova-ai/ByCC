import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { ANTHROPIC_CONFIG_DIR_BASE, anthropicConfigDir } from "./anthropic-constants";
import {
  buildClaudeArgs,
  compatibilityKey,
  decorateAndSerialize,
  ensureConfigDir,
  makeAnthropicWorkerId,
  withSessionLock,
} from "./claude-session";
import { buildStreamJsonInput } from "./stream-json-adapter";

describe("compatibilityKey (P1-5)", () => {
  it("같은 system+model+schema → 같은 키", () => {
    const a = compatibilityKey({ system: "s", model: "claude-sonnet-4-6" });
    const b = compatibilityKey({ system: "s", model: "claude-sonnet-4-6" });
    expect(a).toBe(b);
  });

  it("model 다르면 다른 키 (sessionKey 재사용 오염 방지)", () => {
    const a = compatibilityKey({ system: "s", model: "claude-sonnet-4-6" });
    const b = compatibilityKey({ system: "s", model: "claude-opus-4-8" });
    expect(a).not.toBe(b);
  });

  it("text 모드 vs structured 모드 다른 키", () => {
    const text = compatibilityKey({ system: "s", model: "m" });
    const json = compatibilityKey({ system: "s", model: "m", outputSchema: '{"type":"object"}' });
    expect(text).not.toBe(json);
  });

  it("다른 schema 내용 → 다른 키 (codex P1-2: boolean 으로는 못 잡던 오염)", () => {
    const schemaA = compatibilityKey({
      system: "s",
      model: "m",
      outputSchema: '{"type":"object","properties":{"a":{"type":"string"}}}',
    });
    const schemaB = compatibilityKey({
      system: "s",
      model: "m",
      outputSchema: '{"type":"object","properties":{"b":{"type":"integer"}}}',
    });
    expect(schemaA).not.toBe(schemaB);
  });

  it("같은 schema 내용 → 같은 키", () => {
    const s = '{"type":"object"}';
    expect(compatibilityKey({ system: "s", model: "m", outputSchema: s })).toBe(
      compatibilityKey({ system: "s", model: "m", outputSchema: s }),
    );
  });

  it("system 다르면 다른 키", () => {
    const a = compatibilityKey({ system: "a", model: "m" });
    const b = compatibilityKey({ system: "b", model: "m" });
    expect(a).not.toBe(b);
  });
});

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
  it("첫 호출: --session-id, resume 아님", () => {
    const args = buildClaudeArgs({ model: "m", sessionId: "uuid-1", isResume: false });
    expect(args).toContain("--session-id");
    expect(args).toContain("uuid-1");
    expect(args).not.toContain("--resume");
    // 멀티턴 필수: --no-session-persistence 없어야 함
    expect(args).not.toContain("--no-session-persistence");
    // 입력 포맷
    expect(args).toContain("--input-format");
    expect(args[args.indexOf("--input-format") + 1]).toBe("stream-json");
  });

  it("후속 호출: --resume <id>, session-id 아님", () => {
    const args = buildClaudeArgs({ model: "m", sessionId: "uuid-1", isResume: true });
    expect(args).toContain("--resume");
    expect(args[args.indexOf("--resume") + 1]).toBe("uuid-1");
    expect(args).not.toContain("--session-id");
  });

  it("structured(jsonSchema 있음): --allowed-tools StructuredOutput + --json-schema (P2-7)", () => {
    const args = buildClaudeArgs({
      model: "m",
      sessionId: "u",
      isResume: false,
      jsonSchema: '{"type":"object"}',
    });
    expect(args).toContain("--allowed-tools");
    expect(args).toContain("StructuredOutput");
    expect(args).toContain("--json-schema");
  });

  it("non-structured(jsonSchema 없음): --allowed-tools 미부여 (P2-7)", () => {
    const args = buildClaudeArgs({ model: "m", sessionId: "u", isResume: false });
    expect(args).not.toContain("--allowed-tools");
    expect(args).not.toContain("--json-schema");
    // 단 --tools "" 로 전체 차단은 유지
    expect(args).toContain("--tools");
  });

  it("inline [System] 금지: --system-prompt 정식 채널 사용 (R7)", () => {
    const args = buildClaudeArgs({ model: "m", system: "you are X", sessionId: "u", isResume: false });
    expect(args).toContain("--system-prompt");
    expect(args[args.indexOf("--system-prompt") + 1]).toBe("you are X");
  });
});

describe("decorateAndSerialize (envelope, U2 P1-#3 위임분)", () => {
  it("각 라인에 session_id/uuid/parent_tool_use_id:null 부착 + message 보존", () => {
    const lines = buildStreamJsonInput({
      input: [{ type: "text", text: "hi", text_elements: [] }],
      isResume: false,
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
      isResume: false,
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
      isResume: false,
    });
    const parsed = decorateAndSerialize(lines, "s")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(parsed[0]!.uuid).not.toBe(parsed[1]!.uuid);
  });
});
