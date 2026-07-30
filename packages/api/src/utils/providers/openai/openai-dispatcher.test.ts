import { beforeEach, describe, expect, it, vi } from "vitest";

import { QuotaThresholdExceededError } from "../../../application/qgrid/qgrid.types";
import { TokenModel } from "../../../application/token/token.model";
import { type OpenAICredentials } from "../../../application/token/token.types";
import { type GenerateRequest, type GenerateResult } from "../common/provider-dispatcher";
import { CodexAppServerWorker } from "./codex-worker";
import {
  ImageGenerationError,
  makeOpenAIWorkerId,
  OpenAIDispatcher,
} from "./openai-dispatcher";
import { type OpenAIQuotaUsageResult } from "./openai-quota";
import {
  estimateOpenAIWorkerRssGiB,
  MAX_OPENAI_WORKERS_PER_TOKEN,
  type OpenAIWorkerPoolConfig,
  resolveOpenAIWorkerPoolConfig,
} from "./openai-worker-pool-config";

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

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
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

  it("defaults to autoscaling from 1 to 3 workers per token", () => {
    // dev0 OOM 사고(SON-516) 응급처치로 기본값을 5-15 에서 1-3 으로 축소 (f6d1333).
    expect(resolveOpenAIWorkerPoolConfig({})).toMatchObject({
      autoscale: true,
      minWorkersPerToken: 1,
      maxWorkersPerToken: 3,
    });
  });

  it("keeps an explicit fixed worker mode for emergency rollback", () => {
    expect(
      resolveOpenAIWorkerPoolConfig({
        QGRID_OPENAI_MIN_WORKERS_PER_TOKEN: "5",
        QGRID_OPENAI_AUTOSCALE: "false",
      }),
    ).toMatchObject({
      autoscale: false,
      minWorkersPerToken: 5,
      maxWorkersPerToken: 5,
    });
  });

  it("ignores the removed QGRID_WORKERS_PER_TOKEN variable", () => {
    // 과거엔 min 의 폴백이었다 — dev0 사고 조사(SON-516)에서 이름과 달리 min 에만
    // 꽂히는 함정으로 확인되어 제거. QGRID_OPENAI_MIN_WORKERS_PER_TOKEN 하나로 통일.
    expect(
      resolveOpenAIWorkerPoolConfig({ QGRID_WORKERS_PER_TOKEN: "15" }),
    ).toMatchObject({ minWorkersPerToken: 1, maxWorkersPerToken: 3 });
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
  it("runs minimum-capacity maintenance in fixed worker mode", async () => {
    vi.useFakeTimers();
    const findMany = vi.spyOn(TokenModel, "findMany").mockResolvedValue({ rows: [] } as never);
    const dispatcher = new OpenAIDispatcher(
      autoscaleConfig({
        autoscale: false,
        minWorkersPerToken: 2,
        maxWorkersPerToken: 2,
      }),
      () => 64,
    );
    const evaluateAutoscaling = vi
      .spyOn(dispatcher, "evaluateAutoscaling")
      .mockResolvedValue(undefined);

    try {
      await dispatcher.start();
      await vi.advanceTimersByTimeAsync(5_000);

      expect(evaluateAutoscaling).toHaveBeenCalledTimes(1);
    } finally {
      await dispatcher.stop();
      findMany.mockRestore();
      vi.useRealTimers();
    }
  });

  it("repairs an absent token pool after every initial worker spawn failed", async () => {
    const dispatcher = new OpenAIDispatcher(autoscaleConfig(), () => 64);
    const tokenCredentials = credentials();
    const spawnSingleWorker = vi.spyOn(dispatcher, "spawnSingleWorker").mockResolvedValueOnce(null);

    await dispatcher.spawnWorkers(1, "token", tokenCredentials, null, 1);
    expect(dispatcher.workerPool.has(1)).toBe(false);

    const recoveredWorker = fakeWorker({ tokenId: 1, workerIndex: 0 });
    spawnSingleWorker.mockResolvedValueOnce(recoveredWorker);
    await dispatcher.evaluateAutoscaling();

    expect(dispatcher.workerPool.get(1)).toEqual([recoveredWorker]);
    expect(recoveredWorker.kill).not.toHaveBeenCalled();
  });

  it("does not race minimum repair against an in-flight token bootstrap", async () => {
    const dispatcher = new OpenAIDispatcher(autoscaleConfig(), () => 64);
    const pendingSpawn = deferred<CodexAppServerWorker | null>();
    const spawnSingleWorker = vi
      .spyOn(dispatcher, "spawnSingleWorker")
      .mockReturnValue(pendingSpawn.promise);

    const bootstrap = dispatcher.spawnWorkers(1, "token", credentials(), null, 1);
    await vi.waitFor(() => expect(spawnSingleWorker).toHaveBeenCalledTimes(1));
    const evaluation = dispatcher.evaluateAutoscaling();

    expect(spawnSingleWorker).toHaveBeenCalledTimes(1);
    const worker = fakeWorker({ tokenId: 1, workerIndex: 0 });
    pendingSpawn.resolve(worker);
    await Promise.all([bootstrap, evaluation]);

    expect(dispatcher.workerPool.get(1)).toEqual([worker]);
    expect(worker.kill).not.toHaveBeenCalled();
  });

  it("discards a bootstrapping worker when its token is removed mid-spawn", async () => {
    const dispatcher = new OpenAIDispatcher(autoscaleConfig(), () => 64);
    const pendingSpawn = deferred<CodexAppServerWorker | null>();
    const spawnSingleWorker = vi
      .spyOn(dispatcher, "spawnSingleWorker")
      .mockReturnValue(pendingSpawn.promise);

    const bootstrap = dispatcher.spawnWorkers(1, "token", credentials(), null, 1);
    await vi.waitFor(() => expect(spawnSingleWorker).toHaveBeenCalledTimes(1));
    await dispatcher.onTokenRemoved(1);
    const staleWorker = fakeWorker({ tokenId: 1, workerIndex: 0 });
    pendingSpawn.resolve(staleWorker);
    await bootstrap;

    expect(dispatcher.workerPool.has(1)).toBe(false);
    expect(staleWorker.kill).toHaveBeenCalledTimes(1);
  });

  it("repairs the configured minimum even when demand autoscaling is disabled", async () => {
    const dispatcher = new OpenAIDispatcher(
      autoscaleConfig({
        autoscale: false,
        minWorkersPerToken: 2,
        maxWorkersPerToken: 2,
      }),
      () => 0,
    );
    const tokenCredentials = credentials();
    vi.spyOn(dispatcher, "spawnWorkers").mockResolvedValue(undefined);
    await dispatcher.onTokenAdded(1, "token", tokenCredentials, null, 1);
    const existing = fakeWorker({ tokenId: 1, workerIndex: 0 });
    dispatcher.workerPool.set(1, [existing]);
    const recovered = fakeWorker({ tokenId: 1, workerIndex: 1 });
    const spawnSingleWorker = vi
      .spyOn(dispatcher, "spawnSingleWorker")
      .mockResolvedValue(recovered);

    await dispatcher.evaluateAutoscaling();

    expect(spawnSingleWorker).toHaveBeenCalledWith(1, "token", tokenCredentials, 1);
    expect(dispatcher.workerPool.get(1)).toEqual([existing, recovered]);
  });

  it("does not retry a failed minimum spawn as demand expansion in the same evaluation", async () => {
    const dispatcher = new OpenAIDispatcher(autoscaleConfig(), () => 64);
    vi.spyOn(dispatcher, "spawnWorkers").mockResolvedValue(undefined);
    await dispatcher.onTokenAdded(1, "token", credentials(), null, 1);
    dispatcher.queue.push({} as never);
    const spawnSingleWorker = vi
      .spyOn(dispatcher, "spawnSingleWorker")
      .mockResolvedValue(null);

    await dispatcher.evaluateAutoscaling();

    expect(spawnSingleWorker).toHaveBeenCalledTimes(1);
    dispatcher.queue = [];
  });

  it("keeps scaling healthy tokens when another token minimum repair fails", async () => {
    const dispatcher = new OpenAIDispatcher(autoscaleConfig(), () => 64);
    vi.spyOn(dispatcher, "spawnWorkers").mockResolvedValue(undefined);
    await dispatcher.onTokenAdded(1, "broken", credentials(), null, 1);
    await dispatcher.onTokenAdded(2, "healthy", credentials(), null, 1);
    dispatcher.workerPool.set(2, [
      fakeWorker({ tokenId: 2, tokenName: "healthy", workerIndex: 0, busy: true }),
    ]);
    dispatcher.queue.push({} as never);
    const healthyExpansion = fakeWorker({
      tokenId: 2,
      tokenName: "healthy",
      workerIndex: 1,
    });
    const spawnSingleWorker = vi
      .spyOn(dispatcher, "spawnSingleWorker")
      .mockImplementation(async (tokenId) => (tokenId === 1 ? null : healthyExpansion));

    await dispatcher.evaluateAutoscaling();

    expect(spawnSingleWorker).toHaveBeenCalledTimes(2);
    expect(dispatcher.workerPool.get(2)).toHaveLength(2);
    dispatcher.queue = [];
  });

  it("does not duplicate a minimum slot while its worker is transiently restarting", async () => {
    const dispatcher = new OpenAIDispatcher(autoscaleConfig(), () => 64);
    vi.spyOn(dispatcher, "spawnWorkers").mockResolvedValue(undefined);
    await dispatcher.onTokenAdded(1, "token", credentials(), null, 1);
    dispatcher.workerPool.set(1, [
      fakeWorker({ tokenId: 1, workerIndex: 0, ready: false }),
    ]);
    const spawnSingleWorker = vi.spyOn(dispatcher, "spawnSingleWorker");

    await dispatcher.evaluateAutoscaling();

    expect(spawnSingleWorker).not.toHaveBeenCalled();
    expect(dispatcher.workerPool.get(1)).toHaveLength(1);
  });

  it("queues while active token metadata exists but every worker is unavailable", async () => {
    const dispatcher = new OpenAIDispatcher(autoscaleConfig(), () => 64);
    vi.spyOn(dispatcher, "spawnWorkers").mockResolvedValue(undefined);
    await dispatcher.onTokenAdded(1, "token", credentials(), null, 1);
    const evaluateAutoscaling = vi
      .spyOn(dispatcher, "evaluateAutoscaling")
      .mockResolvedValue(undefined);

    const queued = dispatcher.enqueue(async (worker) => worker.tokenName);
    await waitForQueue(dispatcher);

    expect(evaluateAutoscaling).toHaveBeenCalled();
    const recovered = fakeWorker({ tokenId: 1, workerIndex: 0 });
    dispatcher.workerPool.set(1, [recovered]);
    await dispatcher.drainQueue();

    await expect(queued).resolves.toBe("token");
  });

  it("still rejects immediately when no active OpenAI token metadata exists", async () => {
    const dispatcher = new OpenAIDispatcher(autoscaleConfig(), () => 64);

    await expect(dispatcher.enqueue(async () => "ok")).rejects.toThrow("NO_OPENAI_WORKERS");
    expect(dispatcher.queueLength).toBe(0);
  });

  it("keeps a recovery queue when another token is removed but an active token remains", async () => {
    const dispatcher = new OpenAIDispatcher(autoscaleConfig(), () => 64);
    vi.spyOn(dispatcher, "spawnWorkers").mockResolvedValue(undefined);
    await dispatcher.onTokenAdded(1, "removed", credentials(), null, 1);
    await dispatcher.onTokenAdded(2, "recovering", credentials(), null, 1);

    const queued = dispatcher.enqueue(async () => "ok");
    const rejection = expect(queued).rejects.toThrow("TEST_CLEANUP");
    await waitForQueue(dispatcher);
    await dispatcher.onTokenRemoved(1);

    expect(dispatcher.queueLength).toBe(1);
    dispatcher.rejectAllQueued("TEST_CLEANUP");
    await rejection;
  });

  it("keeps a recovery queue when another token is deactivated but an active token remains", async () => {
    const dispatcher = new OpenAIDispatcher(autoscaleConfig(), () => 64);
    vi.spyOn(dispatcher, "spawnWorkers").mockResolvedValue(undefined);
    await dispatcher.onTokenAdded(1, "deactivated", credentials(), null, 1);
    await dispatcher.onTokenAdded(2, "recovering", credentials(), null, 1);

    const queued = dispatcher.enqueue(async () => "ok");
    const rejection = expect(queued).rejects.toThrow("TEST_CLEANUP");
    await waitForQueue(dispatcher);
    dispatcher.onTokenDeactivated(1);

    expect(dispatcher.queueLength).toBe(1);
    dispatcher.rejectAllQueued("TEST_CLEANUP");
    await rejection;
  });

  it("drains immediately when capacity appears before a fixed-mode queue wake-up", async () => {
    const dispatcher = new OpenAIDispatcher(
      autoscaleConfig({
        autoscale: false,
        minWorkersPerToken: 1,
        maxWorkersPerToken: 1,
      }),
      () => 64,
    );
    const worker = fakeWorker({ tokenId: 1, workerIndex: 0 });
    addWorkers(dispatcher, [worker]);
    await dispatcher.onTokenUpdated(1, "token", credentials(), null, 1);

    await expect(dispatcher.enqueue(async (selected) => selected.tokenName)).resolves.toBe(
      "token",
    );
    expect(dispatcher.queueLength).toBe(0);
  });

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

  it("does not add workers to a quota-blocked token", async () => {
    const dispatcher = new OpenAIDispatcher(autoscaleConfig(), () => 64);
    const hazeCredentials = credentials({ accountId: "haze" });
    const nkCredentials = credentials({ accountId: "nk" });
    vi.spyOn(dispatcher, "spawnWorkers").mockResolvedValue(undefined);
    await dispatcher.onTokenAdded(1, "openai/haze", hazeCredentials, 80, 1);
    await dispatcher.onTokenAdded(2, "openai/nk", nkCredentials, null, 1);
    dispatcher.workerPool.set(1, [
      fakeWorker({ tokenId: 1, tokenName: "openai/haze", workerIndex: 0 }),
    ]);
    dispatcher.workerPool.set(2, [
      fakeWorker({ tokenId: 2, tokenName: "openai/nk", workerIndex: 0 }),
    ]);
    readOpenAIQuotaUsageMock.mockResolvedValue(quotaOk(85));

    const selected = await dispatcher.acquireIdleWorker();
    expect(selected?.tokenName).toBe("openai/nk");
    selected?.releaseTurn();

    const spawnSingleWorker = vi
      .spyOn(dispatcher, "spawnSingleWorker")
      .mockImplementation(async (tokenId, tokenName, _credentials, workerIndex) =>
        fakeWorker({ tokenId, tokenName, workerIndex }),
      );
    await dispatcher.scaleUpOneStep();

    expect(spawnSingleWorker).toHaveBeenCalledTimes(1);
    expect(spawnSingleWorker).toHaveBeenCalledWith(2, "openai/nk", nkCredentials, 1);
    expect(dispatcher.workerPool.get(1)).toHaveLength(1);
    expect(dispatcher.workerPool.get(2)).toHaveLength(2);
  });

  it("maintains the configured minimum for a quota-blocked token", async () => {
    const dispatcher = new OpenAIDispatcher(autoscaleConfig(), () => 64);
    const tokenCredentials = credentials({ accountId: "haze" });
    vi.spyOn(dispatcher, "spawnWorkers").mockResolvedValue(undefined);
    await dispatcher.onTokenAdded(1, "openai/haze", tokenCredentials, 80, 1);
    dispatcher.workerPool.set(1, [
      fakeWorker({ tokenId: 1, tokenName: "openai/haze", workerIndex: 0 }),
    ]);
    readOpenAIQuotaUsageMock.mockResolvedValue(quotaOk(85));

    await expect(dispatcher.acquireIdleWorker()).rejects.toBeInstanceOf(
      QuotaThresholdExceededError,
    );
    dispatcher.workerPool.delete(1);
    const replacement = fakeWorker({
      tokenId: 1,
      tokenName: "openai/haze",
      workerIndex: 0,
    });
    const spawnSingleWorker = vi
      .spyOn(dispatcher, "spawnSingleWorker")
      .mockResolvedValue(replacement);

    await dispatcher.evaluateAutoscaling();

    expect(spawnSingleWorker).toHaveBeenCalledWith(
      1,
      "openai/haze",
      tokenCredentials,
      0,
    );
    expect(dispatcher.workerPool.get(1)).toEqual([replacement]);
  });

  it("discards a worker spawned while its token becomes quota-blocked", async () => {
    const dispatcher = new OpenAIDispatcher(autoscaleConfig(), () => 64);
    const tokenCredentials = credentials();
    vi.spyOn(dispatcher, "spawnWorkers").mockResolvedValue(undefined);
    await dispatcher.onTokenAdded(1, "openai/haze", tokenCredentials, 80, 1);
    dispatcher.workerPool.set(1, [
      fakeWorker({ tokenId: 1, tokenName: "openai/haze", workerIndex: 0 }),
    ]);
    readOpenAIQuotaUsageMock.mockResolvedValue(quotaOk(85));

    let resolveSpawn!: (worker: CodexAppServerWorker) => void;
    const spawnedWorker = fakeWorker({
      tokenId: 1,
      tokenName: "openai/haze",
      workerIndex: 1,
    });
    const spawnSingleWorker = vi.spyOn(dispatcher, "spawnSingleWorker").mockImplementation(
      () =>
        new Promise<CodexAppServerWorker>((resolve) => {
          resolveSpawn = resolve;
        }),
    );

    const scaling = dispatcher.scaleUpOneStep();
    await vi.waitFor(() => expect(spawnSingleWorker).toHaveBeenCalledTimes(1));
    await expect(dispatcher.acquireIdleWorker()).rejects.toBeInstanceOf(
      QuotaThresholdExceededError,
    );
    resolveSpawn(spawnedWorker);
    await scaling;

    expect(spawnedWorker.kill).toHaveBeenCalledTimes(1);
    expect(dispatcher.workerPool.get(1)).toHaveLength(1);
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

  it.each([1, 2, 5])(
    "converges repeated idle evaluations to configured minimum %i and never below it",
    async (minimum) => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      const initialCount = minimum + 3;
      const dispatcher = new OpenAIDispatcher(
        autoscaleConfig({
          minWorkersPerToken: minimum,
          maxWorkersPerToken: initialCount,
          scaleDownIdleMs: 1_000,
        }),
        () => 64,
      );
      vi.spyOn(dispatcher, "spawnWorkers").mockResolvedValue(undefined);
      await dispatcher.onTokenAdded(1, "token", credentials(), null, 1);
      const workers = Array.from({ length: initialCount }, (_, workerIndex) =>
        fakeWorker({ tokenId: 1, workerIndex }),
      );
      dispatcher.workerPool.set(1, workers);
      vi.setSystemTime(2_001);

      await dispatcher.evaluateAutoscaling();
      expect(dispatcher.workerPool.get(1)).toHaveLength(initialCount - 1);
      await dispatcher.evaluateAutoscaling();
      expect(dispatcher.workerPool.get(1)).toHaveLength(initialCount - 2);
      await dispatcher.evaluateAutoscaling();
      expect(dispatcher.workerPool.get(1)).toHaveLength(minimum);
      await dispatcher.evaluateAutoscaling();
      expect(dispatcher.workerPool.get(1)).toHaveLength(minimum);

      for (let workerIndex = minimum; workerIndex < initialCount; workerIndex++) {
        expect(workers[workerIndex]?.kill).toHaveBeenCalledTimes(1);
      }
      for (let workerIndex = 0; workerIndex < minimum; workerIndex++) {
        expect(workers[workerIndex]?.kill).not.toHaveBeenCalled();
      }
    } finally {
      vi.useRealTimers();
    }
    },
  );

  it("still scales healthy idle pools down when another token cannot recover its minimum", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      const dispatcher = new OpenAIDispatcher(
        autoscaleConfig({ scaleDownIdleMs: 1_000 }),
        () => 64,
      );
      vi.spyOn(dispatcher, "spawnWorkers").mockResolvedValue(undefined);
      await dispatcher.onTokenAdded(1, "broken", credentials(), null, 1);
      await dispatcher.onTokenAdded(2, "healthy", credentials(), null, 1);
      const healthyWorkers = [
        fakeWorker({ tokenId: 2, tokenName: "healthy", workerIndex: 0 }),
        fakeWorker({ tokenId: 2, tokenName: "healthy", workerIndex: 1 }),
      ];
      dispatcher.workerPool.set(2, healthyWorkers);
      vi.spyOn(dispatcher, "spawnSingleWorker").mockResolvedValue(null);
      vi.setSystemTime(2_001);

      await dispatcher.evaluateAutoscaling();

      expect(dispatcher.workerPool.get(2)).toEqual([healthyWorkers[0]]);
      expect(healthyWorkers[1]?.kill).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("removes a terminal worker by identity and requests minimum repair", async () => {
    const dispatcher = new OpenAIDispatcher(autoscaleConfig(), () => 64);
    vi.spyOn(dispatcher, "spawnWorkers").mockResolvedValue(undefined);
    await dispatcher.onTokenAdded(1, "token", credentials(), null, 1);
    const terminal = fakeWorker({ tokenId: 1, workerIndex: 0, ready: false });
    dispatcher.workerPool.set(1, [terminal]);
    const evaluateAutoscaling = vi
      .spyOn(dispatcher, "evaluateAutoscaling")
      .mockResolvedValue(undefined);

    await dispatcher.handleWorkerTerminalFailure(terminal);

    expect(dispatcher.workerPool.has(1)).toBe(false);
    expect(terminal.kill).toHaveBeenCalledTimes(1);
    expect(evaluateAutoscaling).toHaveBeenCalledTimes(1);
  });

  it("returns to the configured minimum after scale-down and terminal failure overlap", async () => {
    const dispatcher = new OpenAIDispatcher(
      autoscaleConfig({
        minWorkersPerToken: 2,
        maxWorkersPerToken: 3,
        scaleDownIdleMs: 0,
      }),
      () => 64,
    );
    vi.spyOn(dispatcher, "spawnWorkers").mockResolvedValue(undefined);
    await dispatcher.onTokenAdded(1, "token", credentials(), null, 1);
    const terminal = fakeWorker({ tokenId: 1, workerIndex: 0, ready: false });
    const survivor = fakeWorker({ tokenId: 1, workerIndex: 1 });
    const excess = fakeWorker({ tokenId: 1, workerIndex: 2 });
    dispatcher.workerPool.set(1, [terminal, survivor, excess]);

    await dispatcher.scaleDownOneStep();
    expect(dispatcher.workerPool.get(1)).toEqual([terminal, survivor]);

    const replacement = fakeWorker({ tokenId: 1, workerIndex: 0 });
    vi.spyOn(dispatcher, "spawnSingleWorker").mockResolvedValue(replacement);
    await dispatcher.handleWorkerTerminalFailure(terminal);
    await vi.waitFor(() =>
      expect(dispatcher.workerPool.get(1)).toEqual([replacement, survivor]),
    );

    expect(excess.kill).toHaveBeenCalledTimes(1);
    expect(terminal.kill).toHaveBeenCalledTimes(1);
    expect(dispatcher.workerPool.get(1)).toHaveLength(2);
  });

  it("ignores a stale terminal callback after the token pool was replaced", async () => {
    const dispatcher = new OpenAIDispatcher(autoscaleConfig(), () => 64);
    vi.spyOn(dispatcher, "spawnWorkers").mockResolvedValue(undefined);
    await dispatcher.onTokenAdded(1, "token", credentials(), null, 1);
    const stale = fakeWorker({ tokenId: 1, workerIndex: 0, ready: false });
    const current = fakeWorker({ tokenId: 1, workerIndex: 0 });
    dispatcher.workerPool.set(1, [current]);
    const evaluateAutoscaling = vi.spyOn(dispatcher, "evaluateAutoscaling");

    await dispatcher.handleWorkerTerminalFailure(stale);

    expect(dispatcher.workerPool.get(1)).toEqual([current]);
    expect(current.kill).not.toHaveBeenCalled();
    expect(evaluateAutoscaling).not.toHaveBeenCalled();
  });

  it("wires a spawned worker terminal signal to dispatcher cleanup", async () => {
    const initialize = vi
      .spyOn(CodexAppServerWorker.prototype, "initialize")
      .mockResolvedValue(undefined);
    const kill = vi.spyOn(CodexAppServerWorker.prototype, "kill").mockResolvedValue(undefined);
    const dispatcher = new OpenAIDispatcher(autoscaleConfig(), () => 64);

    try {
      await dispatcher.spawnWorkers(1, "token", credentials(), null, 1);
      const worker = dispatcher.workerPool.get(1)?.[0];
      expect(worker).toBeDefined();
      const evaluateAutoscaling = vi
        .spyOn(dispatcher, "evaluateAutoscaling")
        .mockResolvedValue(undefined);

      worker?.onTerminalFailure?.();
      await vi.waitFor(() => expect(evaluateAutoscaling).toHaveBeenCalledTimes(1));

      expect(kill).toHaveBeenCalledTimes(1);
      expect(dispatcher.workerPool.has(1)).toBe(false);
    } finally {
      initialize.mockRestore();
      kill.mockRestore();
    }
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

  it("keeps fresh rate-limit cache across routing-only token updates", async () => {
    const dispatcher = new OpenAIDispatcher();
    const rateLimits = {
      rateLimits: { primary: { usedPercent: 85 } },
      rateLimitsByLimitId: null,
    };
    const worker = fakeWorker({
      tokenId: 1,
      tokenName: "openai/haze",
      rateLimits,
    });
    addWorkers(dispatcher, [worker]);
    await dispatcher.onTokenUpdated(1, "openai/haze", credentials(), 80, 1);

    await dispatcher.getRateLimitsByTokenId(1);
    await dispatcher.onTokenUpdated(1, "openai/haze", credentials(), 80, 2);
    await expect(dispatcher.getRateLimitsByTokenId(1)).resolves.toMatchObject({
      data: rateLimits,
    });

    expect(worker.getRateLimits).toHaveBeenCalledTimes(1);
  });

  it("does not cache a response from an outdated provider identity", async () => {
    const dispatcher = new OpenAIDispatcher();
    const oldRateLimits = {
      rateLimits: { primary: { usedPercent: 85 } },
      rateLimitsByLimitId: null,
    };
    const currentRateLimits = {
      rateLimits: { primary: { usedPercent: 10 } },
      rateLimitsByLimitId: null,
    };
    const oldWorker = fakeWorker({ tokenId: 1, tokenName: "openai/haze" });
    const currentWorker = fakeWorker({
      tokenId: 1,
      tokenName: "openai/haze",
      rateLimits: currentRateLimits,
    });
    addWorkers(dispatcher, [oldWorker]);
    await dispatcher.onTokenUpdated(1, "openai/haze", credentials(), 80);
    const pendingRateLimits = deferred<unknown>();
    vi.mocked(oldWorker.getRateLimits).mockImplementationOnce(() => pendingRateLimits.promise);
    vi.mocked(oldWorker.canReuseForToken).mockReturnValue(false);
    vi.spyOn(dispatcher, "spawnWorkers").mockImplementation(async () => {
      dispatcher.workerPool.set(1, [currentWorker]);
    });

    const outdatedRead = dispatcher.getRateLimitsByTokenId(1);
    await vi.waitFor(() => expect(oldWorker.getRateLimits).toHaveBeenCalledTimes(1));
    await dispatcher.onTokenUpdated(
      1,
      "openai/haze",
      credentials({ accountId: "new-account" }),
      80,
    );
    pendingRateLimits.resolve(oldRateLimits);

    await expect(outdatedRead).resolves.toMatchObject({ data: oldRateLimits });
    await expect(dispatcher.getRateLimitsByTokenId(1)).resolves.toMatchObject({
      data: currentRateLimits,
    });
    expect(currentWorker.getRateLimits).toHaveBeenCalledTimes(1);
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

  it("logs over-threshold and recovery only when the token gate state changes", async () => {
    const dispatcher = new OpenAIDispatcher();
    const worker = fakeWorker({ tokenId: 1, tokenName: "openai/haze" });
    addWorkers(dispatcher, [worker]);
    await dispatcher.onTokenUpdated(1, "openai/haze", credentials(), 80);
    readOpenAIQuotaUsageMock
      .mockResolvedValueOnce(quotaOk(85))
      .mockResolvedValueOnce(quotaOk(85))
      .mockResolvedValueOnce(quotaOk(10))
      .mockResolvedValueOnce(quotaOk(10));

    await expect(dispatcher.acquireIdleWorker()).rejects.toBeInstanceOf(
      QuotaThresholdExceededError,
    );
    await expect(dispatcher.acquireIdleWorker()).rejects.toBeInstanceOf(
      QuotaThresholdExceededError,
    );
    const recoveredWorker = await dispatcher.acquireIdleWorker();
    recoveredWorker?.releaseTurn();
    const stillEligibleWorker = await dispatcher.acquireIdleWorker();
    stillEligibleWorker?.releaseTurn();

    const overThresholdLogs = loggerInfoMock.mock.calls.filter(([message]) =>
      String(message).includes("quota_threshold gate: over_threshold"),
    );
    const recoveredLogs = loggerInfoMock.mock.calls.filter(([message]) =>
      String(message).includes("quota_threshold gate: recovered"),
    );
    expect(overThresholdLogs).toHaveLength(1);
    expect(overThresholdLogs[0]).toEqual([
      "quota_threshold gate: over_threshold openai/haze[1] (85% >= 80%)",
      expect.objectContaining({
        tokenId: 1,
        tokenName: "openai/haze",
        threshold: 80,
        cachedUtilization: 85,
        reason: "over_threshold",
      }),
    ]);
    expect(recoveredLogs).toHaveLength(1);
    expect(recoveredLogs[0]).toEqual([
      "quota_threshold gate: recovered openai/haze[1] (10% < 80%)",
      expect.objectContaining({
        tokenId: 1,
        tokenName: "openai/haze",
        threshold: 80,
        cachedUtilization: 10,
        reason: "recovered",
      }),
    ]);
  });

  it("clears the runtime quota block when a lookup fails open", async () => {
    const dispatcher = new OpenAIDispatcher();
    const worker = fakeWorker({ tokenId: 1, tokenName: "openai/haze" });
    addWorkers(dispatcher, [worker]);
    await dispatcher.onTokenUpdated(1, "openai/haze", credentials(), 80);
    readOpenAIQuotaUsageMock
      .mockResolvedValueOnce(quotaOk(85))
      .mockResolvedValueOnce(quotaFail("rpc timeout"))
      .mockResolvedValueOnce(quotaOk(85));

    await expect(dispatcher.acquireIdleWorker()).rejects.toBeInstanceOf(
      QuotaThresholdExceededError,
    );
    const failOpenWorker = await dispatcher.acquireIdleWorker();
    failOpenWorker?.releaseTurn();
    await expect(dispatcher.acquireIdleWorker()).rejects.toBeInstanceOf(
      QuotaThresholdExceededError,
    );

    const overThresholdLogs = loggerInfoMock.mock.calls.filter(([message]) =>
      String(message).includes("quota_threshold gate: over_threshold"),
    );
    expect(overThresholdLogs).toHaveLength(2);
    expect(loggerWarnMock).toHaveBeenCalledWith(
      expect.stringContaining("lookup_fail_open"),
      expect.objectContaining({ tokenId: 1, reason: "lookup_fail_open" }),
    );
  });

  it("starts a new quota-block transition after the threshold changes", async () => {
    const dispatcher = new OpenAIDispatcher();
    const worker = fakeWorker({ tokenId: 1, tokenName: "openai/haze" });
    addWorkers(dispatcher, [worker]);
    await dispatcher.onTokenUpdated(1, "openai/haze", credentials(), 80);
    readOpenAIQuotaUsageMock.mockResolvedValue(quotaOk(85));

    await expect(dispatcher.acquireIdleWorker()).rejects.toBeInstanceOf(
      QuotaThresholdExceededError,
    );
    await dispatcher.onTokenUpdated(1, "openai/haze", credentials(), 70);
    await expect(dispatcher.acquireIdleWorker()).rejects.toBeInstanceOf(
      QuotaThresholdExceededError,
    );

    const overThresholdLogs = loggerInfoMock.mock.calls.filter(([message]) =>
      String(message).includes("quota_threshold gate: over_threshold"),
    );
    expect(overThresholdLogs).toHaveLength(2);
    expect(overThresholdLogs[1]?.[0]).toBe(
      "quota_threshold gate: over_threshold openai/haze[1] (85% >= 70%)",
    );
  });

  it("starts a new quota-block transition after deactivation and reactivation", async () => {
    const dispatcher = new OpenAIDispatcher();
    const worker = fakeWorker({ tokenId: 1, tokenName: "openai/haze" });
    addWorkers(dispatcher, [worker]);
    await dispatcher.onTokenUpdated(1, "openai/haze", credentials(), 80);
    readOpenAIQuotaUsageMock.mockResolvedValue(quotaOk(85));

    await expect(dispatcher.acquireIdleWorker()).rejects.toBeInstanceOf(
      QuotaThresholdExceededError,
    );
    dispatcher.onTokenDeactivated(1);
    dispatcher.onTokenActivated(1);
    await expect(dispatcher.acquireIdleWorker()).rejects.toBeInstanceOf(
      QuotaThresholdExceededError,
    );

    const overThresholdLogs = loggerInfoMock.mock.calls.filter(([message]) =>
      String(message).includes("quota_threshold gate: over_threshold"),
    );
    expect(overThresholdLogs).toHaveLength(2);
  });

  it("discards an over-threshold result when the threshold changes during lookup", async () => {
    const dispatcher = new OpenAIDispatcher();
    const worker = fakeWorker({ tokenId: 1, tokenName: "openai/haze" });
    addWorkers(dispatcher, [worker]);
    await dispatcher.onTokenUpdated(1, "openai/haze", credentials(), 80);
    const pendingQuota = deferred<OpenAIQuotaUsageResult>();
    readOpenAIQuotaUsageMock
      .mockImplementationOnce(() => pendingQuota.promise)
      .mockResolvedValueOnce(quotaOk(85))
      .mockResolvedValueOnce(quotaOk(95));

    const pendingAcquire = dispatcher.acquireIdleWorker();
    await vi.waitFor(() => expect(readOpenAIQuotaUsageMock).toHaveBeenCalledTimes(1));
    await dispatcher.onTokenUpdated(1, "openai/haze", credentials(), 90);
    pendingQuota.resolve(quotaOk(85));

    const eligibleWorker = await pendingAcquire;
    expect(eligibleWorker).toBe(worker);
    eligibleWorker?.releaseTurn();
    await expect(dispatcher.acquireIdleWorker()).rejects.toBeInstanceOf(
      QuotaThresholdExceededError,
    );

    const overThresholdLogs = loggerInfoMock.mock.calls.filter(([message]) =>
      String(message).includes("quota_threshold gate: over_threshold"),
    );
    expect(overThresholdLogs).toEqual([
      [
        "quota_threshold gate: over_threshold openai/haze[1] (95% >= 90%)",
        expect.objectContaining({
          tokenId: 1,
          threshold: 90,
          cachedUtilization: 95,
        }),
      ],
    ]);
  });

  it("does not re-block autoscaling when the threshold is removed during lookup", async () => {
    const dispatcher = new OpenAIDispatcher(autoscaleConfig(), () => 64);
    const worker = fakeWorker({
      tokenId: 1,
      tokenName: "openai/haze",
      workerIndex: 0,
    });
    addWorkers(dispatcher, [worker]);
    await dispatcher.onTokenUpdated(1, "openai/haze", credentials(), 80);
    const pendingQuota = deferred<OpenAIQuotaUsageResult>();
    readOpenAIQuotaUsageMock.mockImplementationOnce(() => pendingQuota.promise);

    const pendingAcquire = dispatcher.acquireIdleWorker();
    await vi.waitFor(() => expect(readOpenAIQuotaUsageMock).toHaveBeenCalledTimes(1));
    await dispatcher.onTokenUpdated(1, "openai/haze", credentials(), null);
    pendingQuota.resolve(quotaOk(85));

    const eligibleWorker = await pendingAcquire;
    expect(eligibleWorker).toBe(worker);
    eligibleWorker?.releaseTurn();
    expect(
      loggerInfoMock.mock.calls.filter(([message]) =>
        String(message).includes("quota_threshold gate:"),
      ),
    ).toHaveLength(0);

    const spawnedWorker = fakeWorker({
      tokenId: 1,
      tokenName: "openai/haze",
      workerIndex: 1,
    });
    const spawnSingleWorker = vi
      .spyOn(dispatcher, "spawnSingleWorker")
      .mockResolvedValue(spawnedWorker);
    await dispatcher.scaleUpOneStep();

    expect(spawnSingleWorker).toHaveBeenCalledTimes(1);
    expect(dispatcher.workerPool.get(1)).toEqual([worker, spawnedWorker]);
  });

  it("does not restore a quota block when the token is deactivated during lookup", async () => {
    const dispatcher = new OpenAIDispatcher();
    const worker = fakeWorker({ tokenId: 1, tokenName: "openai/haze" });
    addWorkers(dispatcher, [worker]);
    await dispatcher.onTokenUpdated(1, "openai/haze", credentials(), 80);
    const pendingQuota = deferred<OpenAIQuotaUsageResult>();
    readOpenAIQuotaUsageMock
      .mockImplementationOnce(() => pendingQuota.promise)
      .mockResolvedValueOnce(quotaOk(85));

    const pendingAcquire = dispatcher.acquireIdleWorker();
    await vi.waitFor(() => expect(readOpenAIQuotaUsageMock).toHaveBeenCalledTimes(1));
    dispatcher.onTokenDeactivated(1);
    pendingQuota.resolve(quotaOk(85));

    await expect(pendingAcquire).resolves.toBeNull();
    expect(
      loggerInfoMock.mock.calls.filter(([message]) =>
        String(message).includes("quota_threshold gate:"),
      ),
    ).toHaveLength(0);

    dispatcher.onTokenActivated(1);
    await expect(dispatcher.acquireIdleWorker()).rejects.toBeInstanceOf(
      QuotaThresholdExceededError,
    );
    expect(
      loggerInfoMock.mock.calls.filter(([message]) =>
        String(message).includes("quota_threshold gate: over_threshold"),
      ),
    ).toHaveLength(1);
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
    const workerA = fakeWorker({ tokenId: 1, tokenName: "tok-A", busy: true });
    const workerB = fakeWorker({ tokenId: 2, tokenName: "tok-B", busy: true });
    addWorkers(dispatcher, [workerA, workerB]);
    await dispatcher.onTokenUpdated(1, "tok-A", credentials(), 80);
    await dispatcher.onTokenUpdated(2, "tok-B", credentials(), 80);
    const queued = dispatcher.enqueue(async (w) => w.tokenName);
    await waitForQueue(dispatcher);
    readOpenAIQuotaUsageMock.mockReset();
    readOpenAIQuotaUsageMock
      .mockResolvedValueOnce(quotaOk(90))
      .mockResolvedValueOnce(quotaOk(10));
    workerA.releaseTurn();
    workerB.releaseTurn();

    await dispatcher.drainQueue();

    await expect(queued).resolves.toBe("tok-B");
  });

  it("serializes concurrent drain calls so a queue item is not assigned twice", async () => {
    const dispatcher = new OpenAIDispatcher();
    const worker = fakeWorker({ tokenId: 1, tokenName: "tok-A", busy: true });
    addWorkers(dispatcher, [worker]);
    await dispatcher.onTokenUpdated(1, "tok-A", credentials(), null, 1);
    const execute = vi.fn(async (w: CodexAppServerWorker) => w.tokenName);
    const queued = dispatcher.enqueue(execute);
    await waitForQueue(dispatcher);
    worker.releaseTurn();

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

  it("falls back from reuse when the token is deactivated during quota lookup", async () => {
    const dispatcher = new OpenAIDispatcher();
    const workerA = fakeWorker({ tokenId: 1, tokenName: "tok-A", threads: ["thread-1"] });
    const workerB = fakeWorker({ tokenId: 2, tokenName: "tok-B" });
    addWorkers(dispatcher, [workerA, workerB]);
    await dispatcher.onTokenUpdated(1, "tok-A", credentials(), 80);
    await dispatcher.onTokenUpdated(2, "tok-B", credentials(), null);
    const pendingQuota = deferred<OpenAIQuotaUsageResult>();
    readOpenAIQuotaUsageMock.mockImplementationOnce(() => pendingQuota.promise);
    const executeTurn = vi
      .spyOn(dispatcher, "executeTurn")
      .mockImplementation(async (worker, _req, reuseThreadId) =>
        resultFor(worker, reuseThreadId ?? "thread-new"),
      );

    const pendingGenerate = dispatcher.generate(
      baseReq({
        reuse: { workerId: makeOpenAIWorkerId(1, 0), threadId: "thread-1", epoch: 1 },
      }),
    );
    await vi.waitFor(() => expect(readOpenAIQuotaUsageMock).toHaveBeenCalledTimes(1));
    dispatcher.onTokenDeactivated(1);
    pendingQuota.resolve(quotaOk(10));

    await expect(pendingGenerate).resolves.toMatchObject({ tokenName: "tok-B" });
    expect(workerA.tryAcquireTurn).not.toHaveBeenCalled();
    expect(executeTurn).toHaveBeenCalledWith(workerB, expect.anything());
  });

  it("falls back from busy reuse when its quota metadata changes", async () => {
    const dispatcher = new OpenAIDispatcher();
    const workerA = fakeWorker({
      tokenId: 1,
      tokenName: "tok-A",
      threads: ["thread-1"],
      busy: true,
    });
    const workerB = fakeWorker({ tokenId: 2, tokenName: "tok-B" });
    addWorkers(dispatcher, [workerA, workerB]);
    await dispatcher.onTokenUpdated(1, "tok-A", credentials(), 80);
    await dispatcher.onTokenUpdated(2, "tok-B", credentials(), null);
    readOpenAIQuotaUsageMock
      .mockResolvedValueOnce(quotaOk(10))
      .mockResolvedValueOnce(quotaOk(10));
    const executeTurn = vi
      .spyOn(dispatcher, "executeTurn")
      .mockImplementation(async (worker, _req, reuseThreadId) =>
        resultFor(worker, reuseThreadId ?? "thread-new"),
      );

    const pendingGenerate = dispatcher.generate(
      baseReq({
        reuse: { workerId: makeOpenAIWorkerId(1, 0), threadId: "thread-1", epoch: 1 },
      }),
    );
    await vi.waitFor(() => expect(workerA.tryAcquireTurn).toHaveBeenCalledTimes(1));
    await dispatcher.onTokenUpdated(1, "tok-A", credentials(), 5);

    await expect(pendingGenerate).resolves.toMatchObject({ tokenName: "tok-B" });
    expect(executeTurn).toHaveBeenCalledWith(workerB, expect.anything());
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
