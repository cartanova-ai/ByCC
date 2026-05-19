/**
 * CodexAppServerWorker — 토큰 1개에 대응하는 codex app-server 프로세스 관리.
 *
 * - spawn + initialize + chatgptAuthTokens login
 * - ephemeral thread 생성 → turn 실행
 * - Semaphore 로 동시성 제한
 * - crash 감지 + auto-restart (exponential backoff, max 3)
 * - CODEX_HOME 격리 + env whitelist
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";

import { getLogger } from "@logtape/logtape";

import { CodexRpcClient } from "./codex-rpc";

const logger = getLogger(["qgrid", "codex-worker"]);

const MAX_RESTART_ATTEMPTS = 3;
const RESTART_BACKOFF_BASE_MS = 1_000;

// ── Types ───────────────────────────────────────────────────────────

export interface WorkerConfig {
  tokenId: number;
  tokenName: string;
  accessToken: string;
  accountId: string;
  planType?: string;
  maxConcurrentTurns?: number;
}

export interface TurnRequest {
  input: Array<{ type: string; text: string }>;
  developerInstructions?: string;
  outputSchema?: unknown;
  effort?: string;
  model?: string;
  history?: unknown[];
}

export interface TurnResult {
  text: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    reasoningOutputTokens: number;
  };
  durationMs: number;
  model: string;
}

// ── Semaphore ───────────────────────────────────────────────────────

class Semaphore {
  private current = 0;

  constructor(private max: number) {}

  tryAcquire(): boolean {
    if (this.current < this.max) {
      this.current++;
      return true;
    }
    return false;
  }

  release(): void {
    this.current--;
  }

  get available(): boolean {
    return this.current < this.max;
  }
}

// ── Worker ──────────────────────────────────────────────────────────

export class CodexAppServerWorker {
  private proc: ChildProcess | null = null;
  private rpc: CodexRpcClient | null = null;
  private turnLimiter: Semaphore;
  private codexHome: string;
  private restartAttempts = 0;
  private ready = false;
  private destroyed = false;
  active = true;

  constructor(private config: WorkerConfig) {
    this.turnLimiter = new Semaphore(config.maxConcurrentTurns ?? 1);
    this.codexHome = `/tmp/qgrid-codex/${config.tokenId}`;
  }

  // ── Lifecycle ───────────────────────────────────────────────────

  private async spawnAndInit(): Promise<void> {
    mkdirSync(this.codexHome, { recursive: true });

    const isolatedCwd = `${this.codexHome}/cwd`;
    mkdirSync(isolatedCwd, { recursive: true });

    this.proc = spawn("codex", ["app-server", "--listen", "stdio://"], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: isolatedCwd,
      env: {
        PATH: process.env.PATH,
        TMPDIR: process.env.TMPDIR,
        CODEX_HOME: this.codexHome,
      },
    });

    this.proc.on("exit", (code) => {
      logger.info(`worker ${this.config.tokenName} exited (code=${code})`);
      this.ready = false;
      this.rpc = null;
      this.proc = null;
      if (!this.destroyed) this.scheduleRestart();
    });

    this.rpc = new CodexRpcClient(this.proc);

    await this.rpc.request("initialize", {
      clientInfo: { name: "qgrid", version: "1.0.0" },
      capabilities: { experimentalApi: true },
    });
  }

  private async waitForLoginCompleted(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("login timeout")), 120_000);
      this.rpc!.onNotification("account/login/completed", (params) => {
        clearTimeout(timeout);
        const p = params as { success: boolean; error?: string };
        if (p.success) resolve();
        else reject(new Error(`login failed: ${p.error ?? "unknown"}`));
      });
    });
  }

  async initialize(): Promise<void> {
    await this.spawnAndInit();

    await this.rpc!.request("account/login/start", {
      type: "chatgptAuthTokens",
      accessToken: this.config.accessToken,
      chatgptAccountId: this.config.accountId,
      ...(this.config.planType ? { chatgptPlanType: this.config.planType } : {}),
    });

    await this.waitForLoginCompleted();
    this.ready = true;
    this.restartAttempts = 0;
    logger.info(`worker ${this.config.tokenName} ready`);
  }

  async startBrowserLogin(): Promise<string> {
    await this.spawnAndInit();

    const result = await this.rpc!.request<{ authUrl: string; loginId: string }>(
      "account/login/start",
      { type: "chatgpt" },
    );

    logger.info(
      `worker ${this.config.tokenName} browser login started: ${result.authUrl.slice(0, 60)}...`,
    );
    return result.authUrl;
  }

  async waitForBrowserLoginComplete(): Promise<void> {
    await this.waitForLoginCompleted();

    // codex managed 모드에서 auth.json 에 토큰 저장됨 → 읽어서 credentials 반환
    this.ready = true;
    this.restartAttempts = 0;
    logger.info(`worker ${this.config.tokenName} browser login completed`);
  }

  async readManagedCredentials(): Promise<{
    accessToken: string;
    refreshToken: string;
    idToken?: string;
    accountId: string;
  } | null> {
    try {
      const authPath = `${this.codexHome}/auth.json`;
      const raw = JSON.parse(readFileSync(authPath, "utf-8"));
      return {
        accessToken: raw.tokens?.access_token ?? "",
        refreshToken: raw.tokens?.refresh_token ?? "",
        idToken: raw.tokens?.id_token,
        accountId: raw.tokens?.account_id ?? "",
      };
    } catch {
      return null;
    }
  }

  async kill(): Promise<void> {
    this.destroyed = true;
    this.ready = false;
    this.rpc?.destroy();

    if (this.proc) {
      this.proc.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.proc?.kill("SIGKILL");
          resolve();
        }, 3_000);
        this.proc!.on("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }

    try {
      rmSync(this.codexHome, { recursive: true, force: true });
    } catch {
      // best effort cleanup
    }
  }

  get isReady(): boolean {
    return this.ready && !this.destroyed;
  }

  get isDestroyed(): boolean {
    return this.destroyed;
  }

  get tokenId(): number {
    return this.config.tokenId;
  }

  get tokenName(): string {
    return this.config.tokenName;
  }

  // ── Rate limits ─────────────────────────────────────────────────

  async getRateLimits(): Promise<unknown> {
    if (!this.rpc || !this.ready) throw new Error("worker not ready");
    return this.rpc.request("account/rateLimits/read", {});
  }

  // ── Server-request delegation ───────────────────────────────────

  setServerRequestHandler(handler: (method: string, params: unknown) => Promise<unknown>): void {
    if (this.rpc) {
      this.rpc.onServerRequest("account/chatgptAuthTokens/refresh", (params) =>
        handler("account/chatgptAuthTokens/refresh", params),
      );
    }
  }

  // ── Turn execution ──────────────────────────────────────────────

  tryAcquireTurn(): boolean {
    return this.turnLimiter.tryAcquire();
  }

  releaseTurn(): void {
    this.turnLimiter.release();
  }

  get hasCapacity(): boolean {
    return this.turnLimiter.available;
  }

  // NOTE: notification handlers are per-method singletons (Map.set overwrites).
  // This is safe ONLY when maxConcurrentTurns=1. If increased, handlers must be
  // multiplexed by threadId to avoid one turn's handlers overwriting another's.
  async executeTurn(req: TurnRequest): Promise<TurnResult> {
    if (!this.rpc || !this.ready) throw new Error("worker not ready");

    // thread/start
    const threadResult = await this.rpc.request<{
      thread: { id: string };
      model: string;
    }>("thread/start", {
      ephemeral: true,
      cwd: `${this.codexHome}/cwd`,
      baseInstructions: req.outputSchema
        ? "You are a helpful assistant. Respond using the provided output schema."
        : "You are a helpful assistant. Do not use any tools such as shell, file operations, or web search. Respond with text only.",
      developerInstructions: req.developerInstructions ?? "",
      sandbox: "read-only",
      approvalPolicy: "never",
      experimentalRawEvents: false,
      persistExtendedHistory: false,
      config: {
        apps: {
          _default: { enabled: false, destructive_enabled: false, open_world_enabled: false },
        },
      },
    });

    const threadId = threadResult.thread.id;
    const model = req.model ?? threadResult.model;

    if (req.history && req.history.length > 0) {
      await this.rpc.request("thread/inject_items", {
        threadId,
        items: req.history,
      });
    }

    await this.rpc.request("turn/start", {
      threadId,
      input: req.input,
      ...(req.outputSchema ? { outputSchema: req.outputSchema } : {}),
      ...(req.effort ? { effort: req.effort } : {}),
      ...(req.model ? { model: req.model } : {}),
    });

    // consume notifications until turn/completed
    return new Promise<TurnResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("turn timeout (600s)"));
        cleanup();
      }, 600_000);

      let text = "";
      let usage = {
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        reasoningOutputTokens: 0,
      };
      let durationMs = 0;

      const cleanup = () => {
        clearTimeout(timeout);
        this.rpc?.onNotification("item/completed", () => {});
        this.rpc?.onNotification("item/agentMessage/delta", () => {});
        this.rpc?.onNotification("turn/completed", () => {});
        this.rpc?.onNotification("thread/tokenUsage/updated", () => {});
        this.rpc?.onNotification("error", () => {});
      };

      this.rpc!.onNotification("item/completed", (params) => {
        const p = params as { item: { type: string; text?: string }; threadId: string };
        if (p.threadId !== threadId) return;
        if (p.item.type === "agentMessage" && p.item.text) {
          text = p.item.text;
        }
      });

      this.rpc!.onNotification("thread/tokenUsage/updated", (params) => {
        const p = params as {
          threadId: string;
          tokenUsage: {
            total: {
              inputTokens: number;
              outputTokens: number;
              cachedInputTokens: number;
              reasoningOutputTokens: number;
            };
          };
        };
        if (p.threadId !== threadId) return;
        usage = p.tokenUsage.total;
      });

      this.rpc!.onNotification("turn/completed", (params) => {
        const p = params as {
          threadId: string;
          turn: { durationMs: number; status: string; error?: unknown };
        };
        if (p.threadId !== threadId) return;
        durationMs = p.turn.durationMs;

        cleanup();

        if (p.turn.status === "completed") {
          resolve({ text, usage, durationMs, model });
        } else {
          reject(new Error(`turn failed: ${JSON.stringify(p.turn.error)}`));
        }
      });

      this.rpc!.onNotification("error", (params) => {
        const p = params as { threadId: string; error: { message: string }; willRetry: boolean };
        if (p.threadId !== threadId) return;
        if (!p.willRetry) {
          cleanup();
          reject(new Error(`codex error: ${p.error.message}`));
        }
      });
    });
  }

  // ── Restart ─────────────────────────────────────────────────────

  private scheduleRestart(): void {
    if (this.destroyed) return;
    if (this.restartAttempts >= MAX_RESTART_ATTEMPTS) {
      logger.warn(`worker ${this.config.tokenName} max restart attempts reached`);
      return;
    }

    this.restartAttempts++;
    const delay = RESTART_BACKOFF_BASE_MS * 2 ** (this.restartAttempts - 1);
    logger.info(
      `worker ${this.config.tokenName} restarting in ${delay}ms (attempt ${this.restartAttempts})`,
    );

    setTimeout(() => {
      if (this.destroyed) return;
      this.initialize().catch((e) => {
        logger.warn(`worker ${this.config.tokenName} restart failed: ${(e as Error).message}`);
        this.scheduleRestart();
      });
    }, delay);
  }
}
