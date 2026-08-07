import { type Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.raw(
    `CREATE INDEX request_logs_model_name_index ON request_logs USING btree(model_name ASC NULLS LAST);`,
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("request_logs", (table) => {
    table.dropIndex(["model_name"], "request_logs_model_name_index");
  });
}
