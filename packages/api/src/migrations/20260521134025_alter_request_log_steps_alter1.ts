import { type Knex } from "knex";

export async function up(_knex: Knex): Promise<void> {
  // The preceding create-table migration already creates this index.
}

export async function down(_knex: Knex): Promise<void> {
  // Keep the index owned by the preceding create-table migration.
}
