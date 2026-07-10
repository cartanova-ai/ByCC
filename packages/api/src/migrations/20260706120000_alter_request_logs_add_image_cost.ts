import { type Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("request_logs", (table) => {
    table.integer("image_cost_usd").nullable();
    table.string("image_cost_method", 100).nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("request_logs", (table) => {
    table.dropColumns("image_cost_usd", "image_cost_method");
  });
}
