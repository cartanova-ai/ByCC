/** One-time setup for public.tokens -> tokens_changed NOTIFY triggers. */
import { getLogger } from "@logtape/logtape";
import { Client, type ClientConfig } from "pg";

const logger = getLogger(["qgrid", "trigger-setup"]);

const CONNECTION_TIMEOUT_MS = 5_000;
const SETUP_LOCK_TIMEOUT_MS = 3_000;
const SETUP_STATEMENT_TIMEOUT_MS = 10_000;

const ADVISORY_LOCK_CLASS_ID = 717;
const ADVISORY_LOCK_OBJECT_ID = 44900;

export const TOKENS_TRIGGER_SETUP_SQL = `
  CREATE OR REPLACE FUNCTION public.tokens_notify() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
  AS $func$
  BEGIN
    PERFORM pg_notify('tokens_changed', json_build_object(
      'op', TG_OP,
      'id', COALESCE(NEW.id, OLD.id)
    )::text);
    RETURN COALESCE(NEW, OLD);
  END;
  $func$;

  DROP TRIGGER IF EXISTS tokens_changed_trigger ON public.tokens;
  DROP TRIGGER IF EXISTS tokens_changed ON public.tokens;

  CREATE OR REPLACE TRIGGER tokens_changed_ins_del
  AFTER INSERT OR DELETE ON public.tokens
  FOR EACH ROW EXECUTE FUNCTION public.tokens_notify();

  CREATE OR REPLACE TRIGGER tokens_changed_upd
  AFTER UPDATE ON public.tokens
  FOR EACH ROW
  WHEN (
    OLD.active IS DISTINCT FROM NEW.active OR
    OLD.reauth_required IS DISTINCT FROM NEW.reauth_required OR
    OLD.credentials IS DISTINCT FROM NEW.credentials OR
    OLD.provider IS DISTINCT FROM NEW.provider OR
    OLD.name IS DISTINCT FROM NEW.name OR
    OLD.quota_threshold IS DISTINCT FROM NEW.quota_threshold OR
    OLD.keepalive_enabled IS DISTINCT FROM NEW.keepalive_enabled
  )
  EXECUTE FUNCTION public.tokens_notify();
`;

export async function ensureTokensTrigger(connConfig: ClientConfig): Promise<void> {
  const client = new Client({
    ...connConfig,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    application_name: "qgrid-trigger-setup",
  });

  let lockAcquired = false;
  try {
    await client.connect();
    await client.query("SET search_path TO public");
    await client.query(`SET lock_timeout = '${SETUP_LOCK_TIMEOUT_MS}ms'`);
    await client.query(`SET statement_timeout = '${SETUP_STATEMENT_TIMEOUT_MS}ms'`);
    await client.query("SELECT pg_advisory_lock($1, $2)", [
      ADVISORY_LOCK_CLASS_ID,
      ADVISORY_LOCK_OBJECT_ID,
    ]);
    lockAcquired = true;

    await client.query(TOKENS_TRIGGER_SETUP_SQL);
    logger.info("trigger ensured (public.tokens_notify + tokens_changed_* triggers)");
  } finally {
    if (lockAcquired) {
      await client
        .query("SELECT pg_advisory_unlock($1, $2)", [
          ADVISORY_LOCK_CLASS_ID,
          ADVISORY_LOCK_OBJECT_ID,
        ])
        .catch(() => {});
    }
    await client.end().catch(() => {});
  }
}
