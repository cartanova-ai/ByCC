import { type Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("tokens", (table) => {
    table.increments().primary();
    table
      .timestamp("created_at", { useTz: true, precision: 3 })
      .notNullable()
      .defaultTo(knex.raw("CURRENT_TIMESTAMP"));
    table.text("token").notNullable();
    table.text("name").nullable();
    table.text("refresh_token").nullable();
    table.bigInteger("expires_at").nullable();
    table.text("account_uuid").nullable();
    table.boolean("active").notNullable().defaultTo(knex.raw("true"));
  });
}

export async function down(knex: Knex): Promise<void> {
  return knex.schema.dropTable("tokens");
}
