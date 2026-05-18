import { type Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("tokens", (table) => {
    // drop columns
    table.dropColumns("account_uuid", "expires_at", "refresh_token", "token");
    // add
    table.jsonb("credentials").notNullable();
    table.string("provider", 20).notNullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("tokens", (table) => {
    // rollback - add
    table.dropColumns("credentials", "provider");
    // rollback - drop columns
    table.text("account_uuid").nullable();
    table.bigInteger("expires_at").nullable();
    table.text("refresh_token").nullable();
    table.text("token").notNullable();
  });
}
