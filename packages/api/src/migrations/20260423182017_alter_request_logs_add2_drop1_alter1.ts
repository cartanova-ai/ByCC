import { type Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("request_logs", (table) => {
    // drop columns
    table.dropColumns("query");
    // add
    table.text("system_prompt").nullable();
    table.text("user_prompt").nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("request_logs", (table) => {
    // rollback - add
    table.dropColumns("system_prompt", "user_prompt");
    // rollback - drop columns
    table.text("query").notNullable();
  });
}
