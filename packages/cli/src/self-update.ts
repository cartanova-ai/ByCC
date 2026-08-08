import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

export type PackageManager = "npm" | "pnpm";

export const SELF_UPDATE_CHECK_TIMEOUT_MS = 15_000;
export const SELF_UPDATE_INSTALL_TIMEOUT_MS = 120_000;

export type SelfUpdateOutcome = { kind: "continue" } | { kind: "exit"; exitCode: number };

export type SelfUpdateDependencies = {
  latestVersion: (packageName: string) => string;
  commandPath: (command: string) => string;
  commandVersion: (command: string, env: NodeJS.ProcessEnv) => string | null;
  pnpmGlobalBinDir: () => string | null;
  spawn: (
    command: string,
    args: string[],
    options: { env: NodeJS.ProcessEnv; stdio: "inherit"; timeout?: number },
  ) => { status: number | null };
  log: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

export type SelfUpdateParams = {
  packageName: string;
  currentVersion: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  userAgent?: string;
};

export function parseVersion(output: string | null): string | null {
  return output?.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?/)?.[0] ?? null;
}

/** qgrid 자체 업데이트만 조율한다. 계속 기동할지, 새 바이너리 종료 코드를 전달할지 반환한다. */
export function runSelfUpdate(
  params: SelfUpdateParams,
  dependencies: SelfUpdateDependencies,
): SelfUpdateOutcome {
  const { packageName, currentVersion, args, env, userAgent } = params;
  const { latestVersion, commandPath, commandVersion, spawn, log, warn, error } = dependencies;

  let latest: string;
  try {
    latest = latestVersion(packageName);
  } catch (cause) {
    warn(`Warning: failed to check for qgrid-cli updates: ${(cause as Error).message}`);
    warn(`Continuing with qgrid-cli ${currentVersion}.`);
    return { kind: "continue" };
  }

  if (latest === currentVersion) return { kind: "continue" };

  const packageManager = detectSelfUpdatePackageManager(commandPath("qgrid"), userAgent);
  const globalBinDir = packageManager === "pnpm" ? dependencies.pnpmGlobalBinDir() : null;
  const updateEnv = withPrependedPath(env, globalBinDir);
  const installCmd = selfUpdateInstallCommand(packageManager, packageName, latest);
  log(`Updating qgrid-cli: ${currentVersion} → ${latest}`);

  try {
    const updated = spawn(installCmd.command, installCmd.args, {
      env: updateEnv,
      stdio: "inherit",
      timeout: SELF_UPDATE_INSTALL_TIMEOUT_MS,
    });
    if (updated.status !== 0) {
      warn(`Warning: failed to update qgrid-cli to ${latest}.`);
      warn(
        `Continuing with qgrid-cli ${currentVersion}; fix the global ${packageManager} install.`,
      );
      return { kind: "continue" };
    }
  } catch (cause) {
    warn(`Warning: failed to update qgrid-cli to ${latest}: ${(cause as Error).message}`);
    warn(`Continuing with qgrid-cli ${currentVersion}; fix the global ${packageManager} install.`);
    return { kind: "continue" };
  }

  const restartCommand = resolveQgridRestartCommand(packageManager, globalBinDir);
  const updatedVersion = parseVersion(commandVersion(restartCommand, updateEnv));
  if (updatedVersion !== latest) {
    warn(
      `Warning: updated qgrid-cli verification failed. Expected ${latest}, found ${updatedVersion ?? "unknown"}.`,
    );
    warn(
      `Continuing with qgrid-cli ${currentVersion}; check PATH and global ${packageManager} bin configuration.`,
    );
    return { kind: "continue" };
  }

  log("Updated. Restarting...\n");
  const restarted = spawn(restartCommand, args.concat("--skip-update"), {
    env: updateEnv,
    stdio: "inherit",
  });
  if (restarted.status === null) {
    error("Failed to restart qgrid-cli after updating.");
    return { kind: "exit", exitCode: 1 };
  }
  return { kind: "exit", exitCode: restarted.status };
}

export function detectSelfUpdatePackageManager(
  qgridPath: string,
  userAgent = process.env.npm_config_user_agent,
): PackageManager {
  return userAgent?.includes("pnpm") || qgridPath.includes("pnpm") ? "pnpm" : "npm";
}

export function parsePnpmGlobalBinDir(output: string): string | null {
  return (
    output.match(/configured global bin directory "([^"]+)"/)?.[1] ??
    output.match(/global bin directory "([^"]+)"/)?.[1] ??
    null
  );
}

export function pnpmGlobalBinDir(): string | null {
  const result = spawnSync("pnpm", ["bin", "-g"], {
    encoding: "utf-8",
    timeout: SELF_UPDATE_CHECK_TIMEOUT_MS,
  });
  if (result.status === 0) {
    const value = result.stdout.trim();
    return value.length > 0 ? value : null;
  }

  return parsePnpmGlobalBinDir(`${result.stdout}\n${result.stderr}`);
}

export function withPrependedPath(
  env: NodeJS.ProcessEnv,
  pathEntry: string | null,
): NodeJS.ProcessEnv {
  if (!pathEntry) return env;

  const pathValue = env.PATH ?? "";
  const parts = pathValue.split(delimiter).filter(Boolean);
  if (parts.includes(pathEntry)) return env;

  return {
    ...env,
    PATH: [pathEntry, ...parts].join(delimiter),
  };
}

export function selfUpdateInstallCommand(
  packageManager: PackageManager,
  packageName: string,
  version: string,
): { command: string; args: string[] } {
  const exactPackage = `${packageName}@${version}`;
  return packageManager === "pnpm"
    ? { command: "pnpm", args: ["add", "-g", exactPackage, "--save-exact"] }
    : { command: "npm", args: ["i", "-g", exactPackage] };
}

export function resolveQgridRestartCommand(
  packageManager: PackageManager,
  globalBinDir: string | null,
): string {
  if (packageManager !== "pnpm" || !globalBinDir) return "qgrid";

  const executable = process.platform === "win32" ? "qgrid.cmd" : "qgrid";
  const candidate = join(globalBinDir, executable);
  return existsSync(candidate) ? candidate : "qgrid";
}
