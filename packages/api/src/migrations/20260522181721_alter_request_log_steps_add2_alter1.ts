import { type Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("request_log_steps", (table) => {
    // add
    table.text("reasoning_text").nullable();
    table.integer("reasoning_tokens").nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("request_log_steps", (table) => {
    // rollback - add
    table.dropColumns("reasoning_text", "reasoning_tokens");
  });
}
