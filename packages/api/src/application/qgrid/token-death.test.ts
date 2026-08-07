import { afterEach, describe, expect, it, vi } from "vitest";

import { SLACK_COLOR } from "../../utils/slack-notify";
import { deactivateAuthDeadToken, notifyTokenAdded } from "./token-death";

const { findOneMock, deactivateMock, notifySlackMock } = vi.hoisted(() => ({
  findOneMock: vi.fn(),
  deactivateMock: vi.fn(),
  notifySlackMock: vi.fn(),
}));

vi.mock("../token/token.model", () => ({
  TokenModel: { findOne: findOneMock, deactivateIfActive: deactivateMock },
}));

// SLACK_COLOR 는 상수라 가릴 이유가 없다 — 전송 함수만 스텁한다.
vi.mock("../../utils/slack-notify", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils/slack-notify")>()),
  notifySlack: notifySlackMock,
}));

const token = { id: 7, name: "anthropic/test-token", provider: "anthropic" };

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
    const notification = notifySlackMock.mock.calls[0]![0] as {
      subject: string;
      context: string;
      color: string;
    };
    expect(notification.subject).toBe("anthropic/test-token");
    expect(notification.context).toContain("anthropic:400");
    expect(notification.color).toBe(SLACK_COLOR.bad);
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

    // 필드가 늘어도 새는 곳이 생기지 않도록 페이로드 전체를 훑는다.
    const payload = JSON.stringify(notifySlackMock.mock.calls[0]![0]);
    expect(payload).not.toContain("sk-ant");
    expect(payload).not.toContain("@");
  });
});

describe("notifyTokenAdded", () => {
  afterEach(() => {
    notifySlackMock.mockReset();
  });

  it("sends one added notification naming the token and provider", () => {
    notifyTokenAdded("anthropic/test-token", "anthropic");

    expect(notifySlackMock).toHaveBeenCalledTimes(1);
    const notification = notifySlackMock.mock.calls[0]![0] as {
      subject: string;
      context: string;
      color: string;
    };
    expect(notification.subject).toBe("anthropic/test-token");
    expect(notification.context).toContain("anthropic");
    expect(notification.color).toBe(SLACK_COLOR.good);
  });
});
