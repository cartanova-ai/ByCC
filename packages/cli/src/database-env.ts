const DATABASE_ENV_DEFAULTS = {
  HOST: "localhost",
  PORT: "5432",
  USER: "postgres",
  PASSWORD: "postgres",
  NAME: "qgrid",
} as const;

/**
 * Qgrid의 공개 DB 환경변수를 Sonamu가 읽는 내부 환경변수로 복사합니다.
 *
 * QGRID_DB_*가 있으면 우선하며, 없으면 기존 SONAMU_DB_* 또는 CLI 기본값을 사용합니다.
 */
export function applyQgridDatabaseEnv(env: NodeJS.ProcessEnv): void {
  for (const [suffix, defaultValue] of Object.entries(DATABASE_ENV_DEFAULTS)) {
    const qgridKey = `QGRID_DB_${suffix}`;
    const sonamuKey = `SONAMU_DB_${suffix}`;
    env[sonamuKey] = env[qgridKey] ?? env[sonamuKey] ?? defaultValue;
  }
}
