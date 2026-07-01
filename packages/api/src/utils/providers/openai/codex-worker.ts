import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import { getLogger } from "@logtape/logtape";

import { type ThreadInjectItemsParams } from "../../../codex-protocol/v2/ThreadInjectItemsParams";
import { type ThreadStartParams } from "../../../codex-protocol/v2/ThreadStartParams";
import { type ThreadStartResponse } from "../../../codex-protocol/v2/ThreadStartResponse";
import { type TokenUsageBreakdown } from "../../../codex-protocol/v2/TokenUsageBreakdown";
import { type TurnStartParams } from "../../../codex-protocol/v2/TurnStartParams";
import { type TurnStartResponse } from "../../../codex-protocol/v2/TurnStartResponse";
import { type StreamCallbacks as CommonStreamCallbacks } from "../common/provider-dispatcher";
import { createTtftTracker } from "../common/ttft";
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
  ttftMs: number | null;
  model: string;
}

export type StreamCallbacks = CommonStreamCallbacks<TurnResult>;

type RefreshableWorkerCredentials = Pick<WorkerConfig, "accessToken" | "accountId" | "planType">;
type ActiveTurnAbort = (error: Error) => void;

// thread/start 공통 옵션
const THREAD_DEFAULTS = {
  sandbox: "read-only",
  approvalPolicy: "never",
  config: {
    apps: { _default: { enabled: false, destructive_enabled: false, open_world_enabled: false } },
  },
} satisfies Partial<ThreadStartParams>;

const BASE_INSTRUCTIONS =
  "You are a helpful assistant. Do not use any tools such as shell, file operations, or web search. Respond with text only.";

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
  private activeTurnAbort?: ActiveTurnAbort;
  active = true;
  onReady?: () => void;
  // restart 시 rpc 객체가 새로 생성되므로, 핸들러를 보관했다가 매 spawn마다 재바인딩한다.
  serverRequestHandler?: (method: string, params: unknown) => Promise<unknown>;

  // thread 재사용(prompt cache): worker 가 생성한 thread 들의 메타.
  // ephemeral thread 는 이 프로세스 메모리에만 존재하므로 restart 시 전부 무효.
  private threadMeta = new Map<string, { lastUsedAt: number }>();
  // spawn 카운터. restart 마다 증가 → conv 핸들의 epoch 와 대조해 stale thread 감지.
  private epochCounter = 0;
  private static readonly THREAD_IDLE_TTL_MS = 10 * 60_000;
  private static readonly MAX_THREADS_PER_WORKER = 16;

  constructor(private config: WorkerConfig) {
    const suffix = config.workerIndex !== undefined ? `-${config.workerIndex}` : "";
    this.codexHome = `/tmp/qgrid-codex/${config.tokenId}${suffix}`;
  }

  // ── Lifecycle ───────────────────────────────────────────────────

  private async spawnAndInit(): Promise<void> {
    // 새 codex 프로세스 → 기존 ephemeral thread 전부 무효. epoch 증가로 stale 감지.
    this.epochCounter++;
    this.threadMeta.clear();
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
      this.failActiveTurn(
        new Error(`codex worker exited while turn was running (code=${code ?? "unknown"})`),
      );
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
    this.failActiveTurn(new Error("codex worker stopped"));
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
  get workerIndex(): number {
    return this.config.workerIndex ?? 0;
  }
  get tokenName(): string {
    return this.config.tokenName;
  }

  canReuseForToken(_tokenName: string, credentials: RefreshableWorkerCredentials): boolean {
    return (
      this.config.accountId === credentials.accountId &&
      (this.config.planType ?? undefined) === (credentials.planType ?? undefined)
    );
  }

  updateTokenState(tokenName: string, credentials: RefreshableWorkerCredentials): void {
    this.config.tokenName = tokenName;
    this.config.accessToken = credentials.accessToken;
    this.config.accountId = credentials.accountId;
    if (credentials.planType) {
      this.config.planType = credentials.planType;
    } else {
      delete this.config.planType;
    }
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

  // 새 thread 생성 (thread/start + 필요 시 history inject). 첫 turn / 폴백 경로용.
  // 후속 turn 은 createThread 없이 startTurnOnThread 만 호출해 conversation_id 를 고정한다.
  // thread 의 기본 model 도 반환 (req.model 미지정 시 fallback).
  async createThread(req: TurnRequest): Promise<{ threadId: string; model: string }> {
    if (!this.rpc || !this.ready) throw new Error("worker not ready");
    this.sweepIdleThreads();

    const threadConfig: ThreadStartParams["config"] = {
      ...THREAD_DEFAULTS.config,
      ...(req.verbosity ? { model_verbosity: req.verbosity } : {}),
    };
    const { thread, model: threadModel } = await this.rpc.request<ThreadStartResponse>(
      "thread/start",
      {
        ephemeral: true,
        cwd: `${this.codexHome}/cwd`,
        baseInstructions: BASE_INSTRUCTIONS,
        developerInstructions: req.developerInstructions ?? "",
        sandbox: THREAD_DEFAULTS.sandbox,
        approvalPolicy: THREAD_DEFAULTS.approvalPolicy,
        config: threadConfig,
      } satisfies Partial<ThreadStartParams>,
    );

    const threadId = thread.id;
    if (req.history?.length) {
      await this.rpc.request("thread/inject_items", {
        threadId,
        items: req.history,
      } satisfies ThreadInjectItemsParams);
    }
    this.threadMeta.set(threadId, { lastUsedAt: Date.now() });

    return { threadId, model: req.model ?? threadModel };
  }

  // 기존 thread 에 turn 만 실행 (inject 없음). conversation_id 유지 → prompt cache 적중.
  private async startTurnOnThread(threadId: string, req: TurnRequest): Promise<{ turnId: string }> {
    if (!this.rpc || !this.ready) throw new Error("worker not ready");

    const { turn } = await this.rpc.request<TurnStartResponse>("turn/start", {
      threadId,
      input: req.input,
      ...(req.outputSchema ? { outputSchema: req.outputSchema } : {}),
      ...(req.effort ? { effort: req.effort } : {}),
      ...(req.model ? { model: req.model } : {}),
      ...(req.reasoningSummary ? { summary: req.reasoningSummary } : {}),
      ...(req.serviceTier ? { serviceTier: req.serviceTier } : {}),
    });
    const meta = this.threadMeta.get(threadId);
    if (meta) meta.lastUsedAt = Date.now();
    return { turnId: turn.id };
  }

  // existingThreadId 있으면 그 thread 재사용(후속 turn), 없으면 새 thread 생성(첫 turn).
  // 호출 후 사용한 threadId 를 반환해 dispatcher 가 conv 핸들을 발급한다.
  async executeTurn(
    req: TurnRequest,
    existingThreadId?: string,
  ): Promise<TurnResult & { threadId: string }> {
    let threadId: string;
    let model: string;
    if (existingThreadId) {
      threadId = existingThreadId;
      model = req.model ?? "";
    } else {
      ({ threadId, model } = await this.createThread(req));
    }
    const ttftTracker = createTtftTracker();
    const resultPromise = this.consumeTurnNotifications(threadId, model, ttftTracker);
    try {
      ttftTracker.markStart();
      await this.startTurnOnThread(threadId, req);
    } catch (e) {
      this.failActiveTurn(e as Error);
      await resultPromise.catch(() => {});
      throw e;
    }
    const result = await resultPromise;
    return { ...result, threadId };
  }

  async executeTurnStream(
    req: TurnRequest,
    cb: StreamCallbacks,
    existingThreadId?: string,
  ): Promise<{ threadId: string }> {
    let threadId: string;
    let model: string;
    if (existingThreadId) {
      threadId = existingThreadId;
      model = req.model ?? "";
    } else {
      ({ threadId, model } = await this.createThread(req));
    }
    cb.onThreadId?.(threadId);
    const ttftTracker = createTtftTracker();
    const resultPromise = this.consumeStreamNotifications(threadId, model, cb, ttftTracker);
    let turnId: string;
    try {
      ttftTracker.markStart();
      ({ turnId } = await this.startTurnOnThread(threadId, req));
    } catch (e) {
      this.failActiveTurn(e as Error);
      await resultPromise.catch(() => {});
      throw e;
    }
    cb.onTurnId?.(turnId);
    await resultPromise;
    return { threadId };
  }

  // ── thread 재사용 지원 ───────────────────────────────────────────

  get epoch(): number {
    return this.epochCounter;
  }

  hasThread(threadId: string): boolean {
    return this.threadMeta.has(threadId);
  }

  // idle TTL 초과 / 개수 상한 초과 thread 를 정리. createThread 직전 lazy 호출.
  // codex ephemeral thread 는 명시적 close RPC 없이 맵에서 제거 → 더 이상 turn 안 보냄.
  sweepIdleThreads(): void {
    const now = Date.now();
    for (const [id, meta] of this.threadMeta) {
      if (now - meta.lastUsedAt > CodexAppServerWorker.THREAD_IDLE_TTL_MS) {
        this.threadMeta.delete(id);
      }
    }
    // createThread 직전 호출 → 새 thread 1 개가 곧 추가된다. 추가 후에도 MAX 를 넘지 않도록
    // MAX-1 이하로 줄여 둔다(그래야 생성 직후 정확히 MAX). LRU: lastUsedAt 오름차순으로 제거.
    const limit = CodexAppServerWorker.MAX_THREADS_PER_WORKER - 1;
    if (this.threadMeta.size > limit) {
      const sorted = [...this.threadMeta.entries()].toSorted(
        (a, b) => a[1].lastUsedAt - b[1].lastUsedAt,
      );
      const over = this.threadMeta.size - limit;
      for (let i = 0; i < over; i++) this.threadMeta.delete(sorted[i]![0]);
    }
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    if (!this.rpc || !this.ready) return;
    try {
      await this.rpc.request("turn/interrupt", { threadId, turnId });
    } catch {}
  }

  private failActiveTurn(error: Error): void {
    const abort = this.activeTurnAbort;
    this.activeTurnAbort = undefined;
    abort?.(error);
  }

  private consumeTurnNotifications(
    threadId: string,
    model: string,
    ttftTracker = createTtftTracker(),
  ): Promise<TurnResult> {
    return new Promise<TurnResult>((resolve, reject) => {
      let settled = false;
      let abort: ActiveTurnAbort;
      const timeout = setTimeout(() => {
        finishWithError(new Error("turn timeout (600s)"));
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
        if (this.activeTurnAbort === abort) this.activeTurnAbort = undefined;
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

      const finishWithError = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };

      const finishWithResult = (result: TurnResult) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      };

      abort = finishWithError;
      this.activeTurnAbort = abort;

      this.rpc!.onNotification("item/completed", (p) => {
        if (p.threadId !== threadId) return;
        if (p.item.type === "agentMessage") text = p.item.text;
      });

      this.rpc!.onNotification("item/agentMessage/delta", (p) => {
        if (p.threadId !== threadId) return;
        ttftTracker.recordFirstDelta();
        text += p.delta;
      });

      this.rpc!.onNotification("thread/tokenUsage/updated", (p) => {
        if (p.threadId !== threadId) return;
        // thread 재사용 시 .total 은 대화 전체 누적이라, cold 였던 이전 turn 까지 섞여
        // 이 요청 자체의 cache 적중률이 희석된다(예: turn1 cold 0% + turn2 90% → 48% 로 기록).
        // .last 는 이번 turn 만의 usage 라 request_log 가 그 요청의 실제 토큰을 정확히 반영한다.
        usage = p.tokenUsage.last;
      });

      this.rpc!.onNotification("turn/completed", (p) => {
        if (p.threadId !== threadId) return;
        durationMs = p.turn.durationMs ?? 0;
        if (p.turn.status === "completed") {
          finishWithResult({ text, usage, durationMs, ttftMs: ttftTracker.value(), model });
        } else {
          finishWithError(new Error(`turn failed: ${JSON.stringify(p.turn.error)}`));
        }
      });

      this.rpc!.onNotification("error", (p) => {
        if (p.threadId !== threadId) return;
        if (!p.willRetry) {
          finishWithError(new Error(`codex error: ${p.error.message}`));
        }
      });
    });
  }

  private consumeStreamNotifications(
    threadId: string,
    model: string,
    cb: StreamCallbacks,
    ttftTracker = createTtftTracker(),
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let abort: ActiveTurnAbort;
      const timeout = setTimeout(() => {
        finishWithError(new Error("turn timeout (600s)"));
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
        if (this.activeTurnAbort === abort) this.activeTurnAbort = undefined;
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

      const finishWithError = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        cb.onError(error);
        reject(error);
      };

      const finishWithComplete = (result: TurnResult) => {
        if (settled) return;
        settled = true;
        cleanup();
        cb.onComplete(result);
        resolve();
      };

      abort = finishWithError;
      this.activeTurnAbort = abort;

      this.rpc!.onNotification("item/agentMessage/delta", (p) => {
        if (p.threadId !== threadId) return;
        ttftTracker.recordFirstDelta();
        text += p.delta;
        cb.onDelta(p.delta);
      });

      this.rpc!.onNotification("item/completed", (p) => {
        if (p.threadId !== threadId) return;
        if (p.item.type === "agentMessage") text = p.item.text;
      });

      this.rpc!.onNotification("thread/tokenUsage/updated", (p) => {
        if (p.threadId !== threadId) return;
        // thread 재사용 시 .total 은 대화 전체 누적이라, cold 였던 이전 turn 까지 섞여
        // 이 요청 자체의 cache 적중률이 희석된다(예: turn1 cold 0% + turn2 90% → 48% 로 기록).
        // .last 는 이번 turn 만의 usage 라 request_log 가 그 요청의 실제 토큰을 정확히 반영한다.
        usage = p.tokenUsage.last;
      });

      this.rpc!.onNotification("turn/completed", (p) => {
        if (p.threadId !== threadId) return;
        if (p.turn.status === "completed") {
          finishWithComplete({
            text,
            usage,
            durationMs: p.turn.durationMs ?? 0,
            ttftMs: ttftTracker.value(),
            model,
          });
        } else {
          finishWithError(new Error(`turn ${p.turn.status}: ${JSON.stringify(p.turn.error)}`));
        }
      });

      this.rpc!.onNotification("error", (p) => {
        if (p.threadId !== threadId) return;
        if (!p.willRetry) {
          finishWithError(new Error(`codex error: ${p.error.message}`));
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
