import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { findOneMock, saveMock, deactivateMock } = vi.hoisted(() => ({
  findOneMock: vi.fn(),
  saveMock: vi.fn(),
  deactivateMock: vi.fn(),
}));

vi.mock("../../../application/token/token.model", () => ({
  TokenModel: { findOne: findOneMock, save: saveMock },
}));
vi.mock("../../../application/qgrid/token-death", () => ({
  deactivateAuthDeadToken: deactivateMock,
}));

import { handleChatgptAuthTokensRefresh } from "./openai-refresh";

function token(id: number) {
  return {
    id,
    provider: "openai",
    name: `token-${id}`,
    credentials: {
      accessToken: "old-access",
      refreshToken: "old-refresh",
      idToken: "old-id",
      accessTokenExpiresAt: 1,
      accountId: "account-1",
      planType: "pro",
    },
  };
}

describe("OpenAI refresh", () => {
  beforeEach(() => {
    findOneMock.mockReset();
    saveMock.mockReset().mockResolvedValue([1]);
    deactivateMock.mockReset();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("deduplicates concurrent refreshes and persists refresh-token rotation", async () => {
    findOneMock.mockResolvedValue(token(10));
    let resolveFetch!: (response: Response) => void;
    const fetchMock = vi.fn(
      (_input: string | URL | Request, _init?: RequestInit) =>
        new Promise<Response>((resolve) => (resolveFetch = resolve)),
    );
    vi.stubGlobal("fetch", fetchMock);

    const first = handleChatgptAuthTokensRefresh(10);
    const second = handleChatgptAuthTokensRefresh(10);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    resolveFetch(
      new Response(
        JSON.stringify({
          access_token: "new-access",
          refresh_token: "new-refresh",
          id_token: "new-id",
          expires_in: 60,
        }),
        { status: 200 },
      ),
    );

    await expect(Promise.all([first, second])).resolves.toEqual([
      { accessToken: "new-access", chatgptAccountId: "account-1", chatgptPlanType: "pro" },
      { accessToken: "new-access", chatgptAccountId: "account-1", chatgptPlanType: "pro" },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect((request.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/x-www-form-urlencoded",
    );
    expect(Object.fromEntries(request.body as URLSearchParams)).toEqual({
      grant_type: "refresh_token",
      client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
      refresh_token: "old-refresh",
    });
    expect(saveMock).toHaveBeenCalledWith([
      expect.objectContaining({
        id: 10,
        credentials: expect.objectContaining({
          accessToken: "new-access",
          refreshToken: "new-refresh",
          idToken: "new-id",
        }),
      }),
    ]);
  });

  it("uses current stored credentials during the five-second refresh interval", async () => {
    findOneMock.mockResolvedValue(token(10));
    vi.stubGlobal("fetch", vi.fn());

    await expect(handleChatgptAuthTokensRefresh(10)).resolves.toEqual({
      accessToken: "old-access",
      chatgptAccountId: "account-1",
      chatgptPlanType: "pro",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("deactivates credentials on an explicit permanent failure code", async () => {
    findOneMock.mockResolvedValue(token(11));
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "refresh_token_reused" }), { status: 401 }),
      ),
    );

    await expect(handleChatgptAuthTokensRefresh(11)).rejects.toThrow("OpenAI refresh failed: 401");
    expect(deactivateMock).toHaveBeenCalledWith(
      { id: 11, name: "token-11", provider: "openai" },
      "old-refresh",
      "openai:refresh_token_reused",
    );
  });
});
