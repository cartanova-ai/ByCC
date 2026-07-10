import { describe, expect, it } from "vitest";

import { TokenSaveParams } from "./token.types";

const baseToken = {
  provider: "anthropic",
  credentials: {
    accessToken: "sk-ant-oat01-test",
    refreshToken: "sk-ant-ort01-test",
    expiresAt: Date.now() + 3_600_000,
    accountUuid: "acc-1",
  },
  name: "tok-A",
};

describe("TokenSaveParams", () => {
  it("keeps quota_threshold optional for existing token saves", () => {
    const parsed = TokenSaveParams.parse(baseToken);

    expect(parsed).not.toHaveProperty("quota_threshold");
  });

  it("accepts valid nullable quota_threshold values", () => {
    expect(TokenSaveParams.parse({ ...baseToken, quota_threshold: 80 }).quota_threshold).toBe(80);
    expect(
      TokenSaveParams.parse({ ...baseToken, quota_threshold: null }).quota_threshold,
    ).toBeNull();
  });

  it("rejects quota_threshold values outside 1..100", () => {
    expect(() => TokenSaveParams.parse({ ...baseToken, quota_threshold: 0 })).toThrow();
    expect(() => TokenSaveParams.parse({ ...baseToken, quota_threshold: 101 })).toThrow();
  });

  it("accepts integer weights from 1 through 100", () => {
    expect(TokenSaveParams.parse({ ...baseToken, weight: 1 }).weight).toBe(1);
    expect(TokenSaveParams.parse({ ...baseToken, weight: 100 }).weight).toBe(100);
  });

  it("rejects invalid weights", () => {
    for (const weight of [0, 101, 1.5]) {
      expect(() => TokenSaveParams.parse({ ...baseToken, weight })).toThrow();
    }
  });
});
