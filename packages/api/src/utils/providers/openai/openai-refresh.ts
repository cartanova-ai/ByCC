/**
 * OpenAI chatgptAuthTokens refresh handler.
 *
 * - codex app-server 가 401 받으면 `account/chatgptAuthTokens/refresh` server-request 를 보냄
 * - qgrid 가 DB 의 refresh_token 으로 새 access_token 을 발급받아 응답
 * - per-token inflight promise 로 concurrent refresh dedup
 * - rotation 감지: 새 refresh_token 있으면 DB 즉시 업데이트
 */
import { getLogger } from "@logtape/logtape";

import { TokenModel } from "../../../application/token/token.model";
import { type OpenAICredentials } from "../../../application/token/token.types";

const logger = getLogger(["qgrid", "openai-refresh"]);

import { OPENAI_CLIENT_ID, OPENAI_TOKEN_URL } from "./openai-constants";

// per-token inflight promise dedup + minimum interval
const inflightRefresh = new Map<number, Promise<RefreshResult>>();
const lastRefreshTime = new Map<number, number>();
const REFRESH_MIN_INTERVAL_MS = 5_000;

interface RefreshResult {
  accessToken: string;
  chatgptAccountId: string;
  chatgptPlanType?: string;
}

export async function handleChatgptAuthTokensRefresh(tokenId: number): Promise<RefreshResult> {
  const existing = inflightRefresh.get(tokenId);
  if (existing) {
    logger.info(`refresh dedup for token ${tokenId}`);
    return existing;
  }

  const lastAt = lastRefreshTime.get(tokenId) ?? 0;
  if (Date.now() - lastAt < REFRESH_MIN_INTERVAL_MS) {
    logger.info(`refresh too soon for token ${tokenId}, reading current creds from DB`);
    return readCurrentCreds(tokenId);
  }

  lastRefreshTime.set(tokenId, Date.now());
  const promise = doRefresh(tokenId);
  inflightRefresh.set(tokenId, promise);

  try {
    return await promise;
  } finally {
    inflightRefresh.delete(tokenId);
  }
}

async function readCurrentCreds(tokenId: number): Promise<RefreshResult> {
  const token = await TokenModel.findOne("A", { id: tokenId });
  if (!token || token.provider !== "openai") throw new Error(`token ${tokenId} not found`);
  const creds = token.credentials as OpenAICredentials;
  return {
    accessToken: creds.accessToken,
    chatgptAccountId: creds.accountId,
    chatgptPlanType: creds.planType,
  };
}

async function doRefresh(tokenId: number): Promise<RefreshResult> {
  const token = await TokenModel.findOne("A", { id: tokenId });
  if (!token || token.provider !== "openai") {
    throw new Error(`token ${tokenId} not found or not openai`);
  }

  const creds = token.credentials as OpenAICredentials;
  if (!creds.refreshToken) {
    throw new Error(`token ${tokenId} has no refreshToken`);
  }

  logger.info(`refreshing token ${token.name} (id=${tokenId})`);

  const resp = await fetch(OPENAI_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: OPENAI_CLIENT_ID,
      refresh_token: creds.refreshToken,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`OpenAI refresh failed: ${resp.status} ${body}`);
  }

  const data = (await resp.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    id_token?: string;
  };

  const newRefreshToken = data.refresh_token ?? creds.refreshToken;
  const rotated =
    data.refresh_token !== null &&
    data.refresh_token !== undefined &&
    data.refresh_token !== creds.refreshToken;
  if (rotated) {
    logger.info(`refresh_token rotated for token ${token.name}`);
  }

  const updatedCreds: OpenAICredentials = {
    ...creds,
    accessToken: data.access_token,
    refreshToken: newRefreshToken,
    accessTokenExpiresAt: data.expires_in
      ? Date.now() + data.expires_in * 1000
      : creds.accessTokenExpiresAt,
    ...(data.id_token ? { idToken: data.id_token } : {}),
  };

  await TokenModel.save([
    {
      id: tokenId,
      provider: "openai",
      credentials: updatedCreds,
      name: token.name,
    },
  ]);

  logger.info(`token ${token.name} refreshed successfully`);

  return {
    accessToken: data.access_token,
    chatgptAccountId: creds.accountId,
    chatgptPlanType: creds.planType,
  };
}
