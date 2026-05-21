import { type Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  return knex.schema.alterTable("request_log_steps", (table) => {
    table
      .foreign("request_log_id")
      .references("request_logs.id")
      .onUpdate("CASCADE")
      .onDelete("CASCADE");
  });
}

export async function down(knex: Knex): Promise<void> {
  return knex.schema.alterTable("request_log_steps", (table) => {
    table.dropForeign(["request_log_id"]);
  });
}
