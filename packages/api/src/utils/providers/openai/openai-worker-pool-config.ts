export const MAX_OPENAI_WORKERS_PER_TOKEN = 20;
const DEFAULT_OPENAI_MIN_WORKERS_PER_TOKEN = 5;
const DEFAULT_OPENAI_MAX_WORKERS_PER_TOKEN = 15;

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

export function resolveOpenAIWorkerPoolConfig(
  env: Record<string, string | undefined> = process.env,
): OpenAIWorkerPoolConfig {
  const autoscale = env.QGRID_OPENAI_AUTOSCALE !== "false" && env.QGRID_OPENAI_AUTOSCALE !== "0";
  const legacyWorkers = boundedInteger(
    env.QGRID_WORKERS_PER_TOKEN,
    DEFAULT_OPENAI_MIN_WORKERS_PER_TOKEN,
    1,
    MAX_OPENAI_WORKERS_PER_TOKEN,
  );
  const minWorkersPerToken = boundedInteger(
    env.QGRID_OPENAI_MIN_WORKERS_PER_TOKEN,
    legacyWorkers,
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
