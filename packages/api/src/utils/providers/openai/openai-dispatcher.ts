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
  type ProviderDispatcher,
} from "../common/provider-dispatcher";
import {
  CodexAppServerWorker,
  type StreamCallbacks,
  type TurnRequest,
  type TurnResult,
} from "./codex-worker";
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
    this.workerPool.delete(id);
    await Promise.allSettled(workers.map((w) => w.kill()));
    if (this.getAllReadyActiveWorkers().length === 0) {
      this.rejectAllQueued("NO_OPENAI_WORKERS");
    }
    if (workers.length > 0) logger.info(`workers removed for token ${id}: ${workers.length}`);
  }

  async onTokenUpdated(id: number, name: string, credentials: OpenAICredentials): Promise<void> {
    const existing = this.workerPool.get(id) ?? [];
    if (existing.length === 0) {
      await this.spawnWorkers(id, name, credentials);
      return;
    }

    if (existing.every((w) => w.canReuseForToken(name, credentials))) {
      existing.forEach((w) => w.updateTokenState(name, credentials));
      logger.info(`workers updated in-place for token ${id} (${name})`);
      this.drainQueue();
      return;
    }

    this.workerPool.delete(id);
    await Promise.allSettled(existing.map((w) => w.kill()));
    await this.spawnWorkers(id, name, credentials);
  }

  onTokenDeactivated(id: number): void {
    (this.workerPool.get(id) ?? []).forEach((w) => {
      w.active = false;
    });
    if (this.getAllReadyActiveWorkers().length === 0) {
      this.rejectAllQueued("NO_ACTIVE_WORKERS");
    }
    logger.info(`workers deactivated: token ${id}`);
  }

  onTokenActivated(id: number): void {
    (this.workerPool.get(id) ?? []).forEach((w) => {
      w.active = true;
    });
    this.drainQueue();
    logger.info(`workers activated: token ${id}`);
  }

  // ── Generate ────────────────────────────────────────────────────

  async generate(req: GenerateRequest): Promise<GenerateResult> {
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

  async generateStream(req: GenerateRequest, cb: StreamCallbacks): Promise<void> {
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

  async executeTurn(worker: CodexAppServerWorker, req: GenerateRequest): Promise<GenerateResult> {
    const turnReq: TurnRequest = {
      input: req.input,
      developerInstructions: req.systemPrompt,
      outputSchema: req.outputSchema,
      effort: req.effort ?? DEFAULT_EFFORT,
      model: req.model,
      history: req.history,
      verbosity: req.verbosity,
      reasoningSummary: req.reasoningSummary,
      serviceTier: req.serviceTier,
    };
    const result: TurnResult = await worker.executeTurn(turnReq);
    return {
      text: result.text,
      tokenName: worker.tokenName,
      usage: result.usage,
      durationMs: result.durationMs,
      model: result.model,
    };
  }

  async executeStreamTurn(
    worker: CodexAppServerWorker,
    req: GenerateRequest,
    cb: StreamCallbacks,
  ): Promise<void> {
    const turnReq: TurnRequest = {
      input: req.input,
      developerInstructions: req.systemPrompt,
      outputSchema: req.outputSchema,
      effort: req.effort ?? DEFAULT_EFFORT,
      model: req.model,
      history: req.history,
      verbosity: req.verbosity,
      reasoningSummary: req.reasoningSummary,
      serviceTier: req.serviceTier,
    };
    const wrappedCb: StreamCallbacks = {
      ...cb,
      onComplete: (result) => {
        cb.onComplete({ ...result, tokenName: worker.tokenName } as TurnResult & {
          tokenName: string;
        });
      },
    };
    await worker.executeTurnStream(turnReq, wrappedCb);
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
    if (workers.length > 0) {
      this.workerPool.set(tokenId, workers);
      logger.info(`${workers.length}/${WORKERS_PER_TOKEN} workers spawned for ${tokenName}`);
    }
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
      logger.info(`worker spawned: ${tokenName}[${workerIndex}] (id=${tokenId + 1})`);
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
