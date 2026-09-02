import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const { latest } = vi.hoisted(() => ({ latest: vi.fn() }));

vi.mock("./application/token/token.model", () => ({
  TokenModel: {
    getDB: () => ({ migrate: { latest } }),
  },
}));

import {
  createStartupMigrationSource,
  resolveStartupMigrationDirs,
  runRequiredMigrations,
} from "./startup-migrations";

const tempRoots: string[] = [];

async function makeDirs() {
  const root = await mkdtemp(path.join(os.tmpdir(), "qgrid-startup-migrations-"));
  tempRoots.push(root);
  const sourceDir = path.join(root, "src", "migrations");
  const compiledDir = path.join(root, "dist", "migrations");
  await mkdir(sourceDir, { recursive: true });
  await mkdir(compiledDir, { recursive: true });
  return { sourceDir, compiledDir };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("resolveStartupMigrationDirs", () => {
  it("패키지된 CLI(dist 실행)에서는 이름은 bundle/src, 모듈은 bundle/dist 를 가리킨다", () => {
    expect(resolveStartupMigrationDirs("/opt/qgrid-cli/bundle/dist")).toEqual({
      sourceDir: "/opt/qgrid-cli/bundle/src/migrations",
      compiledDir: "/opt/qgrid-cli/bundle/dist/migrations",
    });
  });

  it("소스 실행(src)에서는 두 경로가 같은 src/migrations 다", () => {
    expect(resolveStartupMigrationDirs("/repo/packages/api/src")).toEqual({
      sourceDir: "/repo/packages/api/src/migrations",
      compiledDir: "/repo/packages/api/src/migrations",
    });
  });
});

describe("createStartupMigrationSource", () => {
  it("knex_migrations 에 기록된 것과 같은 .ts 파일명을 정렬해 나열하고 그 외 파일은 무시한다", async () => {
    const dirs = await makeDirs();
    await writeFile(path.join(dirs.sourceDir, "20260901163614_alter_tokens_add1_alter1.ts"), "");
    await writeFile(path.join(dirs.sourceDir, "20260820153531_alter_tokens_add1_alter1.ts"), "");
    await writeFile(path.join(dirs.sourceDir, "20260820153531_alter_tokens_add1_alter1.d.ts"), "");
    await writeFile(path.join(dirs.sourceDir, "README.md"), "");

    const source = createStartupMigrationSource(dirs);
    const names = await source.getMigrations([]);

    expect(names).toEqual([
      "20260820153531_alter_tokens_add1_alter1.ts",
      "20260901163614_alter_tokens_add1_alter1.ts",
    ]);
    expect(source.getMigrationName("20260820153531_alter_tokens_add1_alter1.ts")).toBe(
      "20260820153531_alter_tokens_add1_alter1.ts",
    );
  });

  it("컴파일된 .js 가 있으면 .ts 대신 그것을 로드한다 (2.9.0 부팅 크래시 재발 방지)", async () => {
    const dirs = await makeDirs();
    const name = "20260901163614_alter_tokens_add1_alter1.ts";
    await writeFile(path.join(dirs.sourceDir, name), 'throw new Error("source .ts must not load");\n');
    await writeFile(
      path.join(dirs.compiledDir, name.replace(/\.ts$/, ".js")),
      'export async function up() { return "compiled"; }\nexport async function down() { return "down"; }\n',
    );

    const migration = await createStartupMigrationSource(dirs).getMigration(name);

    await expect(migration.up({} as never)).resolves.toBe("compiled");
    await expect(migration.down?.({} as never)).resolves.toBe("down");
  });

  it("컴파일 산출물이 없으면 소스 모듈로 fallback 한다 (ts loader 가 있는 소스 실행)", async () => {
    const dirs = await makeDirs();
    const name = "20260901163614_alter_tokens_add1_alter1.ts";
    await writeFile(
      path.join(dirs.sourceDir, name),
      'export async function up() { return "source"; }\n',
    );

    const migration = await createStartupMigrationSource(dirs).getMigration(name);

    await expect(migration.up({} as never)).resolves.toBe("source");
    await expect(migration.down?.({} as never)).resolves.toBeUndefined();
  });

  it("up() 이 없는 모듈은 명확한 오류로 실패한다", async () => {
    const dirs = await makeDirs();
    const name = "20260901163614_alter_tokens_add1_alter1.ts";
    await writeFile(path.join(dirs.compiledDir, name.replace(/\.ts$/, ".js")), "export const x = 1;\n");

    await expect(createStartupMigrationSource(dirs).getMigration(name)).rejects.toThrow(
      /has no up\(\) export/,
    );
  });
});

describe("required startup migrations", () => {
  it("knex 기본 directory 대신 migrationSource 로 latest 를 실행한다", async () => {
    const dirs = await makeDirs();
    latest.mockResolvedValueOnce([3, ["20260901163614_alter_tokens_add1_alter1.ts"]]);

    await runRequiredMigrations(dirs);

    expect(latest).toHaveBeenCalledWith({ migrationSource: expect.any(Object) });
    const call = latest.mock.calls.at(-1)?.[0] as { migrationSource: unknown; directory?: string };
    expect(call.directory).toBeUndefined();
  });

  it("terminates with a failure status when migration fails", async () => {
    const dirs = await makeDirs();
    const failure = new Error("tokens.weight migration failed");
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw failure;
    });
    latest.mockRejectedValueOnce(failure);

    await expect(runRequiredMigrations(dirs)).rejects.toBe(failure);

    expect(exit).toHaveBeenCalledWith(1);
  });
});
