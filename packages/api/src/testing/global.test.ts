import { describe, expect, it, vi } from "vitest";

import {
  dropWorkerDatabases,
  provisionWorkerDatabases,
  recreateWorkerDatabases,
  resolveMaxWorkers,
} from "./global";

describe("parallel test database setup", () => {
  it("recreates worker databases from the template through an admin connection", async () => {
    const query = vi.fn().mockResolvedValue({});

    await recreateWorkerDatabases(
      { query } as never,
      "qgrid_test",
      "qgrid_test_run_a",
      2,
    );

    const sql = query.mock.calls.map(([text]) => String(text).replaceAll(/\s+/g, " ").trim());
    expect(sql).toContain('DROP DATABASE IF EXISTS "qgrid_test_run_a_1"');
    expect(sql).toContain(
      'CREATE DATABASE "qgrid_test_run_a_1" TEMPLATE "qgrid_test" STRATEGY FILE_COPY',
    );
    expect(sql).toContain('DROP DATABASE IF EXISTS "qgrid_test_run_a_2"');
    expect(query).toHaveBeenCalledWith(expect.stringContaining("pg_terminate_backend"), [
      "qgrid_test",
    ]);
  });

  it("terminates worker sessions before dropping worker databases", async () => {
    const query = vi.fn().mockResolvedValue({});

    await dropWorkerDatabases({ query } as never, "qgrid_test_run_a", 1);

    expect(query.mock.calls[0]?.[1]).toEqual(["qgrid_test_run_a_1"]);
    expect(query.mock.calls[1]?.[0]).toBe('DROP DATABASE IF EXISTS "qgrid_test_run_a_1"');
  });

  it("attempts cleanup for every planned database after individual failures", async () => {
    const query = vi.fn(async (text: string, values?: string[]) => {
      if (values?.[0] === "qgrid_test_run_a_1" || text.includes('"qgrid_test_run_a_1"')) {
        throw new Error("db1 cleanup failed");
      }
      return {};
    });

    await expect(
      dropWorkerDatabases({ query } as never, "qgrid_test_run_a", 2),
    ).rejects.toBeInstanceOf(AggregateError);

    expect(query).toHaveBeenCalledWith(expect.stringContaining("pg_terminate_backend"), [
      "qgrid_test_run_a_2",
    ]);
    expect(query).toHaveBeenCalledWith('DROP DATABASE IF EXISTS "qgrid_test_run_a_2"');
  });

  it("uses the worker count resolved by Vitest", () => {
    expect(resolveMaxWorkers({ config: { maxWorkers: 5 } })).toBe(5);
  });

  it("uses a fresh admin connection to clean every planned DB after setup failure", async () => {
    const setupQuery = vi.fn(async (text: string) => {
      if (text.includes('CREATE DATABASE "qgrid_test_run_a_2"')) {
        throw new Error("clone failed");
      }
      return {};
    });
    const cleanupQuery = vi.fn().mockResolvedValue({});
    const createClient = vi
      .fn()
      .mockReturnValueOnce({
        connect: vi.fn().mockResolvedValue(undefined),
        end: vi.fn().mockResolvedValue(undefined),
        query: setupQuery,
      })
      .mockReturnValueOnce({
        connect: vi.fn().mockResolvedValue(undefined),
        end: vi.fn().mockResolvedValue(undefined),
        query: cleanupQuery,
      });

    await expect(
      provisionWorkerDatabases(
        createClient,
        "qgrid_test",
        "qgrid_test_run_a",
        2,
      ),
    ).rejects.toThrow("clone failed");

    const drops = cleanupQuery.mock.calls
      .map(([text]) => String(text).replaceAll(/\s+/g, " ").trim())
      .filter((text) => text.startsWith("DROP DATABASE"));
    expect(createClient).toHaveBeenCalledTimes(2);
    expect(drops).toContain('DROP DATABASE IF EXISTS "qgrid_test_run_a_1"');
    expect(drops).toContain('DROP DATABASE IF EXISTS "qgrid_test_run_a_2"');
  });

  it("preserves both setup and cleanup failures", async () => {
    const setupError = new Error("clone failed");
    const cleanupError = new Error("cleanup failed");
    const createClient = vi
      .fn()
      .mockReturnValueOnce({
        connect: vi.fn().mockResolvedValue(undefined),
        end: vi.fn().mockResolvedValue(undefined),
        query: vi.fn().mockRejectedValue(setupError),
      })
      .mockReturnValueOnce({
        connect: vi.fn().mockResolvedValue(undefined),
        end: vi.fn().mockResolvedValue(undefined),
        query: vi.fn().mockRejectedValue(cleanupError),
      });

    const rejected = provisionWorkerDatabases(
      createClient,
      "qgrid_test",
      "qgrid_test_run_a",
      2,
    ).catch((error: unknown) => error);

    const combinedError = (await rejected) as AggregateError;
    expect(combinedError).toBeInstanceOf(AggregateError);
    expect(combinedError.errors[0]).toBe(setupError);
    expect(combinedError.errors[1]).toBeInstanceOf(AggregateError);
    expect((combinedError.errors[1] as AggregateError).errors).toContain(cleanupError);
  });
});
