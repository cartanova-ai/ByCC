import { type Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("request_logs", (table) => {
    // drop columns
    table.dropColumns("tool_calls");
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("request_logs", (table) => {
    // rollback - drop columns
    table.jsonb("tool_calls").nullable();
  });
}
