import { type Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.raw(
    `CREATE INDEX request_logs_project_name_cost_usd_index ON request_logs USING btree(project_name ASC NULLS LAST, cost_usd ASC NULLS LAST);`,
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("request_logs", (table) => {
    table.dropIndex(["project_name", "cost_usd"], "request_logs_project_name_cost_usd_index");
  });
}
