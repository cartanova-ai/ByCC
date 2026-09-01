import { afterEach, describe, expect, it, vi } from "vitest";

import { SLACK_COLOR } from "../../utils/slack-notify";
import { deactivateAuthDeadToken, notifyTokenAdded } from "./token-death";

const { deactivateMock, notifySlackMock } = vi.hoisted(() => ({
  deactivateMock: vi.fn(),
  notifySlackMock: vi.fn(),
}));

vi.mock("../token/token.model", () => ({
  TokenModel: { markReauthRequired: deactivateMock },
}));

// SLACK_COLOR 는 상수라 가릴 이유가 없다 — 전송 함수만 스텁한다.
vi.mock("../../utils/slack-notify", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils/slack-notify")>()),
  notifySlack: notifySlackMock,
}));

const token = {
  id: 7,
  name: "anthropic/test-token",
  provider: "anthropic",
  credentials: {
    accessToken: "at",
    refreshToken: "rt-current",
    expiresAt: 0,
    accountUuid: "acc-1",
  },
};

describe("deactivateAuthDeadToken", () => {
  afterEach(() => {
    deactivateMock.mockReset();
    notifySlackMock.mockReset();
  });

  it("deactivates and notifies when the failed attempt used the current refresh token", async () => {
    deactivateMock.mockResolvedValue({
      marked: true,
      keptAsLastActive: false,
      staleCredentials: false,
    });

    await expect(deactivateAuthDeadToken(token, "anthropic:400")).resolves.toBe(true);

    expect(deactivateMock).toHaveBeenCalledWith(7, token.credentials);
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

  it("skips deactivation when credentials rotated since the failed attempt", async () => {
    deactivateMock.mockResolvedValue({
      marked: false,
      keptAsLastActive: false,
      staleCredentials: true,
    });

    await expect(deactivateAuthDeadToken(token, "anthropic:400")).resolves.toBe(false);

    expect(deactivateMock).toHaveBeenCalledWith(7, token.credentials);
    expect(notifySlackMock).not.toHaveBeenCalled();
  });

  it("does not notify when another process won the deactivation race", async () => {
    deactivateMock.mockResolvedValue({
      marked: false,
      keptAsLastActive: false,
      staleCredentials: false,
    });

    await expect(deactivateAuthDeadToken(token, "anthropic:400")).resolves.toBe(false);

    expect(notifySlackMock).not.toHaveBeenCalled();
  });

  it("alerts instead of deactivating when the dying token is the last active one", async () => {
    deactivateMock.mockResolvedValue({
      marked: true,
      keptAsLastActive: true,
      staleCredentials: false,
    });

    await expect(deactivateAuthDeadToken(token, "anthropic:400")).resolves.toBe(false);

    expect(notifySlackMock).toHaveBeenCalledTimes(1);
    const notification = notifySlackMock.mock.calls[0]![0] as { title: string; context: string };
    expect(notification.title).toContain("마지막");
    expect(notification.context).toContain("anthropic:400");
  });

  it("does not repeat a last-active alert after another process records auth death", async () => {
    deactivateMock
      .mockResolvedValueOnce({
        marked: true,
        keptAsLastActive: true,
        staleCredentials: false,
      })
      .mockResolvedValue({
        marked: false,
        keptAsLastActive: false,
        staleCredentials: false,
      });

    await deactivateAuthDeadToken(token, "anthropic:400");
    await deactivateAuthDeadToken(token, "anthropic:400");
    await deactivateAuthDeadToken(token, "anthropic:401");

    expect(notifySlackMock).toHaveBeenCalledTimes(1);
  });

  it("never puts the raw provider error body in the notification", async () => {
    deactivateMock.mockResolvedValue({
      marked: true,
      keptAsLastActive: false,
      staleCredentials: false,
    });

    await deactivateAuthDeadToken(token, "anthropic:400");

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
