import { beforeEach, describe, expect, it, vi } from "vitest";

import { type AnthropicCredentials } from "../../../application/token/token.types";
import { type GenerateRequest } from "../common/provider-dispatcher";
import { ANTHROPIC_DEFAULT_MODEL } from "./anthropic-constants";
import { AnthropicDispatcher } from "./anthropic-dispatcher";

const { runClaudeSessionMock, refreshTokenMock } = vi.hoisted(() => ({
  runClaudeSessionMock: vi.fn(),
  refreshTokenMock: vi.fn(),
}));

vi.mock("./claude-session", async (importActual) => {
  const actual = await importActual<typeof import("./claude-session")>();
  return { ...actual, runClaudeSession: runClaudeSessionMock };
});

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
    expect(result.threadCoord).toEqual({ workerId: 1, threadId: "sess-generated", epoch: 0 });
  });

  it("cold 호출: coldInput/coldHistory 를 그대로 전달하고 continuation session id 는 없다", async () => {
    const d = new AnthropicDispatcher();
    d.onTokenAdded(1, "tok-A", creds());

    await d.generate(
      baseReq({ coldHistory: [{ type: "message", role: "assistant", content: [] }] }),
    );

    const call = runClaudeSessionMock.mock.calls[0]![0];
    expect(call).not.toHaveProperty("resumeSessionId");
    expect(call.coldHistory).toBeDefined();
    expect(call.input).toEqual([{ type: "text", text: "hi", text_elements: [] }]);
  });

  it("reuse/reuseInput 이 실려 와도 무시하고 coldInput/coldHistory 로 실행한다", async () => {
    const d = new AnthropicDispatcher();
    d.onTokenAdded(1, "tok-A", creds());

    await d.generate(
      baseReq({
        coldHistory: [{ type: "message", role: "assistant", content: [] }],
        reuse: { workerId: 1, threadId: "S1", epoch: 0 },
        reuseInput: [{ type: "text", text: "delta", text_elements: [] }],
      }),
    );

    const call = runClaudeSessionMock.mock.calls[0]![0];
    expect(call).not.toHaveProperty("resumeSessionId");
    expect(call.coldHistory).toBeDefined();
    expect(call.input).toEqual([{ type: "text", text: "hi", text_elements: [] }]);
  });

  it("structured(outputSchema): jsonSchema 로 직렬화되어 전달", async () => {
    const d = new AnthropicDispatcher();
    d.onTokenAdded(1, "tok-A", creds());
    await d.generate(baseReq({ outputSchema: { type: "object", properties: {} } }));

    const call = runClaudeSessionMock.mock.calls[0]![0];
    expect(call.jsonSchema).toBe(JSON.stringify({ type: "object", properties: {} }));
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

  it("cold 실패는 resume retry 없이 그대로 전파한다", async () => {
    const d = new AnthropicDispatcher();
    d.onTokenAdded(1, "tok-A", creds());
    runClaudeSessionMock.mockRejectedValueOnce(new Error("closed without result"));

    await expect(
      d.generate(
        baseReq({
          reuse: { workerId: 1, threadId: "S1", epoch: 0 },
          reuseInput: [{ type: "text", text: "delta", text_elements: [] }],
        }),
      ),
    ).rejects.toThrow("closed without result");
    expect(runClaudeSessionMock).toHaveBeenCalledTimes(1);
  });

  it("least-used RR: 두 토큰 번갈아 분배", async () => {
    const d = new AnthropicDispatcher();
    d.onTokenAdded(1, "tok-A", creds());
    d.onTokenAdded(2, "tok-B", creds());

    const names = new Set<string>();
    const r1 = await d.generate(baseReq());
    const r2 = await d.generate(baseReq());
    names.add(r1.tokenName);
    names.add(r2.tokenName);

    expect(names.size).toBe(2);
  });

  it("onTokenRemoved 후 그 토큰 미선택", async () => {
    const d = new AnthropicDispatcher();
    d.onTokenAdded(1, "tok-A", creds());
    d.onTokenRemoved(1);

    await expect(d.generate(baseReq())).rejects.toThrow(/No anthropic tokens/);
  });

  it("onTokenUpdated 는 토큰 credentials 를 in-place 갱신한다", async () => {
    const d = new AnthropicDispatcher();
    d.onTokenAdded(1, "tok-A", creds(3_600_000, "acc-1"));
    d.onTokenUpdated(1, "tok-A", creds(7_200_000, "acc-2"));

    await d.generate(baseReq());

    const call = runClaudeSessionMock.mock.calls[0]![0];
    expect(call.tokenId).toBe(1);
  });

  it("model prefix 정규화: 'anthropic/claude-opus-4-8' → canonical 로 세션/result.model", async () => {
    const d = new AnthropicDispatcher();
    d.onTokenAdded(1, "tok-A", creds());

    const result = await d.generate(baseReq({ model: "anthropic/claude-opus-4-8" }));

    const call = runClaudeSessionMock.mock.calls[0]![0];
    expect(call.model).toBe("claude-opus-4-8");
    expect(result.model).toBe("claude-opus-4-8");
  });

  it("[1m] suffix 정규화: result/runClaudeSession 에는 base canonical 만 전달", async () => {
    const d = new AnthropicDispatcher();
    d.onTokenAdded(1, "tok-A", creds());

    const result = await d.generate(baseReq({ model: "anthropic/claude-sonnet-4-6[1m]" }));

    const call = runClaudeSessionMock.mock.calls[0]![0];
    expect(call.model).toBe("claude-sonnet-4-6");
    expect(result.model).toBe("claude-sonnet-4-6");
  });

  it("unsupported alias + [1m] 은 조용히 다운그레이드하지 않는다", async () => {
    const d = new AnthropicDispatcher();
    d.onTokenAdded(1, "tok-A", creds());

    await expect(d.generate(baseReq({ model: "sonnet[1m]" }))).rejects.toThrow(
      /Unsupported Anthropic 1M model suffix/,
    );
  });

  it("model 미지정 → ANTHROPIC_DEFAULT_MODEL 적용", async () => {
    const d = new AnthropicDispatcher();
    d.onTokenAdded(1, "tok-A", creds());

    const result = await d.generate(baseReq({ model: undefined }));

    const call = runClaudeSessionMock.mock.calls[0]![0];
    expect(call.model).toBe(ANTHROPIC_DEFAULT_MODEL);
    expect(result.model).toBe(ANTHROPIC_DEFAULT_MODEL);
  });

  it("replaceTokens: DB 기준 풀 재동기화 — 없는 토큰 제거, 새 토큰 추가", async () => {
    const d = new AnthropicDispatcher();
    d.onTokenAdded(1, "tok-A", creds());

    d.replaceTokens([{ id: 2, name: "tok-B", credentials: creds() }]);
    const result = await d.generate(baseReq());

    expect(result.tokenName).toBe("tok-B");
  });

  it("generateStream: onDelta/onComplete 호출", async () => {
    const d = new AnthropicDispatcher();
    d.onTokenAdded(1, "tok-A", creds());
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
    expect(runClaudeSessionMock.mock.calls[0]![0].includePartialMessages).toBe(true);
  });

  it("generateStream: Claude server error 는 onError 로 전달하고 complete 하지 않는다", async () => {
    const d = new AnthropicDispatcher();
    d.onTokenAdded(1, "tok-A", creds());
    const serverError = new Error(
      "claude error (anthropic/yds): API Error: 529 Overloaded. This is a server-side issue",
    );
    runClaudeSessionMock.mockRejectedValueOnce(serverError);

    const onDelta = vi.fn();
    const onComplete = vi.fn();
    const onError = vi.fn();
    await d.generateStream(baseReq(), { onDelta, onComplete, onError });

    expect(onDelta).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(serverError);
    expect(runClaudeSessionMock.mock.calls[0]![0].includePartialMessages).toBe(true);
  });

  it("refresh: 만료 임박 토큰은 provider 포함해 refreshToken 호출, 새 access token 으로 세션 진행", async () => {
    const d = new AnthropicDispatcher();
    d.onTokenAdded(1, "tok-A", creds(30_000));
    refreshTokenMock.mockResolvedValueOnce("sk-ant-oat01-refreshed");

    await d.generate(baseReq());

    expect(refreshTokenMock).toHaveBeenCalledTimes(1);
    const refreshArg = refreshTokenMock.mock.calls[0]![0];
    expect(refreshArg.provider).toBe("anthropic");
    expect(refreshArg.id).toBe(1);
    expect(runClaudeSessionMock.mock.calls[0]![0].token).toBe("sk-ant-oat01-refreshed");
  });

  it("refresh: 만료 여유 있으면 refresh 안 함, 기존 access token 사용", async () => {
    const d = new AnthropicDispatcher();
    d.onTokenAdded(1, "tok-A", creds(3_600_000));

    await d.generate(baseReq());

    expect(refreshTokenMock).not.toHaveBeenCalled();
    expect(runClaudeSessionMock.mock.calls[0]![0].token).toBe("sk-ant-oat01-test");
  });

  it("refresh 실패해도 기존 access token 으로 진행 — 요청을 죽이지 않음", async () => {
    const d = new AnthropicDispatcher();
    d.onTokenAdded(1, "tok-A", creds(30_000));
    refreshTokenMock.mockRejectedValueOnce(new Error("refresh boom"));

    const result = await d.generate(baseReq());

    expect(result.text).toBe("hello");
    expect(runClaudeSessionMock.mock.calls[0]![0].token).toBe("sk-ant-oat01-test");
  });
});
