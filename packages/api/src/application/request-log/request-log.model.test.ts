import { afterEach, describe, expect, it, vi } from "vitest";

import { RequestLogModel } from "./request-log.model";

function mockQueryBuilder(rows: unknown[]) {
  const chain = {
    select: vi.fn(() => chain),
    where: vi.fn(() => chain),
    whereNotNull: vi.fn(() => chain),
    orderBy: vi.fn(() => chain),
    limit: vi.fn(async () => rows),
  };
  return chain;
}

describe("RequestLogModel TTFT", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reads the first non-null generate-step ttft", async () => {
    const chain = mockQueryBuilder([{ ttft_ms: 42 }]);
    const db = vi.fn(() => chain);
    vi.spyOn(RequestLogModel as unknown as { getDB: () => typeof db }, "getDB").mockReturnValue(
      db,
    );

    await expect(RequestLogModel.firstGenerateStepTtft(7)).resolves.toBe(42);

    expect(db).toHaveBeenCalledWith("request_log_steps");
    expect(chain.where).toHaveBeenCalledWith("request_log_id", 7);
    expect(chain.where).toHaveBeenCalledWith("type", "generate");
    expect(chain.whereNotNull).toHaveBeenCalledWith("ttft_ms");
    expect(chain.orderBy).toHaveBeenNthCalledWith(1, "step_index", "asc");
    expect(chain.orderBy).toHaveBeenNthCalledWith(2, "id", "asc");
  });

  it("returns null when no generate step has ttft", async () => {
    const db = vi.fn(() => mockQueryBuilder([]));
    vi.spyOn(RequestLogModel as unknown as { getDB: () => typeof db }, "getDB").mockReturnValue(
      db,
    );

    await expect(RequestLogModel.firstGenerateStepTtft(7)).resolves.toBeNull();
  });

  it("stores server-derived ttft_ms during finishRun", async () => {
    const ubRegister = vi.fn();
    const transaction = vi.fn(async (cb: (trx: { ubUpsert: () => Promise<number[]> }) => void) =>
      cb({ ubUpsert: vi.fn(async () => [7]) }),
    );
    vi.spyOn(RequestLogModel, "firstGenerateStepTtft").mockResolvedValue(55);
    vi.spyOn(
      RequestLogModel as unknown as { getPuri: () => { ubRegister: typeof ubRegister; transaction: typeof transaction } },
      "getPuri",
    ).mockReturnValue({ ubRegister, transaction });

    await RequestLogModel.finishRun(7, { status: "error", error_message: "boom" });

    expect(ubRegister).toHaveBeenCalledWith(
      "request_logs",
      expect.objectContaining({
        id: 7,
        status: "error",
        error_message: "boom",
        ttft_ms: 55,
      }),
    );
  });

  it("stores zero during finishRun when no generate step has ttft", async () => {
    const ubRegister = vi.fn();
    const transaction = vi.fn(async (cb: (trx: { ubUpsert: () => Promise<number[]> }) => void) =>
      cb({ ubUpsert: vi.fn(async () => [7]) }),
    );
    vi.spyOn(RequestLogModel, "firstGenerateStepTtft").mockResolvedValue(null);
    vi.spyOn(
      RequestLogModel as unknown as { getPuri: () => { ubRegister: typeof ubRegister; transaction: typeof transaction } },
      "getPuri",
    ).mockReturnValue({ ubRegister, transaction });

    await RequestLogModel.finishRun(7, { status: "error", error_message: "boom" });

    expect(ubRegister).toHaveBeenCalledWith(
      "request_logs",
      expect.objectContaining({
        id: 7,
        ttft_ms: 0,
      }),
    );
  });
});
