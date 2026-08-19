import { type Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.raw(
    `CREATE UNIQUE INDEX tokens_provider_name_unique ON tokens USING btree(provider ASC NULLS LAST, name ASC NULLS LAST) NULLS DISTINCT;`,
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("tokens", (table) => {
    table.dropIndex(["provider", "name"], "tokens_provider_name_unique");
  });
}
