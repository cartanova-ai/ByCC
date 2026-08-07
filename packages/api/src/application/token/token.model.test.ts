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

  it("applies weight 1 to newly created tokens by default", async () => {
    const { ubRegister } = mockWritePuri();

    await TokenModel.save([baseToken]);

    expect(ubRegister).toHaveBeenCalledWith(
      "tokens",
      expect.objectContaining({ weight: 1 }),
    );
  });

  it("preserves an explicit create weight and does not inject weight into updates", async () => {
    const { ubRegister } = mockWritePuri();

    await TokenModel.save([{ ...baseToken, weight: 4 }, { ...baseToken, id: 1 }]);

    expect(ubRegister.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ weight: 4 }));
    expect(ubRegister.mock.calls[1]?.[1]).not.toHaveProperty("weight");
  });
});

describe("TokenModel.updateFields", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("updates only the supplied columns and returns the affected row count", async () => {
    const update = vi.fn().mockResolvedValue(1);
    const where = vi.fn(() => ({ update }));
    const table = vi.fn(() => ({ where }));
    const transaction = vi.fn(async (callback: (trx: { table: typeof table }) => Promise<number>) =>
      callback({ table }),
    );
    vi.spyOn(TokenModel as unknown as { getPuri: (mode: "w") => MockPuri }, "getPuri")
      .mockReturnValue({ transaction } as unknown as MockPuri);

    await expect(TokenModel.updateFields(1, { weight: 4 })).resolves.toBe(1);

    expect(table).toHaveBeenCalledWith("tokens");
    expect(where).toHaveBeenCalledWith("id", 1);
    expect(update).toHaveBeenCalledWith({ weight: 4 });
  });
});

describe("TokenModel.deactivateIfActive", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockKnex(responses: unknown[]) {
    const raw = vi.fn();
    for (const response of responses) raw.mockResolvedValueOnce(response);
    vi.spyOn(TokenModel as unknown as { getPuri: (mode: "w") => unknown }, "getPuri").mockReturnValue(
      { knex: { raw } } as unknown as MockPuri,
    );
    return raw;
  }

  it("deactivates in one statement that carries the last-token guard", async () => {
    const raw = mockKnex([{ rowCount: 1 }]);

    await expect(TokenModel.deactivateIfActive(7)).resolves.toEqual({
      deactivated: true,
      keptAsLastActive: false,
    });
    expect(raw).toHaveBeenCalledTimes(1);
    const sql = raw.mock.calls[0]![0] as string;
    expect(sql).toContain("UPDATE tokens SET active = false");
    expect(sql).toContain("count(*)");
  });

  it("returns false without a diagnostic read when the token is already inactive", async () => {
    const raw = mockKnex([{ rowCount: 0 }, { rows: [] }]);

    await expect(TokenModel.deactivateIfActive(7)).resolves.toEqual({
      deactivated: false,
      keptAsLastActive: false,
    });
    expect(raw).toHaveBeenCalledTimes(2);
  });

  it("refuses to deactivate the provider's last active token", async () => {
    const raw = mockKnex([{ rowCount: 0 }, { rows: [{ provider: "anthropic" }] }]);

    // 마지막 활성 토큰은 살려두되, 호출부가 systemic 실패로 알릴 수 있게 구분해 알린다.
    await expect(TokenModel.deactivateIfActive(7)).resolves.toEqual({
      deactivated: false,
      keptAsLastActive: true,
    });
    expect(raw).toHaveBeenCalledTimes(2);
  });
});
