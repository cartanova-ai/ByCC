import { Client, type ClientConfig } from "pg";
import { Sonamu } from "sonamu";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { RequestLogModel } from "./request-log.model";

function mockQueryBuilder(rows: unknown[]) {
  const chain = {
    select: vi.fn(() => chain),
    where: vi.fn(() => chain),
    orderBy: vi.fn(() => chain),
    first: vi.fn(async () => rows[0]),
  };
  return chain;
}

function mockTransactionalWritePuri(transactionPuri: unknown) {
  const transaction = vi.fn(
    async (callback: (trx: unknown) => Promise<unknown>) => callback({}),
  );
  const rootPuri = { knex: { transaction } };
  vi.spyOn(
    RequestLogModel as unknown as { getPuri: (preset: "w") => unknown },
    "getPuri",
  )
    .mockReturnValueOnce(rootPuri)
    .mockReturnValue(transactionPuri);
  return transaction;
}

describe("RequestLogModel TTFT", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reads the first non-null generate-step ttft", async () => {
    const chain = mockQueryBuilder([{ ttft_ms: 42 }]);
    const from = vi.fn(() => chain);
    vi.spyOn(
      RequestLogModel as unknown as { getPuri: () => { from: typeof from } },
      "getPuri",
    ).mockReturnValue({ from });

    await expect(RequestLogModel.firstGenerateStepTtft(7)).resolves.toBe(42);

    expect(from).toHaveBeenCalledWith("request_log_steps");
    expect(chain.where).toHaveBeenCalledWith("request_log_id", 7);
    expect(chain.where).toHaveBeenCalledWith("type", "generate");
    expect(chain.where).toHaveBeenCalledWith("ttft_ms", "!=", null);
    expect(chain.orderBy).toHaveBeenNthCalledWith(1, "step_index", "asc");
    expect(chain.orderBy).toHaveBeenNthCalledWith(2, "id", "asc");
  });

  it("returns null when no generate step has ttft", async () => {
    const from = vi.fn(() => mockQueryBuilder([]));
    vi.spyOn(
      RequestLogModel as unknown as { getPuri: () => { from: typeof from } },
      "getPuri",
    ).mockReturnValue({ from });

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

describe("RequestLogModel run lifecycle", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("stores the requested model and attached tools but no serving model when a run starts", async () => {
    const ubRegister = vi.fn();
    const transaction = vi.fn(
      async (cb: (trx: { ubUpsert: () => Promise<number[]> }) => Promise<number>) =>
        cb({ ubUpsert: vi.fn(async () => [17]) }),
    );
    vi.spyOn(
      RequestLogModel as unknown as {
        getPuri: () => { ubRegister: typeof ubRegister; transaction: typeof transaction };
      },
      "getPuri",
    ).mockReturnValue({ ubRegister, transaction });

    await expect(
      RequestLogModel.createRun({
        user_prompt: "hi",
        requested_model_name: "openai/gpt-5-codex",
        tools: [{ name: "getWeather", description: "Get weather", inputSchema: { type: "object" } }],
      }),
    ).resolves.toBe(17);

    expect(ubRegister).toHaveBeenCalledWith(
      "request_logs",
      expect.objectContaining({
        status: "running",
        requested_model_name: "openai/gpt-5-codex",
        model_name: null,
        tools: [{ name: "getWeather", description: "Get weather", inputSchema: { type: "object" } }],
      }),
    );
  });

  it("finds only stale unresolved tool-wait candidates through Puri", async () => {
    const candidateChain = {
      distinct: vi.fn(),
      join: vi.fn(),
      select: vi.fn(),
      where: vi.fn(),
      limit: vi.fn(async () => [{ id: 7 }]),
    };
    candidateChain.distinct.mockReturnValue(candidateChain);
    candidateChain.join.mockReturnValue(candidateChain);
    candidateChain.select.mockReturnValue(candidateChain);
    candidateChain.where.mockReturnValue(candidateChain);
    const from = vi.fn(() => candidateChain);
    vi.spyOn(
      RequestLogModel as unknown as { getPuri: () => { from: typeof from } },
      "getPuri",
    ).mockReturnValue({ from });

    const threshold = new Date("2026-07-23T00:00:00.000Z");
    await expect(
      RequestLogModel.findStaleToolWaitingRunCandidates(threshold, 10),
    ).resolves.toEqual([7]);

    expect(candidateChain.distinct).toHaveBeenCalledWith("request_logs.id");
    expect(candidateChain.join).toHaveBeenCalledWith(
      "request_log_steps",
      "request_logs.id",
      "request_log_steps.request_log_id",
    );
    expect(candidateChain.where).toHaveBeenCalledWith("request_logs.status", "running");
    expect(candidateChain.where).toHaveBeenCalledWith("request_log_steps.type", "tool_call");
    expect(candidateChain.where).toHaveBeenCalledWith(
      "request_log_steps.created_at",
      "<",
      threshold,
    );
    expect(candidateChain.where).toHaveBeenCalledWith("request_log_steps.tool_result", null);
    expect(candidateChain.where).toHaveBeenCalledWith("request_log_steps.error", null);
  });

  it("expires stale candidates independently", async () => {
    vi.spyOn(Date, "now").mockReturnValue(new Date("2026-07-23T01:00:00.000Z").getTime());
    const findCandidates = vi
      .spyOn(RequestLogModel, "findStaleToolWaitingRunCandidates")
      .mockResolvedValue([7, 8]);
    const tryExpire = vi
      .spyOn(RequestLogModel, "tryExpireStaleToolWaitingRun")
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    await expect(
      RequestLogModel.expireStaleToolWaitingRuns(60_000, "stale tool run"),
    ).resolves.toEqual([7]);

    const threshold = new Date("2026-07-23T00:59:00.000Z");
    expect(findCandidates).toHaveBeenCalledWith(threshold, 10);
    expect(tryExpire).toHaveBeenNthCalledWith(1, 7, threshold, "stale tool run");
    expect(tryExpire).toHaveBeenNthCalledWith(2, 8, threshold, "stale tool run");
  });

  it("expires one stale run only after locking and rechecking its unresolved tool call", async () => {
    const unresolvedChain = {
      select: vi.fn(),
      where: vi.fn(),
      first: vi.fn(async () => ({ id: 101 })),
    };
    unresolvedChain.select.mockReturnValue(unresolvedChain);
    unresolvedChain.where.mockReturnValue(unresolvedChain);

    const aggregateChain = {
      select: vi.fn(),
      where: vi.fn(),
    };
    aggregateChain.select.mockReturnValue(aggregateChain);
    aggregateChain.where
      .mockReturnValueOnce(aggregateChain)
      .mockResolvedValueOnce([
        {
          input_tokens: 10,
          output_tokens: 2,
          cache_read_tokens: 3,
          cache_creation_tokens: 4,
          cache_creation_5m_tokens: 1,
          cache_creation_1h_tokens: 3,
          duration_ms: 90,
          fallback_count: 1,
          cost_usd: 250,
          cost_source: "provider",
        },
      ]);

    const ttftChain = {
      select: vi.fn(),
      where: vi.fn(),
      orderBy: vi.fn(),
      first: vi.fn(async () => ({ ttft_ms: 15 })),
    };
    ttftChain.select.mockReturnValue(ttftChain);
    ttftChain.where.mockReturnValue(ttftChain);
    ttftChain.orderBy.mockReturnValue(ttftChain);

    const updateChain = {
      where: vi.fn(),
      update: vi.fn(async () => 1),
    };
    updateChain.where.mockReturnValue(updateChain);

    const from = vi
      .fn()
      .mockReturnValueOnce(unresolvedChain)
      .mockReturnValueOnce(aggregateChain)
      .mockReturnValueOnce(ttftChain)
      .mockReturnValueOnce(updateChain);
    const raw = vi.fn(async () => ({ rows: [{ acquired: true }] }));
    const transaction = mockTransactionalWritePuri({ knex: { raw }, from });

    await expect(
      RequestLogModel.tryExpireStaleToolWaitingRun(
        7,
        new Date("2026-07-23T00:00:00.000Z"),
        "stale tool run",
      ),
    ).resolves.toBe(true);

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(raw).toHaveBeenCalledWith("SELECT pg_try_advisory_xact_lock(?, ?) AS acquired", [
      718,
      7,
    ]);
    expect(raw.mock.invocationCallOrder[0]).toBeLessThan(
      unresolvedChain.first.mock.invocationCallOrder[0]!,
    );
    expect(unresolvedChain.where).toHaveBeenCalledWith("tool_result", null);
    expect(unresolvedChain.where).toHaveBeenCalledWith("error", null);
    expect(updateChain.update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "error",
        error_message: "stale tool run",
        input_tokens: 10,
        output_tokens: 2,
        cache_read_tokens: 3,
        cache_creation_tokens: 4,
        duration_ms: 90,
        fallback_count: 1,
        cost_usd: 250,
        cost_source: "provider",
        ttft_ms: 15,
      }),
    );
  });

  it("skips a stale candidate when a follow-up already holds its lock", async () => {
    const from = vi.fn();
    const raw = vi.fn(async () => ({ rows: [{ acquired: false }] }));
    const transaction = mockTransactionalWritePuri({ knex: { raw }, from });

    await expect(
      RequestLogModel.tryExpireStaleToolWaitingRun(
        7,
        new Date("2026-07-23T00:00:00.000Z"),
        "stale tool run",
      ),
    ).resolves.toBe(false);

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(from).not.toHaveBeenCalled();
  });

  it("serializes a tool follow-up with stale cleanup in one transaction", async () => {
    const runChain = {
      select: vi.fn(),
      where: vi.fn(),
      first: vi.fn(async () => ({ status: "running" })),
    };
    runChain.select.mockReturnValue(runChain);
    runChain.where.mockReturnValue(runChain);

    const toolChain = {
      where: vi.fn(),
      update: vi.fn(async () => 1),
    };
    toolChain.where.mockReturnValue(toolChain);

    const maxChain = {
      select: vi.fn(),
      where: vi.fn(),
      first: vi.fn(async () => ({ max_step: 4 })),
    };
    maxChain.select.mockReturnValue(maxChain);
    maxChain.where.mockReturnValue(maxChain);

    const from = vi
      .fn()
      .mockReturnValueOnce(runChain)
      .mockReturnValueOnce(toolChain)
      .mockReturnValueOnce(toolChain)
      .mockReturnValueOnce(maxChain);
    const raw = vi.fn(async () => undefined);
    const transaction = mockTransactionalWritePuri({ knex: { raw }, from });

    await expect(
      RequestLogModel.continueToolRun(7, [
        { toolCallId: "call-1", output: "sunny" },
        { toolCallId: "call-2", output: "failed", isError: true },
      ]),
    ).resolves.toBe(5);

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(raw).toHaveBeenCalledWith("SELECT pg_advisory_xact_lock(?, ?)", [718, 7]);
    expect(raw.mock.invocationCallOrder[0]).toBeLessThan(runChain.first.mock.invocationCallOrder[0]!);
    expect(toolChain.update).toHaveBeenNthCalledWith(1, { tool_result: "sunny" });
    expect(toolChain.update).toHaveBeenNthCalledWith(2, { error: "failed" });
  });

});

describe("RequestLogModel cost provenance", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses exact stored cost for rows with a cost source", async () => {
    const chain = {
      where: vi.fn(),
      select: vi.fn(async () => [
        {
          model_name: "claude-opus-4-8",
          input_tokens: 1_000_000,
          output_tokens: 1_000_000,
          cache_read_tokens: 0,
          cache_creation_tokens: 0,
          cache_creation_5m_tokens: null,
          cache_creation_1h_tokens: null,
          cost_usd: 3_000,
          cost_source: "provider",
        },
      ]),
    };
    chain.where.mockReturnValue(chain);
    const from = vi.fn(() => chain);
    vi.spyOn(
      RequestLogModel as unknown as { getPuri: () => { from: typeof from } },
      "getPuri",
    ).mockReturnValue({ from });

    await expect(RequestLogModel.totalCost()).resolves.toBe(0.003);
  });

  it("keeps TTL-aware price-table recomputation for legacy rows", async () => {
    const chain = {
      where: vi.fn(),
      select: vi.fn(async () => [
        {
          model_name: "claude-sonnet-4-6",
          input_tokens: 100_000,
          output_tokens: 0,
          cache_read_tokens: 0,
          cache_creation_tokens: 80_000,
          cache_creation_5m_tokens: 30_000,
          cache_creation_1h_tokens: 50_000,
          cost_usd: null,
          cost_source: null,
        },
      ]),
    };
    chain.where.mockReturnValue(chain);
    const from = vi.fn(() => chain);
    vi.spyOn(
      RequestLogModel as unknown as { getPuri: () => { from: typeof from } },
      "getPuri",
    ).mockReturnValue({ from });

    await expect(RequestLogModel.totalCost()).resolves.toBeCloseTo(0.4725, 10);
  });
});

describe("RequestLogModel PostgreSQL run lock", () => {
  beforeAll(async () => {
    await Sonamu.initForTesting();
  });

  it("does not expire a run while another connection holds its follow-up lock", async () => {
    const wdb = RequestLogModel.getPuri("w");
    const client = new Client(wdb.knex.client.config.connection as ClientConfig);
    const requestLogId = 987_654_321;
    let connected = false;

    try {
      await client.connect();
      connected = true;
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1, $2)", [718, requestLogId]);

      const threshold = new Date(Date.now() + 60_000);
      await expect(
        RequestLogModel.tryExpireStaleToolWaitingRun(
          requestLogId,
          threshold,
          "stale tool run",
        ),
      ).resolves.toBe(false);
    } finally {
      if (connected) {
        await client.query("ROLLBACK").catch(() => {});
        await client.end().catch(() => {});
      }
    }
  });
});
