import { type Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("request_log_steps", (table) => {
    // add
    table.integer("cache_creation_1h_tokens").nullable();
    table.integer("cache_creation_5m_tokens").nullable();
    table.string("cost_source", 20).nullable();
    table.integer("cost_usd").nullable();
    table.integer("fallback_count").nullable();
    table.string("model_name", 50).nullable();
    table.string("requested_model_name", 50).nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("request_log_steps", (table) => {
    // rollback - add
    table.dropColumns(
      "cache_creation_1h_tokens",
      "cache_creation_5m_tokens",
      "cost_source",
      "cost_usd",
      "fallback_count",
      "model_name",
      "requested_model_name",
    );
  });
}
