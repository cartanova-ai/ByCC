/**
 * OpenAIDispatcher — codex app-server worker pool + 토큰 라우팅.
 *
 * - 토큰당 1 worker (CodexAppServerWorker)
 * - RoundRobinPicker + saturation skip (α 패턴)
 * - TokenSubscriber 이벤트로 worker pool 동기화
 * - backpressure: 503 SERVER_BUSY
 */
import { getLogger } from "@logtape/logtape";

import { TokenModel } from "../../../application/token/token.model";
import { type OpenAICredentials } from "../../../application/token/token.types";
import {
  type GenerateRequest,
  type GenerateResult,
  type ProviderDispatcher,
} from "../common/provider-dispatcher";
import { RoundRobinPicker } from "../common/token-picker";
import { CodexAppServerWorker, type TurnRequest, type TurnResult } from "./codex-worker";
import { handleChatgptAuthTokensRefresh } from "./openai-refresh";

const logger = getLogger(["qgrid", "openai-dispatcher"]);

const DEFAULT_EFFORT = "low";

type WorkerCandidate = { id: number; worker: CodexAppServerWorker };

export class OpenAIDispatcher implements ProviderDispatcher {
  private workerPool = new Map<number, CodexAppServerWorker>();
  private picker = new RoundRobinPicker<WorkerCandidate>();

  async start(): Promise<void> {
    const tokens = await TokenModel.findActiveByProvider("A", "openai");
    logger.info(`starting ${tokens.length} openai workers`);

    await Promise.allSettled(
      tokens.map((t) => this.spawnWorker(t.id, t.name, t.credentials as OpenAICredentials)),
    );
  }

  async stop(): Promise<void> {
    const kills = [...this.workerPool.values()].map((w) => w.kill());
    await Promise.allSettled(kills);
    this.workerPool.clear();
  }

  // ── Token events (from TokenSubscriber) ─────────────────────────

  async onTokenAdded(id: number, name: string, credentials: OpenAICredentials): Promise<void> {
    if (this.workerPool.has(id)) return;
    await this.spawnWorker(id, name, credentials);
  }

  async onTokenRemoved(id: number): Promise<void> {
    const worker = this.workerPool.get(id);
    if (!worker) return;
    await worker.kill();
    this.workerPool.delete(id);
    logger.info(`worker removed: ${worker.tokenName}`);
  }

  async onTokenUpdated(id: number, name: string, credentials: OpenAICredentials): Promise<void> {
    // credentials 변경 시 worker 재시작
    const existing = this.workerPool.get(id);
    if (existing) {
      await existing.kill();
      this.workerPool.delete(id);
    }
    await this.spawnWorker(id, name, credentials);
  }

  // ── Generate ────────────────────────────────────────────────────

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const workers = [...this.workerPool.values()].filter((w) => w.isReady);
    if (workers.length === 0) {
      throw new Error("NO_OPENAI_WORKERS");
    }

    // α pattern: RoundRobin pick → saturation skip
    const candidates = workers.map((w) => ({ id: w.tokenId, worker: w }));
    for (let i = 0; i < candidates.length; i++) {
      const picked = this.picker.pick(candidates);
      if (!picked) break;
      if (picked.worker.tryAcquireTurn()) {
        try {
          return await this.executeTurn(picked.worker, req);
        } finally {
          picked.worker.releaseTurn();
        }
      }
    }

    throw new Error("SERVER_BUSY");
  }

  // ── Internal ────────────────────────────────────────────────────

  private async executeTurn(
    worker: CodexAppServerWorker,
    req: GenerateRequest,
  ): Promise<GenerateResult> {
    const turnReq: TurnRequest = {
      input: req.input,
      developerInstructions: req.systemPrompt,
      outputSchema: req.outputSchema,
      effort: req.effort ?? DEFAULT_EFFORT,
      model: req.model,
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

  private async spawnWorker(
    tokenId: number,
    tokenName: string,
    credentials: OpenAICredentials,
  ): Promise<void> {
    const worker = new CodexAppServerWorker({
      tokenId,
      tokenName,
      accessToken: credentials.accessToken,
      accountId: credentials.accountId,
      planType: credentials.planType,
    });

    worker.setServerRequestHandler(async (method) => {
      if (method === "account/chatgptAuthTokens/refresh") {
        return handleChatgptAuthTokensRefresh(tokenId);
      }
      throw new Error(`unhandled server-request: ${method}`);
    });

    try {
      await worker.initialize();
      this.workerPool.set(tokenId, worker);
      logger.info(`worker spawned: ${tokenName} (id=${tokenId})`);
    } catch (e) {
      logger.warn(`worker spawn failed: ${tokenName}: ${(e as Error).message}`);
      await worker.kill().catch(() => {});
    }
  }

  private rateLimitsCache = new Map<string, { data: unknown; cachedAt: number }>();
  private static readonly RATE_LIMITS_CACHE_TTL = 60_000;

  async getRateLimits(tokenName?: string): Promise<unknown> {
    const cacheKey = tokenName ?? "_default";
    const cached = this.rateLimitsCache.get(cacheKey);
    if (cached && Date.now() - cached.cachedAt < OpenAIDispatcher.RATE_LIMITS_CACHE_TTL) {
      return cached.data;
    }

    const workers = [...this.workerPool.values()].filter((w) => w.isReady);
    const worker = tokenName ? workers.find((w) => w.tokenName === tokenName) : workers[0];
    if (!worker) throw new Error("no ready openai workers");
    const data = await worker.getRateLimits();
    this.rateLimitsCache.set(cacheKey, { data, cachedAt: Date.now() });
    return data;
  }

  // ── Browser login flow ───────────────────────────────────────────

  private pendingLogin: {
    worker: CodexAppServerWorker;
    name: string;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;

  async startBrowserLogin(name: string): Promise<{ authUrl: string }> {
    // 기존 pending 정리
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

    // 5분 후 자동 정리
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

  get workerCount(): number {
    return this.workerPool.size;
  }

  get readyWorkerCount(): number {
    return [...this.workerPool.values()].filter((w) => w.isReady).length;
  }
}
