import { type Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("tokens", (table) => {
    // alter column
    table.text("name").notNullable().alter();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("tokens", (table) => {
    // rollback - alter column
    table.text("name").nullable().alter();
  });
}
