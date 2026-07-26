import crypto from "node:crypto";

import { getLogger } from "@logtape/logtape";
import { type FastifyReply, type FastifyRequest } from "fastify";
import { api, BadRequestException, BaseFrameClass, Sonamu, stream } from "sonamu";
import { getCacheManagerRef } from "sonamu/cache";

import { type LocalizedString } from "../../i18n/sd.generated";
import {
  getAccessToken,
  getExpiresAt,
  getRefreshToken,
} from "../../utils/providers/common/credentials";
import { MICRO_USD, RequestLogModel } from "../request-log/request-log.model";
import { type TokenSubsetA } from "../sonamu.generated";
import { TokenModel, type TokenUpdateFields } from "../token/token.model";
import { TokenCredentials } from "../token/token.types";
import {
  type AnthropicUsageRaw,
  buildAuthUrl,
  exchangeCodeForTokens,
  fetchUsage,
  generatePKCE,
  refreshAccessToken,
} from "./oauth";
import {
  afterQuery,
  beforeQuery,
  finishRunAborted,
  finishRunWithError,
} from "./qgrid-run-lifecycle";
import { QgridDispatcher } from "./qgrid.dispatcher";
import {
  type QueryInput,
  type AppendStepInput,
  type CreateRunInput,
  type FinishRunInput,
  type HealthResponse,
  type OAuthStartResult,
  type QueryOutput,
  type QgridRunContext,
  StreamEvents,
  type TokenStats,
  type UsageResponse,
} from "./qgrid.types";

const pendingStreams = new Map<string, QueryInput>();

type PendingOAuth = { codeVerifier: string; name: string; redirectUri: string };
const OAUTH_STATE_PREFIX = "oauth:state:";
const OAUTH_STATE_TTL = "5m";

function unixSecondsToIso(seconds: number | null | undefined): string | null {
  return typeof seconds === "number" ? new Date(seconds * 1000).toISOString() : null;
}

async function setOAuthState(state: string, data: PendingOAuth): Promise<void> {
  const cache = getCacheManagerRef();
  if (!cache) throw new Error("CacheManager not initialized");
  await cache.set({
    key: `${OAUTH_STATE_PREFIX}${state}`,
    value: JSON.stringify(data),
    ttl: OAUTH_STATE_TTL,
  });
}

async function getOAuthState(state: string): Promise<PendingOAuth | undefined> {
  const cache = getCacheManagerRef();
  if (!cache) throw new Error("CacheManager not initialized");
  const raw = await cache.get<string>({ key: `${OAUTH_STATE_PREFIX}${state}` });
  if (!raw) return undefined;
  return JSON.parse(raw) as PendingOAuth;
}

async function deleteOAuthState(state: string): Promise<void> {
  const cache = getCacheManagerRef();
  if (!cache) return;
  await cache.delete({ key: `${OAUTH_STATE_PREFIX}${state}` });
}

function getOAuthRedirectUri(): string {
  const publicBaseUrl = process.env.QGRID_PUBLIC_BASE_URL?.replace(/\/+$/, "");
  if (publicBaseUrl) return `${publicBaseUrl}/callback`;

  const serverPort = process.env.PORT ?? "44900";
  return `http://localhost:${serverPort}/callback`;
}

function rejectImageGenerationStream(args: QueryInput): void {
  if (!args.imageGeneration) return;
  throw new BadRequestException(
    "qgrid: imageGeneration is not supported with streaming; use query/generateText instead." as LocalizedString,
  );
}

function rejectLegacyLogMode(args: QueryInput): void {
  if (!Object.hasOwn(args, "logMode")) return;
  throw new BadRequestException(
    "qgrid: logMode is no longer supported; use logger: false to disable request logging." as LocalizedString,
  );
}

function createHttpDisconnectHandle(): {
  signal: AbortSignal;
  dispose: () => void;
} {
  const abortController = new AbortController();
  let requestRaw: FastifyRequest["raw"] | undefined;
  let responseRaw: FastifyReply["raw"] | undefined;

  try {
    const ctx = Sonamu.getContext();
    requestRaw = ctx.request?.raw;
    if (ctx.transport === "http") responseRaw = ctx.reply.raw;
  } catch {
    // Direct frame calls (for example unit tests) do not have an HTTP context.
  }

  const abort = () => abortController.abort();
  const abortOnIncompleteResponseClose = () => {
    if (!responseRaw?.writableEnded) abort();
  };

  requestRaw?.once("aborted", abort);
  responseRaw?.once("close", abortOnIncompleteResponseClose);

  if (requestRaw?.aborted || (responseRaw?.destroyed && !responseRaw.writableEnded)) {
    abort();
  }

  return {
    signal: abortController.signal,
    dispose: () => {
      requestRaw?.removeListener("aborted", abort);
      responseRaw?.removeListener("close", abortOnIncompleteResponseClose);
    },
  };
}

const logger = getLogger(["qgrid"]);
const oauthLogger = getLogger(["qgrid", "oauth"]);

class QgridFrameClass extends BaseFrameClass {
  constructor() {
    super("Qgrid");
  }

  @api({ httpMethod: "POST", clients: ["axios", "tanstack-mutation"] })
  async query(args: QueryInput): Promise<QueryOutput> {
    rejectLegacyLogMode(args);
    const disconnect = createHttpDisconnectHandle();
    try {
      if (args.logger === false) {
        return await QgridDispatcher.query(args, disconnect.signal);
      }

      const { requestLogId, stepIndex } = await beforeQuery(args);
      let result: QueryOutput;
      try {
        result = await QgridDispatcher.query(args, disconnect.signal);
      } catch (e) {
        if (disconnect.signal.aborted) {
          await finishRunAborted(requestLogId, args);
        } else {
          await finishRunWithError(requestLogId, (e as Error).message, args);
        }
        throw e;
      }

      try {
        const lifecycle = await afterQuery(requestLogId, stepIndex, args, result);
        if (disconnect.signal.aborted) {
          await finishRunAborted(requestLogId, args);
        }
        // tool-call requestLogId와 provider threadCoord는 서로 독립적으로 유지한다.
        const threadCoord = result.runContext?.threadCoord;
        const runContext =
          lifecycle.runContext || threadCoord
            ? { ...lifecycle.runContext, ...(threadCoord ? { threadCoord } : {}) }
            : undefined;
        return { ...result, runContext };
      } catch (e) {
        logger.error(`query afterQuery failed: ${(e as Error).message}`);
        if (disconnect.signal.aborted) {
          await finishRunAborted(requestLogId, args);
        } else {
          await finishRunWithError(requestLogId, (e as Error).message, args);
        }
        // provider 응답은 성공했으므로 로깅 장애가 생성 결과를 덮어쓰지 않는다.
        return result;
      }
    } finally {
      disconnect.dispose();
    }
  }

  @api({ httpMethod: "POST", clients: ["axios", "tanstack-mutation"] })
  async prepareStream(args: QueryInput): Promise<{ streamId: string }> {
    rejectLegacyLogMode(args);
    rejectImageGenerationStream(args);
    const streamId = crypto.randomUUID();
    pendingStreams.set(streamId, args);
    const expiry = setTimeout(() => pendingStreams.delete(streamId), 30_000);
    expiry.unref?.();
    return { streamId };
  }

  @stream({ type: "sse", events: StreamEvents })
  async queryStream(streamId: string): Promise<void> {
    const args = pendingStreams.get(streamId);
    pendingStreams.delete(streamId);
    if (!args) throw new Error("invalid or expired streamId");
    rejectLegacyLogMode(args);
    rejectImageGenerationStream(args);

    const ctx = Sonamu.getContext();
    const sse = ctx.createSSE(StreamEvents);
    let threadId: string | undefined;
    let turnId: string | undefined;
    let streamResult: QueryOutput | undefined;
    let streamError: Error | undefined;
    let clientClosed = false;
    const abortController = new AbortController();

    const interruptOpenAI = () => {
      if (threadId && turnId) {
        QgridDispatcher.openaiDispatcher?.interruptWorkerTurn(threadId, turnId).catch(() => {});
      }
    };

    sse.onClose(() => {
      clientClosed = true;
      abortController.abort();
      interruptOpenAI();
    });

    let runInfo: { requestLogId: number; stepIndex: number } | undefined;
    if (args.logger !== false) {
      // provider 실행 전 running row 생성에 실패하면 logged 요청으로 진행하지 않는다.
      runInfo = await beforeQuery(args);
    }

    // beforeQuery DB 작업 중 close를 놓치지 않고 provider 실행 전에 마감한다.
    if (clientClosed || sse.closed) {
      if (runInfo) await finishRunAborted(runInfo.requestLogId, args);
      await sse.end();
      return;
    }

    try {
      await QgridDispatcher.queryStream(
        args,
        {
          onDelta: (text) => {
            if (!clientClosed && !sse.closed) sse.publish("delta", { text });
          },
          onThreadId: (id) => {
            threadId = id;
            if ((clientClosed || sse.closed) && turnId) {
              interruptOpenAI();
            }
          },
          onTurnId: (id) => {
            turnId = id;
            if ((clientClosed || sse.closed) && threadId) {
              interruptOpenAI();
            }
          },
          onComplete: (result) => {
            streamResult = result;
          },
          onError: (err) => {
            streamError = err;
          },
        },
        abortController.signal,
      );
    } catch (e) {
      streamError = e as Error;
    }

    // provider 결과가 없는 close는 즉시 aborted로 마감한다.
    if (clientClosed && !streamResult) {
      if (runInfo) await finishRunAborted(runInfo.requestLogId, args);
      await sse.end();
      return;
    }

    // dispatcher 완료 후 lifecycle 처리 (await 안전)
    if (streamResult) {
      // dispatcher 가 실은 thread 재사용 좌표는 logger 설정과 무관하게 회송한다.
      const threadCoord = streamResult.runContext?.threadCoord;
      let runContext: QgridRunContext | undefined =
        threadCoord !== undefined ? { threadCoord } : undefined;
      if (runInfo) {
        try {
          // close 후 도착한 결과도 step/usage는 남기되, 아래에서 최종 status를 aborted로 덮어쓴다.
          const lifecycle = await afterQuery(
            runInfo.requestLogId,
            runInfo.stepIndex,
            args,
            streamResult,
          );
          runContext =
            lifecycle.runContext || threadCoord
              ? { ...lifecycle.runContext, ...(threadCoord ? { threadCoord } : {}) }
              : undefined;

          // afterQuery가 진행되는 사이 client가 닫힌 경우 완료 상태를 aborted로 되돌린다.
          if (clientClosed) {
            await finishRunAborted(runInfo.requestLogId, args);
            await sse.end();
            return;
          }
        } catch (e) {
          logger.error(`stream afterQuery failed: ${(e as Error).message}`);
          await finishRunWithError(runInfo.requestLogId, (e as Error).message, args);

          if (clientClosed) {
            await finishRunAborted(runInfo.requestLogId, args);
            await sse.end();
            return;
          }
        }
      }
      if (!clientClosed && !sse.closed) sse.publish("done", { ...streamResult, runContext });
    } else if (streamError) {
      if (runInfo) await finishRunWithError(runInfo.requestLogId, streamError.message, args);
      if (!clientClosed && !sse.closed) sse.publish("error", { message: streamError.message });
    } else if ((clientClosed || sse.closed) && runInfo) {
      await finishRunAborted(runInfo.requestLogId, args);
    }

    await sse.end();
  }

  @api({ httpMethod: "POST", clients: ["axios", "tanstack-mutation"] })
  async createRun(input: CreateRunInput): Promise<{ requestLogId: number }> {
    const requestLogId = await RequestLogModel.createRun({
      user_prompt: input.userPrompt,
      requested_model_name: input.modelName,
      effort: input.effort,
      project_name: input.projectName,
      system_prompt: input.systemPrompt,
      history: input.history ? JSON.parse(input.history) : undefined,
    });
    return { requestLogId };
  }

  @api({ httpMethod: "POST", clients: ["axios", "tanstack-mutation"] })
  async appendStep(input: AppendStepInput): Promise<{ stepId: number }> {
    const stepId = await RequestLogModel.appendStep(input.requestLogId, {
      step_index: input.stepIndex,
      type: input.type,
      model_name: input.modelName,
      requested_model_name: input.requestedModelName,
      fallback_count: input.fallbackCount,
      input_tokens: input.inputTokens,
      output_tokens: input.outputTokens,
      cache_read_tokens: input.cacheReadTokens,
      cache_creation_tokens: input.cacheCreationTokens,
      cache_creation_5m_tokens: input.cacheCreation5mTokens,
      cache_creation_1h_tokens: input.cacheCreation1hTokens,
      cost_usd: input.costUsd === undefined ? undefined : Math.round(input.costUsd * MICRO_USD),
      cost_source: input.costSource,
      duration_ms: input.durationMs,
      ttft_ms: input.ttftMs ?? null,
      finish_reason: input.finishReason,
      reasoning_text: input.reasoningText,
      reasoning_tokens: input.reasoningTokens,
      tool_call_index: input.toolCallIndex,
      tool_call_id: input.toolCallId,
      tool_name: input.toolName,
      tool_args: input.toolArgs,
      tool_result: input.toolResult,
      tool_duration_ms: input.toolDurationMs,
      error: input.error,
    });
    return { stepId };
  }

  @api({ httpMethod: "POST", clients: ["axios", "tanstack-mutation"] })
  async finishRun(input: FinishRunInput): Promise<{ ok: boolean }> {
    await RequestLogModel.finishRun(input.requestLogId, {
      status: input.status,
      response: input.response,
      token_name: input.tokenName,
      model_name: input.modelName,
      requested_model_name: input.requestedModelName,
      fallback_count: input.fallbackCount,
      input_tokens: input.totalInputTokens,
      output_tokens: input.totalOutputTokens,
      cache_read_tokens: input.totalCacheReadTokens,
      cache_creation_tokens: input.totalCacheCreationTokens,
      cache_creation_5m_tokens: input.totalCacheCreation5mTokens,
      cache_creation_1h_tokens: input.totalCacheCreation1hTokens,
      cost_usd: input.costUsd === undefined ? undefined : Math.round(input.costUsd * MICRO_USD),
      cost_source: input.costSource,
      duration_ms: input.totalDurationMs,
      history: input.history ? JSON.parse(input.history) : undefined,
      error_message: input.errorMessage,
    });
    return { ok: true };
  }

  @api({ httpMethod: "GET", clients: ["axios", "tanstack-query"] })
  async stats(): Promise<TokenStats[]> {
    return QgridDispatcher.getStats();
  }

  @api({ httpMethod: "GET", clients: ["axios", "tanstack-query"] })
  async totalCost(tokenName?: string): Promise<{ usd: number }> {
    return { usd: await RequestLogModel.totalCost({ token_name: tokenName }) };
  }

  @api({ httpMethod: "GET", clients: ["axios", "tanstack-query"] })
  async projectNames(): Promise<{ names: string[] }> {
    return { names: await RequestLogModel.distinctProjectNames() };
  }

  @api({ httpMethod: "POST", clients: ["axios", "tanstack-mutation"] })
  async addToken(
    provider: string,
    credentials: TokenCredentials,
    name: string,
  ): Promise<{ added: boolean }> {
    await TokenModel.save([
      {
        provider,
        credentials,
        name,
      },
    ]);
    return { added: true };
  }

  @api({ httpMethod: "POST", clients: ["axios"] })
  async updateToken(
    id: number,
    name?: string,
    quotaThreshold?: number | null,
    weight?: number,
  ): Promise<{ updated: boolean }> {
    if (
      quotaThreshold !== undefined &&
      quotaThreshold !== null &&
      (!Number.isInteger(quotaThreshold) || quotaThreshold < 1 || quotaThreshold > 100)
    ) {
      throw new BadRequestException(
        "quotaThreshold must be an integer between 1 and 100, or null" as LocalizedString,
      );
    }
    if (weight !== undefined && (!Number.isInteger(weight) || weight < 1 || weight > 100)) {
      throw new BadRequestException(
        "weight must be an integer between 1 and 100" as LocalizedString,
      );
    }

    const patch: TokenUpdateFields = {};
    if (name !== undefined) patch.name = name;
    if (quotaThreshold !== undefined) patch.quota_threshold = quotaThreshold;
    if (weight !== undefined) patch.weight = weight;
    if (Object.keys(patch).length === 0) return { updated: false };

    const updated = await TokenModel.updateFields(id, patch);
    return { updated: updated > 0 };
  }

  @api({ httpMethod: "POST", clients: ["axios", "tanstack-mutation"] })
  async removeToken(id: number): Promise<{ removed: boolean }> {
    const entry = await TokenModel.findOne("A", { id });
    if (!entry) return { removed: false };
    await TokenModel.del([entry.id]);
    return { removed: true };
  }

  /**
   * 토큰 활성화/비활성화 토글 DB의 active 필드 업데이트
   */
  @api({ httpMethod: "POST", clients: ["axios", "tanstack-mutation"] })
  async toggleToken(id: number): Promise<{ active: boolean }> {
    const entry = await TokenModel.findOne("A", { id });
    if (!entry) return { active: false };

    const newActive = !entry.active;
    await TokenModel.save([
      {
        id,
        provider: entry.provider,
        credentials: entry.credentials,
        active: newActive,
        name: entry.name,
      },
    ]);
    return { active: newActive };
  }

  @api({ httpMethod: "POST", clients: ["axios", "tanstack-mutation"] })
  async oauthStart(name: string): Promise<OAuthStartResult> {
    const { codeVerifier, codeChallenge, state } = generatePKCE();

    const redirectUri = getOAuthRedirectUri();
    const authUrl = buildAuthUrl(codeChallenge, state, redirectUri);

    await setOAuthState(state, { codeVerifier, name, redirectUri });

    return { authUrl };
  }

  async handleOAuthCallback(code: string, state: string, reply: FastifyReply): Promise<void> {
    const pending = await getOAuthState(state);
    if (!pending) {
      logger.warn("oauth callback: invalid_state");
      return reply.redirect("/?oauth=error&reason=invalid_state");
    }
    await deleteOAuthState(state);

    try {
      const tokens = await exchangeCodeForTokens(
        code,
        pending.codeVerifier,
        state,
        pending.redirectUri,
      );

      if (tokens.accountUuid) {
        const oldEntries = await TokenModel.findByAccountIdentifier(
          "A",
          "anthropic",
          tokens.accountUuid,
        );
        if (oldEntries.length > 0) {
          await TokenModel.del(oldEntries.map((o) => o.id));
        }
      }

      await TokenModel.save([
        {
          provider: "anthropic",
          credentials: {
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
            expiresAt: tokens.expiresAt ?? 0,
            accountUuid: tokens.accountUuid ?? "",
          },
          name: pending.name,
        },
      ]);

      return reply.redirect(`/?oauth=success&name=${encodeURIComponent(pending.name)}`);
    } catch (e) {
      return reply.redirect(`/?oauth=error&reason=${encodeURIComponent((e as Error).message)}`);
    }
  }

  @api({ httpMethod: "POST", clients: ["axios", "tanstack-mutation"] })
  async oauthStartOpenAI(name: string): Promise<OAuthStartResult> {
    if (!QgridDispatcher.openaiDispatcher) throw new Error("OpenAI dispatcher not initialized");
    const { authUrl } = await QgridDispatcher.openaiDispatcher.startBrowserLogin(name);

    // fire-and-forget: codex login 완료 대기 → 토큰 저장
    QgridDispatcher.openaiDispatcher
      .completeBrowserLogin()
      .then(async (creds) => {
        if (creds.accountId) {
          const oldEntries = await TokenModel.findByAccountIdentifier(
            "A",
            "openai",
            creds.accountId,
          );
          if (oldEntries.length > 0) {
            await TokenModel.del(oldEntries.map((o) => o.id));
          }
        }
        await TokenModel.save([
          {
            provider: "openai",
            credentials: {
              accessToken: creds.accessToken,
              refreshToken: creds.refreshToken,
              idToken: creds.idToken,
              accessTokenExpiresAt: Date.now() + 10 * 24 * 3600 * 1000,
              accountId: creds.accountId,
            },
            name,
          },
        ]);
        logger.info(`OpenAI token saved for ${name}`);
      })
      .catch((e) => {
        logger.warn(`OpenAI browser login failed: ${(e as Error).message}`);
      });

    return { authUrl };
  }

  @api({ httpMethod: "GET", clients: ["axios", "tanstack-query"] })
  async usage(tokenId?: number): Promise<UsageResponse> {
    const { rows: allTokens } = await TokenModel.findMany("A");
    const entry = tokenId
      ? allTokens.find((e) => e.id === tokenId)
      : allTokens.findLast((e) => e.active && e.provider === "anthropic");

    if (!entry) return { error: "NOT_FOUND" };

    if (entry.provider === "openai") {
      if (!entry.active) {
        return { provider: "openai", fiveHour: null, sevenDay: null };
      }

      try {
        const raw = await QgridDispatcher.openaiDispatcher?.getRateLimitsByTokenId(entry.id);
        const rl = raw?.data.rateLimits;
        return {
          provider: "openai",
          fiveHour: rl?.primary
            ? {
                utilization: rl.primary.usedPercent,
                resetsAt: unixSecondsToIso(rl.primary.resetsAt),
                windowDurationMins: rl.primary.windowDurationMins,
              }
            : null,
          sevenDay: rl?.secondary
            ? {
                utilization: rl.secondary.usedPercent,
                resetsAt: unixSecondsToIso(rl.secondary.resetsAt),
                windowDurationMins: rl.secondary.windowDurationMins,
              }
            : null,
        };
      } catch (e) {
        return { error: `OpenAI usage failed: ${(e as Error).message}` };
      }
    }

    if (entry.provider !== "anthropic") {
      return { error: `usage API not supported for provider: ${entry.provider}` };
    }

    let accessToken = getAccessToken(entry.credentials);
    const isExpired = getExpiresAt(entry.credentials) < Date.now();

    if (isExpired && getRefreshToken(entry.credentials)) {
      try {
        accessToken = await this.refreshToken(entry);
      } catch (e) {
        oauthLogger.warn(`refresh failed for ${entry.name}: ${(e as Error).message}`);
        return { error: "re-login required" };
      }
    }

    const raw = await fetchUsage(accessToken);
    if (raw.error && getRefreshToken(entry.credentials)) {
      try {
        accessToken = await this.refreshToken(entry);
        const retried = await fetchUsage(accessToken);
        if (retried.error) return { error: retried.error };
        return convertAnthropicUsage(retried);
      } catch (e) {
        oauthLogger.warn(`refresh failed for ${entry.name}: ${(e as Error).message}`);
        return { error: "re-login required" };
      }
    }
    if (raw.error) return { error: raw.error };
    return convertAnthropicUsage(raw);
  }

  async refreshToken(token: TokenSubsetA): Promise<string> {
    const creds = token.credentials;
    const rt = getRefreshToken(creds);
    if (!rt) throw new Error("No refresh token");
    const refreshed = await refreshAccessToken(rt);
    const updated = TokenCredentials.parse({
      ...creds,
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      expiresAt: refreshed.expiresAt,
    });
    await TokenModel.save([
      {
        id: token.id,
        provider: token.provider,
        credentials: updated,
        name: token.name,
      },
    ]);
    return refreshed.accessToken;
  }

  @api({ httpMethod: "GET", clients: ["axios", "tanstack-query"] })
  async health(): Promise<HealthResponse> {
    return {
      status: "ok",
      activeTokens: QgridDispatcher.tokens.size,
      subscriber: QgridDispatcher.subscriber?.status() ?? null,
    };
  }
}

export const QgridFrame = new QgridFrameClass();

function convertAnthropicUsage(raw: AnthropicUsageRaw): UsageResponse {
  return {
    provider: "anthropic",
    fiveHour: raw.five_hour
      ? { utilization: raw.five_hour.utilization, resetsAt: raw.five_hour.resets_at }
      : null,
    sevenDay: raw.seven_day
      ? { utilization: raw.seven_day.utilization, resetsAt: raw.seven_day.resets_at }
      : null,
  };
}
