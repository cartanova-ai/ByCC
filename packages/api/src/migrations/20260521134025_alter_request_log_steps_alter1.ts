import { type Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.raw(
    `CREATE INDEX request_log_steps_request_log_id_index ON request_log_steps USING btree(request_log_id ASC NULLS LAST);`,
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("request_log_steps", (table) => {
    table.dropIndex(["request_log_id"], "request_log_steps_request_log_id_index");
  });
}
