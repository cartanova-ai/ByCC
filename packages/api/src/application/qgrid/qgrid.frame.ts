import { getLogger } from "@logtape/logtape";
import { type FastifyReply } from "fastify";
import { api, BaseFrameClass } from "sonamu";

import { MICRO_USD, RequestLogModel } from "../request-log/request-log.model";
import { TokenModel } from "../token/token.model";
import { type RefreshTokenParams } from "../token/token.types";
import {
  buildAuthUrl,
  exchangeCodeForTokens,
  fetchUsage,
  generatePKCE,
  refreshAccessToken,
} from "./oauth";
import { QgridDispatcher } from "./qgrid.dispatcher";
import {
  type CliResult,
  type Effort,
  type HealthResponse,
  type OAuthStartResult,
  type TokenStats,
  type UsageResponse,
} from "./qgrid.types";

const pendingOAuth = new Map<string, { codeVerifier: string; name: string; redirectUri: string }>();
const logger = getLogger(["qgrid"]);
const oauthLogger = getLogger(["qgrid", "oauth"]);

class QgridFrameClass extends BaseFrameClass {
  constructor() {
    super("Qgrid");
  }

  @api({ httpMethod: "POST", clients: ["axios", "tanstack-mutation"] })
  async query(
    prompt: string,
    system?: string,
    timeout?: number,
    model?: string,
    projectName?: string,
    jsonSchema?: string,
    effort?: Effort,
  ): Promise<CliResult> {
    const result = await QgridDispatcher.query(
      { system, prompt, model, jsonSchema, effort },
      timeout,
    );

    RequestLogModel.save([
      {
        token_name: result.tokenName,
        project_name: projectName && projectName.length > 0 ? projectName : null,
        model_name: result.model ?? null,
        user_prompt: prompt,
        system_prompt: system ?? null,
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
  async addToken(token: string, name: string, refreshToken?: string): Promise<{ added: boolean }> {
    await TokenModel.save([
      {
        token,
        name,
        ...(refreshToken && refreshToken.length > 0 ? { refresh_token: refreshToken } : {}),
      },
    ]);
    return { added: true };
  }

  @api({ httpMethod: "POST", clients: ["axios", "tanstack-mutation"] })
  async updateToken(
    token: string,
    name?: string,
    newToken?: string,
    refreshToken?: string,
  ): Promise<{ updated: boolean }> {
    const entry = await TokenModel.findByToken("A", token);
    if (!entry) return { updated: false };

    const hasNewToken = newToken !== undefined && newToken.length > 0;
    const hasRefreshToken = refreshToken !== undefined && refreshToken.length > 0;
    await TokenModel.save([
      {
        id: entry.id,
        token: hasNewToken ? newToken : entry.token,
        name: name !== undefined ? name : entry.name,
        ...(hasRefreshToken ? { refresh_token: refreshToken } : {}),
      },
    ]);
    return { updated: true };
  }

  @api({ httpMethod: "POST", clients: ["axios", "tanstack-mutation"] })
  async removeToken(token: string): Promise<{ removed: boolean }> {
    const entry = await TokenModel.findByToken("A", token);
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
    await TokenModel.save([{ id, token: entry.token, active: newActive, name: entry.name }]);
    return { active: newActive };
  }

  @api({ httpMethod: "POST", clients: ["axios", "tanstack-mutation"] })
  async oauthStart(name: string): Promise<OAuthStartResult> {
    const { codeVerifier, codeChallenge, state } = generatePKCE();

    const serverPort = process.env.PORT ?? "44900";
    const redirectUri = `http://localhost:${serverPort}/callback`;
    const authUrl = buildAuthUrl(codeChallenge, state, redirectUri);

    pendingOAuth.set(state, { codeVerifier, name, redirectUri });
    setTimeout(() => pendingOAuth.delete(state), 300_000);

    return { authUrl };
  }

  async handleOAuthCallback(code: string, state: string, reply: FastifyReply): Promise<void> {
    const pending = pendingOAuth.get(state);
    if (!pending) {
      return reply.redirect("/?oauth=error&reason=invalid_state");
    }
    pendingOAuth.delete(state);

    try {
      const tokens = await exchangeCodeForTokens(
        code,
        pending.codeVerifier,
        state,
        pending.redirectUri,
      );

      if (tokens.accountUuid) {
        const oldEntries = await TokenModel.findByAccountUuid("A", tokens.accountUuid);
        if (oldEntries.length > 0) {
          await TokenModel.del(oldEntries.map((o) => o.id));
        }
      }

      await TokenModel.save([
        {
          token: tokens.accessToken,
          name: pending.name,
          refresh_token: tokens.refreshToken,
          expires_at: tokens.expiresAt ? BigInt(tokens.expiresAt) : null,
          account_uuid: tokens.accountUuid,
        },
      ]);

      return reply.redirect(`/?oauth=success&name=${encodeURIComponent(pending.name)}`);
    } catch (e) {
      return reply.redirect(`/?oauth=error&reason=${encodeURIComponent((e as Error).message)}`);
    }
  }

  @api({ httpMethod: "GET", clients: ["axios", "tanstack-query"] })
  async usage(tokenName?: string): Promise<UsageResponse> {
    const { rows: allTokens } = await TokenModel.findMany("A");
    const entry = tokenName
      ? allTokens.find((e) => e.name === tokenName)
      : allTokens.findLast((e) => e.active);

    if (!entry) return { error: "NOT_FOUND" };

    let accessToken = entry.token;
    const isExpired = entry.expires_at && Number(entry.expires_at) < Date.now();

    if (isExpired && entry.refresh_token) {
      try {
        accessToken = await this.refreshToken(entry);
      } catch (e) {
        oauthLogger.warn(`refresh failed for ${entry.name}: ${(e as Error).message}`);
        return { error: "re-login required" };
      }
    }

    const result = await fetchUsage(accessToken);

    if (result.error && entry.refresh_token) {
      try {
        accessToken = await this.refreshToken(entry);
        return await fetchUsage(accessToken);
      } catch (e) {
        oauthLogger.warn(`refresh failed for ${entry.name}: ${(e as Error).message}`);
        return { error: "re-login required" };
      }
    }

    return result;
  }

  async refreshToken(token: RefreshTokenParams): Promise<string> {
    if (!token.refresh_token) throw new Error("No refresh token");
    const refreshed = await refreshAccessToken(token.refresh_token);
    await TokenModel.save([
      {
        id: token.id,
        token: refreshed.accessToken,
        refresh_token: refreshed.refreshToken,
        expires_at: BigInt(refreshed.expiresAt),
        name: token.name ?? "",
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
