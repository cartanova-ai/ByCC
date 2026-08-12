import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildOpenAIAuthUrl,
  exchangeOpenAICode,
  generateOpenAIPKCE,
  parseOpenAITokenClaims,
} from "./openai-oauth";

function jwt(payload: object): string {
  return `e30.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`;
}

afterEach(() => vi.unstubAllGlobals());

describe("OpenAI PKCE OAuth", () => {
  it("builds Codex-compatible PKCE and authorization parameters", () => {
    const pkce = generateOpenAIPKCE();
    const url = new URL(buildOpenAIAuthUrl(pkce.codeChallenge, pkce.state, "https://q/callback"));

    expect(pkce.codeVerifier.length).toBeGreaterThanOrEqual(43);
    expect(url.origin + url.pathname).toBe("https://auth.openai.com/oauth/authorize");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: "code",
      redirect_uri: "https://q/callback",
      code_challenge_method: "S256",
      id_token_add_organizations: "true",
      codex_cli_simplified_flow: "true",
      originator: "codex_cli_rs",
      state: pkce.state,
    });
  });

  it("reads account, plan, and expiration from nested OpenAI JWT claims", () => {
    expect(
      parseOpenAITokenClaims(
        jwt({
          exp: 123,
          "https://api.openai.com/auth": {
            chatgpt_account_id: "account-1",
            chatgpt_plan_type: "pro",
          },
        }),
      ),
    ).toEqual({ expiresAt: 123_000, accountId: "account-1", planType: "pro" });
  });

  it("exchanges the code directly and returns the existing credential shape", async () => {
    const access = jwt({ exp: 200, "https://api.openai.com/auth": {} });
    const id = jwt({
      exp: 300,
      "https://api.openai.com/auth": {
        chatgpt_account_id: "account-1",
        chatgpt_plan_type: "plus",
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ access_token: access, refresh_token: "refresh", id_token: id }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(exchangeOpenAICode("code", "verifier", "https://q/callback")).resolves.toEqual({
      accessToken: access,
      refreshToken: "refresh",
      idToken: id,
      accessTokenExpiresAt: 200_000,
      idTokenExpiresAt: 300_000,
      accountId: "account-1",
      planType: "plus",
    });
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(Object.fromEntries(request.body as URLSearchParams)).toEqual({
      grant_type: "authorization_code",
      code: "code",
      redirect_uri: "https://q/callback",
      client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
      code_verifier: "verifier",
    });
  });

  it("redacts token endpoint response bodies", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response('{"access_token":"secret-access","refresh_token":"secret-refresh"}', { status: 400 }),
    ));
    await expect(exchangeOpenAICode("code", "verifier", "https://q/callback")).rejects.toThrow(
      "OPENAI_TOKEN_EXCHANGE_HTTP_400",
    );
    await expect(exchangeOpenAICode("code", "verifier", "https://q/callback")).rejects.not.toThrow(
      /secret/,
    );
  });
});
