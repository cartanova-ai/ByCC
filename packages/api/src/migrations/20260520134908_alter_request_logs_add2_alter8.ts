import { type Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("request_logs", (table) => {
    // add
    table.text("error_message").nullable();
    table.text("status").notNullable().defaultTo("succeeded");
    // alter column
    table.integer("cache_creation_tokens").notNullable().defaultTo(knex.raw("0")).alter();
    // alter column
    table.integer("cache_read_tokens").notNullable().defaultTo(knex.raw("0")).alter();
    // alter column
    table.integer("duration_ms").notNullable().defaultTo(knex.raw("0")).alter();
    // alter column
    table.integer("input_tokens").notNullable().defaultTo(knex.raw("0")).alter();
    // alter column
    table.integer("output_tokens").notNullable().defaultTo(knex.raw("0")).alter();
    // alter column
    table.text("response").notNullable().defaultTo("").alter();
    // alter column
    table.string("token_name", 100).nullable().alter();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("request_logs", (table) => {
    // rollback - add
    table.dropColumns("error_message", "status");
    // rollback - alter column
    table.integer("cache_creation_tokens").notNullable().alter();
    // rollback - alter column
    table.integer("cache_read_tokens").notNullable().alter();
    // rollback - alter column
    table.integer("duration_ms").notNullable().alter();
    // rollback - alter column
    table.integer("input_tokens").notNullable().alter();
    // rollback - alter column
    table.integer("output_tokens").notNullable().alter();
    // rollback - alter column
    table.text("response").notNullable().alter();
    // rollback - alter column
    table.string("token_name", 100).notNullable().alter();
  });
}
