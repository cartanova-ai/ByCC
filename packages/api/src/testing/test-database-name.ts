import { randomUUID } from "node:crypto";

let configuredRunDatabase: string | undefined;

export function createTestRunDatabaseName(prefix: string, entropy: string): string {
  const safePrefix = prefix.replaceAll(/[^A-Za-z0-9_]/g, "_");
  const safeEntropy = entropy.replaceAll(/[^A-Za-z0-9_]/g, "_");
  const maxPrefixLength = 63 - safeEntropy.length - 1;
  return `${safePrefix.slice(0, maxPrefixLength)}_${safeEntropy}`;
}

export function configureTestRunDatabaseName(): string {
  if (!configuredRunDatabase) {
    const prefix = process.env.QGRID_TEST_RUN_DB ?? "qgrid_test";
    const entropy = `${process.pid}_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
    configuredRunDatabase = createTestRunDatabaseName(prefix, entropy);
  }

  process.env.QGRID_TEST_RUN_DB = configuredRunDatabase;
  process.env.SONAMU_DB_NAME = configuredRunDatabase;
  return configuredRunDatabase;
}
