import { beforeEach, describe, expect, it, vi } from "vitest";

import { QuotaThresholdExceededError } from "../../../application/qgrid/qgrid.types";
import { type OpenAICredentials } from "../../../application/token/token.types";
import { type GenerateRequest, type GenerateResult } from "../common/provider-dispatcher";
import { type CodexAppServerWorker } from "./codex-worker";
import { OpenAIDispatcher } from "./openai-dispatcher";
import { type OpenAIQuotaUsageResult } from "./openai-quota";

const { readOpenAIQuotaUsageMock, loggerInfoMock, loggerWarnMock } = vi.hoisted(() => ({
  readOpenAIQuotaUsageMock: vi.fn(),
  loggerInfoMock: vi.fn(),
  loggerWarnMock: vi.fn(),
}));

vi.mock("@logtape/logtape", () => ({
  getLogger: () => ({ info: loggerInfoMock, warn: loggerWarnMock }),
}));

vi.mock("./openai-quota", () => ({
  readOpenAIQuotaUsage: readOpenAIQuotaUsageMock,
}));

function credentials(overrides: Partial<OpenAICredentials> = {}): OpenAICredentials {
  return {
    accessToken: "access",
    refreshToken: "refresh",
    accessTokenExpiresAt: Date.now() + 60_000,
    accountId: "account",
    planType: "plus",
    ...overrides,
  };
}

function quotaOk(utilizationPct: number): OpenAIQuotaUsageResult {
  return {
    kind: "ok",
    utilizationPct,
    cacheAgeMs: 100,
    windowDurationMins: 300,
    resetsAt: 1_782_912_345,
    limitId: "codex-primary",
  };
}

function quotaFail(reason = "rate limit lookup failed"): OpenAIQuotaUsageResult {
  return { kind: "lookup_failed", reason };
}

function baseReq(overrides: Partial<GenerateRequest> = {}): GenerateRequest {
  return {
    model: "gpt-5-codex",
    systemPrompt: "you are helpful",
    coldInput: [{ type: "text", text: "hi", text_elements: [] }],
    ...overrides,
  };
}

function resultFor(worker: CodexAppServerWorker, threadId = "thread-new"): GenerateResult {
  return {
    text: "ok",
    tokenName: worker.tokenName,
    usage: {
      totalTokens: 1,
      inputTokens: 1,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
    },
    durationMs: 10,
    model: "gpt-5-codex",
    threadCoord: {
      workerId: worker.tokenId * 10 + worker.workerIndex,
      threadId,
      epoch: worker.epoch,
    },
  };
}

function fakeWorker(
  reusableOrOptions:
    | boolean
    | {
        tokenId?: number;
        tokenName?: string;
        workerIndex?: number;
        reusable?: boolean;
        ready?: boolean;
        active?: boolean;
        busy?: boolean;
        threads?: string[];
        epoch?: number;
        rateLimits?: unknown;
      },
): CodexAppServerWorker {
  const options =
    typeof reusableOrOptions === "boolean" ? { reusable: reusableOrOptions } : reusableOrOptions;
  let busy = options.busy ?? false;
  const worker = {
    tokenId: options.tokenId ?? 1,
    tokenName: options.tokenName ?? "token",
    workerIndex: options.workerIndex ?? 0,
    active: options.active ?? true,
    epoch: options.epoch ?? 1,
    kill: vi.fn(async () => {}),
    canReuseForToken: vi.fn(() => options.reusable ?? true),
    updateTokenState: vi.fn(),
    get isReady() {
      return options.ready ?? true;
    },
    tryAcquireTurn: vi.fn(() => {
      if (busy) return false;
      busy = true;
      return true;
    }),
    releaseTurn: vi.fn(() => {
      busy = false;
    }),
    hasThread: vi.fn((threadId: string) => (options.threads ?? []).includes(threadId)),
    getRateLimits: vi.fn(
      async () => options.rateLimits ?? { rateLimits: {}, rateLimitsByLimitId: null },
    ),
  } as unknown as CodexAppServerWorker;
  return worker;
}

beforeEach(() => {
  readOpenAIQuotaUsageMock.mockReset();
  readOpenAIQuotaUsageMock.mockResolvedValue(quotaOk(0));
  loggerInfoMock.mockReset();
  loggerWarnMock.mockReset();
});

function addWorkers(dispatcher: OpenAIDispatcher, workers: CodexAppServerWorker[]): void {
  const byToken = new Map<number, CodexAppServerWorker[]>();
  for (const worker of workers) {
    const group = byToken.get(worker.tokenId) ?? [];
    group.push(worker);
    byToken.set(worker.tokenId, group);
  }
  for (const [tokenId, group] of byToken) dispatcher.workerPool.set(tokenId, group);
}

async function waitForQueue(dispatcher: OpenAIDispatcher, length = 1): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (dispatcher.queueLength === length) return;
  }
  expect(dispatcher.queueLength).toBe(length);
}

describe("OpenAIDispatcher token updates", () => {
  it("keeps existing workers when only OpenAI auth tokens rotate", async () => {
    const dispatcher = new OpenAIDispatcher();
    const worker = fakeWorker(true);
    const spawnWorkers = vi.spyOn(dispatcher, "spawnWorkers").mockResolvedValue(undefined);
    dispatcher.workerPool.set(1, [worker]);

    const rotated = credentials({
      accessToken: "new-access",
      refreshToken: "new-refresh",
      idToken: "new-id",
      accessTokenExpiresAt: Date.now() + 120_000,
    });
    await dispatcher.onTokenUpdated(1, "renamed-token", rotated, 80);

    expect(worker.kill).not.toHaveBeenCalled();
    expect(worker.updateTokenState).toHaveBeenCalledWith("renamed-token", rotated);
    expect(spawnWorkers).not.toHaveBeenCalled();
    expect(dispatcher.workerPool.get(1)).toEqual([worker]);
  });

  it("restarts workers when the OpenAI login identity changes", async () => {
    const dispatcher = new OpenAIDispatcher();
    const worker = fakeWorker(false);
    const spawnWorkers = vi.spyOn(dispatcher, "spawnWorkers").mockResolvedValue(undefined);
    dispatcher.workerPool.set(1, [worker]);

    const changedIdentity = credentials({ accountId: "other-account" });
    await dispatcher.onTokenUpdated(1, "token", changedIdentity, null);

    expect(worker.kill).toHaveBeenCalledTimes(1);
    expect(spawnWorkers).toHaveBeenCalledWith(1, "token", changedIdentity, null);
  });

  it("uses tokenId keyed rate-limit cache", async () => {
    const dispatcher = new OpenAIDispatcher();
    const rateLimitsA = { rateLimits: { primary: { usedPercent: 10 } }, rateLimitsByLimitId: null };
    const rateLimitsB = { rateLimits: { primary: { usedPercent: 20 } }, rateLimitsByLimitId: null };
    const workerA = fakeWorker({ tokenId: 1, tokenName: "same-name", rateLimits: rateLimitsA });
    const workerB = fakeWorker({ tokenId: 2, tokenName: "same-name", rateLimits: rateLimitsB });
    addWorkers(dispatcher, [workerA, workerB]);

    await expect(dispatcher.getRateLimitsByTokenId(1)).resolves.toMatchObject({
      data: rateLimitsA,
    });
    await expect(dispatcher.getRateLimitsByTokenId(1)).resolves.toMatchObject({
      data: rateLimitsA,
    });
    await expect(dispatcher.getRateLimitsByTokenId(2)).resolves.toMatchObject({
      data: rateLimitsB,
    });

    expect(workerA.getRateLimits).toHaveBeenCalledTimes(1);
    expect(workerB.getRateLimits).toHaveBeenCalledTimes(1);
  });

  it("replaceTokens removes absent OpenAI workers and updates threshold metadata", async () => {
    const dispatcher = new OpenAIDispatcher();
    const workerA = fakeWorker({ tokenId: 1, tokenName: "tok-A" });
    const workerB = fakeWorker({ tokenId: 2, tokenName: "tok-B" });
    addWorkers(dispatcher, [workerA, workerB]);

    await dispatcher.replaceTokens([
      { id: 1, name: "tok-A", credentials: credentials(), quotaThreshold: 80 },
    ]);
    readOpenAIQuotaUsageMock.mockResolvedValueOnce(quotaOk(85));

    await expect(dispatcher.acquireIdleWorker()).rejects.toBeInstanceOf(
      QuotaThresholdExceededError,
    );
    expect(workerB.kill).toHaveBeenCalledTimes(1);
  });
});

describe("OpenAIDispatcher quota threshold gate", () => {
  it("excludes over-threshold tokenIds before idle selection", async () => {
    const dispatcher = new OpenAIDispatcher();
    const workerA = fakeWorker({ tokenId: 1, tokenName: "tok-A" });
    const workerB = fakeWorker({ tokenId: 2, tokenName: "tok-B" });
    addWorkers(dispatcher, [workerA, workerB]);
    await dispatcher.onTokenUpdated(1, "tok-A", credentials(), 80);
    await dispatcher.onTokenUpdated(2, "tok-B", credentials(), 80);
    readOpenAIQuotaUsageMock.mockResolvedValueOnce(quotaOk(85)).mockResolvedValueOnce(quotaOk(10));

    const worker = await dispatcher.acquireIdleWorker();

    expect(worker?.tokenName).toBe("tok-B");
    expect(workerA.tryAcquireTurn).not.toHaveBeenCalled();
    expect(loggerInfoMock).toHaveBeenCalledWith(
      expect.stringContaining("over_threshold"),
      expect.objectContaining({
        tokenId: 1,
        tokenName: "tok-A",
        provider: "openai",
        threshold: 80,
        cachedUtilization: 85,
        windowDurationMins: 300,
        resetsAt: 1_782_912_345,
        limitId: "codex-primary",
        reason: "over_threshold",
      }),
    );
  });

  it("keeps eligible busy workers queued instead of throwing quota errors", async () => {
    const dispatcher = new OpenAIDispatcher();
    const worker = fakeWorker({ tokenId: 1, tokenName: "tok-A", busy: true });
    addWorkers(dispatcher, [worker]);
    await dispatcher.onTokenUpdated(1, "tok-A", credentials(), 80);
    readOpenAIQuotaUsageMock.mockResolvedValue(quotaOk(10));

    await expect(dispatcher.acquireIdleWorker()).resolves.toBeNull();
    const queued = dispatcher.enqueue(async (w) => w.tokenName);
    await waitForQueue(dispatcher);

    worker.releaseTurn();
    await dispatcher.drainQueue(worker);
    await expect(queued).resolves.toBe("tok-A");
  });

  it("throws typed error when no active ready tokenId passes threshold", async () => {
    const dispatcher = new OpenAIDispatcher();
    addWorkers(dispatcher, [fakeWorker({ tokenId: 1, tokenName: "tok-A" })]);
    await dispatcher.onTokenUpdated(1, "tok-A", credentials(), 80);
    readOpenAIQuotaUsageMock.mockResolvedValueOnce(quotaOk(90));

    await expect(dispatcher.acquireIdleWorker()).rejects.toBeInstanceOf(
      QuotaThresholdExceededError,
    );
  });

  it("rechecks threshold at drain time before assigning the released worker", async () => {
    const dispatcher = new OpenAIDispatcher();
    const workerA = fakeWorker({ tokenId: 1, tokenName: "tok-A" });
    const workerB = fakeWorker({ tokenId: 2, tokenName: "tok-B" });
    addWorkers(dispatcher, [workerA, workerB]);
    await dispatcher.onTokenUpdated(1, "tok-A", credentials(), 80);
    await dispatcher.onTokenUpdated(2, "tok-B", credentials(), 80);
    const queued = dispatcher.enqueue(async (w) => w.tokenName);
    await waitForQueue(dispatcher);
    readOpenAIQuotaUsageMock.mockReset();
    readOpenAIQuotaUsageMock
      .mockResolvedValueOnce(quotaOk(90))
      .mockResolvedValueOnce(quotaOk(90))
      .mockResolvedValueOnce(quotaOk(10));

    await dispatcher.drainQueue(workerA);

    await expect(queued).resolves.toBe("tok-B");
  });

  it("serializes concurrent drain calls so a queue item is not assigned twice", async () => {
    const dispatcher = new OpenAIDispatcher();
    const worker = fakeWorker({ tokenId: 1, tokenName: "tok-A" });
    addWorkers(dispatcher, [worker]);
    const execute = vi.fn(async (w: CodexAppServerWorker) => w.tokenName);
    const queued = dispatcher.enqueue(execute);
    await waitForQueue(dispatcher);

    await Promise.all([dispatcher.drainQueue(worker), dispatcher.drainQueue(worker)]);

    await expect(queued).resolves.toBe("tok-A");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("treats quota lookup failure as fail-open", async () => {
    const dispatcher = new OpenAIDispatcher();
    addWorkers(dispatcher, [fakeWorker({ tokenId: 1, tokenName: "tok-A" })]);
    await dispatcher.onTokenUpdated(1, "tok-A", credentials(), 80);
    readOpenAIQuotaUsageMock.mockResolvedValueOnce(quotaFail("rpc timeout"));

    await expect(dispatcher.acquireIdleWorker()).resolves.toMatchObject({ tokenName: "tok-A" });
    expect(loggerWarnMock).toHaveBeenCalledWith(
      expect.stringContaining("lookup_fail_open"),
      expect.objectContaining({
        tokenId: 1,
        tokenName: "tok-A",
        provider: "openai",
        threshold: 80,
        reason: "lookup_fail_open",
      }),
    );
  });

  it("falls back from over-threshold reuse to cold on another tokenId", async () => {
    const dispatcher = new OpenAIDispatcher();
    const workerA = fakeWorker({ tokenId: 1, tokenName: "tok-A", threads: ["thread-1"] });
    const workerB = fakeWorker({ tokenId: 2, tokenName: "tok-B" });
    addWorkers(dispatcher, [workerA, workerB]);
    await dispatcher.onTokenUpdated(1, "tok-A", credentials(), 80);
    await dispatcher.onTokenUpdated(2, "tok-B", credentials(), 80);
    readOpenAIQuotaUsageMock.mockResolvedValueOnce(quotaOk(85)).mockResolvedValueOnce(quotaOk(10));
    const executeTurn = vi
      .spyOn(dispatcher, "executeTurn")
      .mockImplementation(async (worker, _req, reuseThreadId) =>
        resultFor(worker, reuseThreadId ?? "thread-new"),
      );

    const result = await dispatcher.generate(
      baseReq({ reuse: { workerId: 10, threadId: "thread-1", epoch: 1 } }),
    );

    expect(result.tokenName).toBe("tok-B");
    expect(executeTurn.mock.calls[0]?.[0]).toBe(workerB);
    expect(executeTurn.mock.calls[0]?.[2]).toBeUndefined();
    expect(workerA.tryAcquireTurn).not.toHaveBeenCalled();
  });

  it("keeps reuse when the reused token is under threshold", async () => {
    const dispatcher = new OpenAIDispatcher();
    const worker = fakeWorker({ tokenId: 1, tokenName: "tok-A", threads: ["thread-1"] });
    addWorkers(dispatcher, [worker]);
    await dispatcher.onTokenUpdated(1, "tok-A", credentials(), 80);
    readOpenAIQuotaUsageMock.mockResolvedValueOnce(quotaOk(10));
    const executeTurn = vi
      .spyOn(dispatcher, "executeTurn")
      .mockImplementation(async (selected, _req, reuseThreadId) =>
        resultFor(selected, reuseThreadId ?? "thread-new"),
      );

    const result = await dispatcher.generate(
      baseReq({ reuse: { workerId: 10, threadId: "thread-1", epoch: 1 } }),
    );

    expect(result.tokenName).toBe("tok-A");
    expect(executeTurn).toHaveBeenCalledWith(worker, expect.anything(), "thread-1");
  });

  it("throws typed error when reuse is over threshold and no cold tokenId is eligible", async () => {
    const dispatcher = new OpenAIDispatcher();
    const worker = fakeWorker({ tokenId: 1, tokenName: "tok-A", threads: ["thread-1"] });
    addWorkers(dispatcher, [worker]);
    await dispatcher.onTokenUpdated(1, "tok-A", credentials(), 80);
    readOpenAIQuotaUsageMock.mockResolvedValueOnce(quotaOk(85));

    await expect(
      dispatcher.generate(baseReq({ reuse: { workerId: 10, threadId: "thread-1", epoch: 1 } })),
    ).rejects.toBeInstanceOf(QuotaThresholdExceededError);
  });
});
