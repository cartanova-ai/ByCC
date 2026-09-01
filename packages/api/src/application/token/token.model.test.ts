import { randomUUID } from "node:crypto";

import { Sonamu } from "sonamu";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

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

describe("TokenModel.replaceByAccount", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("re-login으로 row가 교체돼도 기존 keepalive 선택을 보존한다", async () => {
    vi.spyOn(TokenModel, "findByAccountIdentifier").mockResolvedValue([
      {
        id: 1,
        created_at: new Date(),
        active: true,
        reauth_required: false,
        ord: 0,
        quota_threshold: 80,
        weight: 1,
        keepalive_enabled: true,
        ...baseToken,
      },
    ]);
    vi.spyOn(TokenModel, "del").mockResolvedValue(1);
    const save = vi.spyOn(TokenModel, "save").mockResolvedValue([2]);

    await TokenModel.replaceByAccount("anthropic", "acc-1", baseToken);

    expect(save).toHaveBeenCalledWith([
      expect.objectContaining({ keepalive_enabled: true }),
    ]);
  });
});

describe("TokenModel.findActiveByProviderAndName", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("active·provider·name 세 조건으로 단일 토큰을 조회한다", async () => {
    const where = vi.fn();
    const qb = { where };
    const row = { id: 7, active: true, ...baseToken };
    vi.spyOn(
      TokenModel as unknown as { getSubsetQueries: (subset: "A") => { qb: typeof qb } },
      "getSubsetQueries",
    ).mockReturnValue({ qb });
    const executeSubsetQuery = vi
      .spyOn(
        TokenModel as unknown as {
          executeSubsetQuery: (input: unknown) => Promise<{ rows: typeof row[] }>;
        },
        "executeSubsetQuery",
      )
      .mockResolvedValue({ rows: [row] });

    await expect(
      TokenModel.findActiveByProviderAndName("A", "anthropic", "anthropic/tok-A"),
    ).resolves.toBe(row);

    expect(where.mock.calls).toEqual([
      ["tokens.active", true],
      ["tokens.provider", "anthropic"],
      ["tokens.name", "anthropic/tok-A"],
    ]);
    expect(executeSubsetQuery).toHaveBeenCalledWith(
      expect.objectContaining({ subset: "A", qb, params: { num: 1, page: 1 } }),
    );
  });
});

describe("TokenModel.findReauthRequired", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("queries auth-dead tokens instead of every inactive token", async () => {
    const where = vi.fn();
    const orderBy = vi.fn();
    const qb = { where, orderBy };
    vi.spyOn(
      TokenModel as unknown as { getSubsetQueries: (subset: "A") => { qb: typeof qb } },
      "getSubsetQueries",
    ).mockReturnValue({ qb });
    vi.spyOn(
      TokenModel as unknown as {
        executeSubsetQuery: (input: unknown) => Promise<{ rows: unknown[] }>;
      },
      "executeSubsetQuery",
    ).mockResolvedValue({ rows: [] });

    await TokenModel.findReauthRequired("A");

    expect(where).toHaveBeenCalledWith("tokens.reauth_required", true);
    expect(where).not.toHaveBeenCalledWith("tokens.active", false);
  });
});

describe("TokenModel.markReauthRequired", () => {
  beforeAll(async () => {
    await Sonamu.initForTesting();
  });

  it("serializes provider deaths, preserves one active token, and rejects stale credentials", async () => {
    const suffix = randomUUID();
    const tokens = [
      {
        ...baseToken,
        name: `auth-state-a-${suffix}`,
        credentials: { ...baseToken.credentials, accountUuid: `account-a-${suffix}` },
      },
      {
        ...baseToken,
        name: `auth-state-b-${suffix}`,
        credentials: { ...baseToken.credentials, accountUuid: `account-b-${suffix}` },
      },
    ];
    const ids = await TokenModel.save(tokens);

    try {
      await expect(
        TokenModel.markReauthRequired(ids[0]!, {
          ...tokens[0]!.credentials,
          accessToken: "stale-access-token",
        }),
      ).resolves.toEqual({
        marked: false,
        keptAsLastActive: false,
        staleCredentials: true,
      });

      const results = await Promise.all([
        TokenModel.markReauthRequired(ids[0]!, tokens[0]!.credentials),
        TokenModel.markReauthRequired(ids[1]!, tokens[1]!.credentials),
      ]);
      expect(results.every((result) => result.marked)).toBe(true);

      const { rows } = await TokenModel.findMany("A", { id: ids, num: 2 });
      expect(rows.every((row) => row.reauth_required)).toBe(true);
      expect(rows.filter((row) => row.active)).toHaveLength(1);

      await expect(
        TokenModel.markReauthRequired(ids[0]!, tokens[0]!.credentials),
      ).resolves.toEqual({
        marked: false,
        keptAsLastActive: false,
        staleCredentials: false,
      });

      const inactive = rows.find((row) => !row.active)!;
      const refreshedCredentials = {
        ...inactive.credentials,
        accessToken: "refreshed-access-token",
        refreshToken: "refreshed-refresh-token",
      };
      await TokenModel.save([
        {
          id: inactive.id,
          provider: inactive.provider,
          credentials: refreshedCredentials,
          name: inactive.name,
          reauth_required: false,
        },
      ]);
      await expect(
        TokenModel.markReauthRequired(inactive.id, inactive.credentials),
      ).resolves.toEqual({
        marked: false,
        keptAsLastActive: false,
        staleCredentials: true,
      });

      await expect(TokenModel.toggleActive(inactive.id)).resolves.toEqual({
        active: true,
        reauthRequired: false,
      });
      await TokenModel.toggleActive(inactive.id);
      await Promise.all([
        TokenModel.toggleActive(inactive.id),
        TokenModel.markReauthRequired(inactive.id, refreshedCredentials),
      ]);
      await expect(TokenModel.findById("A", inactive.id)).resolves.toMatchObject({
        active: false,
        reauth_required: true,
      });
    } finally {
      await TokenModel.del(ids);
    }
  });
});
