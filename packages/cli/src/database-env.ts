const DATABASE_ENV_SUFFIXES = ["HOST", "PORT", "USER", "PASSWORD", "NAME"] as const;

/**
 * Qgrid의 공개 DB 환경변수를 Sonamu가 읽는 내부 환경변수로 복사합니다.
 *
 * QGRID_DB_*가 있으면 우선하며, 없으면 기존 SONAMU_DB_* 값을 그대로 둡니다.
 */
export function applyQgridDatabaseEnv(env: NodeJS.ProcessEnv): void {
  for (const suffix of DATABASE_ENV_SUFFIXES) {
    const qgridKey = `QGRID_DB_${suffix}`;
    const sonamuKey = `SONAMU_DB_${suffix}`;
    const value = env[qgridKey];
    if (value !== undefined) env[sonamuKey] = value;
  }
}
