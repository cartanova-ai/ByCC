import { describe, expect, it } from "vitest";

import { applyQgridDatabaseEnv } from "./database-env";

describe("applyQgridDatabaseEnv", () => {
  it("QGRID_DB_*를 내부 SONAMU_DB_*로 복사한다", () => {
    const env: NodeJS.ProcessEnv = {
      QGRID_DB_HOST: "100.100.102.1",
      QGRID_DB_PORT: "5432",
      QGRID_DB_USER: "f9dev",
      QGRID_DB_PASSWORD: "secret",
      QGRID_DB_NAME: "qgrid",
    };

    applyQgridDatabaseEnv(env);

    expect(env.SONAMU_DB_HOST).toBe("100.100.102.1");
    expect(env.SONAMU_DB_PORT).toBe("5432");
    expect(env.SONAMU_DB_USER).toBe("f9dev");
    expect(env.SONAMU_DB_PASSWORD).toBe("secret");
    expect(env.SONAMU_DB_NAME).toBe("qgrid");
  });

  it("QGRID_DB_*가 기존 SONAMU_DB_*보다 우선한다", () => {
    const env: NodeJS.ProcessEnv = {
      QGRID_DB_HOST: "qgrid-host",
      SONAMU_DB_HOST: "sonamu-host",
    };

    applyQgridDatabaseEnv(env);

    expect(env.SONAMU_DB_HOST).toBe("qgrid-host");
  });

  it("QGRID_DB_*가 없으면 기존 SONAMU_DB_*를 유지한다", () => {
    const env: NodeJS.ProcessEnv = {
      SONAMU_DB_HOST: "sonamu-host",
      SONAMU_DB_NAME: "legacy-compatible",
    };

    applyQgridDatabaseEnv(env);

    expect(env.SONAMU_DB_HOST).toBe("sonamu-host");
    expect(env.SONAMU_DB_NAME).toBe("legacy-compatible");
  });
});
