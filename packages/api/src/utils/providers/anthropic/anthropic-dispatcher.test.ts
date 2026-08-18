import { beforeEach, describe, expect, it, vi } from "vitest";

import { QuotaThresholdExceededError } from "../../../application/qgrid/qgrid.types";
import { ToolCallEmulationError } from "../../../application/qgrid/tool-emulation";
import { type AnthropicCredentials } from "../../../application/token/token.types";
import { type GenerateRequest } from "../common/provider-dispatcher";
import { ANTHROPIC_DEFAULT_MODEL } from "./anthropic-constants";
import { AnthropicDispatcher } from "./anthropic-dispatcher";
import { type AnthropicQuotaUsageResult } from "./anthropic-quota";

const {
  runClaudeSessionMock,
  refreshTokenMock,
  readAnthropicQuotaUsageMock,
  loggerInfoMock,
  loggerWarnMock,
} = vi.hoisted(() => ({
  runClaudeSessionMock: vi.fn(),
  refreshTokenMock: vi.fn(),
  readAnthropicQuotaUsageMock: vi.fn(),
  loggerInfoMock: vi.fn(),
  loggerWarnMock: vi.fn(),
}));

vi.mock("@logtape/logtape", () => ({
  getLogger: () => ({ info: loggerInfoMock, warn: loggerWarnMock }),
}));

vi.mock("./claude-session", async (importActual) => {
  const actual = await importActual<typeof import("./claude-session")>();
  return { ...actual, runClaudeSession: runClaudeSessionMock };
});

vi.mock("./anthropic-quota", () => ({
  readAnthropicQuotaUsage: readAnthropicQuotaUsageMock,
}));

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

function quotaOk(utilizationPct: number, cacheAgeMs = 100): AnthropicQuotaUsageResult {
  return { kind: "ok", utilizationPct, cacheAgeMs };
}

function quotaFail(reason = "usage lookup failed"): AnthropicQuotaUsageResult {
  return { kind: "lookup_failed", reason };
}

function firstRunRequest() {
  const call = runClaudeSessionMock.mock.calls[0]?.[0];
  if (call === undefined) throw new Error("runClaudeSession was not called");
  return call;
}

function firstRefreshTokenArg() {
  const call = refreshTokenMock.mock.calls[0]?.[0];
  if (call === undefined) throw new Error("refreshToken was not called");
  return call;
}

async function selectedTokenNames(
  dispatcher: AnthropicDispatcher,
  count: number,
): Promise<string[]> {
  return Promise.all(
    Array.from({ length: count }, async () => (await dispatcher.generate(baseReq())).tokenName),
  );
}

describe("AnthropicDispatcher", () => {
  beforeEach(() => {
    runClaudeSessionMock.mockReset();
    runClaudeSessionMock.mockResolvedValue(sessionResult());
    refreshTokenMock.mockReset();
    refreshTokenMock.mockResolvedValue("sk-ant-oat01-refreshed");
    readAnthropicQuotaUsageMock.mockReset();
    loggerInfoMock.mockReset();
    loggerWarnMock.mockReset();
  });

  it("토큰 없으면 에러", async () => {
    const d = new AnthropicDispatcher();
    await expect(d.generate(baseReq())).rejects.toThrow(/No anthropic tokens/);
  });

  it("happy: generate → GenerateResult (threadCoord 조립, systemHash 없음)", async () => {
    const d = new AnthropicDispatcher();
    d.onTokenAdded(1, "tok-A", creds(), null, 1);
    runClaudeSessionMock.mockResolvedValueOnce(sessionResult({ ttftMs: 42 }));

    const result = await d.generate(baseReq());

    expect(result.text).toBe("hello");
    expect(result.tokenName).toBe("tok-A");
    expect(result.model).toBe("claude-sonnet-4-6");
    expect(result.ttftMs).toBe(42);
    expect(result.threadCoord).toEqual({ workerId: 1, threadId: "sess-generated", epoch: 0 });
  });

  it("cold 호출: coldInput/coldHistory 를 그대로 전달하고 continuation session id 는 없다", async () => {
    const d = new AnthropicDispatcher();
    d.onTokenAdded(1, "tok-A", creds(), null, 1);

    await d.generate(
      baseReq({ coldHistory: [{ type: "message", role: "assistant", content: [] }] }),
    );

    const call = firstRunRequest();
    expect(call).not.toHaveProperty("resumeSessionId");
    expect(call.coldHistory).toBeDefined();
    expect(call.input).toEqual([{ type: "text", text: "hi", text_elements: [] }]);
  });

  it("reuse/reuseInput 이 실려 와도 무시하고 coldInput/coldHistory 로 실행한다", async () => {
    const d = new AnthropicDispatcher();
    d.onTokenAdded(1, "tok-A", creds(), null, 1);

    await d.generate(
      baseReq({
        coldHistory: [{ type: "message", role: "assistant", content: [] }],
        reuse: { workerId: 1, threadId: "S1", epoch: 0 },
        reuseInput: [{ type: "text", text: "delta", text_elements: [] }],
      }),
    );

    const call = firstRunRequest();
    expect(call).not.toHaveProperty("resumeSessionId");
    expect(call.coldHistory).toBeDefined();
    expect(call.input).toEqual([{ type: "text", text: "hi", text_elements: [] }]);
  });

  it("structured(outputSchema): jsonSchema 로 직렬화되어 전달", async () => {
    const d = new AnthropicDispatcher();
    d.onTokenAdded(1, "tok-A", creds(), null, 1);
    await d.generate(baseReq({ outputSchema: { type: "object", properties: {} } }));

    const call = firstRunRequest();
    expect(call.jsonSchema).toBe(JSON.stringify({ type: "object", properties: {} }));
  });

  it("argv 안전 한도를 넘는 structured schema를 session 실행 전에 거부한다", async () => {
    const d = new AnthropicDispatcher();
    d.onTokenAdded(1, "tok-A", creds(), null, 1);

    await expect(
      d.generate(
        baseReq({
          outputSchema: {
            type: "object",
            description: "x".repeat(64 * 1024),
          },
        }),
      ),
    ).rejects.toThrow("Anthropic dispatch schema exceeds argv UTF-8 byte limit");
    expect(runClaudeSessionMock).not.toHaveBeenCalled();
  });

  it("요청 timeoutMs를 Claude session에 전달하고 미지정 시 240초 기본값을 쓴다", async () => {
    const d = new AnthropicDispatcher();
    d.onTokenAdded(1, "tok-A", creds(), null, 1);

    await d.generate(baseReq({ timeoutMs: 360_000 }));
    expect(firstRunRequest().timeoutMs).toBe(360_000);

    runClaudeSessionMock.mockClear();
    await d.generate(baseReq());
    expect(firstRunRequest().timeoutMs).toBe(240_000);
  });

  it("quota 소진 → 에러", async () => {
    const d = new AnthropicDispatcher();
    d.onTokenAdded(1, "tok-A", creds(), null, 1);
    runClaudeSessionMock.mockResolvedValueOnce(sessionResult({ quotaExhausted: true }));

    await expect(d.generate(baseReq())).rejects.toThrow(/quota exhausted/);
  });

  it("claude 에러 → 에러", async () => {
    const d = new AnthropicDispatcher();
    d.onTokenAdded(1, "tok-A", creds(), null, 1);
    runClaudeSessionMock.mockResolvedValueOnce(sessionResult({ isError: true, text: "boom" }));

    await expect(d.generate(baseReq())).rejects.toThrow(/claude error/);
  });

  it("cold 실패는 resume retry 없이 그대로 전파한다", async () => {
    const d = new AnthropicDispatcher();
    d.onTokenAdded(1, "tok-A", creds(), null, 1);
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

  it("routes Anthropic requests in a 3:1 ratio", async () => {
    const d = new AnthropicDispatcher();
    d.onTokenAdded(1, "tok-A", creds(), null, 3);
    d.onTokenAdded(2, "tok-B", creds(), null, 1);

    const names = await selectedTokenNames(d, 4);

    expect(names.filter((name) => name === "tok-A")).toHaveLength(3);
    expect(names.filter((name) => name === "tok-B")).toHaveLength(1);
    expect(readAnthropicQuotaUsageMock).not.toHaveBeenCalled();
  });

  it("preferredTokenId 가 있으면 가중 선택과 무관하게 그 토큰을 고른다", async () => {
    const d = new AnthropicDispatcher();
    d.onTokenAdded(1, "tok-A", creds(), null, 10);
    d.onTokenAdded(2, "tok-B", creds(), null, 1);

    const result = await d.generate(baseReq({ preferredTokenId: 2 }));

    expect(result.tokenName).toBe("tok-B");
  });

  it("preferredTokenId 가 풀에 없으면 다른 토큰으로 대체하지 않는다", async () => {
    const d = new AnthropicDispatcher();
    d.onTokenAdded(1, "tok-A", creds(), null, 1);

    await expect(d.generate(baseReq({ preferredTokenId: 99 }))).rejects.toThrow(
      "Preferred anthropic token 99 is not available",
    );
    expect(runClaudeSessionMock).not.toHaveBeenCalled();
  });

  it("지정 토큰이 threshold 를 넘으면 eligible 토큰으로 대체하지 않는다", async () => {
    const d = new AnthropicDispatcher();
    d.onTokenAdded(1, "tok-A", creds(), null, 1);
    d.onTokenAdded(2, "tok-B", creds(), 80, 1);
    readAnthropicQuotaUsageMock.mockResolvedValueOnce(quotaOk(80));

    const error = await d.generate(baseReq({ preferredTokenId: 2 })).catch((e) => e);

    expect(error).toBeInstanceOf(QuotaThresholdExceededError);
    expect(error.message).toBe(
      "All anthropic tokens exceeded quota threshold: tok-B (threshold 80%)",
    );
    expect(readAnthropicQuotaUsageMock).toHaveBeenCalledTimes(1);
    expect(runClaudeSessionMock).not.toHaveBeenCalled();
  });

  it("지정 선택은 다음 비지정 요청의 가중 선택 상태를 소비하지 않는다", async () => {
    const d = new AnthropicDispatcher();
    d.onTokenAdded(1, "tok-A", creds(), null, 1);
    d.onTokenAdded(2, "tok-B", creds(), null, 2);

    expect((await d.generate(baseReq())).tokenName).toBe("tok-B");
    expect((await d.generate(baseReq({ preferredTokenId: 2 }))).tokenName).toBe("tok-B");
    expect((await d.generate(baseReq())).tokenName).toBe("tok-A");
  });

  it("recomputes weighted selection from quota-eligible tokens", async () => {
    const d = new AnthropicDispatcher();
    d.onTokenAdded(1, "tok-A", creds(), 80, 10);
    d.onTokenAdded(2, "tok-B", creds(), 80, 1);
    readAnthropicQuotaUsageMock
      .mockResolvedValueOnce(quotaOk(90))
      .mockResolvedValueOnce(quotaOk(10));

    expect((await d.generate(baseReq())).tokenName).toBe("tok-B");
  });

  it("resets the schedule when a token weight changes", async () => {
    const d = new AnthropicDispatcher();
    d.onTokenAdded(1, "tok-A", creds(), null, 1);
    d.onTokenAdded(2, "tok-B", creds(), null, 1);
    await d.generate(baseReq());

    d.onTokenUpdated(1, "tok-A", creds(), null, 1);
    d.onTokenUpdated(2, "tok-B", creds(), null, 3);
    const names = await selectedTokenNames(d, 4);

    expect(names.filter((name) => name === "tok-B")).toHaveLength(3);
  });

  it("threshold 초과 토큰은 후보에서 제외하고 미설정 토큰을 선택한다", async () => {
    const d = new AnthropicDispatcher();
    d.onTokenAdded(1, "tok-A", creds(), 80, 1);
    d.onTokenAdded(2, "tok-B", creds(), null, 1);
    readAnthropicQuotaUsageMock.mockResolvedValueOnce(quotaOk(85, 1_000));

    const result = await d.generate(baseReq());

    expect(result.tokenName).toBe("tok-B");
    expect(readAnthropicQuotaUsageMock).toHaveBeenCalledTimes(1);
    expect(loggerInfoMock).toHaveBeenCalledWith(
      expect.stringContaining("over_threshold"),
      expect.objectContaining({
        tokenId: 1,
        tokenName: "tok-A",
        provider: "anthropic",
        threshold: 80,
        cachedUtilization: 85,
        cacheAge: 1_000,
        reason: "over_threshold",
      }),
    );
  });

  it("threshold 경계는 utilization >= threshold 일 때 제외한다", async () => {
    const d = new AnthropicDispatcher();
    d.onTokenAdded(1, "tok-A", creds(), 80, 1);
    d.onTokenAdded(2, "tok-B", creds(), 80, 1);
    readAnthropicQuotaUsageMock
      .mockResolvedValueOnce(quotaOk(80))
      .mockResolvedValueOnce(quotaOk(79));

    const result = await d.generate(baseReq());

    expect(result.tokenName).toBe("tok-B");
  });

  it("quota 조회 실패는 fail-open 으로 통과시키고 lookup_fail_open 로그를 남긴다", async () => {
    const d = new AnthropicDispatcher();
    d.onTokenAdded(1, "tok-A", creds(), 80, 1);
    readAnthropicQuotaUsageMock.mockResolvedValueOnce(quotaFail("timeout"));

    const result = await d.generate(baseReq());

    expect(result.tokenName).toBe("tok-A");
    expect(loggerWarnMock).toHaveBeenCalledWith(
      expect.stringContaining("lookup_fail_open"),
      expect.objectContaining({
        tokenId: 1,
        tokenName: "tok-A",
        provider: "anthropic",
        threshold: 80,
        reason: "lookup_fail_open",
      }),
    );
  });

  it("utilization 0 은 정상 조회로 보고 fail-open 로그를 남기지 않는다", async () => {
    const d = new AnthropicDispatcher();
    d.onTokenAdded(1, "tok-A", creds(), 80, 1);
    readAnthropicQuotaUsageMock.mockResolvedValueOnce(quotaOk(0));

    const result = await d.generate(baseReq());

    expect(result.tokenName).toBe("tok-A");
    expect(loggerWarnMock).not.toHaveBeenCalledWith(
      expect.stringContaining("lookup_fail_open"),
      expect.anything(),
    );
  });

  it("모든 threshold 설정 토큰이 초과되면 typed error 로 실패한다", async () => {
    const d = new AnthropicDispatcher();
    d.onTokenAdded(1, "tok-A", creds(), 80, 1);
    d.onTokenAdded(2, "tok-B", creds(), 90, 1);
    readAnthropicQuotaUsageMock
      .mockResolvedValueOnce(quotaOk(85, 100))
      .mockResolvedValueOnce(quotaOk(95, 200));

    const error = await d.generate(baseReq()).catch((e) => e);

    expect(error).toBeInstanceOf(QuotaThresholdExceededError);
    expect(error).toMatchObject({ code: "QUOTA_THRESHOLD_EXCEEDED" });
    expect(error.message).toBe(
      "All anthropic tokens exceeded quota threshold: tok-A (threshold 80%), tok-B (threshold 90%)",
    );
  });

  it("가중 선택은 quota 초과 토큰을 제외한 eligible 집합에서 계산한다", async () => {
    const d = new AnthropicDispatcher();
    d.onTokenAdded(1, "tok-A", creds(), 80, 1);
    d.onTokenAdded(2, "tok-B", creds(), 80, 1);
    d.onTokenAdded(3, "tok-C", creds(), 80, 1);

    readAnthropicQuotaUsageMock
      .mockResolvedValueOnce(quotaOk(10))
      .mockResolvedValueOnce(quotaOk(10))
      .mockResolvedValueOnce(quotaOk(10));
    await d.generate(baseReq());
    readAnthropicQuotaUsageMock.mockReset();

    readAnthropicQuotaUsageMock
      .mockResolvedValueOnce(quotaOk(95))
      .mockResolvedValueOnce(quotaOk(10))
      .mockResolvedValueOnce(quotaOk(10));

    const result = await d.generate(baseReq());

    expect(result.tokenName).not.toBe("tok-A");
    expect(new Set(["tok-B", "tok-C"]).has(result.tokenName)).toBe(true);
  });

  it("동시 요청은 quota await 이후 동기 선택으로 서로 다른 eligible 토큰을 고른다", async () => {
    const d = new AnthropicDispatcher();
    d.onTokenAdded(1, "tok-A", creds(), 80, 1);
    d.onTokenAdded(2, "tok-B", creds(), 80, 1);
    readAnthropicQuotaUsageMock.mockResolvedValue(quotaOk(0));

    const results = await Promise.all([d.generate(baseReq()), d.generate(baseReq())]);

    expect(new Set(results.map((r) => r.tokenName)).size).toBe(2);
  });

  it("onTokenRemoved 후 그 토큰 미선택", async () => {
    const d = new AnthropicDispatcher();
    d.onTokenAdded(1, "tok-A", creds(), null, 1);
    d.onTokenRemoved(1);

    await expect(d.generate(baseReq())).rejects.toThrow(/No anthropic tokens/);
  });

  it("onTokenUpdated 는 토큰 credentials 를 in-place 갱신한다", async () => {
    const d = new AnthropicDispatcher();
    d.onTokenAdded(1, "tok-A", creds(3_600_000, "acc-1"), null, 1);
    d.onTokenUpdated(1, "tok-A", creds(7_200_000, "acc-2"), null, 1);

    await d.generate(baseReq());

    const call = firstRunRequest();
    expect(call.tokenId).toBe(1);
  });

  it("model prefix 정규화: 'anthropic/claude-opus-4-8' → canonical 로 세션/result.model", async () => {
    const d = new AnthropicDispatcher();
    d.onTokenAdded(1, "tok-A", creds(), null, 1);

    const result = await d.generate(baseReq({ model: "anthropic/claude-opus-4-8" }));

    const call = firstRunRequest();
    expect(call.model).toBe("claude-opus-4-8");
    expect(result.model).toBe("claude-opus-4-8");
  });

  it("[1m] suffix 정규화: result/runClaudeSession 에는 base canonical 만 전달", async () => {
    const d = new AnthropicDispatcher();
    d.onTokenAdded(1, "tok-A", creds(), null, 1);

    const result = await d.generate(baseReq({ model: "anthropic/claude-sonnet-4-6[1m]" }));

    const call = firstRunRequest();
    expect(call.model).toBe("claude-sonnet-4-6");
    expect(result.model).toBe("claude-sonnet-4-6");
  });

  it("unsupported alias + [1m] 은 조용히 다운그레이드하지 않는다", async () => {
    const d = new AnthropicDispatcher();
    d.onTokenAdded(1, "tok-A", creds(), null, 1);

    await expect(d.generate(baseReq({ model: "sonnet[1m]" }))).rejects.toThrow(
      /Unsupported Anthropic 1M model suffix/,
    );
  });

  it("model 미지정 → ANTHROPIC_DEFAULT_MODEL 적용", async () => {
    const d = new AnthropicDispatcher();
    d.onTokenAdded(1, "tok-A", creds(), null, 1);

    const result = await d.generate(baseReq({ model: undefined }));

    const call = firstRunRequest();
    expect(call.model).toBe(ANTHROPIC_DEFAULT_MODEL);
    expect(result.model).toBe(ANTHROPIC_DEFAULT_MODEL);
  });

  it("replaceTokens: DB 기준 풀 재동기화 — 없는 토큰 제거, 새 토큰 추가", async () => {
    const d = new AnthropicDispatcher();
    d.onTokenAdded(1, "tok-A", creds(), null, 1);

    d.replaceTokens([{ id: 2, name: "tok-B", credentials: creds(), weight: 1 }]);
    const result = await d.generate(baseReq());

    expect(result.tokenName).toBe("tok-B");
  });

  it("generateStream: onDelta/onComplete 호출", async () => {
    const d = new AnthropicDispatcher();
    d.onTokenAdded(1, "tok-A", creds(), null, 1);
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
    expect(firstRunRequest().includePartialMessages).toBe(true);
  });

  it("generateStream: completion callback throw를 onError로 전달하고 정상 종료한다", async () => {
    const d = new AnthropicDispatcher();
    d.onTokenAdded(1, "tok-A", creds(), null, 1);
    runClaudeSessionMock.mockResolvedValueOnce(sessionResult({ text: "malformed envelope" }));
    const completionError = new ToolCallEmulationError(
      "response envelope is missing required keys: toolCalls",
    );
    const onComplete = vi.fn(() => {
      throw completionError;
    });
    const onError = vi.fn();

    await expect(
      d.generateStream(baseReq(), {
        onDelta: vi.fn(),
        onComplete,
        onError,
      }),
    ).resolves.toBeUndefined();

    expect(onComplete).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(completionError);
    expect(firstRunRequest().includePartialMessages).toBe(true);
  });

  it("generateStream: Claude server error 는 onError 로 전달하고 complete 하지 않는다", async () => {
    const d = new AnthropicDispatcher();
    d.onTokenAdded(1, "tok-A", creds(), null, 1);
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
    expect(firstRunRequest().includePartialMessages).toBe(true);
  });

  it("refresh: 만료 임박 토큰은 provider 포함해 refreshToken 호출, 새 access token 으로 세션 진행", async () => {
    const d = new AnthropicDispatcher();
    d.onTokenAdded(1, "tok-A", creds(30_000), null, 1);
    refreshTokenMock.mockResolvedValueOnce("sk-ant-oat01-refreshed");

    await d.generate(baseReq());

    expect(refreshTokenMock).toHaveBeenCalledTimes(1);
    const refreshArg = firstRefreshTokenArg();
    expect(refreshArg.provider).toBe("anthropic");
    expect(refreshArg.id).toBe(1);
    expect(firstRunRequest().token).toBe("sk-ant-oat01-refreshed");
  });

  it("refresh: 만료 여유 있으면 refresh 안 함, 기존 access token 사용", async () => {
    const d = new AnthropicDispatcher();
    d.onTokenAdded(1, "tok-A", creds(3_600_000), null, 1);

    await d.generate(baseReq());

    expect(refreshTokenMock).not.toHaveBeenCalled();
    expect(firstRunRequest().token).toBe("sk-ant-oat01-test");
  });

  it("refresh 실패해도 기존 access token 으로 진행 — 요청을 죽이지 않음", async () => {
    const d = new AnthropicDispatcher();
    d.onTokenAdded(1, "tok-A", creds(30_000), null, 1);
    refreshTokenMock.mockRejectedValueOnce(new Error("refresh boom"));

    const result = await d.generate(baseReq());

    expect(result.text).toBe("hello");
    expect(firstRunRequest().token).toBe("sk-ant-oat01-test");
  });
});
