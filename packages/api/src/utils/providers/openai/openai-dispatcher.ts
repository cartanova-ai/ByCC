import { getLogger } from "@logtape/logtape";

import { QuotaThresholdExceededError } from "../../../application/qgrid/qgrid.types";
import { TokenModel } from "../../../application/token/token.model";
import { type OpenAICredentials } from "../../../application/token/token.types";
import { resolveOpenAIEffort } from "../common/effort";
import {
  type GenerateRequest,
  type GenerateResult,
  type GenerateStreamCallbacks,
  type GeneratedImage,
  type ProviderDispatcher,
} from "../common/provider-dispatcher";
import { SmoothWeightedRoundRobin } from "../common/smooth-weighted-round-robin";
import {
  type JsonValue,
  type OpenAIResponseItem,
  type OpenAIResponsesOptions,
} from "./openai-backend-protocol";
import { OpenAIDirectClient, type OpenAIDirectClientOptions } from "./openai-direct-client";
import { readOpenAIQuotaUsage, type OpenAIRateLimitsWithMeta } from "./openai-quota";
import { handleChatgptAuthTokensRefresh } from "./openai-refresh";
import { type OpenAITransportKind, resolveOpenAITransportKind } from "./openai-transport-config";

const logger = getLogger(["qgrid", "openai-dispatcher"]);
// 교체된 codex worker 가 강제하던 watchdog. 호출자가 timeoutMs 를 생략해도 요청이
// 영원히 매달리지 않도록 direct transport 도 유한한 기본 상한을 유지한다.
const DEFAULT_REQUEST_TIMEOUT_MS = 600_000;

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

type TokenMetadata = {
  name: string;
  credentials: OpenAICredentials;
  quotaThreshold?: number | null;
  weight: number;
  active: boolean;
  generation: number;
};

type TokenSelection = { tokenId: number; metadata: TokenMetadata };

export type OpenAIDirectClientFactory = (
  options: OpenAIDirectClientOptions,
  tokenId: number,
) => Pick<OpenAIDirectClient, "responses"> & { close?: () => void };

type ClientEntry = {
  generation: number;
  client: Pick<OpenAIDirectClient, "responses"> & { close?: () => void };
  inFlight: number;
  retired: boolean;
};

export interface OpenAIDispatcherDependencies {
  clientFactory?: OpenAIDirectClientFactory;
  fetch?: typeof fetch;
}

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  return reason instanceof Error ? reason : new DOMException("Aborted", "AbortError");
}

function activeSignal(signal?: AbortSignal, timeoutMs?: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function quotaMessage(entries: Array<{ name: string; threshold: number }>): string {
  const detail = entries.map((e) => `${e.name} (threshold ${e.threshold}%)`).join(", ");
  return detail
    ? `All openai tokens exceeded quota threshold: ${detail}`
    : "All openai tokens exceeded quota threshold";
}

function inputItems(req: GenerateRequest): OpenAIResponseItem[] {
  const history = (req.coldHistory ?? []) as OpenAIResponseItem[];
  const content: OpenAIResponseItem[] = req.coldInput.map((input) => {
    if (input.type === "text") return { type: "input_text", text: input.text };
    if (input.type === "image") return { type: "input_image", image_url: input.url };
    if (input.type === "localImage") return { type: "input_image", image_url: input.path };
    return { type: "input_text", text: `${input.name}: ${input.path}` };
  });
  return [...history, { type: "message", role: "user", content }];
}

function asReasoning(req: GenerateRequest): OpenAIResponsesOptions["reasoning"] | undefined {
  const summary =
    req.reasoningSummary && req.reasoningSummary !== "none" ? req.reasoningSummary : undefined;
  // Codex 어휘·모델 상한 밖의 effort 는 여기서 조용히 버린다(백엔드 기본값 적용).
  const effort = resolveOpenAIEffort(req.model ?? "", req.effort);
  if (!effort && !summary) return undefined;
  return {
    ...(effort ? { effort } : {}),
    ...(summary
      ? {
          summary: summary as NonNullable<OpenAIResponsesOptions["reasoning"]>["summary"],
        }
      : {}),
  };
}

function requestOptions(req: GenerateRequest): OpenAIResponsesOptions {
  return {
    model: req.model ?? "",
    ...(req.systemPrompt ? { instructions: req.systemPrompt } : {}),
    history: inputItems(req),
    ...(asReasoning(req) ? { reasoning: asReasoning(req) } : {}),
    ...(req.verbosity ? { verbosity: req.verbosity as OpenAIResponsesOptions["verbosity"] } : {}),
    ...(req.serviceTier
      ? { serviceTier: req.serviceTier === "fast" ? "priority" : req.serviceTier }
      : {}),
    ...(req.promptCacheKey ? { promptCacheKey: req.promptCacheKey } : {}),
    ...(req.outputSchema ? { outputSchema: { schema: req.outputSchema as JsonValue } } : {}),
    ...(req.imageGeneration
      ? { imageGeneration: req.imageGenerationOptions ? { ...req.imageGenerationOptions } : true }
      : {}),
  };
}

/**
 * Direct OpenAI dispatcher — Anthropic 과 동일한 stateless 실행 모델.
 *
 * 요청 = 토큰 선택(quota gate + weighted round-robin + cache affinity 선호) → HTTPS/WS
 * 전송. permit/큐 같은 동시성 상한은 두지 않는다: 전송은 fetch 한 번이라 로컬 자원이
 * 희소하지 않고, 상류 제한은 백엔드의 응답(429 등)이 진실이다. worker pool 시절의
 * 큐 의미론(SERVER_BUSY, 큐 타임아웃)은 이 전환으로 제거됐다.
 */
export class OpenAIDispatcher implements ProviderDispatcher {
  readonly tokenMetadata = new Map<number, TokenMetadata>();
  readonly transportKind: OpenAITransportKind;
  readonly rateLimitsCache = new Map<number, OpenAIRateLimitsWithMeta & { generation: number }>();
  private readonly pendingRateLimits = new Map<
    number,
    Promise<OpenAIRateLimitsWithMeta & { generation: number }>
  >();
  private readonly clients = new Map<number, ClientEntry>();
  private readonly retiredClients = new Set<ClientEntry>();
  static readonly RATE_LIMITS_CACHE_TTL = 60_000;

  private readonly selector = new SmoothWeightedRoundRobin();
  private readonly clientFactory: OpenAIDirectClientFactory;
  private readonly fetchImpl: typeof fetch;
  private readonly quotaBlocked = new Set<number>();
  private inFlightCount = 0;

  constructor(
    transportKind: OpenAITransportKind = resolveOpenAITransportKind(),
    dependencies: OpenAIDispatcherDependencies = {},
  ) {
    this.transportKind = transportKind;
    this.clientFactory =
      dependencies.clientFactory ?? ((options) => new OpenAIDirectClient(options));
    this.fetchImpl = dependencies.fetch ?? fetch;
  }

  async start(): Promise<void> {
    const { rows } = await TokenModel.findMany("A");
    for (const row of rows) {
      if (row.provider !== "openai") continue;
      this.setToken(
        row.id,
        row.name,
        row.credentials as OpenAICredentials,
        row.quota_threshold,
        row.weight,
        row.active,
      );
    }
    logger.info(`started direct OpenAI runtime with ${this.tokenMetadata.size} tokens`);
  }

  async stop(): Promise<void> {
    for (const { client } of this.clients.values()) client.close?.();
    this.clients.clear();
    for (const entry of this.retiredClients) entry.client.close?.();
    this.retiredClients.clear();
    this.tokenMetadata.clear();
    this.rateLimitsCache.clear();
    this.quotaBlocked.clear();
    this.selector.resetScores();
  }

  async onTokenAdded(
    id: number,
    name: string,
    credentials: OpenAICredentials,
    quotaThreshold?: number | null,
    weight = 1,
  ): Promise<void> {
    this.setToken(id, name, credentials, quotaThreshold, weight, true);
  }

  async onTokenUpdated(
    id: number,
    name: string,
    credentials: OpenAICredentials,
    quotaThreshold?: number | null,
    weight = 1,
  ): Promise<void> {
    const old = this.tokenMetadata.get(id);
    this.setToken(id, name, credentials, quotaThreshold, weight, old?.active ?? true);
  }

  async onTokenRemoved(id: number): Promise<void> {
    this.retireClient(id);
    this.tokenMetadata.delete(id);
    this.selector.removeToken(id);
    this.invalidateRateLimitsCache(id);
    this.quotaBlocked.delete(id);
  }

  onTokenDeactivated(id: number): void {
    const token = this.tokenMetadata.get(id);
    if (token) token.active = false;
    this.selector.resetScores();
  }

  onTokenActivated(id: number): void {
    const token = this.tokenMetadata.get(id);
    if (token) token.active = true;
    this.selector.resetScores();
  }

  async replaceTokens(
    rows: Array<{
      id: number;
      name: string;
      credentials: OpenAICredentials;
      quotaThreshold?: number | null;
      weight: number;
    }>,
  ): Promise<void> {
    const ids = new Set(rows.map((r) => r.id));
    for (const id of this.tokenMetadata.keys()) if (!ids.has(id)) await this.onTokenRemoved(id);
    for (const row of rows)
      await this.onTokenUpdated(row.id, row.name, row.credentials, row.quotaThreshold, row.weight);
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    return this.run(req);
  }

  async generateStream(req: GenerateRequest, cb: GenerateStreamCallbacks): Promise<void> {
    if (req.imageGeneration)
      throw new ImageGenerationError(
        "gate",
        "image generation is not supported on the streaming path",
      );
    try {
      cb.onComplete(await this.run(req, cb.onDelta));
    } catch (error) {
      cb.onError(error as Error);
      throw error;
    }
  }

  // generate/generateStream 공통 실행 — 토큰 선택과 in-flight 집계를 한 곳에 둔다.
  private async run(
    req: GenerateRequest,
    onDelta?: (text: string) => void,
  ): Promise<GenerateResult> {
    const signal = activeSignal(req.abortSignal, req.timeoutMs);
    if (signal.aborted) throw abortError(signal);
    const selection = await this.selectToken(
      req.preferredTokenId,
      req.requirePreferredToken ?? false,
      signal,
    );
    this.inFlightCount++;
    try {
      if (signal.aborted) throw abortError(signal);
      return await this.runDirect(selection, { ...req, abortSignal: signal }, onDelta);
    } finally {
      this.inFlightCount--;
    }
  }

  private async runDirect(
    selection: TokenSelection,
    req: GenerateRequest,
    onDelta?: (text: string) => void,
  ): Promise<GenerateResult> {
    const startedAt = Date.now();
    let firstDeltaAt: number | undefined;
    let text = "";
    let usage = {
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningOutputTokens: 0,
    };
    const images: GeneratedImage[] = [];
    let imageAttempted = false;
    let servingModel = req.model ?? "";
    const metadata = selection.metadata;
    const clientEntry = this.acquireClient(selection);
    try {
      for await (const event of clientEntry.client.responses(
        requestOptions(req),
        req.abortSignal,
      )) {
        if (event.type === "text-delta") {
          firstDeltaAt ??= Date.now();
          text += event.text;
          onDelta?.(event.text);
        } else if (event.type === "image") {
          imageAttempted = true;
          images.push({ data: event.base64, revisedPrompt: event.revisedPrompt ?? null });
        } else if (event.type === "output-item" && event.item.type === "image_generation_call") {
          imageAttempted = true;
        } else if (event.type === "completed" && event.usage) {
          servingModel = event.model ?? servingModel;
          usage = {
            totalTokens: event.usage.totalTokens,
            inputTokens: event.usage.inputTokens,
            outputTokens: event.usage.outputTokens,
            cachedInputTokens: event.usage.cachedInputTokens,
            reasoningOutputTokens: event.usage.reasoningTokens,
          };
        } else if (event.type === "completed") {
          servingModel = event.model ?? servingModel;
        } else if (event.type === "error") {
          if (req.imageGeneration)
            throw new ImageGenerationError("incomplete", event.error.message);
          throw event.error;
        }
      }
    } finally {
      this.releaseClient(clientEntry);
    }
    if (req.imageGeneration && images.length === 0) {
      throw new ImageGenerationError(
        imageAttempted ? "incomplete" : "not_called",
        imageAttempted
          ? "image generation did not complete"
          : "model did not call image generation",
      );
    }
    return {
      text,
      tokenName: metadata.name,
      usage,
      durationMs: Date.now() - startedAt,
      ttftMs: firstDeltaAt === undefined ? null : firstDeltaAt - startedAt,
      model: servingModel,
      threadCoord: { workerId: selection.tokenId, threadId: req.promptCacheKey ?? "", epoch: -1 },
      ...(images.length ? { images } : {}),
    };
  }

  /** 세대가 바뀐 client 는 사용 중인 요청이 끝난 뒤에 닫는다. */
  private acquireClient(selection: TokenSelection): ClientEntry {
    const metadata = selection.metadata;
    let entry = this.clients.get(selection.tokenId);
    if (entry && entry.generation !== metadata.generation) {
      this.retireClient(selection.tokenId);
      entry = undefined;
    }
    if (!entry) {
      const client = this.clientFactory(
        {
          credentials: {
            accessToken: metadata.credentials.accessToken,
            accountId: metadata.credentials.accountId,
          },
          transportKind: this.transportKind,
          fetch: this.fetchImpl,
          refreshCredentials: async () => {
            const refreshed = await handleChatgptAuthTokensRefresh(selection.tokenId);
            const current = this.tokenMetadata.get(selection.tokenId);
            if (current)
              current.credentials = {
                ...current.credentials,
                accessToken: refreshed.accessToken,
                accountId: refreshed.chatgptAccountId,
              };
            return { accessToken: refreshed.accessToken, accountId: refreshed.chatgptAccountId };
          },
        },
        selection.tokenId,
      );
      entry = { generation: metadata.generation, client, inFlight: 0, retired: false };
      this.clients.set(selection.tokenId, entry);
    }
    entry.inFlight++;
    return entry;
  }

  private releaseClient(entry: ClientEntry): void {
    entry.inFlight = Math.max(0, entry.inFlight - 1);
    if (entry.retired && entry.inFlight === 0) {
      this.retiredClients.delete(entry);
      entry.client.close?.();
    }
  }

  /** map 에서 떼어내고, 진행 중인 요청이 없을 때만 즉시 닫는다. */
  private retireClient(tokenId: number): void {
    const entry = this.clients.get(tokenId);
    if (!entry) return;
    this.clients.delete(tokenId);
    entry.retired = true;
    if (entry.inFlight === 0) entry.client.close?.();
    else this.retiredClients.add(entry);
  }

  /**
   * 토큰 선택 — quota gate 를 통과한 active 토큰 중에서 고른다. cache affinity 선호
   * 토큰이 eligible 하면 그 판정만으로 즉시 결정하고(전체 sweep 생략, weighted 상태
   * 비변경), 아니면 병렬 quota 판정 후 smooth weighted round-robin. 동시성 상한이
   * 없으므로 "빈 자리" 개념도 없다 — 선택 즉시 실행이다.
   */
  private async selectToken(
    preferredTokenId: number | undefined,
    requirePreferredToken: boolean,
    signal: AbortSignal,
  ): Promise<TokenSelection> {
    if (preferredTokenId !== undefined) {
      const preferred = this.tokenMetadata.get(preferredTokenId);
      if (preferred?.active && (await this.isQuotaEligible(preferredTokenId, preferred, signal))) {
        return { tokenId: preferredTokenId, metadata: preferred };
      }
      if (requirePreferredToken) {
        if (!preferred?.active) {
          throw new Error(`Preferred openai token ${preferredTokenId} is not available`);
        }
        const threshold = preferred.quotaThreshold;
        if (threshold !== null && threshold !== undefined) {
          throw new QuotaThresholdExceededError(
            quotaMessage([{ name: preferred.name, threshold }]),
          );
        }
      }
    }

    // 토큰별 quota 판정은 서로 독립이라 병렬로 — 직렬 대기는 콜드 캐시에서
    // 토큰 수 × 조회 지연만큼 요청 시작을 늦춘다.
    const checks = await Promise.all(
      [...this.tokenMetadata.entries()]
        .filter(([, token]) => token.active)
        .map(async ([id, token]) => ({
          id,
          token,
          eligible: await this.isQuotaEligible(id, token, signal),
        })),
    );
    const eligible = new Set(checks.filter((c) => c.eligible).map((c) => c.id));
    if (eligible.size === 0) {
      const over = checks
        .filter(
          (c) =>
            !c.eligible && c.token.quotaThreshold !== null && c.token.quotaThreshold !== undefined,
        )
        .map((c) => ({ name: c.token.name, threshold: c.token.quotaThreshold as number }));
      if (over.length) {
        logger.warn("quota_threshold gate: all_exceeded", {
          provider: "openai",
          overThresholdTokens: over,
        });
        throw new QuotaThresholdExceededError(quotaMessage(over));
      }
      throw new Error("NO_OPENAI_WORKERS");
    }
    const selected = this.selector.select(eligible);
    const metadata = selected !== null ? this.tokenMetadata.get(selected) : undefined;
    if (selected === null || !metadata) throw new Error("NO_OPENAI_WORKERS");
    return { tokenId: selected, metadata };
  }

  private setToken(
    id: number,
    name: string,
    credentials: OpenAICredentials,
    quotaThreshold: number | null | undefined,
    weight: number,
    active: boolean,
  ): void {
    const old = this.tokenMetadata.get(id);
    if (old) {
      Object.assign(old, {
        name,
        credentials,
        quotaThreshold,
        weight,
        active,
        generation: old.generation + 1,
      });
    } else {
      this.tokenMetadata.set(id, {
        name,
        credentials,
        quotaThreshold,
        weight,
        active,
        generation: 1,
      });
    }
    this.selector.setToken(id, weight);
    this.invalidateRateLimitsCache(id);
    this.quotaBlocked.delete(id);
  }

  async getRateLimitsByTokenId(
    tokenId: number,
    signal?: AbortSignal,
  ): Promise<OpenAIRateLimitsWithMeta> {
    const token = this.tokenMetadata.get(tokenId);
    if (!token) throw new Error(`openai token ${tokenId} not found`);
    const cached = this.rateLimitsCache.get(tokenId);
    if (
      cached &&
      cached.generation === token.generation &&
      Date.now() - cached.cachedAt < OpenAIDispatcher.RATE_LIMITS_CACHE_TTL
    )
      return cached;

    // single-flight: 동시성 상한이 없어진 뒤로 TTL 만료 순간 동시 요청 수만큼 같은
    // 조회가 몰릴 수 있다 — 진행 중인 fetch 를 공유한다. 최초 호출자의 abort 로
    // 공유 조회가 실패해도 소비처(isQuotaEligible)가 fail-open 으로 처리한다.
    const pending = this.pendingRateLimits.get(tokenId);
    if (pending) return pending;
    const fetchPromise = (async () => {
      const result = await readOpenAIQuotaUsage({
        credentials: token.credentials,
        fetch: this.fetchImpl,
        ...(signal ? { signal } : {}),
      });
      if (result.kind === "lookup_failed") throw new Error(result.reason);
      if (!result.raw) throw new Error("OpenAI quota response missing raw rate limits");
      const entry = { data: result.raw, cachedAt: Date.now(), generation: token.generation };
      if (this.tokenMetadata.get(tokenId) === token) this.rateLimitsCache.set(tokenId, entry);
      return entry;
    })().finally(() => this.pendingRateLimits.delete(tokenId));
    this.pendingRateLimits.set(tokenId, fetchPromise);
    return fetchPromise;
  }

  private async isQuotaEligible(
    id: number,
    token: TokenMetadata,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (token.quotaThreshold === null || token.quotaThreshold === undefined) return true;
    const generation = token.generation;
    const result = await readOpenAIQuotaUsage(async () => this.getRateLimitsByTokenId(id, signal));
    if (this.tokenMetadata.get(id) !== token || token.generation !== generation) return false;
    if (result.kind === "lookup_failed") {
      this.quotaBlocked.delete(id);
      logger.warn("quota_threshold gate: lookup_fail_open", {
        tokenId: id,
        tokenName: token.name,
        lookupReason: result.reason,
      });
      return true;
    }
    if (result.utilizationPct >= token.quotaThreshold) {
      if (!this.quotaBlocked.has(id))
        logger.info(
          `quota_threshold gate: over_threshold ${token.name}[${id}] (${result.utilizationPct}% >= ${token.quotaThreshold}%)`,
        );
      this.quotaBlocked.add(id);
      return false;
    }
    if (this.quotaBlocked.delete(id))
      logger.info(
        `quota_threshold gate: recovered ${token.name}[${id}] (${result.utilizationPct}% < ${token.quotaThreshold}%)`,
      );
    return true;
  }

  private invalidateRateLimitsCache(id: number): void {
    this.rateLimitsCache.delete(id);
  }

  get tokenCount(): number {
    return [...this.tokenMetadata.values()].filter((t) => t.active).length;
  }
  get inFlight(): number {
    return this.inFlightCount;
  }

  /**
   * 토큰별 쿼터 스냅샷 — 신선한(rate limits TTL 내) 캐시만 읽고 절대 fetch 하지 않는다.
   * monit vitals 는 로그 폴링에 편승하는 값이라 여기서 네트워크를 타면 안 된다.
   * threshold 미설정 토큰은 쿼터 판정을 돌지 않아 usedPercent 가 null 로 남을 수 있다.
   */
  get quotaByToken(): Array<{
    name: string;
    usedPercent: number | null;
    threshold: number | null;
    blocked: boolean;
    resetsAt: number | null;
  }> {
    const now = Date.now();
    return [...this.tokenMetadata.entries()]
      .map(([id, t]) => {
        const cached = this.rateLimitsCache.get(id);
        const fresh =
          cached !== undefined &&
          cached.generation === t.generation &&
          now - cached.cachedAt < OpenAIDispatcher.RATE_LIMITS_CACHE_TTL;
        const primary = fresh ? cached.data.rateLimits?.primary : undefined;
        return {
          name: t.name,
          usedPercent: primary?.usedPercent ?? null,
          threshold: t.quotaThreshold ?? null,
          blocked: this.quotaBlocked.has(id),
          // wham 의 resetsAt 은 unix 초 단위다(qgrid.frame unixSecondsToIso 와 동일 규약).
          // 소비처가 단위를 추측하지 않도록 여기서 ms epoch 으로 정규화한다.
          resetsAt:
            primary?.resetsAt !== null && primary?.resetsAt !== undefined
              ? primary.resetsAt * 1000
              : null,
        };
      })
      .toSorted((a, b) => a.name.localeCompare(b.name));
  }
}
