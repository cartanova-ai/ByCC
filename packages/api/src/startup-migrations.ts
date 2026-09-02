import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { getLogger } from "@logtape/logtape";
import { type Knex } from "knex";

import { TokenModel } from "./application/token/token.model";

export type StartupMigrationDirs = {
  /** Sonamu 가 migration 을 생성·기록하는 원본 디렉터리. `knex_migrations.name` 은 이 파일명(`.ts`)이다. */
  sourceDir: string;
  /** 빌드 산출물 디렉터리. dist 에서 실행 중이면 같은 이름의 `.js` 가 여기 있다. */
  compiledDir: string;
};

// import.meta.dirname 은 소스 실행(ts loader)에서는 `src/`, 패키지된 CLI 에서는 `bundle/dist/` 다.
// 두 경우 모두 `../src/migrations` 가 이름의 정본이고 `./migrations` 가 컴파일 산출물 위치다.
// 소스 실행에서는 둘이 같은 디렉터리라 컴파일 파일이 없고, `.ts` 를 loader 가 직접 읽는다.
export function resolveStartupMigrationDirs(
  moduleDir: string = import.meta.dirname,
): StartupMigrationDirs {
  return {
    sourceDir: path.join(moduleDir, "../src/migrations"),
    compiledDir: path.join(moduleDir, "migrations"),
  };
}

// Sonamu 가 만드는 파일명 규칙: `YYYYMMDDHHmmss_<title>.ts`. 타입 선언이나 README 는 제외한다.
const MIGRATION_FILE_RE = /^\d{14}_.+\.ts$/;

type MigrationModule = {
  up?: (knex: Knex) => Promise<unknown>;
  down?: (knex: Knex) => Promise<unknown>;
};

/**
 * 패키지된 CLI 는 `bundle/dist` 에서 실행되는데, knex 기본 FsMigrations 에 `../src/migrations` 를
 * 넘기면 pending migration 을 `.ts` 로 import 하다 "Unknown file extension .ts" 로 죽는다(2.9.0 사고).
 * 반대로 디렉터리를 `dist/migrations` 로 바꾸면 `knex_migrations` 에 `.ts` 이름으로 기록된 과거
 * migration 이 전부 pending 으로 보인다. 그래서 이름은 `src/migrations` 의 `.ts` 파일명을 그대로
 * 쓰고, 모듈만 컴파일된 `.js` 가 있으면 그것을 로드한다.
 */
export function createStartupMigrationSource(
  dirs: StartupMigrationDirs,
): Knex.MigrationSource<string> {
  return {
    async getMigrations() {
      const entries = await readdir(dirs.sourceDir);
      return entries
        .filter((name) => MIGRATION_FILE_RE.test(name) && !name.endsWith(".d.ts"))
        .sort();
    },
    getMigrationName(name) {
      return name;
    },
    async getMigration(name) {
      const compiled = path.join(dirs.compiledDir, name.replace(/\.ts$/, ".js"));
      const source = path.join(dirs.sourceDir, name);
      const target = existsSync(compiled) ? compiled : source;
      const module = (await import(pathToFileURL(target).href)) as MigrationModule;
      if (typeof module.up !== "function") {
        throw new Error(`migration ${name} has no up() export (${target})`);
      }
      return { up: module.up, down: module.down ?? (async () => undefined) };
    },
  };
}

export type StartupMigrationDeps = {
  getKnex: () => Pick<Knex, "migrate">;
  exit: (code: number) => never;
};

// 테스트는 deps 를 주입한다. 모듈 목으로 TokenModel 을 바꾸는 방식은 전체 스위트에서 목이 새면
// 실제 process.exit(1) 이 worker 를 죽여 남은 테스트가 조용히 pending 으로 빠진다.
export async function runRequiredMigrations(
  dirs: StartupMigrationDirs = resolveStartupMigrationDirs(),
  deps: StartupMigrationDeps = { getKnex: () => TokenModel.getDB("w"), exit: process.exit },
): Promise<void> {
  const log = getLogger(["qgrid", "startup"]);
  try {
    const knex = deps.getKnex();
    const [batch, migrations] = await knex.migrate.latest({
      migrationSource: createStartupMigrationSource(dirs),
    });
    if (migrations.length > 0) {
      log.info(`migration: ${migrations.length} applied (batch ${batch})`);
    }
  } catch (error) {
    log.error(`migration failed: ${(error as Error).message}`);
    deps.exit(1);
  }
}
