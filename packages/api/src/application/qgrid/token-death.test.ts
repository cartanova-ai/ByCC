import { afterEach, describe, expect, it, vi } from "vitest";

import { deactivateAuthDeadToken, notifyTokenRecovered } from "./token-death";

const { findOneMock, deactivateMock, notifySlackMock } = vi.hoisted(() => ({
  findOneMock: vi.fn(),
  deactivateMock: vi.fn(),
  notifySlackMock: vi.fn(),
}));

vi.mock("../token/token.model", () => ({
  TokenModel: { findOne: findOneMock, deactivateIfActive: deactivateMock },
}));

vi.mock("../../utils/slack-notify", () => ({ notifySlack: notifySlackMock }));

const token = { id: 7, name: "anthropic/haze", provider: "anthropic" };

function storedRefreshToken(refreshToken: string) {
  return {
    id: 7,
    provider: "anthropic",
    credentials: { accessToken: "at", refreshToken, expiresAt: 0, accountUuid: "acc-1" },
  };
}

describe("deactivateAuthDeadToken", () => {
  afterEach(() => {
    findOneMock.mockReset();
    deactivateMock.mockReset();
    notifySlackMock.mockReset();
  });

  it("deactivates and notifies when the failed attempt used the current refresh token", async () => {
    findOneMock.mockResolvedValue(storedRefreshToken("rt-current"));
    deactivateMock.mockResolvedValue(true);

    await expect(
      deactivateAuthDeadToken(token, "rt-current", "anthropic:400"),
    ).resolves.toBe(true);

    expect(deactivateMock).toHaveBeenCalledWith(7);
    expect(notifySlackMock).toHaveBeenCalledTimes(1);
    const message = notifySlackMock.mock.calls[0]![0] as string;
    expect(message).toContain("anthropic/haze");
    expect(message).toContain("anthropic:400");
  });

  it("skips deactivation when the refresh token rotated since the failed attempt", async () => {
    findOneMock.mockResolvedValue(storedRefreshToken("rt-rotated"));

    await expect(deactivateAuthDeadToken(token, "rt-stale", "anthropic:400")).resolves.toBe(false);

    expect(deactivateMock).not.toHaveBeenCalled();
    expect(notifySlackMock).not.toHaveBeenCalled();
  });

  it("does not notify when another process won the deactivation race", async () => {
    findOneMock.mockResolvedValue(storedRefreshToken("rt-current"));
    deactivateMock.mockResolvedValue(false);

    await expect(deactivateAuthDeadToken(token, "rt-current", "anthropic:400")).resolves.toBe(
      false,
    );

    expect(notifySlackMock).not.toHaveBeenCalled();
  });

  it("does nothing when the token no longer exists", async () => {
    findOneMock.mockResolvedValue(undefined);

    await expect(deactivateAuthDeadToken(token, "rt-current", "anthropic:400")).resolves.toBe(
      false,
    );

    expect(deactivateMock).not.toHaveBeenCalled();
  });

  it("never puts the raw provider error body in the notification", async () => {
    findOneMock.mockResolvedValue(storedRefreshToken("rt-current"));
    deactivateMock.mockResolvedValue(true);

    await deactivateAuthDeadToken(token, "rt-current", "anthropic:400");

    const message = notifySlackMock.mock.calls[0]![0] as string;
    expect(message).not.toContain("sk-ant");
    expect(message).not.toContain("@");
  });
});

describe("notifyTokenRecovered", () => {
  afterEach(() => {
    notifySlackMock.mockReset();
  });

  it("sends one recovery notification naming the token and provider", () => {
    notifyTokenRecovered("anthropic/haze", "anthropic");

    expect(notifySlackMock).toHaveBeenCalledTimes(1);
    const message = notifySlackMock.mock.calls[0]![0] as string;
    expect(message).toContain("anthropic/haze");
    expect(message).toContain("anthropic");
  });
});
