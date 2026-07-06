import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  detectSelfUpdatePackageManager,
  parsePnpmGlobalBinDir,
  resolveQgridRestartCommand,
  selfUpdateInstallCommand,
  withPrependedPath,
} from "./self-update";

describe("qgrid CLI self-update", () => {
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
});
