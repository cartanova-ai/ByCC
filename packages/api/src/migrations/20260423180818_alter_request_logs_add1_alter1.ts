import { type Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("request_logs", (table) => {
    // add
    table.string("project_name", 50).nullable();
  });
  await knex.raw(
    `CREATE INDEX request_logs_project_name_index ON request_logs USING btree(project_name ASC NULLS LAST);`,
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("request_logs", (table) => {
    // rollback - add
    table.dropColumns("project_name");
  });
}
