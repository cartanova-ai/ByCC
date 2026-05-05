import { type Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("request_logs", (table) => {
    table.increments().primary();
    table
      .timestamp("created_at", { useTz: true, precision: 3 })
      .notNullable()
      .defaultTo(knex.raw("CURRENT_TIMESTAMP"));
    table.string("token_name", 100).notNullable();
    table.text("query").notNullable();
    table.text("response").notNullable();
    table.integer("input_tokens").notNullable();
    table.integer("output_tokens").notNullable();
    table.integer("cache_read_tokens").notNullable();
    table.integer("cache_creation_tokens").notNullable();
    table.integer("duration_ms").notNullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  return knex.schema.dropTable("request_logs");
}
