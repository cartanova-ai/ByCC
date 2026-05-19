import { getLogger } from "@logtape/logtape";
import { type FastifyReply } from "fastify";
import { api, BaseFrameClass } from "sonamu";
import { getCacheManagerRef } from "sonamu/cache";

import {
  getAccessToken,
  getExpiresAt,
  getRefreshToken,
} from "../../utils/providers/common/credentials";
import { MICRO_USD, RequestLogModel } from "../request-log/request-log.model";
import { type TokenSubsetA } from "../sonamu.generated";
import { TokenModel } from "../token/token.model";
import { TokenCredentials } from "../token/token.types";
import {
  type AnthropicUsageRaw,
  buildAuthUrl,
  exchangeCodeForTokens,
  fetchUsage,
  generatePKCE,
  refreshAccessToken,
} from "./oauth";
import { QgridDispatcher } from "./qgrid.dispatcher";
import {
  type QueryInput,
  type CliResult,
  type HealthResponse,
  type OAuthStartResult,
  type TokenStats,
  type UsageResponse,
} from "./qgrid.types";

type PendingOAuth = { codeVerifier: string; name: string; redirectUri: string };
const OAUTH_STATE_PREFIX = "oauth:state:";
const OAUTH_STATE_TTL = "5m";

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

const logger = getLogger(["qgrid"]);
const oauthLogger = getLogger(["qgrid", "oauth"]);

class QgridFrameClass extends BaseFrameClass {
  constructor() {
    super("Qgrid");
  }

  @api({ httpMethod: "POST", clients: ["axios", "tanstack-mutation"] })
  async query(args: QueryInput): Promise<CliResult> {
    const result = await QgridDispatcher.query(args, args.timeout);

    RequestLogModel.save([
      {
        token_name: result.tokenName,
        project_name: args.projectName?.length ? args.projectName : null,
        model_name: result.model ?? null,
        user_prompt: args.prompt,
        system_prompt: args.system ?? null,
        response: result.text,
        input_tokens: result.usage.input_tokens,
        output_tokens: result.usage.output_tokens,
        cache_read_tokens: result.usage.cache_read_input_tokens,
        cache_creation_tokens: result.usage.cache_creation_input_tokens,
        duration_ms: result.durationMs,
        cost_usd: result.costUsd !== null ? Math.round(result.costUsd * MICRO_USD) : null,
      },
    ]).catch((e) => logger.error(`requestLog save failed: ${(e as Error).message}`));

    return result;
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

  @api({ httpMethod: "POST", clients: ["axios", "tanstack-mutation"] })
  async updateToken(id: number, name?: string): Promise<{ updated: boolean }> {
    const entry = await TokenModel.findOne("A", { id });
    if (!entry) return { updated: false };

    await TokenModel.save([
      {
        id: entry.id,
        provider: entry.provider,
        credentials: entry.credentials,
        name: name !== undefined ? name : entry.name,
      },
    ]);
    return { updated: true };
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

    const serverPort = process.env.PORT ?? "44900";
    const redirectUri = `http://localhost:${serverPort}/callback`;
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
      try {
        const raw = (await QgridDispatcher.openaiDispatcher?.getRateLimits(entry.name)) as {
          rateLimits?: {
            primary?: { usedPercent: number; windowDurationMins: number; resetsAt: number };
            secondary?: { usedPercent: number; windowDurationMins: number; resetsAt: number };
          };
        };
        const rl = raw?.rateLimits;
        return {
          provider: "openai",
          fiveHour: rl?.primary
            ? {
                utilization: rl.primary.usedPercent,
                resetsAt: new Date(rl.primary.resetsAt * 1000).toISOString(),
              }
            : null,
          sevenDay: rl?.secondary
            ? {
                utilization: rl.secondary.usedPercent,
                resetsAt: new Date(rl.secondary.resetsAt * 1000).toISOString(),
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
