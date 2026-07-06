import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

export type PackageManager = "npm" | "pnpm";

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
  const result = spawnSync("pnpm", ["bin", "-g"], { encoding: "utf-8" });
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
