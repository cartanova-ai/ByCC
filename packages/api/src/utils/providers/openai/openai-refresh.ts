/**
 * OpenAI chatgptAuthTokens refresh handler.
 *
 * - direct HTTPS/WS transport가 401 refresh를 소유하고 저장된 refresh token으로 갱신함
 * - qgrid 가 DB 의 refresh_token 으로 새 access_token 을 발급받아 응답
 * - per-token inflight promise 로 concurrent refresh dedup
 * - rotation 감지: 새 refresh_token 있으면 DB 즉시 업데이트
 */
import { getLogger } from "@logtape/logtape";

import { deactivateAuthDeadToken } from "../../../application/qgrid/token-death";
import { TokenModel } from "../../../application/token/token.model";
import { type OpenAICredentials } from "../../../application/token/token.types";

const logger = getLogger(["qgrid", "openai-refresh"]);

import { OPENAI_CLIENT_ID, OPENAI_TOKEN_URL } from "./openai-constants";

// 재로그인 외 복구 불가한 refresh 실패 코드. 어느 것이든 토큰이 죽었다는 확정 신호다.
const PERMANENT_FAILURE_CODES = new Set([
  "refresh_token_expired",
  "refresh_token_reused",
  "refresh_token_invalidated",
]);

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
  logger.info(`refresh requested for token ${tokenId} (pid=${process.pid})`);
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
    // 토큰 엔드포인트는 OAuth 표준 form 인코딩 계약을 강제한다. JSON 으로 보내면
    // access token 만료 후의 모든 refresh 가 거부되어 토큰이 통째로 죽는다.
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: OPENAI_CLIENT_ID,
      refresh_token: creds.refreshToken,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    // 401 본문의 error 코드가 토큰 사망의 결정적 사인이다.
    //   refresh_token_expired     → refresh_token 자체 만료
    //   refresh_token_reused      → 이미 사용된(회전 폐기된) refresh_token 재사용 → 패밀리 무효화
    //   refresh_token_invalidated → 서버측 revoke
    // 위 3개는 모두 영구 실패. 재등록 외 복구 불가.
    let errorCode: string | undefined;
    try {
      errorCode = (JSON.parse(body) as { error?: string }).error;
    } catch {}
    logger.error(
      `OpenAI refresh FAILED token=${token.name}(id=${tokenId}) status=${resp.status} ` +
        `code=${errorCode ?? "?"} body=${body}`,
    );
    // 영구 실패는 errorCode 로만 판정한다 — status 를 함께 요구하면 provider 가
    // 상태코드를 바꿀 때 판정이 조용히 멎는다.
    if (errorCode && PERMANENT_FAILURE_CODES.has(errorCode)) {
      await deactivateAuthDeadToken(
        { id: tokenId, name: token.name, provider: "openai", credentials: creds },
        `openai:${errorCode}`,
      );
    }
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

  // 회전(rotated)이 일어났는데 이 save 가 실패하면, OpenAI 쪽 옛 refresh_token 은 이미
  // 폐기된 상태에서 DB 에는 옛 토큰이 남는다 → 다음 refresh 가 refresh_token_reused 로
  // 영구 사망. 이 구간 실패는 토큰 사망의 직접 원인이므로 반드시 크게 남긴다.
  try {
    await TokenModel.save([
      {
        id: tokenId,
        provider: "openai",
        credentials: updatedCreds,
        name: token.name,
        reauth_required: false,
      },
    ]);
  } catch (e) {
    logger.error(
      `OpenAI refresh: DB save FAILED after rotation(rotated=${rotated}) ` +
        `token=${token.name}(id=${tokenId}) — 옛 refresh_token 폐기됨, DB 미반영 → 토큰 사망 위험. err=${String(e)}`,
    );
    throw e;
  }

  logger.info(`token ${token.name} refreshed successfully (rotated=${rotated})`);

  return {
    accessToken: data.access_token,
    chatgptAccountId: creds.accountId,
    chatgptPlanType: creds.planType,
  };
}
