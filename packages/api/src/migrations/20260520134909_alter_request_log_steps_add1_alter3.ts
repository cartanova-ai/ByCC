import { type Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("request_log_steps", (table) => {
    // add
    table.text("error").nullable();
    // alter column
    table.text("tool_args").nullable().alter();
    // alter column
    table.text("tool_result").nullable().alter();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("request_log_steps", (table) => {
    // rollback - add
    table.dropColumns("error");
    // rollback - alter column
    table.jsonb("tool_args").nullable().alter();
    // rollback - alter column
    table.jsonb("tool_result").nullable().alter();
  });
}
