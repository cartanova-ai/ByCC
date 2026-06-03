import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import { getLogger } from "@logtape/logtape";

import { type ThreadInjectItemsParams } from "../../../codex-protocol/v2/ThreadInjectItemsParams";
import { type ThreadStartParams } from "../../../codex-protocol/v2/ThreadStartParams";
import { type ThreadStartResponse } from "../../../codex-protocol/v2/ThreadStartResponse";
import { type TokenUsageBreakdown } from "../../../codex-protocol/v2/TokenUsageBreakdown";
import { type TurnStartParams } from "../../../codex-protocol/v2/TurnStartParams";
import { type TurnStartResponse } from "../../../codex-protocol/v2/TurnStartResponse";
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
  workerIndex?: number;
}

export interface TurnRequest {
  input: TurnStartParams["input"];
  outputSchema?: TurnStartParams["outputSchema"];
  effort?: string;
  model?: string;
  developerInstructions?: string;
  history?: ThreadInjectItemsParams["items"];
  verbosity?: string;
  reasoningSummary?: string;
  serviceTier?: string;
}

export interface TurnResult {
  text: string;
  usage: TokenUsageBreakdown;
  durationMs: number;
  model: string;
}

export interface StreamCallbacks {
  onDelta: (text: string) => void;
  onComplete: (result: TurnResult) => void;
  onError: (error: Error) => void;
  onThreadId?: (threadId: string) => void;
  onTurnId?: (turnId: string) => void;
}

// thread/start 공통 옵션
const THREAD_DEFAULTS = {
  sandbox: "read-only",
  approvalPolicy: "never",
  config: {
    apps: { _default: { enabled: false, destructive_enabled: false, open_world_enabled: false } },
  },
} satisfies Partial<ThreadStartParams>;

const BASE_INSTRUCTIONS = {
  text: "You are a helpful assistant. Do not use any tools such as shell, file operations, or web search. Respond with text only.",
  withSchema: "You are a helpful assistant. Respond using the provided output schema.",
} as const;

// codex가 매 요청에 자동 주입하는 내장 tool(shell/web_search/spawn_agent 등 14개)과
// instruction 블록(permissions/environment_context/skills, ~10KB)을 비활성화
// $CODEX_HOME/config.toml 로 써넣으면 codex 부팅 시 scan
// 통제불가: update_plan/request_user_input
const CODEX_CONFIG_TOML = `web_search = "disabled"
include_permissions_instructions = false
include_apps_instructions = false
include_environment_context = false

[features]
shell_tool = false
tool_search = false
tool_suggest = false
multi_agent = false
image_generation = false
apps = false
plugins = false

[tools]
view_image = false

[skills]
include_instructions = false
`;

// ── Worker ──────────────────────────────────────────────────────────

export class CodexAppServerWorker {
  private proc: ChildProcess | null = null;
  private rpc: CodexRpcClient | null = null;
  private codexHome: string;
  private restartAttempts = 0;
  private ready = false;
  private destroyed = false;
  private busy = false;
  active = true;
  onReady?: () => void;
  // restart 시 rpc 객체가 새로 생성되므로, 핸들러를 보관했다가 매 spawn마다 재바인딩한다.
  serverRequestHandler?: (method: string, params: unknown) => Promise<unknown>;

  constructor(private config: WorkerConfig) {
    const suffix = config.workerIndex !== undefined ? `-${config.workerIndex}` : "";
    this.codexHome = `/tmp/qgrid-codex/${config.tokenId}${suffix}`;
  }

  // ── Lifecycle ───────────────────────────────────────────────────

  private async spawnAndInit(): Promise<void> {
    const cwd = `${this.codexHome}/cwd`;
    mkdirSync(cwd, { recursive: true });
    // codex 내장 tool/web_search/instruction 블록 비활성화
    writeFileSync(`${this.codexHome}/config.toml`, CODEX_CONFIG_TOML);

    this.proc = spawn("codex", ["app-server", "--listen", "stdio://"], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd,
      env: {
        PATH: process.env.PATH,
        TMPDIR: process.env.TMPDIR,
        CODEX_HOME: this.codexHome,
        // environment 비활성화 → has_environment=false → shell/apply_patch/view_image 제거
        CODEX_EXEC_SERVER_URL: "none",
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
    // restart 후에도 refresh server-request 핸들러를 유지 (없으면 codex 토큰 회전 실패 → session expired)
    this.bindServerRequestHandler();

    await this.rpc.request("initialize", {
      clientInfo: { name: "qgrid", version: "1.0.0" },
      capabilities: { experimentalApi: true },
    });
  }

  private waitForLoginCompleted(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("login timeout")), 120_000);
      this.rpc!.onNotification("account/login/completed", (p) => {
        clearTimeout(timeout);
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
    const result = await this.rpc!.request<{ authUrl: string }>("account/login/start", {
      type: "chatgpt",
    });
    logger.info(`worker ${this.config.tokenName} browser login started`);
    return result.authUrl;
  }

  async waitForBrowserLoginComplete(): Promise<void> {
    await this.waitForLoginCompleted();
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
      const raw = JSON.parse(readFileSync(`${this.codexHome}/auth.json`, "utf-8"));
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
    } catch {}
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
    this.serverRequestHandler = handler;
    this.bindServerRequestHandler();
  }

  // spawnAndInit에서 rpc 생성 직후 호출. restart로 rpc가 새로 만들어져도 핸들러가 유지된다.
  bindServerRequestHandler(): void {
    const handler = this.serverRequestHandler;
    if (!handler) return;
    this.rpc?.onServerRequest("account/chatgptAuthTokens/refresh", (params) =>
      handler("account/chatgptAuthTokens/refresh", params),
    );
  }

  // ── Turn execution ──────────────────────────────────────────────

  tryAcquireTurn(): boolean {
    if (this.busy) return false;
    this.busy = true;
    return true;
  }
  releaseTurn(): void {
    this.busy = false;
  }
  get hasCapacity(): boolean {
    return !this.busy;
  }

  async startThread(
    req: TurnRequest,
  ): Promise<{ threadId: string; turnId: string; model: string }> {
    if (!this.rpc || !this.ready) throw new Error("worker not ready");

    const threadConfig: ThreadStartParams["config"] = {
      ...THREAD_DEFAULTS.config,
      ...(req.verbosity ? { model_verbosity: req.verbosity } : {}),
    };
    const { thread, model: threadModel } = await this.rpc.request<ThreadStartResponse>(
      "thread/start",
      {
        ephemeral: true,
        cwd: `${this.codexHome}/cwd`,
        baseInstructions: req.outputSchema ? BASE_INSTRUCTIONS.withSchema : BASE_INSTRUCTIONS.text,
        developerInstructions: req.developerInstructions ?? "",
        sandbox: THREAD_DEFAULTS.sandbox,
        approvalPolicy: THREAD_DEFAULTS.approvalPolicy,
        config: threadConfig,
      } satisfies Partial<ThreadStartParams>,
    );

    const threadId = thread.id;
    const model = req.model ?? threadModel;
    if (req.history?.length) {
      await this.rpc.request("thread/inject_items", {
        threadId,
        items: req.history,
      } satisfies ThreadInjectItemsParams);
    }

    const { turn } = await this.rpc.request<TurnStartResponse>("turn/start", {
      threadId,
      input: req.input,
      ...(req.outputSchema ? { outputSchema: req.outputSchema } : {}),
      ...(req.effort ? { effort: req.effort } : {}),
      ...(req.model ? { model: req.model } : {}),
      ...(req.reasoningSummary ? { summary: req.reasoningSummary } : {}),
      ...(req.serviceTier ? { serviceTier: req.serviceTier } : {}),
    });

    return { threadId, turnId: turn.id, model };
  }

  async executeTurn(req: TurnRequest): Promise<TurnResult> {
    const { threadId, model } = await this.startThread(req);
    return this.consumeTurnNotifications(threadId, model);
  }

  async executeTurnStream(req: TurnRequest, cb: StreamCallbacks): Promise<void> {
    const { threadId, turnId, model } = await this.startThread(req);
    cb.onThreadId?.(threadId);
    cb.onTurnId?.(turnId);
    return this.consumeStreamNotifications(threadId, model, cb);
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    if (!this.rpc || !this.ready) return;
    try {
      await this.rpc.request("turn/interrupt", { threadId, turnId });
    } catch {}
  }

  private consumeTurnNotifications(threadId: string, model: string): Promise<TurnResult> {
    return new Promise<TurnResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("turn timeout (600s)"));
      }, 600_000);

      let text = "";
      let usage: TokenUsageBreakdown = {
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        reasoningOutputTokens: 0,
      };
      let durationMs = 0;

      const cleanup = () => {
        clearTimeout(timeout);
        for (const n of [
          "item/completed",
          "item/agentMessage/delta",
          "turn/completed",
          "thread/tokenUsage/updated",
          "error",
        ] as const) {
          this.rpc?.onNotification(n, () => {});
        }
      };

      this.rpc!.onNotification("item/completed", (p) => {
        if (p.threadId !== threadId) return;
        if (p.item.type === "agentMessage") text = p.item.text;
      });

      this.rpc!.onNotification("thread/tokenUsage/updated", (p) => {
        if (p.threadId !== threadId) return;
        usage = p.tokenUsage.total;
      });

      this.rpc!.onNotification("turn/completed", (p) => {
        if (p.threadId !== threadId) return;
        durationMs = p.turn.durationMs ?? 0;
        cleanup();
        if (p.turn.status === "completed") resolve({ text, usage, durationMs, model });
        else reject(new Error(`turn failed: ${JSON.stringify(p.turn.error)}`));
      });

      this.rpc!.onNotification("error", (p) => {
        if (p.threadId !== threadId) return;
        if (!p.willRetry) {
          cleanup();
          reject(new Error(`codex error: ${p.error.message}`));
        }
      });
    });
  }

  private consumeStreamNotifications(
    threadId: string,
    model: string,
    cb: StreamCallbacks,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        cb.onError(new Error("turn timeout (600s)"));
        reject(new Error("turn timeout (600s)"));
      }, 600_000);

      let text = "";
      let usage: TokenUsageBreakdown = {
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        reasoningOutputTokens: 0,
      };

      const cleanup = () => {
        clearTimeout(timeout);
        for (const n of [
          "item/completed",
          "item/agentMessage/delta",
          "turn/completed",
          "thread/tokenUsage/updated",
          "error",
        ] as const) {
          this.rpc?.onNotification(n, () => {});
        }
      };

      this.rpc!.onNotification("item/agentMessage/delta", (p) => {
        if (p.threadId !== threadId) return;
        text += p.delta;
        cb.onDelta(p.delta);
      });

      this.rpc!.onNotification("item/completed", (p) => {
        if (p.threadId !== threadId) return;
        if (p.item.type === "agentMessage") text = p.item.text;
      });

      this.rpc!.onNotification("thread/tokenUsage/updated", (p) => {
        if (p.threadId !== threadId) return;
        usage = p.tokenUsage.total;
      });

      this.rpc!.onNotification("turn/completed", (p) => {
        if (p.threadId !== threadId) return;
        cleanup();
        if (p.turn.status === "completed") {
          cb.onComplete({ text, usage, durationMs: p.turn.durationMs ?? 0, model });
          resolve();
        } else {
          const err = new Error(`turn ${p.turn.status}: ${JSON.stringify(p.turn.error)}`);
          cb.onError(err);
          reject(err);
        }
      });

      this.rpc!.onNotification("error", (p) => {
        if (p.threadId !== threadId) return;
        if (!p.willRetry) {
          cleanup();
          const err = new Error(`codex error: ${p.error.message}`);
          cb.onError(err);
          reject(err);
        }
      });
    });
  }

  // ── Restart ─────────────────────────────────────────────────────

  private scheduleRestart(): void {
    if (this.destroyed || this.restartAttempts >= MAX_RESTART_ATTEMPTS) {
      if (this.restartAttempts >= MAX_RESTART_ATTEMPTS) {
        logger.warn(`worker ${this.config.tokenName} max restart attempts reached`);
      }
      return;
    }

    this.restartAttempts++;
    const baseDelay = RESTART_BACKOFF_BASE_MS * 2 ** (this.restartAttempts - 1);
    const stagger = (this.config.workerIndex ?? 0) * 2_000;
    const delay = baseDelay + stagger;
    logger.info(
      `worker ${this.config.tokenName}[${this.config.workerIndex ?? 0}] restarting in ${delay}ms (attempt ${this.restartAttempts})`,
    );

    setTimeout(() => {
      if (this.destroyed) return;
      this.initialize()
        .then(() => this.onReady?.())
        .catch((e) => {
          logger.warn(`worker ${this.config.tokenName} restart failed: ${(e as Error).message}`);
          this.scheduleRestart();
        });
    }, delay);
  }
}
