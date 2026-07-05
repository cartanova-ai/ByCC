/**
 * OpenAIDispatcher — codex app-server worker pool + 토큰 라우팅.
 *
 * - 토큰당 N worker (CodexAppServerWorker), 기본 3
 * - idle worker round-robin 선택 + 큐 대기 (전부 busy 시)
 * - TokenSubscriber 이벤트로 worker pool 동기화
 * - backpressure: 큐 full 또는 timeout 시 SERVER_BUSY
 */
import { getLogger } from "@logtape/logtape";

import { QuotaThresholdExceededError } from "../../../application/qgrid/qgrid.types";
import { TokenModel } from "../../../application/token/token.model";
import { type OpenAICredentials } from "../../../application/token/token.types";
import { type GetAccountRateLimitsResponse } from "../../../codex-protocol/v2/GetAccountRateLimitsResponse";
import {
  type GenerateRequest,
  type GenerateResult,
  type GenerateStreamCallbacks,
  type ProviderDispatcher,
} from "../common/provider-dispatcher";
import { CodexAppServerWorker, type StreamCallbacks, type TurnRequest } from "./codex-worker";
import {
  readOpenAIQuotaUsage,
  type OpenAIQuotaUsageResult,
  type OpenAIRateLimitsWithMeta,
} from "./openai-quota";
import { handleChatgptAuthTokensRefresh } from "./openai-refresh";

const logger = getLogger(["qgrid", "openai-dispatcher"]);

// 이미지 생성 요청이 게이트/생성에 실패했을 때의 구분자.
// - "gate": 사전 검증 실패(capability/모델 멀티모달 불충족) — turn 미실행.
// - "not_called": turn 은 성공했으나 모델이 image tool 을 호출 안 함 — 재시도 무익(프롬프트 문제).
// - "incomplete": tool 시도됐으나 완성 이미지 미도착 — 재시도 후보(서버측 실패/거부).
export type ImageFailureKind = "gate" | "not_called" | "incomplete";

export class ImageGenerationError extends Error {
  constructor(
    readonly kind: ImageFailureKind,
    message: string,
  ) {
    super(message);
    this.name = "ImageGenerationError";
  }
}

const DEFAULT_EFFORT = "low";
const MAX_WORKERS_PER_TOKEN = 5;
const WORKERS_PER_TOKEN = Math.min(
  Number(process.env.QGRID_WORKERS_PER_TOKEN ?? 3),
  MAX_WORKERS_PER_TOKEN,
);
const QUEUE_TIMEOUT_MS = 60_000;
const MAX_QUEUE_SIZE = 50;
const SPAWN_INTERVAL_MS = 500;

// thread 재사용(prompt cache 고정). 끄면 기존 "매 turn 새 thread + history inject" 동작.
const THREAD_REUSE_ENABLED = process.env.QGRID_OPENAI_THREAD_REUSE !== "false";
// 좌표 worker 가 busy 일 때 free 를 기다리는 최대 시간. 초과 시 새 thread 로 폴백.
const REUSE_WORKER_WAIT_MS = 5_000;
const REUSE_WORKER_POLL_MS = 50;

// workerId 합성: tokenId 와 workerIndex(0..4) 를 하나의 안정 숫자로 인코딩.
function makeWorkerId(tokenId: number, workerIndex: number): number {
  return tokenId * 10 + workerIndex;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function quotaThresholdExceededMessage(
  provider: string,
  tokens: Array<{ tokenName: string; threshold: number }>,
): string {
  const details = tokens
    .map((token) => `${token.tokenName} (threshold ${token.threshold}%)`)
    .join(", ");
  return details.length > 0
    ? `All ${provider} tokens exceeded quota threshold: ${details}`
    : `All ${provider} tokens exceeded quota threshold`;
}

type QueueItem = {
  resolve: (worker: CodexAppServerWorker) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  abortCleanup?: () => void;
  excludedTokenIds: Set<number>;
};

type TokenMetadata = {
  name: string;
  quotaThreshold?: number | null;
};

type TokenEligibility = {
  readyActiveTokenIds: Set<number>;
  eligibleTokenIds: Set<number>;
  overThresholdTokens: Array<{ tokenName: string; threshold: number }>;
  thresholdedTokenCount: number;
};

export class OpenAIDispatcher implements ProviderDispatcher {
  workerPool = new Map<number, CodexAppServerWorker[]>();
  tokenMetadata = new Map<number, TokenMetadata>();
  rrCursor = 0;
  queue: QueueItem[] = [];
  private draining = false;
  private drainAgain = false;

  async start(): Promise<void> {
    const { rows } = await TokenModel.findMany("A");
    const openaiTokens = rows.filter((t) => t.provider === "openai");
    logger.info(
      `starting ${openaiTokens.length} openai tokens (${WORKERS_PER_TOKEN} workers each)`,
    );

    await Promise.allSettled(
      openaiTokens.map(async (t) => {
        await this.spawnWorkers(
          t.id,
          t.name,
          t.credentials as OpenAICredentials,
          t.quota_threshold,
        );
        if (!t.active) this.onTokenDeactivated(t.id);
      }),
    );
  }

  async stop(): Promise<void> {
    this.rejectAllQueued("DISPATCHER_SHUTDOWN");
    const kills = [...this.workerPool.values()].flat().map((w) => w.kill());
    await Promise.allSettled(kills);
    this.workerPool.clear();
    this.tokenMetadata.clear();
    this.rateLimitsCache.clear();
  }

  // ── Token events (from TokenSubscriber) ─────────────────────────

  async onTokenAdded(
    id: number,
    name: string,
    credentials: OpenAICredentials,
    quotaThreshold?: number | null,
  ): Promise<void> {
    this.setTokenMetadata(id, name, quotaThreshold);
    if (this.workerPool.has(id)) return;
    await this.spawnWorkers(id, name, credentials, quotaThreshold);
  }

  async onTokenRemoved(id: number): Promise<void> {
    const workers = this.workerPool.get(id) ?? [];
    const tokenName = workers[0]?.tokenName;
    this.workerPool.delete(id);
    this.tokenMetadata.delete(id);
    this.rateLimitsCache.delete(id);
    await Promise.allSettled(workers.map((w) => w.kill()));
    if (this.getAllReadyActiveWorkers().length === 0) {
      this.rejectAllQueued("NO_OPENAI_WORKERS");
    }
    if (workers.length > 0) {
      const label = tokenName ?? `token ${id}`;
      logger.info(`workers removed: ${label} (${workers.length})`);
    }
  }

  async onTokenUpdated(
    id: number,
    name: string,
    credentials: OpenAICredentials,
    quotaThreshold?: number | null,
  ): Promise<void> {
    const existing = this.workerPool.get(id) ?? [];
    const renamed = existing.some((w) => w.tokenName !== name);
    this.setTokenMetadata(id, name, quotaThreshold);
    if (renamed) this.rateLimitsCache.delete(id);

    if (existing.length === 0) {
      await this.spawnWorkers(id, name, credentials, quotaThreshold);
      return;
    }

    if (existing.every((w) => w.canReuseForToken(name, credentials))) {
      existing.forEach((w) => w.updateTokenState(name, credentials));
      logger.info(`workers updated in-place: ${name}`);
      this.requestDrainQueue();
      return;
    }

    this.workerPool.delete(id);
    this.rateLimitsCache.delete(id);
    await Promise.allSettled(existing.map((w) => w.kill()));
    await this.spawnWorkers(id, name, credentials, quotaThreshold);
  }

  onTokenDeactivated(id: number): void {
    const workers = this.workerPool.get(id) ?? [];
    const tokenName = workers[0]?.tokenName;
    workers.forEach((w) => {
      w.active = false;
    });
    if (this.getAllReadyActiveWorkers().length === 0) {
      this.rejectAllQueued("NO_ACTIVE_WORKERS");
    }
    const label = tokenName ?? `token ${id}`;
    logger.info(`workers deactivated: ${label}`);
  }

  onTokenActivated(id: number): void {
    const workers = this.workerPool.get(id) ?? [];
    const tokenName = workers[0]?.tokenName;
    workers.forEach((w) => {
      w.active = true;
    });
    this.requestDrainQueue();
    const label = tokenName ?? `token ${id}`;
    logger.info(`workers activated: ${label}`);
  }

  async replaceTokens(
    rows: Array<{
      id: number;
      name: string;
      credentials: OpenAICredentials;
      quotaThreshold?: number | null;
    }>,
  ): Promise<void> {
    const next = new Set(rows.map((r) => r.id));
    for (const id of Array.from(this.workerPool.keys())) {
      if (!next.has(id)) await this.onTokenRemoved(id);
    }

    for (const row of rows) {
      if (this.workerPool.has(row.id)) {
        await this.onTokenUpdated(row.id, row.name, row.credentials, row.quotaThreshold);
      } else {
        await this.onTokenAdded(row.id, row.name, row.credentials, row.quotaThreshold);
      }
      this.onTokenActivated(row.id);
    }
  }

  // ── Generate ────────────────────────────────────────────────────

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const excludedTokenIds = new Set<number>();
    // thread 재사용 경로: 좌표 worker 를 점유해 기존 thread 에 turn 만 실행.
    const reuseWorker = await this.acquireReuseWorker(req, excludedTokenIds);
    if (reuseWorker) {
      logger.info(
        `↻ ${reuseWorker.tokenName}[${reuseWorker.tokenId}] (reuse thread, ${req.model})`,
      );
      return this.executeAndRelease(reuseWorker, (w) =>
        this.executeTurn(w, req, req.reuse!.threadId),
      );
    }

    const worker = await this.acquireIdleWorker(excludedTokenIds);
    if (worker) {
      logger.info(`→ ${worker.tokenName}[${worker.tokenId}] (model: ${req.model})`);
      return this.executeAndRelease(worker, (w) => this.executeTurn(w, req));
    }
    return this.enqueue((w) => {
      logger.info(`→ ${w.tokenName}[${w.tokenId}] (model: ${req.model}, queued)`);
      return this.executeTurn(w, req);
    }, excludedTokenIds);
  }

  async generateStream(req: GenerateRequest, cb: GenerateStreamCallbacks): Promise<void> {
    const excludedTokenIds = new Set<number>();
    const reuseWorker = await this.acquireReuseWorker(req, excludedTokenIds);
    if (reuseWorker) {
      logger.info(`↻ ${reuseWorker.tokenName}[${reuseWorker.tokenId}] (reuse thread, [stream])`);
      return this.executeAndRelease(reuseWorker, (w) =>
        this.executeStreamTurn(w, req, cb, req.reuse!.threadId),
      );
    }

    const worker = await this.acquireIdleWorker(excludedTokenIds);
    if (worker) {
      logger.info(`→ ${worker.tokenName}[${worker.tokenId}] (model: ${req.model}, [stream])`);
      return this.executeAndRelease(worker, (w) => this.executeStreamTurn(w, req, cb));
    }
    return this.enqueue((w) => {
      logger.info(`→ ${w.tokenName}[${w.tokenId}] (model: ${req.model}, [stream], queued)`);
      return this.executeStreamTurn(w, req, cb);
    }, excludedTokenIds);
  }

  // reuse 좌표가 유효하면 그 worker 를 busy 점유해 반환. 없거나 폴백 대상이면 null.
  // 폴백 사유: 기능 off / 좌표 없음 / worker 부재·죽음 / epoch 불일치(restart) / thread 소멸 /
  //            busy 대기 타임아웃. null 반환 시 호출부는 새 thread 경로로 진행.
  async acquireReuseWorker(
    req: GenerateRequest,
    excludedTokenIds = new Set<number>(),
  ): Promise<CodexAppServerWorker | null> {
    if (!THREAD_REUSE_ENABLED || !req.reuse) return null;
    const { workerId, threadId, epoch } = req.reuse;

    const worker = this.findWorkerById(workerId);
    if (!worker || !worker.isReady || !worker.active) return null;
    if (worker.epoch !== epoch) return null;
    if (!worker.hasThread(threadId)) return null;
    if (!(await this.isTokenQuotaEligible(worker.tokenId, worker.tokenName, excludedTokenIds))) {
      return null;
    }

    const deadline = Date.now() + REUSE_WORKER_WAIT_MS;
    for (;;) {
      // restart(epoch 변경) / thread 소멸이 대기 중에 발생하면 폴백.
      if (worker.epoch !== epoch || !worker.hasThread(threadId)) return null;
      if (worker.tryAcquireTurn()) return worker;
      if (Date.now() >= deadline) return null;
      await sleep(REUSE_WORKER_POLL_MS);
    }
  }

  findWorkerById(workerId: number): CodexAppServerWorker | null {
    for (const workers of this.workerPool.values()) {
      for (const w of workers) {
        if (makeWorkerId(w.tokenId, w.workerIndex) === workerId) return w;
      }
    }
    return null;
  }

  async interruptWorkerTurn(threadId: string, turnId: string): Promise<void> {
    const allWorkers = [...this.workerPool.values()].flat().filter((w) => w.isReady);
    await Promise.allSettled(allWorkers.map((w) => w.interruptTurn(threadId, turnId)));
  }

  // ── Worker selection ────────────────────────────────────────────
  //  기본 round-robin
  // TODO: 추후 다른 알고리즘으로 변경 가능하게 지원
  async acquireIdleWorker(
    excludedTokenIds = new Set<number>(),
  ): Promise<CodexAppServerWorker | null> {
    const eligibility = await this.resolveTokenEligibility(excludedTokenIds);
    if (eligibility.readyActiveTokenIds.size === 0) return null;
    if (eligibility.eligibleTokenIds.size === 0) this.throwQuotaThresholdExceeded(eligibility);

    const allWorkers = this.getAllReadyActiveWorkers().filter((w) =>
      eligibility.eligibleTokenIds.has(w.tokenId),
    );
    if (allWorkers.length === 0) return null;
    for (let i = 0; i < allWorkers.length; i++) {
      const w = allWorkers[(this.rrCursor + i) % allWorkers.length]!;
      if (w.tryAcquireTurn()) {
        this.rrCursor = (this.rrCursor + i + 1) % allWorkers.length;
        return w;
      }
    }
    return null;
  }

  getAllReadyActiveWorkers(): CodexAppServerWorker[] {
    return [...this.workerPool.values()].flat().filter((w) => w.isReady && w.active);
  }

  // ── Queue ───────────────────────────────────────────────────────

  async enqueue<T>(
    execute: (worker: CodexAppServerWorker) => Promise<T>,
    excludedTokenIds = new Set<number>(),
  ): Promise<T> {
    const eligibility = await this.resolveTokenEligibility(excludedTokenIds);
    if (eligibility.readyActiveTokenIds.size === 0) throw new Error("NO_OPENAI_WORKERS");
    if (eligibility.eligibleTokenIds.size === 0) this.throwQuotaThresholdExceeded(eligibility);
    if (this.queue.length >= MAX_QUEUE_SIZE) {
      throw new Error("SERVER_BUSY");
    }

    return new Promise<T>((resolve, reject) => {
      const item: QueueItem = {
        resolve: (worker) => {
          clearTimeout(item.timer);
          item.abortCleanup?.();
          Promise.resolve()
            .then(() => this.executeAndRelease(worker, execute))
            .then(resolve, reject);
        },
        reject: (err) => {
          clearTimeout(item.timer);
          item.abortCleanup?.();
          reject(err);
        },
        timer: setTimeout(() => {
          this.removeFromQueue(item);
          reject(new Error("SERVER_BUSY"));
        }, QUEUE_TIMEOUT_MS),
        excludedTokenIds: new Set(excludedTokenIds),
      };

      this.queue.push(item);
    });
  }

  removeFromQueue(item: QueueItem): void {
    clearTimeout(item.timer);
    item.abortCleanup?.();
    const idx = this.queue.indexOf(item);
    if (idx !== -1) this.queue.splice(idx, 1);
  }

  rejectAllQueued(reason: string): void {
    const err = new Error(reason);
    this.queue.forEach((item) => {
      clearTimeout(item.timer);
      item.abortCleanup?.();
      item.reject(err);
    });
    this.queue = [];
  }

  async drainQueue(releasedWorker?: CodexAppServerWorker): Promise<void> {
    if (this.draining) {
      this.drainAgain = true;
      return;
    }

    this.draining = true;
    let worker = releasedWorker;
    try {
      do {
        this.drainAgain = false;
        await this.drainQueueOnce(worker);
        worker = undefined;
      } while (this.drainAgain);
    } catch (e) {
      logger.warn(`drainQueue failed: ${(e as Error).message}`);
    } finally {
      this.draining = false;
    }
  }

  private async drainQueueOnce(releasedWorker?: CodexAppServerWorker): Promise<void> {
    if (
      releasedWorker &&
      this.queue.length > 0 &&
      releasedWorker.isReady &&
      releasedWorker.active &&
      (await this.isWorkerEligibleForQueueItem(releasedWorker, this.queue[0]!)) &&
      releasedWorker.tryAcquireTurn()
    ) {
      const next = this.queue.shift()!;
      next.resolve(releasedWorker);
      return;
    }

    while (this.queue.length > 0) {
      const next = this.queue[0]!;
      let worker: CodexAppServerWorker | null;
      try {
        worker = await this.acquireIdleWorker(next.excludedTokenIds);
      } catch (e) {
        if (e instanceof QuotaThresholdExceededError) {
          this.queue.shift();
          next.reject(e);
          continue;
        }
        throw e;
      }
      if (!worker) break;
      this.queue.shift();
      next.resolve(worker);
    }
  }

  // ── Execution ───────────────────────────────────────────────────

  async executeAndRelease<T>(
    worker: CodexAppServerWorker,
    execute: (worker: CodexAppServerWorker) => Promise<T>,
  ): Promise<T> {
    try {
      return await execute(worker);
    } finally {
      worker.releaseTurn();
      this.requestDrainQueue(worker);
    }
  }

  // reuseThreadId 가 있으면 기존 thread 에 delta(reuseInput)만, 없으면 새 thread 에 전체
  // prompt(coldInput) + history inject. reuse 가 dispatcher 단에서 폴백되면 후자로 떨어진다.
  private buildTurnRequest(req: GenerateRequest, reuseThreadId?: string): TurnRequest {
    const reusing = reuseThreadId !== undefined;
    return {
      input: reusing && req.reuseInput ? req.reuseInput : req.coldInput,
      history: reusing ? undefined : req.coldHistory,
      developerInstructions: req.systemPrompt,
      outputSchema: req.outputSchema,
      effort: req.effort ?? DEFAULT_EFFORT,
      model: req.model,
      verbosity: req.verbosity,
      reasoningSummary: req.reasoningSummary,
      serviceTier: req.serviceTier,
      imageGeneration: req.imageGeneration,
    };
  }

  async executeTurn(
    worker: CodexAppServerWorker,
    req: GenerateRequest,
    reuseThreadId?: string,
  ): Promise<GenerateResult> {
    // 이미지 요청 사전 게이트(R5): 배정된 worker 의 capability + 적용 모델 멀티모달.
    // 불충족이면 turn 을 실행하지 않고 명시적 에러.
    if (req.imageGeneration) {
      const reason = await worker.checkImageGenerationSupport(req.model);
      if (reason) throw new ImageGenerationError("gate", reason);
    }

    const turnReq = this.buildTurnRequest(req, reuseThreadId);
    const result = await worker.executeTurn(turnReq, reuseThreadId);

    // 이미지 0개 실패 분류(R6): tool 미호출(재시도 무익) vs 시도 후 미완성(재시도 후보).
    if (req.imageGeneration && (!result.images || result.images.length === 0)) {
      throw result.imageAttempted
        ? new ImageGenerationError("incomplete", "image tool ran but produced no completed image")
        : new ImageGenerationError("not_called", "model did not call the image_generation tool");
    }

    return {
      text: result.text,
      tokenName: worker.tokenName,
      usage: result.usage,
      durationMs: result.durationMs,
      ttftMs: result.ttftMs,
      model: result.model,
      threadCoord: {
        workerId: makeWorkerId(worker.tokenId, worker.workerIndex),
        threadId: result.threadId,
        epoch: worker.epoch,
      },
      images: result.images,
    };
  }

  async executeStreamTurn(
    worker: CodexAppServerWorker,
    req: GenerateRequest,
    cb: GenerateStreamCallbacks,
    reuseThreadId?: string,
  ): Promise<void> {
    const turnReq = this.buildTurnRequest(req, reuseThreadId);
    // worker 의 TurnResult 에 tokenName/threadCoord 를 붙여 상위(GenerateResult)로 올린다.
    // threadId 는 새 thread 면 onThreadId 로 확정되므로 미리 보관해 두고 onComplete 때 읽는다.
    let resolvedThreadId = reuseThreadId ?? "";
    const wrappedCb: StreamCallbacks = {
      ...cb,
      onThreadId: (threadId) => {
        resolvedThreadId = threadId;
        cb.onThreadId?.(threadId);
      },
      onComplete: (result) => {
        cb.onComplete({
          ...result,
          tokenName: worker.tokenName,
          threadCoord: {
            workerId: makeWorkerId(worker.tokenId, worker.workerIndex),
            threadId: resolvedThreadId,
            epoch: worker.epoch,
          },
        });
      },
    };
    await worker.executeTurnStream(turnReq, wrappedCb, reuseThreadId);
  }

  // ── Spawn ───────────────────────────────────────────────────────

  async spawnWorkers(
    tokenId: number,
    tokenName: string,
    credentials: OpenAICredentials,
    quotaThreshold?: number | null,
  ): Promise<void> {
    this.setTokenMetadata(tokenId, tokenName, quotaThreshold);
    const workers: CodexAppServerWorker[] = [];
    for (let i = 0; i < WORKERS_PER_TOKEN; i++) {
      if (i > 0) await sleep(SPAWN_INTERVAL_MS);
      const worker = await this.spawnSingleWorker(tokenId, tokenName, credentials, i);
      if (worker) workers.push(worker);
    }
    if (workers.length > 0) this.workerPool.set(tokenId, workers);
  }

  async spawnSingleWorker(
    tokenId: number,
    tokenName: string,
    credentials: OpenAICredentials,
    workerIndex: number,
  ): Promise<CodexAppServerWorker | null> {
    const worker = new CodexAppServerWorker({
      tokenId,
      tokenName,
      accessToken: credentials.accessToken,
      accountId: credentials.accountId,
      planType: credentials.planType,
      workerIndex,
    });

    worker.onReady = () => this.requestDrainQueue();

    worker.setServerRequestHandler(async (method) => {
      if (method === "account/chatgptAuthTokens/refresh") {
        return handleChatgptAuthTokensRefresh(tokenId);
      }
      throw new Error(`unhandled server-request: ${method}`);
    });

    try {
      await worker.initialize();
      logger.info(`worker spawned: ${tokenName}[${workerIndex}]`);
      return worker;
    } catch (e) {
      logger.warn(`worker spawn failed: ${tokenName}[${workerIndex}]: ${(e as Error).message}`);
      await worker.kill().catch(() => {});
      return null;
    }
  }

  // ── Rate limits ─────────────────────────────────────────────────

  rateLimitsCache = new Map<number, { data: GetAccountRateLimitsResponse; cachedAt: number }>();
  static readonly RATE_LIMITS_CACHE_TTL = 60_000;

  async getRateLimitsByTokenId(tokenId: number): Promise<OpenAIRateLimitsWithMeta> {
    const cached = this.rateLimitsCache.get(tokenId);
    if (cached && Date.now() - cached.cachedAt < OpenAIDispatcher.RATE_LIMITS_CACHE_TTL) {
      return cached;
    }

    const worker = (this.workerPool.get(tokenId) ?? []).find((w) => w.isReady);
    if (!worker) throw new Error("no ready openai workers");
    const data = (await worker.getRateLimits()) as GetAccountRateLimitsResponse;
    const entry = { data, cachedAt: Date.now() };
    this.rateLimitsCache.set(tokenId, entry);
    return entry;
  }

  private requestDrainQueue(releasedWorker?: CodexAppServerWorker): void {
    void this.drainQueue(releasedWorker).catch((e) =>
      logger.warn(`drainQueue failed: ${(e as Error).message}`),
    );
  }

  private setTokenMetadata(id: number, name: string, quotaThreshold?: number | null): void {
    this.tokenMetadata.set(id, { name, quotaThreshold });
  }

  private getQuotaThreshold(tokenId: number): number | null | undefined {
    return this.tokenMetadata.get(tokenId)?.quotaThreshold;
  }

  private hasQuotaThreshold(tokenId: number): boolean {
    const threshold = this.getQuotaThreshold(tokenId);
    return threshold !== undefined && threshold !== null;
  }

  private async resolveTokenEligibility(excludedTokenIds: Set<number>): Promise<TokenEligibility> {
    const workers = this.getAllReadyActiveWorkers();
    const byToken = new Map<number, string>();
    for (const worker of workers) {
      if (!byToken.has(worker.tokenId)) byToken.set(worker.tokenId, worker.tokenName);
    }

    const readyActiveTokenIds = new Set(byToken.keys());
    const eligibleTokenIds = new Set<number>();
    const overThresholdTokens: Array<{ tokenName: string; threshold: number }> = [];
    let thresholdedTokenCount = 0;

    const entries = Array.from(byToken.entries());
    const checks = await Promise.allSettled(
      entries.map(async ([tokenId, tokenName]) => {
        if (excludedTokenIds.has(tokenId)) {
          thresholdedTokenCount++;
          return { tokenId, tokenName, eligible: false };
        }
        if (!this.hasQuotaThreshold(tokenId)) {
          return { tokenId, tokenName, eligible: true };
        }
        thresholdedTokenCount++;
        return {
          tokenId,
          tokenName,
          eligible: await this.isTokenQuotaEligible(tokenId, tokenName),
        };
      }),
    );

    checks.forEach((check, index) => {
      if (check.status === "fulfilled") {
        if (check.value.eligible) {
          eligibleTokenIds.add(check.value.tokenId);
        } else {
          const threshold = this.getQuotaThreshold(check.value.tokenId);
          if (threshold !== undefined && threshold !== null) {
            overThresholdTokens.push({ tokenName: check.value.tokenName, threshold });
          }
        }
        return;
      }

      const entry = entries[index];
      if (entry) {
        const [tokenId, tokenName] = entry;
        this.logQuotaLookupFailOpen(tokenId, tokenName, String(check.reason));
        eligibleTokenIds.add(tokenId);
      }
    });

    return { readyActiveTokenIds, eligibleTokenIds, overThresholdTokens, thresholdedTokenCount };
  }

  private async isWorkerEligibleForQueueItem(
    worker: CodexAppServerWorker,
    item: QueueItem,
  ): Promise<boolean> {
    if (item.excludedTokenIds.has(worker.tokenId)) return false;
    return this.isTokenQuotaEligible(worker.tokenId, worker.tokenName);
  }

  private async isTokenQuotaEligible(
    tokenId: number,
    tokenName: string,
    excludedTokenIds?: Set<number>,
  ): Promise<boolean> {
    const threshold = this.getQuotaThreshold(tokenId);
    if (threshold === undefined || threshold === null) return true;

    let result: OpenAIQuotaUsageResult;
    try {
      result = await readOpenAIQuotaUsage(() => this.getRateLimitsByTokenId(tokenId));
    } catch (e) {
      this.logQuotaLookupFailOpen(tokenId, tokenName, (e as Error).message);
      return true;
    }

    if (result.kind === "lookup_failed") {
      this.logQuotaLookupFailOpen(tokenId, tokenName, result.reason);
      return true;
    }

    if (result.utilizationPct >= threshold) {
      this.logQuotaOverThreshold(tokenId, tokenName, threshold, result);
      excludedTokenIds?.add(tokenId);
      return false;
    }

    return true;
  }

  private logQuotaOverThreshold(
    tokenId: number,
    tokenName: string,
    threshold: number,
    result: Extract<OpenAIQuotaUsageResult, { kind: "ok" }>,
  ): void {
    logger.info("quota_threshold gate: over_threshold", {
      tokenId,
      tokenName,
      provider: "openai",
      threshold,
      cachedUtilization: result.utilizationPct,
      cacheAge: result.cacheAgeMs,
      windowDurationMins: result.windowDurationMins,
      resetsAt: result.resetsAt,
      limitId: result.limitId,
      reason: "over_threshold",
    });
  }

  private logQuotaLookupFailOpen(tokenId: number, tokenName: string, reason: string): void {
    const threshold = this.getQuotaThreshold(tokenId);
    logger.warn("quota_threshold gate: lookup_fail_open", {
      tokenId,
      tokenName,
      provider: "openai",
      threshold,
      reason: "lookup_fail_open",
      lookupReason: reason,
    });
  }

  private throwQuotaThresholdExceeded(eligibility: TokenEligibility): never {
    logger.warn("quota_threshold gate: all_exceeded", {
      provider: "openai",
      tokenCount: eligibility.readyActiveTokenIds.size,
      thresholdedTokenCount: eligibility.thresholdedTokenCount,
      overThresholdTokens: eligibility.overThresholdTokens,
      reason: "all_exceeded",
    });
    throw new QuotaThresholdExceededError(
      quotaThresholdExceededMessage("openai", eligibility.overThresholdTokens),
    );
  }

  // ── Browser login flow ───────────────────────────────────────────

  pendingLogin: {
    worker: CodexAppServerWorker;
    name: string;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;

  async startBrowserLogin(name: string): Promise<{ authUrl: string }> {
    if (this.pendingLogin) {
      this.pendingLogin.worker.kill().catch(() => {});
      clearTimeout(this.pendingLogin.timer);
      this.pendingLogin = null;
    }

    const tempId = Date.now();
    const worker = new CodexAppServerWorker({
      tokenId: tempId,
      tokenName: name,
      accessToken: "",
      accountId: "",
    });

    const authUrl = await worker.startBrowserLogin();

    const timer = setTimeout(() => {
      if (this.pendingLogin?.worker === worker) {
        logger.warn(`browser login timeout for ${name}, killing worker`);
        worker.kill().catch(() => {});
        this.pendingLogin = null;
      }
    }, 300_000);

    this.pendingLogin = { worker, name, timer };
    return { authUrl };
  }

  get pendingLoginName(): string | null {
    return this.pendingLogin?.name ?? null;
  }

  async completeBrowserLogin(): Promise<{
    accessToken: string;
    refreshToken: string;
    idToken?: string;
    accountId: string;
  }> {
    if (!this.pendingLogin) throw new Error("no pending login");
    const { worker, timer } = this.pendingLogin;

    try {
      await worker.waitForBrowserLoginComplete();
      const creds = await worker.readManagedCredentials();
      if (!creds) throw new Error("failed to read credentials after login");
      return creds;
    } finally {
      clearTimeout(timer);
      this.pendingLogin = null;
      await worker.kill().catch(() => {});
    }
  }

  // ── Stats ───────────────────────────────────────────────────────

  get workerCount(): number {
    return [...this.workerPool.values()].flat().length;
  }

  get readyWorkerCount(): number {
    return [...this.workerPool.values()].flat().filter((w) => w.isReady).length;
  }

  get queueLength(): number {
    return this.queue.length;
  }
}
