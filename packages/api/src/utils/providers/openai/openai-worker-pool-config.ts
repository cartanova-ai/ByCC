import { SETTING_DEFS } from "../../../application/setting/setting.schema";
import { getSetting } from "../../../application/setting/setting.store";

export const MAX_OPENAI_WORKERS_PER_TOKEN = 20;
const DEFAULT_OPENAI_MIN_WORKERS_PER_TOKEN = 1;
const DEFAULT_OPENAI_MAX_WORKERS_PER_TOKEN = 3;

export const OPENAI_WORKER_BASE_RSS_GIB = 0.71;
export const OPENAI_WORKER_RSS_GIB = 0.157;

export type OpenAIWorkerPoolConfig = {
  autoscale: boolean;
  minWorkersPerToken: number;
  maxWorkersPerToken: number;
  scaleIntervalMs: number;
  scaleDownIdleMs: number;
  maxEstimatedRssGiB: number;
  minHostAvailableGiB: number;
};

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

function boundedNumber(value: string | undefined, fallback: number, min: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, parsed);
}

/**
 * 설정 저장소(DB) 를 먼저 보고 없으면 env 로 떨어지는 조회 객체.
 *
 * 기존 파싱 로직이 `env[KEY]` 형태를 전제하므로, 소스만 바꿔 끼우고 검증·기본값 처리는
 * 그대로 둔다. 테스트는 `env` 인자에 순수한 맵을 넘겨 저장소를 우회한다.
 */
function settingsBackedEnv(): Record<string, string | undefined> {
  return new Proxy({} as Record<string, string | undefined>, {
    get: (_target, prop: string) => {
      const def = SETTING_DEFS.find((d) => d.envKey === prop);
      return def ? getSetting(def.key, def.envKey) : process.env[prop];
    },
  });
}

export function resolveOpenAIWorkerPoolConfig(
  env: Record<string, string | undefined> = settingsBackedEnv(),
): OpenAIWorkerPoolConfig {
  const autoscale = env.QGRID_OPENAI_AUTOSCALE !== "false" && env.QGRID_OPENAI_AUTOSCALE !== "0";
  const minWorkersPerToken = boundedInteger(
    env.QGRID_OPENAI_MIN_WORKERS_PER_TOKEN,
    DEFAULT_OPENAI_MIN_WORKERS_PER_TOKEN,
    1,
    MAX_OPENAI_WORKERS_PER_TOKEN,
  );
  return {
    autoscale,
    minWorkersPerToken,
    // autoscale 이 꺼지면 max 는 min 으로 고정되므로 env 파싱 자체가 autoscale 분기 안에만 있다.
    maxWorkersPerToken: autoscale
      ? Math.max(
          minWorkersPerToken,
          boundedInteger(
            env.QGRID_OPENAI_MAX_WORKERS_PER_TOKEN,
            DEFAULT_OPENAI_MAX_WORKERS_PER_TOKEN,
            1,
            MAX_OPENAI_WORKERS_PER_TOKEN,
          ),
        )
      : minWorkersPerToken,
    scaleIntervalMs: boundedInteger(env.QGRID_OPENAI_SCALE_INTERVAL_MS, 5_000, 250, 300_000),
    scaleDownIdleMs: boundedInteger(
      env.QGRID_OPENAI_SCALE_DOWN_IDLE_MS,
      10 * 60_000,
      1_000,
      24 * 60 * 60_000,
    ),
    maxEstimatedRssGiB: boundedNumber(env.QGRID_OPENAI_MAX_ESTIMATED_RSS_GIB, 16, 1),
    minHostAvailableGiB: boundedNumber(env.QGRID_OPENAI_MIN_HOST_AVAILABLE_GIB, 20, 0),
  };
}

export function estimateOpenAIWorkerRssGiB(totalWorkers: number): number {
  return OPENAI_WORKER_BASE_RSS_GIB + OPENAI_WORKER_RSS_GIB * totalWorkers;
}
