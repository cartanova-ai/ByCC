/**
 * OpenAI PKCE OAuth — codex client_id 빌려쓰기.
 *
 * authorize URL, token exchange, refresh 는 codex-rs/login/src/server.rs 에서 reverse engineer.
 * client_id: app_EMoamEEZ73f0CkXaXp7hrann (codex CLI 등록)
 */
import { randomBytes, createHash } from "node:crypto";

import { getLogger } from "@logtape/logtape";

const logger = getLogger(["qgrid", "openai-oauth"]);

import { OPENAI_CLIENT_ID, OPENAI_ISSUER, OPENAI_SCOPES } from "./openai-constants";

// ── PKCE ────────────────────────────────────────────────────────────

export function generateOpenAIPKCE(): {
  codeVerifier: string;
  codeChallenge: string;
  state: string;
} {
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  const state = randomBytes(16).toString("hex");
  return { codeVerifier, codeChallenge, state };
}

// ── Authorize URL ───────────────────────────────────────────────────

export function buildOpenAIAuthUrl(
  codeChallenge: string,
  state: string,
  redirectUri: string,
): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: OPENAI_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: OPENAI_SCOPES,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    originator: "qgrid",
    state,
  });
  return `${OPENAI_ISSUER}/oauth/authorize?${params}`;
}

// ── Token Exchange ──────────────────────────────────────────────────

export interface OpenAITokens {
  accessToken: string;
  refreshToken: string;
  idToken?: string;
  expiresIn?: number;
  accountId?: string;
}

export async function exchangeOpenAICode(
  code: string,
  codeVerifier: string,
  redirectUri: string,
): Promise<OpenAITokens> {
  const resp = await fetch(`${OPENAI_ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: OPENAI_CLIENT_ID,
      code,
      code_verifier: codeVerifier,
      redirect_uri: redirectUri,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`OpenAI token exchange failed: ${resp.status} ${body}`);
  }

  const data = (await resp.json()) as {
    access_token: string;
    refresh_token: string;
    id_token?: string;
    expires_in?: number;
  };

  let accountId: string | undefined;
  if (data.id_token) {
    try {
      const payload = JSON.parse(
        Buffer.from(data.id_token.split(".")[1]!, "base64url").toString(),
      );
      accountId = payload.sub ?? payload.account_id;
    } catch {
      logger.warn("failed to parse id_token for accountId");
    }
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    idToken: data.id_token,
    expiresIn: data.expires_in,
    accountId,
  };
}
