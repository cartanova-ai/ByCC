import { Sonamu } from "sonamu";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { QgridFrame } from "./qgrid.frame";

// oauthStart 는 PKCE 상태를 cache 에 저장한다 — redirect 파생 검증에는 실제 cache 가 필요 없다.
vi.mock("sonamu/cache", () => ({
  getCacheManagerRef: () => ({
    set: vi.fn(async () => {}),
    get: vi.fn(async () => undefined),
    delete: vi.fn(async () => {}),
  }),
}));

function redirectUriOf(authUrl: string): string | null {
  return new URL(authUrl).searchParams.get("redirect_uri");
}

describe("QgridFrame.oauthStart redirect derivation", () => {
  let savedPort: string | undefined;

  beforeEach(() => {
    savedPort = process.env.PORT;
    delete process.env.PORT;
  });

  afterEach(() => {
    if (savedPort !== undefined) process.env.PORT = savedPort;
    vi.restoreAllMocks();
  });

  it("derives the callback from the browser-sent Origin header", async () => {
    vi.spyOn(Sonamu, "getContext").mockReturnValue({
      headers: { origin: "https://qgrid.example.com" },
      request: { protocol: "https" },
    } as never);

    const { authUrl } = await QgridFrame.oauthStart("tok");
    expect(redirectUriOf(authUrl)).toBe("https://qgrid.example.com/callback");
  });

  it("falls back to forwarded proto and host headers when Origin is absent", async () => {
    vi.spyOn(Sonamu, "getContext").mockReturnValue({
      headers: { host: "dev0.cartanova.ai:44900", "x-forwarded-proto": "https" },
      request: { protocol: "http" },
    } as never);

    const { authUrl } = await QgridFrame.oauthStart("tok");
    expect(redirectUriOf(authUrl)).toBe("https://dev0.cartanova.ai:44900/callback");
  });

  it("falls back to localhost without an HTTP context", async () => {
    vi.spyOn(Sonamu, "getContext").mockImplementation(() => {
      throw new Error("no context");
    });

    const { authUrl } = await QgridFrame.oauthStart("tok");
    expect(redirectUriOf(authUrl)).toBe("http://localhost:44900/callback");
  });
});
