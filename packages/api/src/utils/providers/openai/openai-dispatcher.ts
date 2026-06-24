/**
 * OpenAIDispatcher — codex app-server worker pool + 토큰 라우팅.
 *
 * - 토큰당 N worker (CodexAppServerWorker), 기본 3
 * - idle worker round-robin 선택 + 큐 대기 (전부 busy 시)
 * - TokenSubscriber 이벤트로 worker pool 동기화
 * - backpressure: 큐 full 또는 timeout 시 SERVER_BUSY
 */
import { getLogger } from "@logtape/logtape";

import { TokenModel } from "../../../application/token/token.model";
import { type OpenAICredentials } from "../../../application/token/token.types";
import {
  type GenerateRequest,
  type GenerateResult,
  type GenerateStreamCallbacks,
  type ProviderDispatcher,
} from "../common/provider-dispatcher";
import { CodexAppServerWorker, type StreamCallbacks, type TurnRequest } from "./codex-worker";
import { handleChatgptAuthTokensRefresh } from "./openai-refresh";

const logger = getLogger(["qgrid", "openai-dispatcher"]);

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

type QueueItem = {
  resolve: (worker: CodexAppServerWorker) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  abortCleanup?: () => void;
};

export class OpenAIDispatcher implements ProviderDispatcher {
  workerPool = new Map<number, CodexAppServerWorker[]>();
  rrCursor = 0;
  queue: QueueItem[] = [];

  async start(): Promise<void> {
    const { rows } = await TokenModel.findMany("A");
    const openaiTokens = rows.filter((t) => t.provider === "openai");
    logger.info(
      `starting ${openaiTokens.length} openai tokens (${WORKERS_PER_TOKEN} workers each)`,
    );

    await Promise.allSettled(
      openaiTokens.map(async (t) => {
        await this.spawnWorkers(t.id, t.name, t.credentials as OpenAICredentials);
        if (!t.active) this.onTokenDeactivated(t.id);
      }),
    );
  }

  async stop(): Promise<void> {
    this.rejectAllQueued("DISPATCHER_SHUTDOWN");
    const kills = [...this.workerPool.values()].flat().map((w) => w.kill());
    await Promise.allSettled(kills);
    this.workerPool.clear();
  }

  // ── Token events (from TokenSubscriber) ─────────────────────────

  async onTokenAdded(id: number, name: string, credentials: OpenAICredentials): Promise<void> {
    if (this.workerPool.has(id)) return;
    await this.spawnWorkers(id, name, credentials);
  }

  async onTokenRemoved(id: number): Promise<void> {
    const workers = this.workerPool.get(id) ?? [];
    const tokenName = workers[0]?.tokenName;
    this.workerPool.delete(id);
    await Promise.allSettled(workers.map((w) => w.kill()));
    if (this.getAllReadyActiveWorkers().length === 0) {
      this.rejectAllQueued("NO_OPENAI_WORKERS");
    }
    if (workers.length > 0) {
      const label = tokenName ?? `token ${id}`;
      logger.info(`workers removed: ${label} (${workers.length})`);
    }
  }

  async onTokenUpdated(id: number, name: string, credentials: OpenAICredentials): Promise<void> {
    const existing = this.workerPool.get(id) ?? [];
    if (existing.length === 0) {
      await this.spawnWorkers(id, name, credentials);
      return;
    }

    if (existing.every((w) => w.canReuseForToken(name, credentials))) {
      existing.forEach((w) => w.updateTokenState(name, credentials));
      logger.info(`workers updated in-place: ${name}`);
      this.drainQueue();
      return;
    }

    this.workerPool.delete(id);
    await Promise.allSettled(existing.map((w) => w.kill()));
    await this.spawnWorkers(id, name, credentials);
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
    this.drainQueue();
    const label = tokenName ?? `token ${id}`;
    logger.info(`workers activated: ${label}`);
  }

  // ── Generate ────────────────────────────────────────────────────

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    // thread 재사용 경로: 좌표 worker 를 점유해 기존 thread 에 turn 만 실행.
    const reuseWorker = await this.acquireReuseWorker(req);
    if (reuseWorker) {
      logger.info(
        `↻ ${reuseWorker.tokenName}[${reuseWorker.tokenId}] (reuse thread, ${req.model})`,
      );
      return this.executeAndRelease(reuseWorker, (w) =>
        this.executeTurn(w, req, req.reuse!.threadId),
      );
    }

    const worker = this.acquireIdleWorker();
    if (worker) {
      logger.info(`→ ${worker.tokenName}[${worker.tokenId}] (model: ${req.model})`);
      return this.executeAndRelease(worker, (w) => this.executeTurn(w, req));
    }
    return this.enqueue((w) => {
      logger.info(`→ ${w.tokenName}[${w.tokenId}] (model: ${req.model}, queued)`);
      return this.executeTurn(w, req);
    });
  }

  async generateStream(req: GenerateRequest, cb: GenerateStreamCallbacks): Promise<void> {
    const reuseWorker = await this.acquireReuseWorker(req);
    if (reuseWorker) {
      logger.info(`↻ ${reuseWorker.tokenName}[${reuseWorker.tokenId}] (reuse thread, [stream])`);
      return this.executeAndRelease(reuseWorker, (w) =>
        this.executeStreamTurn(w, req, cb, req.reuse!.threadId),
      );
    }

    const worker = this.acquireIdleWorker();
    if (worker) {
      logger.info(`→ ${worker.tokenName}[${worker.tokenId}] (model: ${req.model}, [stream])`);
      return this.executeAndRelease(worker, (w) => this.executeStreamTurn(w, req, cb));
    }
    return this.enqueue((w) => {
      logger.info(`→ ${w.tokenName}[${w.tokenId}] (model: ${req.model}, [stream], queued)`);
      return this.executeStreamTurn(w, req, cb);
    });
  }

  // reuse 좌표가 유효하면 그 worker 를 busy 점유해 반환. 없거나 폴백 대상이면 null.
  // 폴백 사유: 기능 off / 좌표 없음 / worker 부재·죽음 / epoch 불일치(restart) / thread 소멸 /
  //            busy 대기 타임아웃. null 반환 시 호출부는 새 thread 경로로 진행.
  async acquireReuseWorker(req: GenerateRequest): Promise<CodexAppServerWorker | null> {
    if (!THREAD_REUSE_ENABLED || !req.reuse) return null;
    const { workerId, threadId, epoch } = req.reuse;

    const worker = this.findWorkerById(workerId);
    if (!worker || !worker.isReady || !worker.active) return null;
    if (worker.epoch !== epoch) return null;
    if (!worker.hasThread(threadId)) return null;

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
  acquireIdleWorker(): CodexAppServerWorker | null {
    const allWorkers = this.getAllReadyActiveWorkers();
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

  enqueue<T>(execute: (worker: CodexAppServerWorker) => Promise<T>): Promise<T> {
    if (this.getAllReadyActiveWorkers().length === 0) {
      return Promise.reject(new Error("NO_OPENAI_WORKERS"));
    }
    if (this.queue.length >= MAX_QUEUE_SIZE) {
      return Promise.reject(new Error("SERVER_BUSY"));
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

  drainQueue(releasedWorker?: CodexAppServerWorker): void {
    if (
      releasedWorker &&
      this.queue.length > 0 &&
      releasedWorker.isReady &&
      releasedWorker.active &&
      releasedWorker.tryAcquireTurn()
    ) {
      const next = this.queue.shift()!;
      next.resolve(releasedWorker);
      return;
    }

    while (this.queue.length > 0) {
      const worker = this.acquireIdleWorker();
      if (!worker) break;
      const next = this.queue.shift()!;
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
      this.drainQueue(worker);
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
    };
  }

  async executeTurn(
    worker: CodexAppServerWorker,
    req: GenerateRequest,
    reuseThreadId?: string,
  ): Promise<GenerateResult> {
    const turnReq = this.buildTurnRequest(req, reuseThreadId);
    const result = await worker.executeTurn(turnReq, reuseThreadId);
    return {
      text: result.text,
      tokenName: worker.tokenName,
      usage: result.usage,
      durationMs: result.durationMs,
      model: result.model,
      threadCoord: {
        workerId: makeWorkerId(worker.tokenId, worker.workerIndex),
        threadId: result.threadId,
        epoch: worker.epoch,
      },
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
  ): Promise<void> {
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

    worker.onReady = () => this.drainQueue();

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

  rateLimitsCache = new Map<string, { data: unknown; cachedAt: number }>();
  static readonly RATE_LIMITS_CACHE_TTL = 60_000;

  async getRateLimits(tokenName?: string): Promise<unknown> {
    const cacheKey = tokenName ?? "_default";
    const cached = this.rateLimitsCache.get(cacheKey);
    if (cached && Date.now() - cached.cachedAt < OpenAIDispatcher.RATE_LIMITS_CACHE_TTL) {
      return cached.data;
    }

    const allWorkers = [...this.workerPool.values()].flat().filter((w) => w.isReady);
    const worker = tokenName ? allWorkers.find((w) => w.tokenName === tokenName) : allWorkers[0];
    if (!worker) throw new Error("no ready openai workers");
    const data = await worker.getRateLimits();
    this.rateLimitsCache.set(cacheKey, { data, cachedAt: Date.now() });
    return data;
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
