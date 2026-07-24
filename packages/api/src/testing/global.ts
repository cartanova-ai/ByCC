import dotenv from "dotenv";
import { Client } from "pg";

dotenv.config();

const MAX_WORKERS = 4;
const TEMPLATE_DB = process.env.QGRID_TEST_DB_NAME ?? "qgrid_test";

type QueryClient = Pick<Client, "query">;
type AdminClient = Pick<Client, "connect" | "end" | "query">;
type AdminClientFactory = () => AdminClient;
type VitestProject = { config?: { maxWorkers?: number } };

function quoteIdentifier(value: string): string {
  if (!/^[A-Za-z0-9_]+$/.test(value)) {
    throw new Error(`invalid database identifier: ${value}`);
  }
  return `"${value}"`;
}

function workerDatabaseNames(templateDb: string, maxWorkers: number): string[] {
  return Array.from({ length: maxWorkers }, (_, index) => `${templateDb}_${index + 1}`);
}

async function terminateConnections(client: QueryClient, database: string): Promise<void> {
  await client.query(
    `
      SELECT pg_terminate_backend(pid)
      FROM pg_stat_activity
      WHERE datname = $1
        AND pid <> pg_backend_pid()
    `,
    [database],
  );
}

export async function recreateWorkerDatabases(
  client: QueryClient,
  templateDb: string,
  runDatabase: string,
  maxWorkers: number,
): Promise<string[]> {
  const workers = workerDatabaseNames(runDatabase, maxWorkers);
  for (const database of [...workers, templateDb]) {
    await terminateConnections(client, database);
  }
  for (const database of workers) {
    await client.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(database)}`);
    await client.query(
      `CREATE DATABASE ${quoteIdentifier(database)} TEMPLATE ${quoteIdentifier(templateDb)} STRATEGY FILE_COPY`,
    );
  }
  return workers;
}

export async function dropWorkerDatabases(
  client: QueryClient,
  templateDb: string,
  maxWorkers: number,
): Promise<void> {
  const errors: unknown[] = [];
  for (const database of workerDatabaseNames(templateDb, maxWorkers)) {
    await terminateConnections(client, database).catch((error) => {
      errors.push(error);
    });
    await client.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(database)}`).catch((error) => {
      errors.push(error);
    });
  }
  if (errors.length > 0) {
    const cleanupError = new AggregateError(errors, "failed to clean one or more test databases", {
      cause: errors[0],
    });
    throw cleanupError;
  }
}

function createAdminClient(): Client {
  return new Client({
    host: process.env.SONAMU_DB_HOST ?? "localhost",
    port: Number(process.env.SONAMU_DB_PORT ?? 5432),
    user: process.env.SONAMU_DB_USER ?? "postgres",
    password: process.env.SONAMU_DB_PASSWORD ?? "postgres",
    database: "postgres",
    application_name: "qgrid-vitest-global-setup",
  });
}

export function resolveMaxWorkers(project?: VitestProject): number {
  const maxWorkers = project?.config?.maxWorkers;
  return Number.isInteger(maxWorkers) && maxWorkers !== undefined && maxWorkers > 0
    ? maxWorkers
    : MAX_WORKERS;
}

export async function provisionWorkerDatabases(
  createClient: AdminClientFactory,
  templateDb: string,
  runDatabase: string,
  maxWorkers: number,
): Promise<void> {
  const client = createClient();
  await client.connect();
  try {
    await recreateWorkerDatabases(client, templateDb, runDatabase, maxWorkers);
  } catch (setupError) {
    await client.end().catch(() => {});
    const cleanupClient = createClient();
    let cleanupError: unknown;
    try {
      await cleanupClient.connect();
      await dropWorkerDatabases(cleanupClient, runDatabase, maxWorkers);
    } catch (error) {
      cleanupError = error;
    } finally {
      await cleanupClient.end().catch((error) => {
        cleanupError ??= error;
      });
    }
    if (cleanupError) {
      const combinedError = new AggregateError(
        [setupError, cleanupError],
        "test database setup and cleanup both failed",
        { cause: setupError },
      );
      throw combinedError;
    }
    throw setupError;
  }
  await client.end();
}

export async function setup(project?: VitestProject): Promise<() => Promise<void>> {
  const runDatabase = process.env.QGRID_TEST_RUN_DB;
  if (!runDatabase || process.env.SONAMU_DB_NAME !== runDatabase) {
    throw new Error("Vitest test database name was not configured consistently");
  }
  const maxWorkers = resolveMaxWorkers(project);
  await provisionWorkerDatabases(createAdminClient, TEMPLATE_DB, runDatabase, maxWorkers);

  return async () => {
    const teardownClient = createAdminClient();
    await teardownClient.connect();
    try {
      await dropWorkerDatabases(teardownClient, runDatabase, maxWorkers);
    } finally {
      await teardownClient.end();
    }
  };
}
