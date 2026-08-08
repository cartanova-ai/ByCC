import { type Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("settings", (table) => {
    table.increments().primary();
    table
      .timestamp("created_at", { useTz: true, precision: 3 })
      .notNullable()
      .defaultTo(knex.raw("CURRENT_TIMESTAMP"));
    table.string("key", 100).notNullable();
    table.text("value").notNullable();
    table.timestamp("updated_at", { useTz: true, precision: 3 }).nullable();
  });
  await knex.raw(`CREATE UNIQUE INDEX settings_key_unique ON settings USING btree(key);`);
}

export async function down(knex: Knex): Promise<void> {
  return knex.schema.dropTable("settings");
}
