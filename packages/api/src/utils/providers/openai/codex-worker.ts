import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getLogger } from "@logtape/logtape";

import {
  CODEX_IMAGE_GENERATION_MODEL,
  resolveImageGenerationOptions,
} from "../../../application/qgrid/qgrid-image-generation";
import { type ImageGenerationOptions } from "../../../application/qgrid/qgrid.types";
import { type Model } from "../../../codex-protocol/v2/Model";
import { type ModelListResponse } from "../../../codex-protocol/v2/ModelListResponse";
import { type ModelProviderCapabilitiesReadResponse } from "../../../codex-protocol/v2/ModelProviderCapabilitiesReadResponse";
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
  // 이 turn 에서 codex 내장 image_generation tool 을 켠다.
  // thread 단위로만 활성화되며(전역 config 는 image_generation=false 유지),
  // 플래그 없는 요청은 tool 구성이 현행과 동일하다.
  imageGeneration?: boolean;
  imageGenerationOptions?: ImageGenerationOptions;
}

// 한 turn 에서 생성된 이미지 하나. codex imageGeneration item 에서 파생.
export interface TurnImage {
  data: string; // base64 image payload (item.result)
  revisedPrompt: string | null;
}

export interface TurnResult {
  text: string;
  usage: TokenUsageBreakdown;
  durationMs: number;
  ttftMs: number | null;
  model: string;
  // 이미지 turn 에서만 채워짐. 완성 이미지가 없으면 빈 배열/undefined.
  images?: TurnImage[];
  // 이미지 tool 호출이 관측됐는지(item/started 또는 hasResult 있는 completed).
  // 이미지 0개일 때 재시도 가능 실패("시도 후 미완성")와 재시도 무익("tool 미호출")을 구분.
  imageAttempted?: boolean;
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

// 이미지 생성 thread 전용 instruction. 기본 BASE_INSTRUCTIONS 의 "text only" 지시가
// 실질 억제기이므로(codex image_generation feature 는 default-on), 이미지 모드에서는
// image_generation tool 사용을 명시적으로 허용한다. shell/web 등 나머지 tool 은 여전히 금지.
const IMAGE_BASE_INSTRUCTIONS =
  "You are a helpful assistant. When asked to create an image, use the image_generation tool to produce it. Do not use any other tools such as shell, file operations, or web search.";

function imageBaseInstructions(options: ImageGenerationOptions | undefined): string {
  const resolved = resolveImageGenerationOptions(options);
  return `${IMAGE_BASE_INSTRUCTIONS} Requested image output: model ${CODEX_IMAGE_GENERATION_MODEL}, quality ${resolved.quality}, size ${resolved.size}, format png.`;
}

// 실측상 완료 item 의 status 는 "generating" 으로 와도 result 에 완성 base64 가 실린다.
// 따라서 완성 판정은 status 문자열이 아니라 result 의 유효성(비어있지 않고 표준 base64 인지)으로 한다.
function isCompletedImageResult(result: unknown): result is string {
  if (typeof result !== "string") return false;
  const trimmed = result.trim();
  if (trimmed.length === 0 || trimmed.startsWith("data:")) return false;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed) || trimmed.length % 4 !== 0) return false;
  return true;
}

// codex가 매 요청에 자동 주입하는 내장 tool(shell/web_search/spawn_agent 등 14개)과
// instruction 블록(permissions/environment_context/skills, ~10KB)을 비활성화
// $CODEX_HOME/config.toml 로 써넣으면 codex 부팅 시 scan
// 통제불가: update_plan/request_user_input
export const CODEX_CONFIG_TOML = `web_search = "disabled"
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

[skills.bundled]
enabled = false
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
  // 이미지 게이트 검증용 캐시. spawn 단위로 무효화(restart 시 clear).
  // capability 는 provider 단위 boolean, 모델 멀티모달 여부는 model/list 로 확인.
  private cachedCapabilities?: ModelProviderCapabilitiesReadResponse;
  private cachedModels?: Map<string, Model>;

  constructor(private config: WorkerConfig) {
    const suffix = config.workerIndex !== undefined ? `-${config.workerIndex}` : "";
    this.codexHome = join(tmpdir(), "qgrid-codex", `${config.tokenId}${suffix}`);
  }

  // ── Lifecycle ───────────────────────────────────────────────────

  private async spawnAndInit(): Promise<void> {
    // 새 codex 프로세스 → 기존 ephemeral thread 전부 무효. epoch 증가로 stale 감지.
    this.epochCounter++;
    this.threadMeta.clear();
    // 새 프로세스 → capability/model 캐시 무효(로그인 계정/버전이 바뀌었을 수 있음).
    this.cachedCapabilities = undefined;
    this.cachedModels = undefined;
    const cwd = `${this.codexHome}/cwd`;
    rmSync(this.codexHome, { recursive: true, force: true });
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

  // ── Image generation gate ───────────────────────────────────────
  // 이미지 tool 은 codex 에서 (AuthMode::Chatgpt) AND (image_generation feature)
  // AND (모델 멀티모달) 3중 게이트다. qgrid 는 OAuth 전용이고 feature 는 thread 에서
  // 켜므로, dispatcher 가 사전 검증할 남은 조건은 capability(provider) + 모델 멀티모달이다.

  private async loadCapabilities(): Promise<ModelProviderCapabilitiesReadResponse> {
    if (!this.rpc || !this.ready) throw new Error("worker not ready");
    if (!this.cachedCapabilities) {
      this.cachedCapabilities = await this.rpc.request<ModelProviderCapabilitiesReadResponse>(
        "modelProvider/capabilities/read",
        {},
      );
    }
    return this.cachedCapabilities;
  }

  private async loadModels(): Promise<Map<string, Model>> {
    if (!this.rpc || !this.ready) throw new Error("worker not ready");
    if (!this.cachedModels) {
      const res = await this.rpc.request<ModelListResponse>("model/list", {});
      this.cachedModels = new Map(res.data.map((m) => [m.model, m]));
    }
    return this.cachedModels;
  }

  // 주어진 모델(미지정이면 thread 기본 모델)로 이미지 생성이 가능한지 검증.
  // 불가 사유를 문자열로 반환하고, 가능하면 null 을 반환한다.
  async checkImageGenerationSupport(model?: string): Promise<string | null> {
    if (!this.rpc || !this.ready) return "worker not ready";
    const caps = await this.loadCapabilities();
    if (!caps.imageGeneration) return "provider does not support image generation";
    // 모델 멀티모달 검증. model 미지정이면 provider capability 만으로 통과시키고,
    // 실제 적용 모델의 멀티모달 여부는 turn 실행 결과(이미지 0개 → U3 실패 분류)가 잡는다.
    if (model) {
      const models = await this.loadModels();
      const info = models.get(model);
      if (info && !info.inputModalities.includes("image")) {
        return `model ${model} is not multimodal (no image input modality)`;
      }
    }
    return null;
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
      // 이미지 모드: thread 단위로만 image_generation feature 를 켠다.
      // 전역 config.toml 은 image_generation=false 유지(텍스트 thread 이중 차단),
      // dotted CLI-스타일 override 키로 이 thread 에서만 활성화(실측 확인).
      ...(req.imageGeneration ? { "features.image_generation": true } : {}),
    };
    const { thread, model: threadModel } = await this.rpc.request<ThreadStartResponse>(
      "thread/start",
      {
        ephemeral: true,
        cwd: `${this.codexHome}/cwd`,
        baseInstructions: req.imageGeneration
          ? imageBaseInstructions(req.imageGenerationOptions)
          : BASE_INSTRUCTIONS,
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
    // 이미지 turn 은 재사용에서 제외(R8): base64 가 thread 메모리·캐시 prefix 에
    // 상주하는 것을 막고, 이미지 thread 를 1 회용으로 둔다. threadMeta 미등록 →
    // 후속 reuse 조회에서 이 thread 는 후보가 되지 않는다.
    if (!req.imageGeneration) {
      this.threadMeta.set(threadId, { lastUsedAt: Date.now() });
    }

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
      const result = await resultPromise;
      return { ...result, threadId };
    } catch (e) {
      this.failActiveTurn(e as Error);
      await resultPromise.catch(() => {});
      throw e;
    } finally {
      // 이미지 thread 는 1 회용 cold thread 인데 threadMeta 에 등록되지 않아
      // sweep 이 못 잡는다. MB 급 base64 가 상주하므로 turn 종료 즉시(성공/실패
      // 불문) 구독을 끊어 codex 30분 언로드 대상으로 만든다.
      if (req.imageGeneration) this.unsubscribeThread(threadId);
    }
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
  // 맵 제거(재사용 라우팅 차단)와 함께 thread/unsubscribe 를 보낸다 — codex 는
  // "구독자 0 + idle" 이 30분(THREAD_UNLOADING_DELAY, 하드코딩) 지속된 thread 를
  // 메모리에서 자동 언로드하는데, thread/start 가 이 커넥션을 자동 구독자로 등록해
  // 두기 때문에 unsubscribe 없이는 그 언로드가 영원히 발동하지 않는다(SON-516 실증).
  sweepIdleThreads(): void {
    const now = Date.now();
    for (const [id, meta] of this.threadMeta) {
      if (now - meta.lastUsedAt > CodexAppServerWorker.THREAD_IDLE_TTL_MS) {
        this.evictThread(id);
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
      for (let i = 0; i < over; i++) this.evictThread(sorted[i]![0]);
    }
  }

  // thread 재사용 포기: 맵 제거(라우팅 차단)와 구독 해제를 한 단위로 묶는다.
  // unsubscribe 한 thread 에 turn 을 보내면 알림이 이 커넥션으로 오지 않으므로
  // 두 동작은 반드시 함께여야 한다.
  private evictThread(threadId: string): void {
    this.threadMeta.delete(threadId);
    this.unsubscribeThread(threadId);
  }

  // 재사용을 포기한 thread 의 구독을 끊는다. 구독자가 없어진 idle thread 는 codex 가
  // 30분 뒤 메모리에서 자동 언로드한다(SON-516 실증). fire-and-forget: 실패해도
  // 무해(restart 시 프로세스째 회수). threadMeta 에 없는 이미지 1회용 thread 는
  // evictThread 대신 이 메서드를 직접 호출한다.
  private unsubscribeThread(threadId: string): void {
    this.rpc?.request("thread/unsubscribe", { threadId }).catch(() => {});
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

  private cleanupGeneratedImages(): void {
    try {
      rmSync(`${this.codexHome}/generated_images`, { recursive: true, force: true });
    } catch {}
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
      const images = new Map<string, TurnImage>(); // item.id → 이미지 (dedup)
      let imageAttempted = false;

      const cleanup = () => {
        clearTimeout(timeout);
        if (this.activeTurnAbort === abort) this.activeTurnAbort = undefined;
        for (const n of [
          "item/started",
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
        if (result.imageAttempted) this.cleanupGeneratedImages();
        resolve(result);
      };

      abort = finishWithError;
      this.activeTurnAbort = abort;

      // 이미지 tool 호출 관측(재시도 판정용). started 는 result 없이 오므로
      // attempted 신호로만 쓰고, 완성 이미지는 completed 에서 result 유효성으로 판정한다.
      this.rpc!.onNotification("item/started", (p) => {
        if (p.threadId !== threadId) return;
        if (p.item.type === "imageGeneration") imageAttempted = true;
      });

      this.rpc!.onNotification("item/completed", (p) => {
        if (p.threadId !== threadId) return;
        if (p.item.type === "agentMessage") {
          text = p.item.text;
        } else if (p.item.type === "imageGeneration") {
          imageAttempted = true;
          if (isCompletedImageResult(p.item.result)) {
            images.set(p.item.id, { data: p.item.result, revisedPrompt: p.item.revisedPrompt });
          }
        }
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
          finishWithResult({
            text,
            usage,
            durationMs,
            ttftMs: ttftTracker.value(),
            model,
            images: images.size > 0 ? [...images.values()] : undefined,
            imageAttempted,
          });
        } else {
          // turn 실패/중단 시 부분 이미지는 폐기(성공으로 승격하지 않음).
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
      const images = new Map<string, TurnImage>(); // item.id → 이미지 (dedup)
      let imageAttempted = false;

      const cleanup = () => {
        clearTimeout(timeout);
        if (this.activeTurnAbort === abort) this.activeTurnAbort = undefined;
        for (const n of [
          "item/started",
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
        try {
          cb.onError(error);
          reject(error);
        } catch (callbackError) {
          reject(callbackError);
        }
      };

      const finishWithComplete = (result: TurnResult) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (result.imageAttempted) this.cleanupGeneratedImages();
        try {
          cb.onComplete(result);
          resolve();
        } catch (callbackError) {
          reject(callbackError);
        }
      };

      abort = finishWithError;
      this.activeTurnAbort = abort;

      this.rpc!.onNotification("item/agentMessage/delta", (p) => {
        if (p.threadId !== threadId) return;
        ttftTracker.recordFirstDelta();
        text += p.delta;
        cb.onDelta(p.delta);
      });

      this.rpc!.onNotification("item/started", (p) => {
        if (p.threadId !== threadId) return;
        if (p.item.type === "imageGeneration") imageAttempted = true;
      });

      this.rpc!.onNotification("item/completed", (p) => {
        if (p.threadId !== threadId) return;
        if (p.item.type === "agentMessage") {
          text = p.item.text;
        } else if (p.item.type === "imageGeneration") {
          imageAttempted = true;
          if (isCompletedImageResult(p.item.result)) {
            images.set(p.item.id, { data: p.item.result, revisedPrompt: p.item.revisedPrompt });
          }
        }
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
            images: images.size > 0 ? [...images.values()] : undefined,
            imageAttempted,
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
