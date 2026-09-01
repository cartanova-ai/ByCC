import { type Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("tokens", (table) => {
    // add
    table.boolean("reauth_required").notNullable().defaultTo(knex.raw("false"));
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("tokens", (table) => {
    // rollback - add
    table.dropColumns("reauth_required");
  });
}
