import { beforeEach, describe, expect, it, vi } from "vitest";

import { QuotaThresholdExceededError } from "../../../application/qgrid/qgrid.types";
import { type OpenAICredentials } from "../../../application/token/token.types";
import { type GenerateRequest, type GenerateResult } from "../common/provider-dispatcher";
import { type CodexAppServerWorker } from "./codex-worker";
import {
  estimateOpenAIWorkerRssGiB,
  ImageGenerationError,
  makeOpenAIWorkerId,
  MAX_OPENAI_WORKERS_PER_TOKEN,
  type OpenAIWorkerPoolConfig,
  OpenAIDispatcher,
  resolveOpenAIWorkerPoolConfig,
} from "./openai-dispatcher";
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
      workerId: makeOpenAIWorkerId(worker.tokenId, worker.workerIndex),
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
        // 이미지 게이트/생성 mock. imageGateReason 이 있으면 checkImageGenerationSupport 가
        // 그 사유를 반환(불가), null 이면 통과. imageTurnResult 로 worker.executeTurn 반환값 지정.
        imageGateReason?: string | null;
        imageTurnResult?: { images?: Array<{ data: string; revisedPrompt: string | null }>; imageAttempted?: boolean };
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
    get hasCapacity() {
      return !busy;
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
    checkImageGenerationSupport: vi.fn(async () => options.imageGateReason ?? null),
    executeTurn: vi.fn(async () => ({
      text: "ok",
      usage: { totalTokens: 1, inputTokens: 1, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 },
      durationMs: 10,
      ttftMs: null,
      model: "gpt-5-codex",
      threadId: "thread-new",
      images: options.imageTurnResult?.images,
      imageAttempted: options.imageTurnResult?.imageAttempted,
    })),
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

function autoscaleConfig(
  overrides: Partial<OpenAIWorkerPoolConfig> = {},
): OpenAIWorkerPoolConfig {
  return {
    autoscale: true,
    minWorkersPerToken: 1,
    maxWorkersPerToken: 3,
    scaleIntervalMs: 5_000,
    scaleDownIdleMs: 600_000,
    maxEstimatedRssGiB: 16,
    minHostAvailableGiB: 20,
    ...overrides,
  };
}

async function waitForQueue(dispatcher: OpenAIDispatcher, length = 1): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (dispatcher.queueLength === length) return;
  }
  expect(dispatcher.queueLength).toBe(length);
}

describe("OpenAIDispatcher worker capacity", () => {
  it("supports 20 workers per token without worker id collisions", () => {
    expect(MAX_OPENAI_WORKERS_PER_TOKEN).toBe(20);

    const tokenIds = [1, 2, 41, 47, 55, 56, 58];
    const workerIds = tokenIds.flatMap((tokenId) =>
      Array.from({ length: MAX_OPENAI_WORKERS_PER_TOKEN }, (_, workerIndex) =>
        makeOpenAIWorkerId(tokenId, workerIndex),
      ),
    );

    expect(new Set(workerIds)).toHaveLength(workerIds.length);
    expect(makeOpenAIWorkerId(1, 10)).not.toBe(makeOpenAIWorkerId(2, 0));
  });

  it("defaults to autoscaling from 5 to 15 workers per token", () => {
    expect(resolveOpenAIWorkerPoolConfig({})).toMatchObject({
      autoscale: true,
      minWorkersPerToken: 5,
      maxWorkersPerToken: 15,
    });
  });

  it("keeps an explicit fixed worker mode for emergency rollback", () => {
    expect(
      resolveOpenAIWorkerPoolConfig({
        QGRID_WORKERS_PER_TOKEN: "5",
        QGRID_OPENAI_AUTOSCALE: "false",
      }),
    ).toMatchObject({
      autoscale: false,
      minWorkersPerToken: 5,
      maxWorkersPerToken: 5,
    });
  });

  it("estimates worker RSS from the dev0 measurement model", () => {
    expect(estimateOpenAIWorkerRssGiB(50)).toBeCloseTo(8.56, 2);
    expect(estimateOpenAIWorkerRssGiB(60)).toBeCloseTo(10.13, 2);
  });
});

describe("OpenAIDispatcher monit stats", () => {
  it("reports worker counts grouped by token name", () => {
    const dispatcher = new OpenAIDispatcher(autoscaleConfig({ autoscale: false }), () => 64);
    addWorkers(dispatcher, [
      fakeWorker({ tokenId: 1, tokenName: "openai/nk" }),
      fakeWorker({ tokenId: 1, tokenName: "openai/nk", workerIndex: 1 }),
      fakeWorker({ tokenId: 2, tokenName: "openai/haze" }),
    ]);

    expect(dispatcher.workerCountsByToken).toEqual([
      { name: "openai/haze", count: 1 },
      { name: "openai/nk", count: 2 },
    ]);
  });
});

describe("OpenAIDispatcher autoscaling", () => {
  it("scales six active tokens from 5 to 15 workers per token", async () => {
    const dispatcher = new OpenAIDispatcher(
      autoscaleConfig({
        minWorkersPerToken: 5,
        maxWorkersPerToken: 15,
        maxEstimatedRssGiB: 16,
      }),
      () => 64,
    );
    vi.spyOn(dispatcher, "spawnWorkers").mockResolvedValue(undefined);

    for (let tokenId = 1; tokenId <= 6; tokenId++) {
      await dispatcher.onTokenAdded(tokenId, `token-${tokenId}`, credentials(), null, 1);
      dispatcher.workerPool.set(
        tokenId,
        Array.from({ length: 5 }, (_, workerIndex) => fakeWorker({ tokenId, workerIndex })),
      );
    }

    vi.spyOn(dispatcher, "spawnSingleWorker").mockImplementation(
      async (tokenId, tokenName, _credentials, workerIndex) =>
        fakeWorker({ tokenId, tokenName, workerIndex }),
    );

    for (let step = 0; step < 12; step++) await dispatcher.scaleUpOneStep();

    expect(dispatcher.workerCount).toBe(90);
    expect([...dispatcher.workerPool.values()].map((workers) => workers.length)).toEqual([
      15, 15, 15, 15, 15, 15,
    ]);
    expect(estimateOpenAIWorkerRssGiB(dispatcher.workerCount)).toBeLessThan(16);
  });

  it("requests a scale-up evaluation when a request enters the queue", async () => {
    const dispatcher = new OpenAIDispatcher(autoscaleConfig(), () => 64);
    addWorkers(dispatcher, [fakeWorker({ tokenId: 1, busy: true })]);
    const scaleUpOneStep = vi.spyOn(dispatcher, "scaleUpOneStep").mockResolvedValue(undefined);

    const queued = dispatcher.enqueue(async () => "ok");
    const rejection = expect(queued).rejects.toThrow("TEST_CLEANUP");
    await waitForQueue(dispatcher);
    dispatcher.rejectAllQueued("TEST_CLEANUP");

    await rejection;
    expect(scaleUpOneStep).toHaveBeenCalledTimes(1);
  });

  it("adds one worker to each active token in a scale-up step", async () => {
    const dispatcher = new OpenAIDispatcher(autoscaleConfig(), () => 64);
    const tokenCredentials = credentials();
    vi.spyOn(dispatcher, "spawnWorkers").mockResolvedValue(undefined);
    await dispatcher.onTokenAdded(1, "token", tokenCredentials, null, 1);
    dispatcher.workerPool.set(1, [fakeWorker({ tokenId: 1, workerIndex: 0 })]);
    const added = fakeWorker({ tokenId: 1, workerIndex: 1 });
    const spawnSingleWorker = vi.spyOn(dispatcher, "spawnSingleWorker").mockResolvedValue(added);

    await dispatcher.scaleUpOneStep();

    expect(spawnSingleWorker).toHaveBeenCalledWith(1, "token", tokenCredentials, 1);
    expect(dispatcher.workerPool.get(1)).toHaveLength(2);
    expect(dispatcher.workerCount).toBe(2);
  });

  it("does not scale past the estimated RSS guard", async () => {
    const dispatcher = new OpenAIDispatcher(
      autoscaleConfig({ maxEstimatedRssGiB: 0.9 }),
      () => 64,
    );
    vi.spyOn(dispatcher, "spawnWorkers").mockResolvedValue(undefined);
    await dispatcher.onTokenAdded(1, "token", credentials(), null, 1);
    dispatcher.workerPool.set(1, [fakeWorker({ tokenId: 1, workerIndex: 0 })]);
    const spawnSingleWorker = vi.spyOn(dispatcher, "spawnSingleWorker");

    await dispatcher.scaleUpOneStep();

    expect(spawnSingleWorker).not.toHaveBeenCalled();
    expect(dispatcher.workerCount).toBe(1);
  });

  it("does not scale when host available memory is below the floor", async () => {
    const dispatcher = new OpenAIDispatcher(autoscaleConfig(), () => 10);
    vi.spyOn(dispatcher, "spawnWorkers").mockResolvedValue(undefined);
    await dispatcher.onTokenAdded(1, "token", credentials(), null, 1);
    dispatcher.workerPool.set(1, [fakeWorker({ tokenId: 1, workerIndex: 0 })]);
    const spawnSingleWorker = vi.spyOn(dispatcher, "spawnSingleWorker");

    await dispatcher.scaleUpOneStep();

    expect(spawnSingleWorker).not.toHaveBeenCalled();
    expect(dispatcher.workerCount).toBe(1);
  });

  it("removes only idle workers above the configured minimum for inactive tokens", async () => {
    const dispatcher = new OpenAIDispatcher(autoscaleConfig(), () => 64);
    vi.spyOn(dispatcher, "spawnWorkers").mockResolvedValue(undefined);
    await dispatcher.onTokenAdded(1, "token", credentials(), null, 1);
    const busy = fakeWorker({ tokenId: 1, workerIndex: 0, busy: true });
    const idle = fakeWorker({ tokenId: 1, workerIndex: 1 });
    dispatcher.workerPool.set(1, [busy, idle]);
    dispatcher.onTokenDeactivated(1);

    await dispatcher.scaleDownOneStep();
    await dispatcher.scaleDownOneStep();

    expect(idle.kill).toHaveBeenCalledTimes(1);
    expect(busy.kill).not.toHaveBeenCalled();
    expect(dispatcher.workerPool.get(1)).toEqual([busy]);
  });
});

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
    expect(spawnWorkers).toHaveBeenCalledWith(1, "token", changedIdentity, null, 1);
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
      { id: 1, name: "tok-A", credentials: credentials(), quotaThreshold: 80, weight: 1 },
    ]);
    readOpenAIQuotaUsageMock.mockResolvedValueOnce(quotaOk(85));

    await expect(dispatcher.acquireIdleWorker()).rejects.toBeInstanceOf(
      QuotaThresholdExceededError,
    );
    expect(workerB.kill).toHaveBeenCalledTimes(1);
  });
});

describe("OpenAIDispatcher weighted routing", () => {
  it("routes cold OpenAI requests by token weight instead of worker count", async () => {
    const dispatcher = new OpenAIDispatcher();
    const a0 = fakeWorker({ tokenId: 1, tokenName: "tok-A", workerIndex: 0 });
    const a1 = fakeWorker({ tokenId: 1, tokenName: "tok-A", workerIndex: 1 });
    const b0 = fakeWorker({ tokenId: 2, tokenName: "tok-B", workerIndex: 0 });
    addWorkers(dispatcher, [a0, a1, b0]);
    await dispatcher.onTokenUpdated(1, "tok-A", credentials(), null, 3);
    await dispatcher.onTokenUpdated(2, "tok-B", credentials(), null, 1);

    const names: string[] = [];
    for (let i = 0; i < 4; i++) {
      const worker = await dispatcher.acquireIdleWorker();
      names.push(worker!.tokenName);
      worker!.releaseTurn();
    }

    expect(names.filter((name) => name === "tok-A")).toHaveLength(3);
    expect(names.filter((name) => name === "tok-B")).toHaveLength(1);
  });

  it("does not give a token extra cold turns for having more workers", async () => {
    const dispatcher = new OpenAIDispatcher();
    addWorkers(dispatcher, [
      fakeWorker({ tokenId: 1, tokenName: "tok-A", workerIndex: 0 }),
      fakeWorker({ tokenId: 1, tokenName: "tok-A", workerIndex: 1 }),
      fakeWorker({ tokenId: 2, tokenName: "tok-B", workerIndex: 0 }),
    ]);
    await dispatcher.onTokenUpdated(1, "tok-A", credentials(), null, 1);
    await dispatcher.onTokenUpdated(2, "tok-B", credentials(), null, 1);

    const names: string[] = [];
    for (let i = 0; i < 4; i++) {
      const worker = await dispatcher.acquireIdleWorker();
      names.push(worker!.tokenName);
      worker!.releaseTurn();
    }

    expect(names).toEqual(["tok-A", "tok-B", "tok-A", "tok-B"]);
  });

  it("skips a high-weight token when all of its workers are busy", async () => {
    const dispatcher = new OpenAIDispatcher();
    addWorkers(dispatcher, [
      fakeWorker({ tokenId: 1, tokenName: "tok-A", busy: true }),
      fakeWorker({ tokenId: 2, tokenName: "tok-B" }),
    ]);
    await dispatcher.onTokenUpdated(1, "tok-A", credentials(), null, 100);
    await dispatcher.onTokenUpdated(2, "tok-B", credentials(), null, 1);

    await expect(dispatcher.acquireIdleWorker()).resolves.toMatchObject({ tokenName: "tok-B" });
  });

  it("uses weighted selection when draining after a worker release", async () => {
    const dispatcher = new OpenAIDispatcher();
    const workerA = fakeWorker({ tokenId: 1, tokenName: "tok-A", busy: true });
    const workerB = fakeWorker({ tokenId: 2, tokenName: "tok-B", busy: true });
    addWorkers(dispatcher, [workerA, workerB]);
    await dispatcher.onTokenUpdated(1, "tok-A", credentials(), null, 1);
    await dispatcher.onTokenUpdated(2, "tok-B", credentials(), null, 3);

    const queued = dispatcher.enqueue(async (worker) => worker.tokenName);
    await waitForQueue(dispatcher);
    workerA.releaseTurn();
    workerB.releaseTurn();

    await dispatcher.drainQueue();
    await expect(queued).resolves.toBe("tok-B");
  });

  it("does not advance weighted state for successful thread reuse", async () => {
    const dispatcher = new OpenAIDispatcher();
    const workerA = fakeWorker({ tokenId: 1, tokenName: "tok-A" });
    const workerB = fakeWorker({
      tokenId: 2,
      tokenName: "tok-B",
      threads: ["thread-B"],
    });
    addWorkers(dispatcher, [workerA, workerB]);
    await dispatcher.onTokenUpdated(1, "tok-A", credentials(), null, 1);
    await dispatcher.onTokenUpdated(2, "tok-B", credentials(), null, 1);
    vi.spyOn(dispatcher, "executeTurn").mockImplementation(
      async (worker, _req, reuseThreadId) =>
        resultFor(worker, reuseThreadId ?? "thread-new"),
    );

    const cold1 = await dispatcher.generate(baseReq());
    const reused = await dispatcher.generate(
      baseReq({
        reuse: { workerId: makeOpenAIWorkerId(2, 0), threadId: "thread-B", epoch: 1 },
      }),
    );
    const cold2 = await dispatcher.generate(baseReq());

    expect([cold1.tokenName, cold2.tokenName]).toEqual(["tok-A", "tok-B"]);
    expect(reused).toMatchObject({
      tokenName: "tok-B",
      threadCoord: { threadId: "thread-B" },
    });
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
    await dispatcher.drainQueue();
    await expect(queued).resolves.toBe("tok-A");
  });

  it("throws typed error when no active ready tokenId passes threshold", async () => {
    const dispatcher = new OpenAIDispatcher();
    addWorkers(dispatcher, [fakeWorker({ tokenId: 1, tokenName: "tok-A" })]);
    await dispatcher.onTokenUpdated(1, "tok-A", credentials(), 80);
    readOpenAIQuotaUsageMock.mockResolvedValueOnce(quotaOk(90));

    const error = await dispatcher.acquireIdleWorker().catch((e) => e);

    expect(error).toBeInstanceOf(QuotaThresholdExceededError);
    expect(error).toMatchObject({ code: "QUOTA_THRESHOLD_EXCEEDED" });
    expect(error.message).toBe(
      "All openai tokens exceeded quota threshold: tok-A (threshold 80%)",
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
      .mockResolvedValueOnce(quotaOk(10));

    await dispatcher.drainQueue();

    await expect(queued).resolves.toBe("tok-B");
  });

  it("serializes concurrent drain calls so a queue item is not assigned twice", async () => {
    const dispatcher = new OpenAIDispatcher();
    const worker = fakeWorker({ tokenId: 1, tokenName: "tok-A" });
    addWorkers(dispatcher, [worker]);
    await dispatcher.onTokenUpdated(1, "tok-A", credentials(), null, 1);
    const execute = vi.fn(async (w: CodexAppServerWorker) => w.tokenName);
    const queued = dispatcher.enqueue(execute);
    await waitForQueue(dispatcher);

    await Promise.all([dispatcher.drainQueue(), dispatcher.drainQueue()]);

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
      baseReq({
        reuse: { workerId: makeOpenAIWorkerId(1, 0), threadId: "thread-1", epoch: 1 },
      }),
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
      baseReq({
        reuse: { workerId: makeOpenAIWorkerId(1, 0), threadId: "thread-1", epoch: 1 },
      }),
    );

    expect(result.tokenName).toBe("tok-A");
    expect(executeTurn).toHaveBeenCalledWith(worker, expect.anything(), "thread-1");
  });

  it("passes worker ttftMs into GenerateResult", async () => {
    const dispatcher = new OpenAIDispatcher();
    const worker = fakeWorker({ tokenId: 1, tokenName: "tok-A" });
    const usage = {
      totalTokens: 12,
      inputTokens: 5,
      cachedInputTokens: 0,
      outputTokens: 7,
      reasoningOutputTokens: 0,
    };
    (
      worker as unknown as {
        executeTurn: () => Promise<{
          text: string;
          usage: typeof usage;
          durationMs: number;
          ttftMs: number | null;
          model: string;
          threadId: string;
        }>;
      }
    ).executeTurn = vi.fn(async () => ({
      text: "ok",
      usage,
      durationMs: 80,
      ttftMs: 11,
      model: "gpt-5-codex",
      threadId: "thread-1",
    }));

    const result = await dispatcher.executeTurn(worker, baseReq());

    expect(result.ttftMs).toBe(11);
    expect(result.threadCoord?.threadId).toBe("thread-1");
  });

  it("throws typed error when reuse is over threshold and no cold tokenId is eligible", async () => {
    const dispatcher = new OpenAIDispatcher();
    const worker = fakeWorker({ tokenId: 1, tokenName: "tok-A", threads: ["thread-1"] });
    addWorkers(dispatcher, [worker]);
    await dispatcher.onTokenUpdated(1, "tok-A", credentials(), 80);
    readOpenAIQuotaUsageMock.mockResolvedValueOnce(quotaOk(85));

    await expect(
      dispatcher.generate(
        baseReq({
          reuse: { workerId: makeOpenAIWorkerId(1, 0), threadId: "thread-1", epoch: 1 },
        }),
      ),
    ).rejects.toBeInstanceOf(QuotaThresholdExceededError);
  });
});

describe("OpenAIDispatcher image generation gate and failure classification", () => {
  it("throws a gate error without running the turn when capability is unsupported", async () => {
    const dispatcher = new OpenAIDispatcher();
    const worker = fakeWorker({ imageGateReason: "provider does not support image generation" });

    await expect(
      dispatcher.executeTurn(worker, baseReq({ imageGeneration: true })),
    ).rejects.toMatchObject({ kind: "gate" });
    // 게이트 실패 시 turn 은 실행되지 않는다.
    expect((worker as unknown as { executeTurn: ReturnType<typeof vi.fn> }).executeTurn).not.toHaveBeenCalled();
  });

  it("throws a gate error for a non-multimodal model", async () => {
    const dispatcher = new OpenAIDispatcher();
    const worker = fakeWorker({ imageGateReason: "model gpt-x is not multimodal (no image input modality)" });

    await expect(
      dispatcher.executeTurn(worker, baseReq({ imageGeneration: true, model: "gpt-x" })),
    ).rejects.toBeInstanceOf(ImageGenerationError);
  });

  it("classifies zero images with no tool call as not_called (retry futile)", async () => {
    const dispatcher = new OpenAIDispatcher();
    const worker = fakeWorker({ imageGateReason: null, imageTurnResult: { imageAttempted: false } });

    await expect(
      dispatcher.executeTurn(worker, baseReq({ imageGeneration: true })),
    ).rejects.toMatchObject({ kind: "not_called" });
  });

  it("classifies zero images after an attempt as incomplete (retry candidate)", async () => {
    const dispatcher = new OpenAIDispatcher();
    const worker = fakeWorker({ imageGateReason: null, imageTurnResult: { imageAttempted: true } });

    await expect(
      dispatcher.executeTurn(worker, baseReq({ imageGeneration: true })),
    ).rejects.toMatchObject({ kind: "incomplete" });
  });

  it("passes an image result through without gating a valid request", async () => {
    const dispatcher = new OpenAIDispatcher();
    const worker = fakeWorker({
      imageGateReason: null,
      imageTurnResult: { images: [{ data: "iVBORw0KGgoBAgM", revisedPrompt: "a cat" }], imageAttempted: true },
    });

    const result = await dispatcher.executeTurn(worker, baseReq({ imageGeneration: true }));
    expect(result.images).toHaveLength(1);
    expect(result.images?.[0]?.revisedPrompt).toBe("a cat");
  });

  it("does not gate or classify a normal text request", async () => {
    const dispatcher = new OpenAIDispatcher();
    const worker = fakeWorker({ imageTurnResult: {} });

    const result = await dispatcher.executeTurn(worker, baseReq());
    expect(result.text).toBe("ok");
    expect((worker as unknown as { checkImageGenerationSupport: ReturnType<typeof vi.fn> }).checkImageGenerationSupport).not.toHaveBeenCalled();
  });
});

describe("OpenAIDispatcher image generation routing", () => {
  it("rejects image requests on the streaming path", async () => {
    const dispatcher = new OpenAIDispatcher();
    const cb = { onDelta: vi.fn(), onComplete: vi.fn(), onError: vi.fn() };
    await expect(
      dispatcher.generateStream(baseReq({ imageGeneration: true }), cb),
    ).rejects.toBeInstanceOf(ImageGenerationError);
  });

  it("forces cold thread for image requests even when a reuse coordinate is present", async () => {
    const dispatcher = new OpenAIDispatcher();
    const worker = await dispatcher.acquireReuseWorker(
      baseReq({
        imageGeneration: true,
        reuse: { workerId: makeOpenAIWorkerId(1, 0), threadId: "t1", epoch: 1 },
      }),
    );
    expect(worker).toBeNull();
  });
});
