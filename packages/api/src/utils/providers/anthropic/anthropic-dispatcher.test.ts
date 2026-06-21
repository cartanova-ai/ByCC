import { beforeEach, describe, expect, it, vi } from "vitest";

import { type AnthropicCredentials } from "../../../application/token/token.types";
import { type GenerateRequest } from "../common/provider-dispatcher";
import { ANTHROPIC_DEFAULT_MODEL } from "./anthropic-constants";
import { AnthropicDispatcher } from "./anthropic-dispatcher";
import { withSessionLock } from "./claude-session";

// runClaudeSession 은 실제 claude 프로세스를 spawn 하므로 모킹.
// compatibilityKey / makeAnthropicWorkerId / withSessionLock 은 순수 함수라 실제 구현 사용.
// vi.hoisted 로 mock fn 을 호이스트해 vi.mock 팩토리에서 참조한다.
const { runClaudeSessionMock, refreshTokenMock } = vi.hoisted(() => ({
  runClaudeSessionMock: vi.fn(),
  refreshTokenMock: vi.fn(),
}));
vi.mock("./claude-session", async (importActual) => {
  const actual = await importActual<typeof import("./claude-session")>();
  return { ...actual, runClaudeSession: runClaudeSessionMock };
});
// run() 이 동적 import 하는 QgridFrame.refreshToken 을 모킹(만료 임박 토큰 preemptive refresh 경로).
vi.mock("../../../application/qgrid/qgrid.frame", () => ({
  QgridFrame: { refreshToken: refreshTokenMock },
}));

function creds(expiresInMs = 3_600_000, accountUuid = "acc-1"): AnthropicCredentials {
  return {
    accessToken: "sk-ant-oat01-test",
    refreshToken: "sk-ant-ort01-test",
    expiresAt: Date.now() + expiresInMs,
    accountUuid,
  };
}

function sessionResult(overrides: Record<string, unknown> = {}) {
  return {
    text: "hello",
    usage: {
      totalTokens: 10,
      inputTokens: 5,
      cachedInputTokens: 0,
      outputTokens: 5,
      reasoningOutputTokens: 0,
    },
    durationMs: 100,
    quotaExhausted: false,
    isError: false,
    sessionId: "sess-generated",
    workerId: 1,
    ...overrides,
  };
}

function baseReq(overrides: Partial<GenerateRequest> = {}): GenerateRequest {
  return {
    model: "claude-sonnet-4-6",
    systemPrompt: "you are helpful",
    coldInput: [{ type: "text", text: "hi", text_elements: [] }],
    ...overrides,
  };
}

describe("AnthropicDispatcher", () => {
  beforeEach(() => {
    runClaudeSessionMock.mockReset();
    runClaudeSessionMock.mockResolvedValue(sessionResult());
    refreshTokenMock.mockReset();
    refreshTokenMock.mockResolvedValue("sk-ant-oat01-refreshed");
  });

  it("토큰 없으면 에러", async () => {
    const d = new AnthropicDispatcher();
    await expect(d.generate(baseReq())).rejects.toThrow(/No anthropic tokens/);
  });

  it("happy: generate → GenerateResult (threadCoord 조립, systemHash 없음)", async () => {
    const d = new AnthropicDispatcher();
    d.onTokenAdded(1, "tok-A", creds());
    const result = await d.generate(baseReq());
    expect(result.text).toBe("hello");
    expect(result.tokenName).toBe("tok-A");
    expect(result.model).toBe("claude-sonnet-4-6");
    // threadCoord: threadId=session-id, epoch=0, workerId=tokenId
    expect(result.threadCoord).toEqual({ workerId: 1, threadId: "sess-generated", epoch: 0 });
  });

  it("cold 호출: resumeSessionId 없음, coldInput/coldHistory 전달", async () => {
    const d = new AnthropicDispatcher();
    d.onTokenAdded(1, "tok-A", creds());
    await d.generate(
      baseReq({ coldHistory: [{ type: "message", role: "assistant", content: [] }] }),
    );
    const call = runClaudeSessionMock.mock.calls[0]![0];
    expect(call.resumeSessionId).toBeUndefined();
    expect(call.coldHistory).toBeDefined();
    expect(call.input).toEqual([{ type: "text", text: "hi", text_elements: [] }]);
  });

  it("resume eligible: 같은 호환키의 reuse.threadId → resume (reuseInput, history 미전달)", async () => {
    const d = new AnthropicDispatcher();
    d.onTokenAdded(1, "tok-A", creds());
    // 1st 호출: session "S1" 발급 + 호환키 저장
    runClaudeSessionMock.mockResolvedValueOnce(sessionResult({ sessionId: "S1" }));
    const first = await d.generate(baseReq());
    expect(first.threadCoord.threadId).toBe("S1");

    // 2nd 호출: 같은 system/model 로 reuse.threadId=S1 → eligible
    runClaudeSessionMock.mockResolvedValueOnce(sessionResult({ sessionId: "S1" }));
    await d.generate(
      baseReq({
        reuse: { workerId: 1, threadId: "S1", epoch: 0 },
        reuseInput: [{ type: "text", text: "delta", text_elements: [] }],
      }),
    );
    const call2 = runClaudeSessionMock.mock.calls[1]![0];
    expect(call2.resumeSessionId).toBe("S1");
    expect(call2.coldHistory).toBeUndefined(); // resume 이면 history 미전달
    expect(call2.input).toEqual([{ type: "text", text: "delta", text_elements: [] }]);
  });

  it("resume 토큰 소유권 고정: 다른 토큰이 idle 이어도 세션을 만든 토큰으로 resume (codex P0)", async () => {
    const d = new AnthropicDispatcher();
    d.onTokenAdded(1, "tok-A", creds());
    d.onTokenAdded(2, "tok-B", creds());

    // 1st cold: RR 로 tok-A(id 1) 가 뽑히도록 — 첫 호출은 rrIndex=0 → idle[0]=id1.
    runClaudeSessionMock.mockResolvedValueOnce(sessionResult({ sessionId: "S1", workerId: 1 }));
    const first = await d.generate(baseReq());
    expect(first.threadCoord.workerId).toBe(1); // tok-A 가 S1 소유

    // 이제 tok-A 는 count=1, tok-B 는 count=0 → least-used RR 이면 tok-B 를 고를 차례.
    // 하지만 reuse.threadId=S1 의 소유 토큰은 tok-A 이므로 반드시 tok-A 로 resume 해야 한다.
    runClaudeSessionMock.mockResolvedValueOnce(sessionResult({ sessionId: "S1", workerId: 1 }));
    const second = await d.generate(
      baseReq({
        reuse: { workerId: 1, threadId: "S1", epoch: 0 },
        reuseInput: [{ type: "text", text: "delta", text_elements: [] }],
      }),
    );
    const call2 = runClaudeSessionMock.mock.calls[1]![0];
    expect(call2.tokenId).toBe(1); // RR 로 tok-B(2) 가 아니라 소유 토큰 tok-A(1)
    expect(call2.resumeSessionId).toBe("S1");
    expect(second.tokenName).toBe("tok-A");
  });

  it("resume 소유권 불일치: stored.tokenId != reuse.workerId → resume 불가, cold (codex P0)", async () => {
    const d = new AnthropicDispatcher();
    d.onTokenAdded(1, "tok-A", creds());
    d.onTokenAdded(2, "tok-B", creds());
    runClaudeSessionMock.mockResolvedValueOnce(sessionResult({ sessionId: "S1", workerId: 1 }));
    await d.generate(baseReq()); // tok-A(1) 가 S1 소유

    // reuse.threadId=S1 은 맞지만 workerId 를 2 로 위조 → 소유권 불일치 → cold fallback.
    runClaudeSessionMock.mockResolvedValueOnce(sessionResult({ sessionId: "S2" }));
    await d.generate(
      baseReq({
        reuse: { workerId: 2, threadId: "S1", epoch: 0 },
        reuseInput: [{ type: "text", text: "x", text_elements: [] }],
      }),
    );
    const call2 = runClaudeSessionMock.mock.calls[1]![0];
    expect(call2.resumeSessionId).toBeUndefined(); // 소유권 불일치라 cold
  });

  it("resume ineligible: 다른 model 이면 호환키 불일치 → cold (새 session)", async () => {
    const d = new AnthropicDispatcher();
    d.onTokenAdded(1, "tok-A", creds());
    runClaudeSessionMock.mockResolvedValueOnce(sessionResult({ sessionId: "S1" }));
    await d.generate(baseReq()); // model sonnet 으로 S1 발급

    // reuse.threadId=S1 이지만 model 이 다름 → 호환키 불일치 → cold
    runClaudeSessionMock.mockResolvedValueOnce(sessionResult({ sessionId: "S2" }));
    await d.generate(
      baseReq({
        model: "claude-opus-4-8",
        reuse: { workerId: 1, threadId: "S1", epoch: 0 },
        reuseInput: [{ type: "text", text: "x", text_elements: [] }],
      }),
    );
    const call2 = runClaudeSessionMock.mock.calls[1]![0];
    expect(call2.resumeSessionId).toBeUndefined(); // cold fallback (P1-5 오염 방지)
  });

  it("resume ineligible: schema 호환키 불일치로 cold fallback 해도 continuation input 을 전달한다", async () => {
    const d = new AnthropicDispatcher();
    d.onTokenAdded(1, "tok-A", creds());
    runClaudeSessionMock.mockResolvedValueOnce(sessionResult({ sessionId: "S1" }));
    await d.generate(
      baseReq({ outputSchema: { type: "object", properties: { a: { type: "string" } } } }),
    );

    runClaudeSessionMock.mockResolvedValueOnce(sessionResult({ sessionId: "S2" }));
    await d.generate(
      baseReq({
        outputSchema: { type: "object", properties: { b: { type: "string" } } },
        coldHistory: [{ type: "function_call_output", call_id: "call_1", output: "ok" }],
        coldInput: [
          {
            type: "text",
            text: "Tool result for call call_1: ok\n\nNow continue answering the user's request using these results.",
            text_elements: [],
          },
        ],
        reuse: { workerId: 1, threadId: "S1", epoch: 0 },
        reuseInput: [
          {
            type: "text",
            text: "Tool result for call call_1: ok\n\nNow continue answering the user's request using these results.",
            text_elements: [],
          },
        ],
      }),
    );

    const call2 = runClaudeSessionMock.mock.calls[1]![0];
    expect(call2.resumeSessionId).toBeUndefined();
    expect(call2.coldHistory).toBeDefined();
    expect(call2.input[0]?.text).toContain("Now continue answering");
    expect(call2.input[0]?.text).not.toBe("");
  });

  it("resume transcript/session failure: 죽은 compat 삭제 후 cold 로 1회 retry 한다", async () => {
    const d = new AnthropicDispatcher();
    d.onTokenAdded(1, "tok-A", creds());
    runClaudeSessionMock.mockResolvedValueOnce(sessionResult({ sessionId: "S1", workerId: 1 }));
    await d.generate(baseReq());

    runClaudeSessionMock
      .mockRejectedValueOnce(
        new Error("Claude session closed without result — stderr: failed to resume transcript"),
      )
      .mockResolvedValueOnce(sessionResult({ sessionId: "S2", workerId: 1 }));

    const result = await d.generate(
      baseReq({
        coldHistory: [{ type: "function_call_output", call_id: "call_1", output: "ok" }],
        coldInput: [
          {
            type: "text",
            text: "Tool result for call call_1: ok\n\nNow continue answering the user's request using these results.",
            text_elements: [],
          },
        ],
        reuse: { workerId: 1, threadId: "S1", epoch: 0 },
        reuseInput: [{ type: "text", text: "delta", text_elements: [] }],
      }),
    );

    expect(result.threadCoord.threadId).toBe("S2");
    const resumeCall = runClaudeSessionMock.mock.calls[1]![0];
    expect(resumeCall.resumeSessionId).toBe("S1");
    expect(resumeCall.coldHistory).toBeUndefined();
    expect(resumeCall.input).toEqual([{ type: "text", text: "delta", text_elements: [] }]);

    const retryCall = runClaudeSessionMock.mock.calls[2]![0];
    expect(retryCall.resumeSessionId).toBeUndefined();
    expect(retryCall.coldHistory).toBeDefined();
    expect(retryCall.input[0]?.text).toContain("Now continue answering");

    runClaudeSessionMock.mockResolvedValueOnce(sessionResult({ sessionId: "S3", workerId: 1 }));
    await d.generate(
      baseReq({
        reuse: { workerId: 1, threadId: "S1", epoch: 0 },
        reuseInput: [{ type: "text", text: "should not resume S1", text_elements: [] }],
      }),
    );
    const postRetryCall = runClaudeSessionMock.mock.calls[3]![0];
    expect(postRetryCall.resumeSessionId).toBeUndefined();
  });

  it.each([
    ["timeout", "Claude session timeout after 120s"],
    ["abort", "aborted"],
    ["spawn", "Claude session spawn error: ENOENT"],
    ["schema", "Claude session closed without result — stderr: schema validation failed"],
    ["session-only", "Claude session failed before result"],
  ])("resume %s failure 는 cold retry 하지 않는다", async (_label, message) => {
    const d = new AnthropicDispatcher();
    d.onTokenAdded(1, "tok-A", creds());
    runClaudeSessionMock.mockResolvedValueOnce(sessionResult({ sessionId: "S1", workerId: 1 }));
    await d.generate(baseReq());

    runClaudeSessionMock.mockRejectedValueOnce(new Error(message));
    await expect(
      d.generate(
        baseReq({
          reuse: { workerId: 1, threadId: "S1", epoch: 0 },
          reuseInput: [{ type: "text", text: "delta", text_elements: [] }],
        }),
      ),
    ).rejects.toThrow(message);

    expect(runClaudeSessionMock).toHaveBeenCalledTimes(2);
  });

  it("quota 소진 → 에러", async () => {
    const d = new AnthropicDispatcher();
    d.onTokenAdded(1, "tok-A", creds());
    runClaudeSessionMock.mockResolvedValueOnce(sessionResult({ quotaExhausted: true }));
    await expect(d.generate(baseReq())).rejects.toThrow(/quota exhausted/);
  });

  it("claude 에러 → 에러", async () => {
    const d = new AnthropicDispatcher();
    d.onTokenAdded(1, "tok-A", creds());
    runClaudeSessionMock.mockResolvedValueOnce(sessionResult({ isError: true, text: "boom" }));
    await expect(d.generate(baseReq())).rejects.toThrow(/claude error/);
  });

  it("structured(outputSchema): jsonSchema 로 직렬화되어 전달", async () => {
    const d = new AnthropicDispatcher();
    d.onTokenAdded(1, "tok-A", creds());
    await d.generate(baseReq({ outputSchema: { type: "object", properties: {} } }));
    const call = runClaudeSessionMock.mock.calls[0]![0];
    expect(call.jsonSchema).toBe(JSON.stringify({ type: "object", properties: {} }));
  });

  it("least-used RR: 두 토큰 번갈아 분배", async () => {
    const d = new AnthropicDispatcher();
    d.onTokenAdded(1, "tok-A", creds());
    d.onTokenAdded(2, "tok-B", creds());
    const names = new Set<string>();
    runClaudeSessionMock.mockResolvedValue(sessionResult());
    const r1 = await d.generate(baseReq());
    const r2 = await d.generate(baseReq());
    names.add(r1.tokenName);
    names.add(r2.tokenName);
    expect(names.size).toBe(2); // 서로 다른 토큰
  });

  it("onTokenRemoved 후 그 토큰 미선택", async () => {
    const d = new AnthropicDispatcher();
    d.onTokenAdded(1, "tok-A", creds());
    d.onTokenRemoved(1);
    await expect(d.generate(baseReq())).rejects.toThrow(/No anthropic tokens/);
  });

  it("onTokenRemoved: 그 토큰으로 만든 session compat 정리 → 이후 같은 reuse.threadId 도 cold", async () => {
    const d = new AnthropicDispatcher();
    d.onTokenAdded(1, "tok-A", creds());
    runClaudeSessionMock.mockResolvedValueOnce(sessionResult({ sessionId: "S1" }));
    await d.generate(baseReq()); // S1 발급(token 1)

    // 토큰 1 제거 → S1 compat 도 정리됨. 다시 토큰 추가 후 reuse.threadId=S1 시도 → eligible 아님(cold)
    d.onTokenRemoved(1);
    d.onTokenAdded(1, "tok-A", creds());
    runClaudeSessionMock.mockResolvedValueOnce(sessionResult({ sessionId: "S2" }));
    await d.generate(
      baseReq({
        reuse: { workerId: 1, threadId: "S1", epoch: 0 },
        reuseInput: [{ type: "text", text: "x", text_elements: [] }],
      }),
    );
    const call2 = runClaudeSessionMock.mock.calls[1]![0];
    expect(call2.resumeSessionId).toBeUndefined(); // compat 정리돼 cold
  });

  it("onTokenUpdated: 같은 accountUuid 의 토큰 rotation 은 기존 session resume 유지 (codex P1)", async () => {
    const d = new AnthropicDispatcher();
    d.onTokenAdded(1, "tok-A", creds(3_600_000, "acc-1"));
    runClaudeSessionMock.mockResolvedValueOnce(sessionResult({ sessionId: "S1", workerId: 1 }));
    await d.generate(baseReq()); // S1 발급(token 1, acc-1)

    // access/refresh/expiresAt 만 바뀐 rotation (accountUuid 동일) → 세션 유지.
    d.onTokenUpdated(1, "tok-A", creds(7_200_000, "acc-1"));
    runClaudeSessionMock.mockResolvedValueOnce(sessionResult({ sessionId: "S1", workerId: 1 }));
    await d.generate(
      baseReq({
        reuse: { workerId: 1, threadId: "S1", epoch: 0 },
        reuseInput: [{ type: "text", text: "x", text_elements: [] }],
      }),
    );
    const call2 = runClaudeSessionMock.mock.calls[1]![0];
    expect(call2.resumeSessionId).toBe("S1"); // rotation 이라 resume 유지
  });

  it("onTokenUpdated: accountUuid 변경(재로그인)이면 그 토큰 session compat 폐기 → cold (codex P1 격리)", async () => {
    const d = new AnthropicDispatcher();
    d.onTokenAdded(1, "tok-A", creds(3_600_000, "acc-1"));
    runClaudeSessionMock.mockResolvedValueOnce(sessionResult({ sessionId: "S1", workerId: 1 }));
    await d.generate(baseReq()); // S1 발급(token 1, acc-1)

    // 다른 accountUuid 로 재로그인 → S1 은 옛 계정 세션이므로 새 계정으로 resume 하면 안 됨.
    d.onTokenUpdated(1, "tok-A", creds(3_600_000, "acc-2"));
    runClaudeSessionMock.mockResolvedValueOnce(sessionResult({ sessionId: "S2" }));
    await d.generate(
      baseReq({
        reuse: { workerId: 1, threadId: "S1", epoch: 0 },
        reuseInput: [{ type: "text", text: "x", text_elements: [] }],
      }),
    );
    const call2 = runClaudeSessionMock.mock.calls[1]![0];
    expect(call2.resumeSessionId).toBeUndefined(); // identity 변경으로 compat 폐기 → cold
  });

  it("TTL 만료: 오래된 session compat 은 sweep 되어 resume 불가 → cold", async () => {
    vi.useFakeTimers();
    try {
      const d = new AnthropicDispatcher();
      d.onTokenAdded(1, "tok-A", creds());
      runClaudeSessionMock.mockResolvedValueOnce(sessionResult({ sessionId: "S1" }));
      await d.generate(baseReq()); // S1 발급 + compat 저장

      // 10분 + 1초 경과 → 다음 generate 진입 시 sweep 으로 S1 폐기
      vi.advanceTimersByTime(10 * 60 * 1000 + 1000);

      runClaudeSessionMock.mockResolvedValueOnce(sessionResult({ sessionId: "S2" }));
      await d.generate(
        baseReq({
          reuse: { workerId: 1, threadId: "S1", epoch: 0 },
          reuseInput: [{ type: "text", text: "x", text_elements: [] }],
        }),
      );
      const call2 = runClaudeSessionMock.mock.calls[1]![0];
      expect(call2.resumeSessionId).toBeUndefined(); // TTL 만료로 cold fallback
    } finally {
      vi.useRealTimers();
    }
  });

  it("model prefix 정규화: 'anthropic/claude-opus-4-8' → canonical 로 세션/result.model (codex P2)", async () => {
    const d = new AnthropicDispatcher();
    d.onTokenAdded(1, "tok-A", creds());
    const result = await d.generate(baseReq({ model: "anthropic/claude-opus-4-8" }));
    // runClaudeSession 과 GenerateResult 둘 다 prefix 없는 canonical id 를 써야 cost/compat 정합.
    const call = runClaudeSessionMock.mock.calls[0]![0];
    expect(call.model).toBe("claude-opus-4-8");
    expect(result.model).toBe("claude-opus-4-8");
  });

  it("model prefix 유무가 같은 호환키 → resume 유지 (codex P2: prefix 가 compat 오염 안 함)", async () => {
    const d = new AnthropicDispatcher();
    d.onTokenAdded(1, "tok-A", creds());
    // 1st: prefix 있는 model 로 S1 발급
    runClaudeSessionMock.mockResolvedValueOnce(sessionResult({ sessionId: "S1", workerId: 1 }));
    await d.generate(baseReq({ model: "anthropic/claude-sonnet-4-6" }));

    // 2nd: prefix 없는 동일 모델로 reuse → canonical 이 같으니 compat 일치 → resume
    runClaudeSessionMock.mockResolvedValueOnce(sessionResult({ sessionId: "S1", workerId: 1 }));
    await d.generate(
      baseReq({
        model: "claude-sonnet-4-6",
        reuse: { workerId: 1, threadId: "S1", epoch: 0 },
        reuseInput: [{ type: "text", text: "x", text_elements: [] }],
      }),
    );
    const call2 = runClaudeSessionMock.mock.calls[1]![0];
    expect(call2.resumeSessionId).toBe("S1");
  });

  it("model 미지정 → ANTHROPIC_DEFAULT_MODEL 적용 (codex P3: sonnet 별칭 우회 차단)", async () => {
    const d = new AnthropicDispatcher();
    d.onTokenAdded(1, "tok-A", creds());
    const result = await d.generate(baseReq({ model: undefined }));
    const call = runClaudeSessionMock.mock.calls[0]![0];
    expect(call.model).toBe(ANTHROPIC_DEFAULT_MODEL);
    expect(result.model).toBe(ANTHROPIC_DEFAULT_MODEL);
  });

  it("replaceTokens: DB 기준 풀 재동기화 — 없는 토큰 제거(+compat 정리), 새 토큰 추가 (codex P1)", async () => {
    const d = new AnthropicDispatcher();
    d.onTokenAdded(1, "tok-A", creds());
    runClaudeSessionMock.mockResolvedValueOnce(sessionResult({ sessionId: "S1", workerId: 1 }));
    await d.generate(baseReq()); // tok-A(1) 가 S1 소유 + compat 저장

    // reconcile: DB 에는 tok-B(2)만 active. tok-A(1) 는 사라짐 → 제거 + S1 compat 정리.
    d.replaceTokens([{ id: 2, name: "tok-B", credentials: creds() }]);

    // 이제 tok-A(1) 미선택 + S1 resume 시도해도 compat 없어서 cold.
    runClaudeSessionMock.mockResolvedValueOnce(sessionResult({ sessionId: "S2", workerId: 2 }));
    const r = await d.generate(
      baseReq({
        reuse: { workerId: 1, threadId: "S1", epoch: 0 },
        reuseInput: [{ type: "text", text: "x", text_elements: [] }],
      }),
    );
    expect(r.tokenName).toBe("tok-B"); // tok-A 제거됨 → tok-B 만 남음
    const call2 = runClaudeSessionMock.mock.calls[1]![0];
    expect(call2.resumeSessionId).toBeUndefined(); // S1 compat 정리됨 → cold
  });

  it("resume deadlock 회귀: runClaudeSession 이 내부 락을 잡아도 dispatcher 가 중첩 락을 안 건다 (codex U5 P0)", async () => {
    const d = new AnthropicDispatcher();
    d.onTokenAdded(1, "tok-A", creds());
    // 1st cold → S1 발급 (mock 도 실제 runClaudeSession 처럼 sessionId 단위 락을 잡게 한다)
    runClaudeSessionMock.mockImplementationOnce(async (req: { resumeSessionId?: string }) =>
      withSessionLock(req.resumeSessionId ?? "S1", async () =>
        sessionResult({ sessionId: "S1", workerId: 1 }),
      ),
    );
    await d.generate(baseReq());

    // 2nd resume(S1): mock 이 실제 withSessionLock("S1") 재진입. dispatcher 가 outer withSessionLock("S1")
    // 으로 또 감쌌다면 같은 sessionId 비-reentrant 락이 자기 자신을 기다려 deadlock → 이 await 가 영구 정지.
    // dispatcher 가 락을 안 거므로 정상 완료돼야 한다.
    runClaudeSessionMock.mockImplementationOnce(async (req: { resumeSessionId?: string }) =>
      withSessionLock(req.resumeSessionId ?? "S1", async () =>
        sessionResult({ sessionId: "S1", workerId: 1 }),
      ),
    );
    const second = await d.generate(
      baseReq({
        reuse: { workerId: 1, threadId: "S1", epoch: 0 },
        reuseInput: [{ type: "text", text: "x", text_elements: [] }],
      }),
    );
    expect(second.threadCoord.threadId).toBe("S1"); // deadlock 없이 완료
  });

  it("generateStream: onDelta/onComplete 호출", async () => {
    const d = new AnthropicDispatcher();
    d.onTokenAdded(1, "tok-A", creds());
    // runClaudeSession 이 onDelta 를 호출하도록 모킹
    runClaudeSessionMock.mockImplementationOnce(async (_req, onDelta: (t: string) => void) => {
      onDelta("부분");
      return sessionResult({ text: "부분완성" });
    });
    const deltas: Array<string> = [];
    let completed: unknown = null;
    await d.generateStream(baseReq(), {
      onDelta: (t) => deltas.push(t),
      onComplete: (r) => (completed = r),
      onError: () => {},
    });
    expect(deltas).toEqual(["부분"]);
    expect(completed).not.toBeNull();
  });

  it("refresh: 만료 임박 토큰은 provider 포함해 refreshToken 호출, 새 access token 으로 세션 진행 (codex P1)", async () => {
    const d = new AnthropicDispatcher();
    // 만료까지 30초 → REFRESH_SAFETY_MS(60s) 안쪽이라 preemptive refresh 발동.
    d.onTokenAdded(1, "tok-A", creds(30_000));
    refreshTokenMock.mockResolvedValueOnce("sk-ant-oat01-refreshed");
    await d.generate(baseReq());

    // refreshToken 은 provider 를 반드시 포함해 호출돼야 함(없으면 TokenModel.save 실패).
    expect(refreshTokenMock).toHaveBeenCalledTimes(1);
    const refreshArg = refreshTokenMock.mock.calls[0]![0];
    expect(refreshArg.provider).toBe("anthropic");
    expect(refreshArg.id).toBe(1);
    // refresh 된 access token 이 claude 세션으로 전달돼야 함.
    const sessionArg = runClaudeSessionMock.mock.calls[0]![0];
    expect(sessionArg.token).toBe("sk-ant-oat01-refreshed");
  });

  it("refresh: 만료 여유 있으면 refresh 안 함, 기존 access token 사용", async () => {
    const d = new AnthropicDispatcher();
    d.onTokenAdded(1, "tok-A", creds(3_600_000)); // 1시간 여유
    await d.generate(baseReq());
    expect(refreshTokenMock).not.toHaveBeenCalled();
    const sessionArg = runClaudeSessionMock.mock.calls[0]![0];
    expect(sessionArg.token).toBe("sk-ant-oat01-test");
  });

  it("refresh 실패해도(throw) 기존 access token 으로 진행 — 요청을 죽이지 않음 (codex P1)", async () => {
    const d = new AnthropicDispatcher();
    d.onTokenAdded(1, "tok-A", creds(30_000));
    refreshTokenMock.mockRejectedValueOnce(new Error("refresh boom"));
    const result = await d.generate(baseReq());
    // refresh 가 throw 해도 catch 후 만료 임박 access token 으로 진행.
    expect(result.text).toBe("hello");
    const sessionArg = runClaudeSessionMock.mock.calls[0]![0];
    expect(sessionArg.token).toBe("sk-ant-oat01-test");
  });
});
