import { type Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("request_log_steps", (table) => {
    // add
    table.integer("ttft_ms").nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("request_log_steps", (table) => {
    // rollback - add
    table.dropColumns("ttft_ms");
  });
}
