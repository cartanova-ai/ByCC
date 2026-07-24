import { afterEach, describe, expect, it } from "vitest";

import {
  configureTestRunDatabaseName,
  createTestRunDatabaseName,
} from "./test-database-name";

const originalRunDatabase = process.env.QGRID_TEST_RUN_DB;
const originalSonamuDatabase = process.env.SONAMU_DB_NAME;

describe("test run database name", () => {
  afterEach(() => {
    if (originalRunDatabase === undefined) delete process.env.QGRID_TEST_RUN_DB;
    else process.env.QGRID_TEST_RUN_DB = originalRunDatabase;
    if (originalSonamuDatabase === undefined) delete process.env.SONAMU_DB_NAME;
    else process.env.SONAMU_DB_NAME = originalSonamuDatabase;
  });

  it("uses one run-unique basename for setup and Sonamu workers", () => {
    delete process.env.QGRID_TEST_RUN_DB;
    process.env.SONAMU_DB_NAME = "qgrid";

    const runDatabase = configureTestRunDatabaseName();

    expect(runDatabase).toMatch(/^qgrid_test_[A-Za-z0-9_]+$/);
    expect(process.env.QGRID_TEST_RUN_DB).toBe(runDatabase);
    expect(process.env.SONAMU_DB_NAME).toBe(runDatabase);
  });

  it("adds controller-specific entropy when processes share a prefix", () => {
    expect(createTestRunDatabaseName("shared_ci", "controller_1")).toBe(
      "shared_ci_controller_1",
    );
    expect(createTestRunDatabaseName("shared_ci", "controller_2")).toBe(
      "shared_ci_controller_2",
    );
  });
});
