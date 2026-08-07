/**
 * OAuth 유틸 — Claude Code 소스의 OAuth 플로우 그대로 재현
 */
import { createHash, randomBytes } from "node:crypto";

import { getLogger } from "@logtape/logtape";

export type AnthropicUsageRaw = {
  error?: string;
  five_hour?: { utilization: number | null; resets_at: string | null } | null;
  seven_day?: { utilization: number | null; resets_at: string | null } | null;
};
export type AnthropicUsageWithMeta = {
  data: AnthropicUsageRaw;
  cachedAt: number;
};

const logger = getLogger(["qgrid", "oauth"]);

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const AUTHORIZE_URL = "https://claude.com/cai/oauth/authorize";
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
// client 허용 목록에 있는 콘솔 콜백. 인증 후 콘솔 페이지가 `code#state`를 표시하고
// 사용자가 붙여넣는 코드 플로우(Claude Code CLI와 동일)에 사용한다.
export const CONSOLE_CALLBACK_URL = "https://console.anthropic.com/oauth/code/callback";

// login 시 사용 (authorize URL)
const ALL_SCOPES = [
  "org:create_api_key",
  "user:profile",
  "user:inference",
  "user:sessions:claude_code",
  "user:mcp_servers",
  "user:file_upload",
];

// refresh 시 사용 (org:create_api_key 제외)
const REFRESH_SCOPES = [
  "user:profile",
  "user:inference",
  "user:sessions:claude_code",
  "user:mcp_servers",
  "user:file_upload",
];

function base64URLEncode(buffer: Buffer): string {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

export function generatePKCE(): { codeVerifier: string; codeChallenge: string; state: string } {
  const codeVerifier = base64URLEncode(randomBytes(32));
  const codeChallenge = base64URLEncode(createHash("sha256").update(codeVerifier).digest());
  const state = base64URLEncode(randomBytes(32));
  return { codeVerifier, codeChallenge, state };
}

export function buildAuthUrl(codeChallenge: string, state: string, redirectUri: string): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.append("code", "true");
  url.searchParams.append("client_id", CLIENT_ID);
  url.searchParams.append("response_type", "code");
  url.searchParams.append("redirect_uri", redirectUri);
  url.searchParams.append("scope", ALL_SCOPES.join(" "));
  url.searchParams.append("code_challenge", codeChallenge);
  url.searchParams.append("code_challenge_method", "S256");
  url.searchParams.append("state", state);
  return url.toString();
}

export type OAuthTokens = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scope: string;
  accountUuid?: string;
  emailAddress?: string;
};

export async function exchangeCodeForTokens(
  code: string,
  codeVerifier: string,
  state: string,
  redirectUri: string,
): Promise<OAuthTokens> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: CLIENT_ID,
      code_verifier: codeVerifier,
      state,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    scope: string;
    account?: { uuid: string; email_address: string };
  };

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
    scope: data.scope,
    accountUuid: data.account?.uuid,
    emailAddress: data.account?.email_address,
  };
}

export async function refreshAccessToken(refreshToken: string): Promise<OAuthTokens> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
      scope: REFRESH_SCOPES.join(" "),
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token refresh failed (${res.status}): ${text}`);
  }
  const data = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    scope: string;
  };

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? refreshToken,
    expiresAt: Date.now() + data.expires_in * 1000,
    scope: data.scope,
  };
}

const usageCache: Record<string, AnthropicUsageWithMeta> = {};
const USAGE_API_CACHE_TTL = 60_000; // 1분

export async function fetchUsage(accessToken: string): Promise<AnthropicUsageRaw> {
  return (await fetchUsageWithMeta(accessToken)).data;
}

export async function fetchUsageWithMeta(accessToken: string): Promise<AnthropicUsageWithMeta> {
  const cacheKey = accessToken.slice(-10);
  const cached = usageCache[cacheKey];
  if (cached && Date.now() - cached.cachedAt < USAGE_API_CACHE_TTL) {
    return cached;
  }

  const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "anthropic-beta": "oauth-2025-04-20",
    },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) {
    const text = await res.text();

    // 파싱 시도해서 에러 메시지 추출
    let errorMessage = `Error ${res.status}`;
    try {
      const parsed = JSON.parse(text);
      errorMessage = parsed.error?.message ?? errorMessage;
    } catch {
      // 파싱 안 되면 기본 메시지
    }

    logger.warn(`${res.status}: ${errorMessage}`);

    // 이전 성공 캐시 있으면 유지
    if (cached?.data && !cached.data.error) return cached;

    // 실패도 캐시 (반복 호출 방지)
    const errorResult = { error: errorMessage };
    const entry = { data: errorResult, cachedAt: Date.now() };
    usageCache[cacheKey] = entry;
    return entry;
  }

  const data = (await res.json()) as AnthropicUsageRaw;
  // cache invalidate
  const entry = { data, cachedAt: Date.now() };
  usageCache[cacheKey] = entry;
  return entry;
}
