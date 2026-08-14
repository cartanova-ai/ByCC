import { type Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.raw(
    `CREATE INDEX request_logs_created_at_index ON request_logs USING btree(created_at ASC NULLS LAST);`,
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("request_logs", (table) => {
    table.dropIndex(["created_at"], "request_logs_created_at_index");
  });
}
