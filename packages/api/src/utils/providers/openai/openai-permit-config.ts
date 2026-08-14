import { getLogger } from "@logtape/logtape";

import { getSetting } from "../../../application/setting/setting.store";

const logger = getLogger(["qgrid", "openai-permit-config"]);

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

/**
 * DB 설정(`settings` 테이블) → env 순으로 읽는다. def 등록 여부와 무관하게 저장된 키를
 * 직접 조회하므로, def 목록에서 빠진 레거시 키의 저장값도 폴백 체인에서 보인다.
 */
function settingsBackedEnv(): Record<string, string | undefined> {
  const KEY_BY_ENV: Record<string, string> = {
    QGRID_OPENAI_PERMITS_PER_TOKEN: "openai.permitsPerToken",
    QGRID_OPENAI_AUTOSCALE: "openai.autoscale",
    QGRID_OPENAI_MIN_WORKERS_PER_TOKEN: "openai.minWorkersPerToken",
    QGRID_OPENAI_MAX_WORKERS_PER_TOKEN: "openai.maxWorkersPerToken",
  };
  return new Proxy({} as Record<string, string | undefined>, {
    get: (_target, prop: string) => {
      const key = KEY_BY_ENV[prop];
      return key ? getSetting(key, prop) : process.env[prop];
    },
  });
}

/**
 * 토큰당 동시 요청 permit 수를 해석한다.
 *
 * 캐노니컬 키는 `openai.permitsPerToken` / `QGRID_OPENAI_PERMITS_PER_TOKEN` 이다.
 * 워커 시절 키(AUTOSCALE + MIN/MAX_WORKERS_PER_TOKEN)는 기존 배포(dev0 ecosystem env,
 * 대시보드 저장값)를 깨지 않기 위한 폴백으로만 남는다 — autoscale off 였으면 MIN 을,
 * 아니면 MAX 를 permit 수로 읽는 기존 재해석을 그대로 따른다.
 */
export function resolveOpenAIPermitConfig(
  env: Record<string, string | undefined> = settingsBackedEnv(),
): OpenAIPermitConfig {
  const transport = env.QGRID_OPENAI_TRANSPORT ?? "websocket";
  if (transport !== "https" && transport !== "websocket") {
    throw new Error(
      `Invalid QGRID_OPENAI_TRANSPORT value: ${transport}. Expected https or websocket.`,
    );
  }

  const canonical = env.QGRID_OPENAI_PERMITS_PER_TOKEN;
  if (canonical !== undefined) {
    return {
      permitsPerToken: boundedInteger(
        canonical,
        DEFAULT_OPENAI_PERMITS_PER_TOKEN,
        1,
        MAX_OPENAI_PERMITS_PER_TOKEN,
      ),
      transport,
    };
  }

  const legacyAutoscaleDisabled =
    env.QGRID_OPENAI_AUTOSCALE === "false" || env.QGRID_OPENAI_AUTOSCALE === "0";
  const legacyKey = legacyAutoscaleDisabled
    ? "QGRID_OPENAI_MIN_WORKERS_PER_TOKEN"
    : "QGRID_OPENAI_MAX_WORKERS_PER_TOKEN";
  const legacyValue = env[legacyKey];
  if (legacyValue !== undefined || env.QGRID_OPENAI_AUTOSCALE !== undefined) {
    logger.warn(
      `deprecated OpenAI concurrency keys in use (${legacyKey}${
        env.QGRID_OPENAI_AUTOSCALE !== undefined ? ", QGRID_OPENAI_AUTOSCALE" : ""
      }); migrate to QGRID_OPENAI_PERMITS_PER_TOKEN / openai.permitsPerToken`,
    );
  }
  return {
    permitsPerToken: boundedInteger(
      legacyValue,
      legacyAutoscaleDisabled ? 1 : DEFAULT_OPENAI_PERMITS_PER_TOKEN,
      1,
      MAX_OPENAI_PERMITS_PER_TOKEN,
    ),
    transport,
  };
}
