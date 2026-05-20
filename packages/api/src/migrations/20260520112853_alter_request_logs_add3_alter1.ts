import { type Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("request_logs", (table) => {
    // add
    table.string("effort", 10).nullable();
    table.jsonb("history").nullable();
    table.jsonb("tool_calls").nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("request_logs", (table) => {
    // rollback - add
    table.dropColumns("effort", "history", "tool_calls");
  });
}
