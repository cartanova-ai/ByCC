import { beforeEach, describe, expect, it, vi } from "vitest";

import { QgridFrame } from "./qgrid.frame";

const { findOneMock, saveMock } = vi.hoisted(() => ({
  findOneMock: vi.fn(),
  saveMock: vi.fn(),
}));

vi.mock("../token/token.model", () => ({
  TokenModel: {
    findOne: findOneMock,
    save: saveMock,
  },
}));

const tokenEntry = {
  id: 1,
  created_at: new Date("2026-06-30T00:00:00.000Z"),
  provider: "anthropic",
  credentials: {
    accessToken: "sk-ant-oat01-test",
    refreshToken: "sk-ant-ort01-test",
    expiresAt: Date.now() + 3_600_000,
    accountUuid: "acc-1",
  },
  name: "tok-A",
  active: true,
  ord: 0,
  quota_threshold: null,
};

describe("QgridFrame.updateToken", () => {
  beforeEach(() => {
    findOneMock.mockReset();
    saveMock.mockReset();
    saveMock.mockResolvedValue([1]);
  });

  it("rejects quota thresholds outside TokenSaveParams bounds before saving", async () => {
    findOneMock.mockResolvedValueOnce(tokenEntry);

    await expect(QgridFrame.updateToken(1, "tok-A", 0)).rejects.toThrow(
      "quotaThreshold must be an integer between 1 and 100, or null",
    );

    expect(saveMock).not.toHaveBeenCalled();
  });

  it("saves valid quota thresholds through the same schema used by token saves", async () => {
    findOneMock.mockResolvedValueOnce(tokenEntry);

    await expect(QgridFrame.updateToken(1, "tok-A", 80)).resolves.toEqual({ updated: true });

    expect(saveMock).toHaveBeenCalledWith([
      expect.objectContaining({
        id: 1,
        name: "tok-A",
        quota_threshold: 80,
      }),
    ]);
  });
});
