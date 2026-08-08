import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  detectSelfUpdatePackageManager,
  parseVersion,
  parsePnpmGlobalBinDir,
  resolveQgridRestartCommand,
  runSelfUpdate,
  selfUpdateInstallCommand,
  type SelfUpdateDependencies,
  withPrependedPath,
} from "./self-update";

describe("qgrid CLI self-update", () => {
  function dependencies(
    overrides: Partial<SelfUpdateDependencies> = {},
  ): SelfUpdateDependencies {
    return {
      latestVersion: vi.fn(() => "2.6.11"),
      commandPath: vi.fn(() => "/usr/local/bin/qgrid"),
      commandVersion: vi.fn(() => "qgrid 2.6.11"),
      pnpmGlobalBinDir: vi.fn(() => null),
      spawn: vi.fn(() => ({ status: 0 })),
      log: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      ...overrides,
    };
  }

  it("installs the exact latest version instead of the moving latest tag", () => {
    expect(
      selfUpdateInstallCommand("pnpm", "@cartanova/qgrid-cli", "2.3.9"),
    ).toStrictEqual({
      command: "pnpm",
      args: ["add", "-g", "@cartanova/qgrid-cli@2.3.9", "--save-exact"],
    });

    expect(selfUpdateInstallCommand("npm", "@cartanova/qgrid-cli", "2.3.9")).toStrictEqual({
      command: "npm",
      args: ["i", "-g", "@cartanova/qgrid-cli@2.3.9"],
    });
  });

  it("parses the same exact semantic version used for post-install verification", () => {
    expect(parseVersion("qgrid 2.6.11")).toBe("2.6.11");
    expect(parseVersion("codex-cli 2.6.11-beta.1+build.4")).toBe("2.6.11-beta.1+build.4");
    expect(parseVersion(null)).toBeNull();
  });

  it("detects pnpm installs from either npm user-agent or qgrid shim path", () => {
    expect(detectSelfUpdatePackageManager("/usr/local/bin/qgrid", "pnpm/11.7.0")).toBe("pnpm");
    expect(detectSelfUpdatePackageManager("/Users/me/Library/pnpm/qgrid", "npm/11.0.0")).toBe(
      "pnpm",
    );
    expect(detectSelfUpdatePackageManager("/usr/local/bin/qgrid", "npm/11.0.0")).toBe("npm");
  });

  it("parses pnpm's global-bin-dir PATH error", () => {
    expect(
      parsePnpmGlobalBinDir(
        '[ERROR] The configured global bin directory "/Users/me/Library/pnpm/bin" is not in PATH',
      ),
    ).toBe("/Users/me/Library/pnpm/bin");
  });

  it("prepends pnpm global bin to PATH once", () => {
    const env = { PATH: ["/usr/bin", "/bin"].join(delimiter) };

    expect(withPrependedPath(env, "/pnpm/bin").PATH).toBe(
      ["/pnpm/bin", "/usr/bin", "/bin"].join(delimiter),
    );
    expect(withPrependedPath({ PATH: "/pnpm/bin" }, "/pnpm/bin").PATH).toBe("/pnpm/bin");
  });

  it("restarts from the pnpm global bin qgrid when it exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "qgrid-bin-"));
    const qgrid = join(dir, process.platform === "win32" ? "qgrid.cmd" : "qgrid");
    writeFileSync(qgrid, "");

    expect(resolveQgridRestartCommand("pnpm", dir)).toBe(qgrid);
    expect(resolveQgridRestartCommand("npm", dir)).toBe("qgrid");
  });

  it("continues boot when the npm version lookup fails", () => {
    const deps = dependencies({
      latestVersion: vi.fn(() => {
        throw new Error("npm unavailable");
      }),
    });

    expect(
      runSelfUpdate(
        {
          packageName: "@cartanova/qgrid-cli",
          currentVersion: "2.6.10",
          args: [],
          env: {},
        },
        deps,
      ),
    ).toEqual({ kind: "continue" });
    expect(deps.warn).toHaveBeenCalledWith(
      "Warning: failed to check for qgrid-cli updates: npm unavailable",
    );
    expect(deps.warn).toHaveBeenCalledWith("Continuing with qgrid-cli 2.6.10.");
    expect(deps.spawn).not.toHaveBeenCalled();
  });

  it.each([1, null])("continues boot when the exact-version install returns %s", (status) => {
    const deps = dependencies({ spawn: vi.fn(() => ({ status })) });

    expect(
      runSelfUpdate(
        {
          packageName: "@cartanova/qgrid-cli",
          currentVersion: "2.6.10",
          args: [],
          env: {},
          userAgent: "npm/11.0.0",
        },
        deps,
      ),
    ).toEqual({ kind: "continue" });
    expect(deps.spawn).toHaveBeenCalledWith(
      "npm",
      ["i", "-g", "@cartanova/qgrid-cli@2.6.11"],
      expect.objectContaining({ stdio: "inherit", timeout: 120_000 }),
    );
    expect(deps.warn).toHaveBeenCalledWith("Warning: failed to update qgrid-cli to 2.6.11.");
    expect(deps.commandVersion).not.toHaveBeenCalled();
  });

  it("continues boot when the installed command does not resolve to the exact version", () => {
    const deps = dependencies({ commandVersion: vi.fn(() => "qgrid 2.6.10") });

    expect(
      runSelfUpdate(
        {
          packageName: "@cartanova/qgrid-cli",
          currentVersion: "2.6.10",
          args: [],
          env: {},
          userAgent: "npm/11.0.0",
        },
        deps,
      ),
    ).toEqual({ kind: "continue" });
    expect(deps.warn).toHaveBeenCalledWith(
      "Warning: updated qgrid-cli verification failed. Expected 2.6.11, found 2.6.10.",
    );
    expect(deps.spawn).toHaveBeenCalledTimes(1);
  });

  it("keeps exact-version verification and restarts with --skip-update on success", () => {
    const spawn = vi
      .fn<SelfUpdateDependencies["spawn"]>()
      .mockReturnValueOnce({ status: 0 })
      .mockReturnValueOnce({ status: 7 });
    const deps = dependencies({ spawn });

    expect(
      runSelfUpdate(
        {
          packageName: "@cartanova/qgrid-cli",
          currentVersion: "2.6.10",
          args: ["--port", "44900"],
          env: { PATH: "/usr/bin" },
          userAgent: "npm/11.0.0",
        },
        deps,
      ),
    ).toEqual({ kind: "exit", exitCode: 7 });
    expect(spawn).toHaveBeenNthCalledWith(
      1,
      "npm",
      ["i", "-g", "@cartanova/qgrid-cli@2.6.11"],
      expect.objectContaining({ stdio: "inherit", timeout: 120_000 }),
    );
    expect(deps.commandVersion).toHaveBeenCalledWith("qgrid", { PATH: "/usr/bin" });
    expect(spawn).toHaveBeenNthCalledWith(
      2,
      "qgrid",
      ["--port", "44900", "--skip-update"],
      expect.objectContaining({ stdio: "inherit" }),
    );
    expect(spawn.mock.calls[1]?.[2]).not.toHaveProperty("timeout");
  });

  it("returns a failure when the restarted process has no exit status", () => {
    const spawn = vi
      .fn<SelfUpdateDependencies["spawn"]>()
      .mockReturnValueOnce({ status: 0 })
      .mockReturnValueOnce({ status: null });
    const deps = dependencies({ spawn });

    expect(
      runSelfUpdate(
        {
          packageName: "@cartanova/qgrid-cli",
          currentVersion: "2.6.10",
          args: [],
          env: {},
          userAgent: "npm/11.0.0",
        },
        deps,
      ),
    ).toEqual({ kind: "exit", exitCode: 1 });
    expect(deps.error).toHaveBeenCalledWith("Failed to restart qgrid-cli after updating.");
  });
});
