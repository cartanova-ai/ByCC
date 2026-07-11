import path from "node:path";

import { getLogger } from "@logtape/logtape";

import { TokenModel } from "./application/token/token.model";

export async function runRequiredMigrations(): Promise<void> {
  const log = getLogger(["qgrid", "startup"]);
  try {
    const knex = TokenModel.getDB("w");
    const migrationsDir = path.join(import.meta.dirname, "../src/migrations");
    const [batch, migrations] = await knex.migrate.latest({ directory: migrationsDir });
    if (migrations.length > 0) {
      log.info(`migration: ${migrations.length} applied (batch ${batch})`);
    }
  } catch (error) {
    log.error(`migration failed: ${(error as Error).message}`);
    process.exit(1);
  }
}
