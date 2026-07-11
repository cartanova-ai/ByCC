import { type Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("tokens", (table) => {
    table.integer("weight").notNullable().defaultTo(1);
  });
  await knex.raw(`
    CREATE OR REPLACE FUNCTION public.tokens_weight_notify() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
    AS $func$
    BEGIN
      PERFORM pg_notify('tokens_changed', json_build_object(
        'op', TG_OP,
        'id', NEW.id
      )::text);
      RETURN NEW;
    END;
    $func$;

    DROP TRIGGER IF EXISTS tokens_weight_changed_upd ON public.tokens;
    CREATE TRIGGER tokens_weight_changed_upd
    AFTER UPDATE OF weight ON public.tokens
    FOR EACH ROW
    WHEN (OLD.weight IS DISTINCT FROM NEW.weight)
    EXECUTE FUNCTION public.tokens_weight_notify();
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    DROP TRIGGER IF EXISTS tokens_weight_changed_upd ON public.tokens;
    DROP FUNCTION IF EXISTS public.tokens_weight_notify();
  `);
  await knex.schema.alterTable("tokens", (table) => {
    table.dropColumns("weight");
  });
}
