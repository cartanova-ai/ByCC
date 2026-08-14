#!/usr/bin/env node
import { execFileSync, execSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Command } from "commander";

import { applyQgridDatabaseEnv } from "./database-env";
import {
  parseVersion,
  pnpmGlobalBinDir,
  runSelfUpdate,
  SELF_UPDATE_CHECK_TIMEOUT_MS,
  SELF_UPDATE_INSTALL_TIMEOUT_MS,
} from "./self-update";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8"));

export const RUNTIME_CLI_DEPENDENCIES = [
  {
    command: "claude",
    packageName: "@anthropic-ai/claude-code",
    label: "Claude Code",
    missingReason: "Anthropic tokens require Claude Code.",
  },
] as const;

type RuntimeCliDependency = (typeof RUNTIME_CLI_DEPENDENCIES)[number];

function commandVersion(command: string, env: NodeJS.ProcessEnv = process.env): string | null {
  try {
    return execFileSync(command, ["--version"], {
      encoding: "utf-8",
      env,
      stdio: "pipe",
      timeout: SELF_UPDATE_CHECK_TIMEOUT_MS,
    }).trim();
  } catch {
    return null;
  }
}

function packageLatestVersion(packageName: string): string {
  return execFileSync("npm", ["view", packageName, "version"], {
    encoding: "utf-8",
    stdio: "pipe",
    timeout: SELF_UPDATE_CHECK_TIMEOUT_MS,
  }).trim();
}

function commandPath(command: string): string {
  try {
    return execFileSync("which", [command], {
      encoding: "utf-8",
      stdio: "pipe",
      timeout: SELF_UPDATE_CHECK_TIMEOUT_MS,
    }).trim();
  } catch {
    return "";
  }
}

function warnMissingRuntimeCliDependency(dep: RuntimeCliDependency): void {
  console.warn(`Warning: ${dep.command} CLI not found. ${dep.missingReason}`);
  console.warn(`Install: npm i -g ${dep.packageName}`);
}

function installRuntimeCliDependency(dep: RuntimeCliDependency): void {
  execFileSync("npm", ["i", "-g", `${dep.packageName}@latest`], {
    stdio: "inherit",
    timeout: SELF_UPDATE_INSTALL_TIMEOUT_MS,
  });
}

export function ensureLatestRuntimeCliDependencies(): void {
  for (const dep of RUNTIME_CLI_DEPENDENCIES) {
    let installedOutput = commandVersion(dep.command);

    try {
      const installed = parseVersion(installedOutput);

      if (!installed) {
        console.log(`Updating ${dep.label}: installing latest`);
        installRuntimeCliDependency(dep);
        installedOutput = commandVersion(dep.command);
      } else {
        const latest = packageLatestVersion(dep.packageName);
        if (installed === latest) continue;

        console.log(`Updating ${dep.label}: ${installed} → ${latest}`);
        installRuntimeCliDependency(dep);
        installedOutput = commandVersion(dep.command);
      }
    } catch (e) {
      console.warn(`Warning: failed to update ${dep.label}: ${(e as Error).message}`);
    }

    if (!installedOutput) {
      warnMissingRuntimeCliDependency(dep);
    }
  }
}

function normalizePort(port: unknown): string {
  const value = String(port);
  const numeric = Number(value);
  if (!/^\d+$/.test(value) || numeric < 1 || numeric > 65_535) {
    console.error(`Invalid port: ${value}`);
    process.exit(1);
  }
  return value;
}

const program = new Command();
program
  .name("qgrid")
  .version(pkg.version)
  .description("Qgrid — LLM subscription token proxy server")
  .option("--db <url>", "PostgreSQL connection URL (e.g. postgres://user:pw@host:port/dbname)")
  .option("-p, --port <port>", "server port (default: 44900)")
  .option("--skip-update", "skip qgrid self-update check")
  .action(async (opts) => {
    const serverPort = normalizePort(opts.port ?? "44900");

    try {
      const pid = execSync(`lsof -ti :${serverPort}`, { encoding: "utf-8" }).trim();
      if (pid) {
        console.error(`Error: Port ${serverPort} is already in use (PID ${pid}).`);
        console.error(`Stop that process or choose a port explicitly with --port.`);
        process.exit(1);
      }
    } catch {
      // 포트 미사용 — 정상
    }

    // check latest version and self-update
    if (!opts.skipUpdate) {
      const outcome = runSelfUpdate(
        {
          packageName: "@cartanova/qgrid-cli",
          currentVersion: pkg.version,
          args: process.argv.slice(2),
          env: process.env,
          userAgent: process.env.npm_config_user_agent,
        },
        {
          latestVersion: packageLatestVersion,
          commandPath,
          commandVersion,
          pnpmGlobalBinDir,
          spawn: (command, args, options) => spawnSync(command, args, options),
          log: console.log,
          warn: console.warn,
          error: console.error,
        },
      );
      if (outcome.kind === "exit") process.exit(outcome.exitCode);
    }

    ensureLatestRuntimeCliDependencies();

    // --db가 최우선이며, Qgrid의 공개 DB 환경변수로 정규화한 뒤 Sonamu 내부 env로 복사한다.
    if (opts.db) {
      const m = opts.db.match(/^postgres(?:ql)?:\/\/([^:]+):(.+)@([^:]+):(\d+)\/(.+)$/);
      if (!m) {
        console.error("Invalid DB URL format. Expected: postgres://user:password@host:port/dbname");
        process.exit(1);
      }
      const [, user, password, host, port, dbName] = m;
      process.env.QGRID_DB_HOST = host;
      process.env.QGRID_DB_PORT = normalizePort(port);
      process.env.QGRID_DB_USER = user;
      process.env.QGRID_DB_PASSWORD = password;
      process.env.QGRID_DB_NAME = dbName;
    }
    applyQgridDatabaseEnv(process.env);
    process.env.PORT = serverPort;

    process.env.NODE_ENV ||= "production";
    if (process.env.NODE_ENV !== "staging" && process.env.NODE_ENV !== "production") {
      console.error(
        `Error: Packaged qgrid supports NODE_ENV=staging or production, received "${process.env.NODE_ENV}"`,
      );
      process.exit(1);
    }

    const bundlePath = join(__dirname, "..", "bundle");
    const serverEntry = join(bundlePath, "dist", "index.js");
    if (!existsSync(serverEntry)) {
      console.error(`Error: Server bundle not found at ${serverEntry}`);
      console.error("Reinstall: npm i -g @cartanova/qgrid-cli");
      process.exit(1);
    }

    process.env.INIT_CWD = bundlePath;

    // DB connection pre-check
    const dbHost = process.env.SONAMU_DB_HOST ?? "localhost";
    const dbPort = process.env.SONAMU_DB_PORT ?? "5432";
    const dbUser = process.env.SONAMU_DB_USER ?? "postgres";
    const dbPassword = process.env.SONAMU_DB_PASSWORD ?? "postgres";
    const dbName = process.env.SONAMU_DB_NAME ?? "qgrid";
    try {
      const pg = await import("pg");
      const client = new pg.default.Client({
        host: dbHost,
        port: Number(dbPort),
        user: dbUser,
        password: dbPassword,
        database: dbName,
        connectionTimeoutMillis: 5000,
      });
      await client.connect();
      await client.end();
    } catch (e) {
      const err = e as Error;
      console.error(`Error: Cannot connect to PostgreSQL at ${dbHost}:${dbPort}/${dbName}`);
      console.error(`error:  ${err.message}`);
      if (err.message.includes("timeout expired")) {
        console.error(
          `cannot connect to the database server. Please check if the database is running and accessible.`,
        );
      }

      console.error(`\nProvide DB connection via --db flag or QGRID_DB_* env vars:`);
      console.error(`  qgrid --db postgres://user:password@host:port/dbname`);
      process.exit(1);
    }

    try {
      await import(serverEntry);
    } catch (e) {
      console.error("Failed to start server:", (e as Error).stack ?? (e as Error).message);
      process.exit(1);
    }
  });

program.parse();
