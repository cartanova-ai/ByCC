import { type Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("request_logs", (table) => {
    // alter column
    table.string("model_name", 255).nullable().alter();
    // alter column
    table.string("requested_model_name", 255).nullable().alter();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("request_logs", (table) => {
    // rollback - alter column
    table.string("model_name", 50).nullable().alter();
    // rollback - alter column
    table.string("requested_model_name", 50).nullable().alter();
  });
}
