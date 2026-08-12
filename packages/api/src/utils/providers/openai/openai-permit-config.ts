import { SETTING_DEFS } from "../../../application/setting/setting.constant";
import { getSetting } from "../../../application/setting/setting.store";

export const MAX_OPENAI_PERMITS_PER_TOKEN = 20;
const DEFAULT_OPENAI_PERMITS_PER_TOKEN = 3;

export type OpenAIPermitConfig = {
  permitsPerToken: number;
  transport: OpenAITransportKind;
};

export type OpenAITransportKind = "https" | "websocket";

function boundedInteger(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(Math.floor(parsed), max));
}

function settingsBackedEnv(): Record<string, string | undefined> {
  return new Proxy({} as Record<string, string | undefined>, {
    get: (_target, prop: string) => {
      const def = SETTING_DEFS.find((d) => d.envKey === prop);
      return def ? getSetting(def.key, def.envKey) : process.env[prop];
    },
  });
}

/**
 * Resolves direct-request concurrency while retaining the existing setting and environment keys.
 * Disabling the legacy autoscale flag keeps the previous fixed-minimum interpretation.
 */
export function resolveOpenAIPermitConfig(
  env: Record<string, string | undefined> = settingsBackedEnv(),
): OpenAIPermitConfig {
  const transport = env.QGRID_OPENAI_TRANSPORT ?? "https";
  if (transport !== "https" && transport !== "websocket") {
    throw new Error(
      `Invalid QGRID_OPENAI_TRANSPORT value: ${transport}. Expected https or websocket.`,
    );
  }
  const legacyAutoscaleDisabled =
    env.QGRID_OPENAI_AUTOSCALE === "false" || env.QGRID_OPENAI_AUTOSCALE === "0";
  const key = legacyAutoscaleDisabled
    ? "QGRID_OPENAI_MIN_WORKERS_PER_TOKEN"
    : "QGRID_OPENAI_MAX_WORKERS_PER_TOKEN";
  const fallback = legacyAutoscaleDisabled ? 1 : DEFAULT_OPENAI_PERMITS_PER_TOKEN;
  return {
    permitsPerToken: boundedInteger(env[key], fallback, 1, MAX_OPENAI_PERMITS_PER_TOKEN),
    transport,
  };
}
