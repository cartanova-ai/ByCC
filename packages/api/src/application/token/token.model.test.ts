import { afterEach, describe, expect, it, vi } from "vitest";

import { TokenModel } from "./token.model";

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

type MockPuri = {
  ubRegister: ReturnType<typeof vi.fn>;
  transaction: ReturnType<typeof vi.fn>;
};

function mockWritePuri() {
  const ubRegister = vi.fn();
  const ubUpsert = vi.fn(async () => [1]);
  const transaction = vi.fn(
    async (cb: (trx: { ubUpsert: typeof ubUpsert }) => Promise<number[]>) =>
      cb({ ubUpsert }),
  );
  vi.spyOn(TokenModel as unknown as { getPuri: (mode: "w") => MockPuri }, "getPuri")
    .mockReturnValue({ ubRegister, transaction });

  return { ubRegister, ubUpsert, transaction };
}

describe("TokenModel.save", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("applies 80% quota threshold to newly created tokens by default", async () => {
    const { ubRegister } = mockWritePuri();

    await TokenModel.save([baseToken]);

    expect(ubRegister).toHaveBeenCalledWith(
      "tokens",
      expect.objectContaining({ quota_threshold: 80 }),
    );
  });

  it("preserves explicit null quota threshold on newly created tokens", async () => {
    const { ubRegister } = mockWritePuri();

    await TokenModel.save([{ ...baseToken, quota_threshold: null }]);

    expect(ubRegister).toHaveBeenCalledWith(
      "tokens",
      expect.objectContaining({ quota_threshold: null }),
    );
  });

  it("does not inject a quota threshold into existing token updates", async () => {
    const { ubRegister } = mockWritePuri();

    await TokenModel.save([{ ...baseToken, id: 1 }]);

    const saved = ubRegister.mock.calls[0]?.[1];
    expect(saved).not.toHaveProperty("quota_threshold");
  });
});
