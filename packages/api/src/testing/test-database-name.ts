import { randomUUID } from "node:crypto";

let configuredRunDatabase: string | undefined;

export function createTestRunDatabaseName(prefix: string, entropy: string): string {
  const safePrefix = prefix.replaceAll(/[^A-Za-z0-9_]/g, "_");
  const safeEntropy = entropy.replaceAll(/[^A-Za-z0-9_]/g, "_");
  const maxPrefixLength = 63 - safeEntropy.length - 1;
  return `${safePrefix.slice(0, maxPrefixLength)}_${safeEntropy}`;
}

export function configureTestRunDatabaseName(): string {
  if (configuredRunDatabase) return configuredRunDatabase;
  const prefix = process.env.QGRID_TEST_RUN_DB ?? "qgrid_test";
  const entropy = `${process.pid}_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
  const runDatabase = createTestRunDatabaseName(prefix, entropy);
  configuredRunDatabase = runDatabase;
  process.env.QGRID_TEST_RUN_DB = runDatabase;
  process.env.QGRID_DB_NAME = runDatabase;
  return runDatabase;
}
