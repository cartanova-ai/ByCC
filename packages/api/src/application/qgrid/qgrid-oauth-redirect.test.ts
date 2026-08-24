import { Sonamu } from "sonamu";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CONSOLE_CALLBACK_URL } from "./oauth";
import { QgridFrame } from "./qgrid.frame";

const { exchangeMock, openAIExchangeMock, tokenSaveMock, tokenDelMock, findByAccountMock, notifyMock } =
  vi.hoisted(() => ({
  exchangeMock: vi.fn(),
  openAIExchangeMock: vi.fn(),
  tokenSaveMock: vi.fn(async () => [1]),
  tokenDelMock: vi.fn(async () => 1),
  findByAccountMock: vi.fn(async () => []),
  notifyMock: vi.fn(),
}));

// oauthStart 는 PKCE 상태를 cache 에 저장한다 — Map 스텁으로 왕복만 지원한다.
vi.mock("sonamu/cache", () => {
  const store = new Map<string, string>();
  return {
    getCacheManagerRef: () => ({
      set: vi.fn(async ({ key, value }: { key: string; value: string }) => {
        store.set(key, value);
      }),
      get: vi.fn(async ({ key }: { key: string }) => store.get(key)),
      delete: vi.fn(async ({ key }: { key: string }) => {
        store.delete(key);
      }),
    }),
  };
});

vi.mock("./oauth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./oauth")>()),
  exchangeCodeForTokens: exchangeMock,
}));

vi.mock("../../utils/providers/openai/openai-oauth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils/providers/openai/openai-oauth")>()),
  exchangeOpenAICode: openAIExchangeMock,
}));

// The relay binds a real loopback port; these tests only assert which redirect URI is signed in.
vi.mock("../../utils/providers/openai/openai-callback-relay", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils/providers/openai/openai-callback-relay")>()),
  startOpenAICallbackRelay: async () => "http://localhost:1455/auth/callback",
}));

vi.mock("../token/token.model", () => ({
  TokenModel: {
    save: tokenSaveMock,
    del: tokenDelMock,
    findByAccountIdentifier: findByAccountMock,
    // 실제 구현과 같은 순서(dedup → save)로 동작시켜 저장 payload 검증이 유지되게 한다.
    replaceByAccount: async (
      _provider: string,
      accountId: string | undefined,
      saveParams: unknown,
    ) => {
      if (accountId) {
        const olds = (await findByAccountMock()) as unknown as { id: number; active: boolean }[];
        if (olds.length > 0) await tokenDelMock();
      }
      await (tokenSaveMock as unknown as (rows: unknown[]) => Promise<number[]>)([saveParams]);
    },
  },
}));

// OAuth 리다이렉트 테스트는 token-death를 검증하지 않는다. 부분 TokenModel mock이
// isolate:false 워커의 token-death 전용 테스트로 새지 않게 실제 모듈 로드를 막는다.
vi.mock("./token-death", () => ({
  deactivateAuthDeadToken: vi.fn(),
  notifyTokenAdded: notifyMock,
}));

function authUrlParam(authUrl: string, key: string): string | null {
  return new URL(authUrl).searchParams.get(key);
}

function mockHttpContext(headers: Record<string, string>, protocol = "http"): void {
  vi.spyOn(Sonamu, "getContext").mockReturnValue({ headers, request: { protocol } } as never);
}

describe("QgridFrame.oauthStart redirect resolution", () => {
  let savedPort: string | undefined;

  beforeEach(() => {
    savedPort = process.env.PORT;
    delete process.env.PORT;
  });

  afterEach(() => {
    if (savedPort !== undefined) process.env.PORT = savedPort;
    vi.restoreAllMocks();
  });

  it("uses the redirect flow with the request-derived callback on loopback origins", async () => {
    mockHttpContext({ origin: "http://localhost:44900" });

    const { authUrl, mode } = await QgridFrame.oauthStart("tok");
    expect(mode).toBe("redirect");
    expect(authUrlParam(authUrl, "redirect_uri")).toBe("http://localhost:44900/callback");
  });

  it("switches to the code flow with the console callback on remote origins", async () => {
    mockHttpContext({ origin: "https://qgrid.example.com" });

    const { authUrl, mode } = await QgridFrame.oauthStart("tok");
    expect(mode).toBe("code");
    expect(authUrlParam(authUrl, "redirect_uri")).toBe(CONSOLE_CALLBACK_URL);
  });

  it("treats forwarded remote hosts as the code flow when Origin is absent", async () => {
    mockHttpContext({ host: "qgrid.example.com", "x-forwarded-proto": "https" });

    const { authUrl, mode } = await QgridFrame.oauthStart("tok");
    expect(mode).toBe("code");
    expect(authUrlParam(authUrl, "redirect_uri")).toBe(CONSOLE_CALLBACK_URL);
  });

  it("uses the redirect flow for a loopback Host header with a port", async () => {
    mockHttpContext({ host: "localhost:44900" });

    const { authUrl, mode } = await QgridFrame.oauthStart("tok");
    expect(mode).toBe("redirect");
    expect(authUrlParam(authUrl, "redirect_uri")).toBe("http://localhost:44900/callback");
  });

  it("falls back to the localhost redirect flow without an HTTP context", async () => {
    vi.spyOn(Sonamu, "getContext").mockImplementation(() => {
      throw new Error("no context");
    });

    const { authUrl, mode } = await QgridFrame.oauthStart("tok");
    expect(mode).toBe("redirect");
    expect(authUrlParam(authUrl, "redirect_uri")).toBe("http://localhost:44900/callback");
  });
});

describe("QgridFrame.oauthComplete code flow", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    exchangeMock.mockReset();
    tokenSaveMock.mockClear();
    findByAccountMock.mockClear().mockResolvedValue([]);
  });

  it("exchanges a pasted code#state against the stored pending state and saves the token", async () => {
    mockHttpContext({ origin: "https://qgrid.example.com" });
    const { authUrl } = await QgridFrame.oauthStart("test-token-2");
    const state = authUrlParam(authUrl, "state")!;

    exchangeMock.mockResolvedValueOnce({
      accessToken: "at",
      refreshToken: "rt",
      expiresAt: 123,
      scope: "user:inference",
      accountUuid: "acc-1",
    });

    await expect(QgridFrame.oauthComplete(`  the-code#${state} `)).resolves.toEqual({
      added: true,
      name: "test-token-2",
    });

    expect(exchangeMock).toHaveBeenCalledWith(
      "the-code",
      expect.any(String),
      state,
      CONSOLE_CALLBACK_URL,
    );
    expect(tokenSaveMock).toHaveBeenCalledWith([
      expect.objectContaining({
        provider: "anthropic",
        name: "test-token-2",
        credentials: expect.objectContaining({ accessToken: "at", accountUuid: "acc-1" }),
      }),
    ]);
  });

  it("rejects input without a #state part", async () => {
    await expect(QgridFrame.oauthComplete("just-a-code")).rejects.toThrow(/code#state/);
    expect(exchangeMock).not.toHaveBeenCalled();
  });

  it("rejects an unknown or expired state", async () => {
    await expect(QgridFrame.oauthComplete("code#no-such-state")).rejects.toThrow(
      /not found or expired/,
    );
    expect(exchangeMock).not.toHaveBeenCalled();
  });
});

describe("QgridFrame direct OpenAI OAuth", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    openAIExchangeMock.mockReset();
    tokenSaveMock.mockClear();
    tokenDelMock.mockClear();
    findByAccountMock.mockClear().mockResolvedValue([]);
    notifyMock.mockClear();
  });

  it("uses the pinned loopback callback despite hostile forwarding headers", async () => {
    mockHttpContext({ origin: "https://qgrid.example.com" });

    const result = await QgridFrame.oauthStartOpenAI("openai-token");
    const url = new URL(result.authUrl);
    expect(result.mode).toBe("redirect");
    expect(url.origin + url.pathname).toBe("https://auth.openai.com/oauth/authorize");
    // OpenAI only accepts the Codex CLI's registered loopback callbacks.
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:1455/auth/callback");
    expect(url.searchParams.get("state")).toBeTruthy();
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("exchanges an OpenAI callback, replaces the duplicate account, and notifies", async () => {
    mockHttpContext({ origin: "https://qgrid.example.com" });
    const { authUrl } = await QgridFrame.oauthStartOpenAI("openai-token");
    const state = authUrlParam(authUrl, "state")!;
    findByAccountMock.mockResolvedValueOnce([{ id: 9, active: true }] as never);
    openAIExchangeMock.mockResolvedValueOnce({
      accessToken: "access",
      refreshToken: "refresh",
      idToken: "id",
      accessTokenExpiresAt: 123,
      idTokenExpiresAt: 456,
      accountId: "account-1",
      planType: "pro",
    });
    const reply = { redirect: vi.fn() };

    await QgridFrame.handleOAuthCallback("the-code", state, reply as never);

    expect(openAIExchangeMock).toHaveBeenCalledWith(
      "the-code",
      expect.any(String),
      "http://localhost:1455/auth/callback",
    );
    expect(tokenDelMock).toHaveBeenCalledOnce();
    expect(tokenSaveMock).toHaveBeenCalledWith([
      {
        provider: "openai",
        credentials: expect.objectContaining({ accountId: "account-1", planType: "pro" }),
        name: "openai-token",
      },
    ]);
    expect(notifyMock).toHaveBeenCalledWith("openai-token", "openai");
    expect(reply.redirect).toHaveBeenCalledWith("/?oauth=success&name=openai-token");
  });

  it("consumes OpenAI state before a failed exchange", async () => {
    mockHttpContext({ origin: "https://qgrid.example.com" });
    const { authUrl } = await QgridFrame.oauthStartOpenAI("openai-token");
    const state = authUrlParam(authUrl, "state")!;
    openAIExchangeMock.mockRejectedValueOnce(new Error("exchange rejected"));
    const firstReply = { redirect: vi.fn() };
    const secondReply = { redirect: vi.fn() };

    await QgridFrame.handleOAuthCallback("bad-code", state, firstReply as never);
    await QgridFrame.handleOAuthCallback("bad-code", state, secondReply as never);

    expect(firstReply.redirect).toHaveBeenCalledWith("/?oauth=error&reason=exchange_failed");
    expect(secondReply.redirect).toHaveBeenCalledWith("/?oauth=error&reason=invalid_state");
    expect(openAIExchangeMock).toHaveBeenCalledOnce();
  });
});
