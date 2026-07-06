import { existsSync } from "node:fs";
import { cp, mkdir, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = path.dirname(fileURLToPath(import.meta.url));
const sourceSkillsDir = path.join(packageDir, "skills", "qgrid");

function hasArg(name) {
  return process.argv.slice(2).includes(name);
}

function findProjectRoot(startDir) {
  let current = path.resolve(startDir);
  let packageJsonRoot = null;

  while (true) {
    if (
      existsSync(path.join(current, "pnpm-workspace.yaml")) ||
      existsSync(path.join(current, ".git"))
    ) {
      return current;
    }

    if (!packageJsonRoot && existsSync(path.join(current, "package.json"))) {
      packageJsonRoot = current;
    }

    const parent = path.dirname(current);
    if (parent === current) return packageJsonRoot ?? path.resolve(startDir);
    current = parent;
  }
}

function defaultProjectRoot() {
  if (process.env.QGRID_SKILLS_CWD) return findProjectRoot(process.env.QGRID_SKILLS_CWD);
  if (process.env.INIT_CWD) return findProjectRoot(process.env.INIT_CWD);

  const cwd = process.cwd();
  if (cwd.includes(`${path.sep}node_modules${path.sep}`)) return null;
  return findProjectRoot(cwd);
}

function defaultTargets() {
  const isGlobalInstall =
    process.env.npm_config_global === "true" || process.env.npm_config_location === "global";

  if (hasArg("--global") || isGlobalInstall) {
    const codexHome = process.env.CODEX_HOME
      ? path.resolve(process.env.CODEX_HOME)
      : path.join(os.homedir(), ".codex");
    const claudeHome = process.env.CLAUDE_HOME
      ? path.resolve(process.env.CLAUDE_HOME)
      : path.join(os.homedir(), ".claude");
    return [
      { label: "Codex", target: path.join(codexHome, "skills", "qgrid"), useSymlink: false },
      { label: "Claude Code", target: path.join(claudeHome, "skills", "qgrid"), useSymlink: false },
    ];
  }

  const projectRoot = defaultProjectRoot();
  if (!projectRoot) return null;

  return [
    {
      label: "Codex",
      target: path.join(projectRoot, ".agents", "skills", "qgrid"),
      useSymlink: true,
    },
    {
      label: "Claude Code",
      target: path.join(projectRoot, ".claude", "skills", "qgrid"),
      useSymlink: true,
    },
  ];
}

async function syncSkill({ label, target, useSymlink }) {
  if (!existsSync(path.join(sourceSkillsDir, "SKILL.md"))) {
    console.log("qgrid skill source not found in qgrid CLI package.");
    return;
  }

  await rm(target, { recursive: true, force: true });
  await mkdir(path.dirname(target), { recursive: true });

  if (useSymlink) {
    try {
      await symlink(sourceSkillsDir, target, "dir");
      console.log(`qgrid skill linked for ${label}: ${target}`);
      return;
    } catch (error) {
      console.log(
        `qgrid skill symlink failed for ${label}: ${error instanceof Error ? error.message : String(error)}`,
      );
      console.log("falling back to copy");
    }
  }

  await cp(sourceSkillsDir, target, { recursive: true });
  console.log(`qgrid skill copied for ${label}: ${target}`);
}

const targetConfigs = defaultTargets();

if (!targetConfigs) {
  console.log("qgrid skill sync skipped: project root not found.");
  process.exit(0);
}

try {
  for (const targetConfig of targetConfigs) {
    await syncSkill(targetConfig);
  }
} catch (error) {
  console.error(`qgrid skill sync failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
