import { type Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("request_log_steps", (table) => {
    table.increments().primary();
    table
      .timestamp("created_at", { useTz: true, precision: 3 })
      .notNullable()
      .defaultTo(knex.raw("CURRENT_TIMESTAMP"));
    table.integer("request_log_id").notNullable();
    table.integer("step_index").notNullable();
    table.text("type").notNullable();
    table.integer("input_tokens").nullable();
    table.integer("output_tokens").nullable();
    table.integer("cache_read_tokens").nullable();
    table.integer("cache_creation_tokens").nullable();
    table.integer("duration_ms").nullable();
    table.string("finish_reason", 20).nullable();
    table.integer("tool_call_index").nullable();
    table.string("tool_call_id", 100).nullable();
    table.string("tool_name", 100).nullable();
    table.jsonb("tool_args").nullable();
    table.jsonb("tool_result").nullable();
    table.integer("tool_duration_ms").nullable();
  });
  await knex.raw(
    `CREATE INDEX request_log_steps_request_log_id_index ON request_log_steps USING btree(request_log_id);`,
  );
}

export async function down(knex: Knex): Promise<void> {
  return knex.schema.dropTable("request_log_steps");
}
