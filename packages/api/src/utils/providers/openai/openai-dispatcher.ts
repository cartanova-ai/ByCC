import { getLogger } from "@logtape/logtape";

import { QuotaThresholdExceededError } from "../../../application/qgrid/qgrid.types";
import { TokenModel } from "../../../application/token/token.model";
import { type OpenAICredentials } from "../../../application/token/token.types";
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
import { type OpenAIPermitConfig, resolveOpenAIPermitConfig } from "./openai-permit-config";
import { readOpenAIQuotaUsage, type OpenAIRateLimitsWithMeta } from "./openai-quota";
import { handleChatgptAuthTokensRefresh } from "./openai-refresh";

const logger = getLogger(["qgrid", "openai-dispatcher"]);
const QUEUE_TIMEOUT_MS = 60_000;
const MAX_QUEUE_SIZE = 50;

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

/** Kept for callers which persisted the old worker coordinate encoding. */
export function makeOpenAIWorkerId(tokenId: number, workerIndex = 0): number {
  return tokenId * 100 + workerIndex;
}

type TokenMetadata = {
  name: string;
  credentials: OpenAICredentials;
  quotaThreshold?: number | null;
  weight: number;
  active: boolean;
  capacity: number;
  inUse: number;
  generation: number;
};

type Permit = { tokenId: number; metadata: TokenMetadata };
type QueueItem = {
  preferredTokenId?: number;
  signal?: AbortSignal;
  resolve: (permit: Permit) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  abortCleanup?: () => void;
};

export type OpenAIDirectClientFactory = (
  options: OpenAIDirectClientOptions,
  tokenId: number,
) => Pick<OpenAIDirectClient, "responses"> & { close?: () => void };

export interface OpenAIDispatcherDependencies {
  clientFactory?: OpenAIDirectClientFactory;
  fetch?: typeof fetch;
  queueTimeoutMs?: number;
}

function abortError(signal?: AbortSignal): Error {
  const reason = signal?.reason;
  return reason instanceof Error ? reason : new DOMException("Aborted", "AbortError");
}

function activeSignal(signal?: AbortSignal, timeoutMs?: number): AbortSignal | undefined {
  const timeout = timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs);
  return signal && timeout ? AbortSignal.any([signal, timeout]) : (signal ?? timeout);
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
  if (!req.effort && !summary) return undefined;
  return {
    ...(req.effort
      ? { effort: req.effort as NonNullable<OpenAIResponsesOptions["reasoning"]>["effort"] }
      : {}),
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

export class OpenAIDispatcher implements ProviderDispatcher {
  readonly tokenMetadata = new Map<number, TokenMetadata>();
  readonly queue: QueueItem[] = [];
  readonly permitConfig: OpenAIPermitConfig;
  readonly rateLimitsCache = new Map<number, OpenAIRateLimitsWithMeta & { generation: number }>();
  private readonly clients = new Map<
    number,
    {
      generation: number;
      client: Pick<OpenAIDirectClient, "responses"> & { close?: () => void };
    }
  >();
  static readonly RATE_LIMITS_CACHE_TTL = 60_000;

  private readonly selector = new SmoothWeightedRoundRobin();
  private readonly clientFactory: OpenAIDirectClientFactory;
  private readonly fetchImpl: typeof fetch;
  private readonly queueTimeoutMs: number;
  private readonly quotaBlocked = new Set<number>();
  private draining = false;
  private drainAgain = false;

  constructor(
    permitConfig: OpenAIPermitConfig = resolveOpenAIPermitConfig(),
    _legacyHostAvailable?: () => number,
    dependencies: OpenAIDispatcherDependencies = {},
  ) {
    this.permitConfig = permitConfig;
    this.clientFactory =
      dependencies.clientFactory ?? ((options) => new OpenAIDirectClient(options));
    this.fetchImpl = dependencies.fetch ?? fetch;
    this.queueTimeoutMs = dependencies.queueTimeoutMs ?? QUEUE_TIMEOUT_MS;
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
    logger.info(
      `started direct OpenAI runtime with ${this.tokenMetadata.size} tokens and ${this.workerCount} permits`,
    );
  }

  async stop(): Promise<void> {
    this.rejectAllQueued("DISPATCHER_SHUTDOWN");
    for (const { client } of this.clients.values()) client.close?.();
    this.clients.clear();
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
    this.requestDrain();
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
    this.requestDrain();
  }

  async onTokenRemoved(id: number): Promise<void> {
    this.clients.get(id)?.client.close?.();
    this.clients.delete(id);
    this.tokenMetadata.delete(id);
    this.selector.removeToken(id);
    this.invalidateRateLimitsCache(id);
    this.quotaBlocked.delete(id);
    if (![...this.tokenMetadata.values()].some((t) => t.active))
      this.rejectAllQueued("NO_OPENAI_WORKERS");
  }

  onTokenDeactivated(id: number): void {
    const token = this.tokenMetadata.get(id);
    if (token) token.active = false;
    this.selector.resetScores();
    if (![...this.tokenMetadata.values()].some((t) => t.active))
      this.rejectAllQueued("NO_ACTIVE_WORKERS");
  }

  onTokenActivated(id: number): void {
    const token = this.tokenMetadata.get(id);
    if (token) token.active = true;
    this.selector.resetScores();
    this.requestDrain();
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
    const signal = activeSignal(req.abortSignal, req.timeoutMs);
    if (signal?.aborted) throw abortError(signal);
    const permit = await this.acquire(req.preferredTokenId, signal);
    try {
      if (signal?.aborted) throw abortError(signal);
      return await this.runDirect(permit, { ...req, abortSignal: signal });
    } finally {
      this.release(permit);
    }
  }

  async generateStream(req: GenerateRequest, cb: GenerateStreamCallbacks): Promise<void> {
    if (req.imageGeneration)
      throw new ImageGenerationError(
        "gate",
        "image generation is not supported on the streaming path",
      );
    const signal = activeSignal(req.abortSignal, req.timeoutMs);
    if (signal?.aborted) throw abortError(signal);
    const permit = await this.acquire(req.preferredTokenId, signal);
    try {
      if (signal?.aborted) throw abortError(signal);
      const result = await this.runDirect(permit, { ...req, abortSignal: signal }, cb.onDelta);
      cb.onComplete(result);
    } catch (error) {
      cb.onError(error as Error);
      throw error;
    } finally {
      this.release(permit);
    }
  }

  private async runDirect(
    permit: Permit,
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
    const metadata = permit.metadata;
    let clientEntry = this.clients.get(permit.tokenId);
    if (!clientEntry || clientEntry.generation !== metadata.generation) {
      clientEntry?.client.close?.();
      const client = this.clientFactory(
        {
          credentials: {
            accessToken: metadata.credentials.accessToken,
            accountId: metadata.credentials.accountId,
          },
          transportKind: this.permitConfig.transport,
          fetch: this.fetchImpl,
          refreshCredentials: async () => {
            const refreshed = await handleChatgptAuthTokensRefresh(permit.tokenId);
            const current = this.tokenMetadata.get(permit.tokenId);
            if (current)
              current.credentials = {
                ...current.credentials,
                accessToken: refreshed.accessToken,
                accountId: refreshed.chatgptAccountId,
              };
            return { accessToken: refreshed.accessToken, accountId: refreshed.chatgptAccountId };
          },
        },
        permit.tokenId,
      );
      clientEntry = { generation: metadata.generation, client };
      this.clients.set(permit.tokenId, clientEntry);
    }
    const client = clientEntry.client;

    for await (const event of client.responses(requestOptions(req), req.abortSignal)) {
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
        if (req.imageGeneration) throw new ImageGenerationError("incomplete", event.error.message);
        throw event.error;
      }
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
      threadCoord: { workerId: permit.tokenId, threadId: req.promptCacheKey ?? "", epoch: -1 },
      ...(images.length ? { images } : {}),
    };
  }

  private async acquire(preferredTokenId?: number, signal?: AbortSignal): Promise<Permit> {
    if (signal?.aborted) throw abortError(signal);
    const permit = await this.selectPermit(preferredTokenId);
    if (permit) {
      if (signal?.aborted) {
        this.release(permit);
        throw abortError(signal);
      }
      return permit;
    }
    if (signal?.aborted) throw abortError(signal);
    if (this.queue.length >= MAX_QUEUE_SIZE) throw new Error("SERVER_BUSY");
    if (![...this.tokenMetadata.values()].some((t) => t.active))
      throw new Error("NO_OPENAI_WORKERS");
    return new Promise<Permit>((resolve, reject) => {
      const item: QueueItem = {
        preferredTokenId,
        signal,
        resolve: (value) => {
          clearTimeout(item.timer);
          item.abortCleanup?.();
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(item.timer);
          item.abortCleanup?.();
          reject(error);
        },
        timer: setTimeout(() => {
          this.removeQueueItem(item);
          reject(new Error("SERVER_BUSY"));
        }, this.queueTimeoutMs),
      };
      if (signal) {
        const abort = () => {
          this.removeQueueItem(item);
          reject(abortError(signal));
        };
        signal.addEventListener("abort", abort, { once: true });
        item.abortCleanup = () => signal.removeEventListener("abort", abort);
        if (signal.aborted) {
          abort();
          return;
        }
      }
      this.queue.push(item);
      this.requestDrain();
    });
  }

  private async selectPermit(preferredTokenId?: number): Promise<Permit | null> {
    const eligible = new Set<number>();
    const over: Array<{ name: string; threshold: number }> = [];
    for (const [id, token] of this.tokenMetadata) {
      if (!token.active || token.inUse >= token.capacity) continue;
      if (await this.isQuotaEligible(id, token)) eligible.add(id);
      else if (token.quotaThreshold !== null && token.quotaThreshold !== undefined)
        over.push({ name: token.name, threshold: token.quotaThreshold });
    }
    const activeAvailable = [...this.tokenMetadata.values()].some(
      (t) => t.active && t.inUse < t.capacity,
    );
    if (activeAvailable && eligible.size === 0 && over.length) {
      logger.warn("quota_threshold gate: all_exceeded", {
        provider: "openai",
        overThresholdTokens: over,
      });
      throw new QuotaThresholdExceededError(quotaMessage(over));
    }
    // Affinity does not mutate smooth weighted state.
    const selected =
      preferredTokenId !== undefined && eligible.has(preferredTokenId)
        ? preferredTokenId
        : this.selector.select(eligible);
    if (selected === null) return null;
    const metadata = this.tokenMetadata.get(selected);
    if (!metadata || metadata.inUse >= metadata.capacity) return null;
    metadata.inUse++;
    return { tokenId: selected, metadata };
  }

  private release(permit: Permit): void {
    permit.metadata.inUse = Math.max(0, permit.metadata.inUse - 1);
    this.requestDrain();
  }

  private requestDrain(): void {
    if (this.draining) {
      this.drainAgain = true;
      return;
    }
    void this.drainQueue().catch((error) =>
      logger.warn(`openai queue drain failed: ${(error as Error).message}`),
    );
  }

  private async drainQueue(): Promise<void> {
    if (this.draining) {
      this.drainAgain = true;
      return;
    }
    this.draining = true;
    try {
      do {
        this.drainAgain = false;
        while (this.queue.length) {
          const item = this.queue[0]!;
          if (item.signal?.aborted) {
            this.queue.shift();
            item.reject(abortError(item.signal));
            continue;
          }
          let permit: Permit | null;
          try {
            permit = await this.selectPermit(item.preferredTokenId);
          } catch (error) {
            this.queue.shift();
            item.reject(error as Error);
            continue;
          }
          if (!permit) break;
          this.queue.shift();
          item.resolve(permit);
        }
      } while (this.drainAgain);
    } finally {
      this.draining = false;
    }
  }

  private removeQueueItem(item: QueueItem): void {
    clearTimeout(item.timer);
    item.abortCleanup?.();
    const index = this.queue.indexOf(item);
    if (index >= 0) this.queue.splice(index, 1);
  }

  private rejectAllQueued(reason: string): void {
    const items = this.queue.splice(0);
    for (const item of items) item.reject(new Error(reason));
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
        capacity: this.permitConfig.permitsPerToken,
        generation: old.generation + 1,
      });
    } else {
      this.tokenMetadata.set(id, {
        name,
        credentials,
        quotaThreshold,
        weight,
        active,
        capacity: this.permitConfig.permitsPerToken,
        inUse: 0,
        generation: 1,
      });
    }
    this.selector.setToken(id, weight);
    this.invalidateRateLimitsCache(id);
    this.quotaBlocked.delete(id);
  }

  async getRateLimitsByTokenId(tokenId: number): Promise<OpenAIRateLimitsWithMeta> {
    const token = this.tokenMetadata.get(tokenId);
    if (!token) throw new Error(`openai token ${tokenId} not found`);
    const cached = this.rateLimitsCache.get(tokenId);
    if (
      cached &&
      cached.generation === token.generation &&
      Date.now() - cached.cachedAt < OpenAIDispatcher.RATE_LIMITS_CACHE_TTL
    )
      return cached;
    const result = await readOpenAIQuotaUsage({
      credentials: token.credentials,
      fetch: this.fetchImpl,
    });
    if (result.kind === "lookup_failed") throw new Error(result.reason);
    if (!result.raw) throw new Error("OpenAI quota response missing raw rate limits");
    const entry = { data: result.raw, cachedAt: Date.now(), generation: token.generation };
    if (this.tokenMetadata.get(tokenId) === token) this.rateLimitsCache.set(tokenId, entry);
    return entry;
  }

  private async isQuotaEligible(id: number, token: TokenMetadata): Promise<boolean> {
    if (token.quotaThreshold === null || token.quotaThreshold === undefined) return true;
    const generation = token.generation;
    const result = await readOpenAIQuotaUsage(async () => this.getRateLimitsByTokenId(id));
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

  get workerCount(): number {
    return [...this.tokenMetadata.values()].reduce((sum, t) => sum + t.capacity, 0);
  }
  get readyWorkerCount(): number {
    return [...this.tokenMetadata.values()].reduce(
      (sum, t) => sum + (t.active ? t.capacity - t.inUse : 0),
      0,
    );
  }
  get queueLength(): number {
    return this.queue.length;
  }
  get workerCountsByToken(): Array<{ name: string; count: number }> {
    return [...this.tokenMetadata.values()]
      .map((t) => ({ name: t.name, count: t.capacity }))
      .toSorted((a, b) => a.name.localeCompare(b.name));
  }
}
