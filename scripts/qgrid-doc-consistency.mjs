import { constants } from "node:fs";
import { access, cp, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mapPath = path.join(repoRoot, "docs", "qgrid-doc-map.json");
const shouldSync = process.argv.slice(2).includes("--sync");

async function exists(target) {
  try {
    await access(target, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function listFiles(root, current = root) {
  if (!(await exists(current))) return [];

  const entries = await readdir(current, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(root, absolute)));
    } else if (entry.isFile()) {
      files.push(path.relative(root, absolute));
    }
  }

  return files.sort();
}

async function compareDirectories(source, mirror) {
  const sourceFiles = await listFiles(source);
  const mirrorFiles = await listFiles(mirror);
  const allFiles = [...new Set([...sourceFiles, ...mirrorFiles])].sort();
  const differences = [];

  for (const relative of allFiles) {
    const sourcePath = path.join(source, relative);
    const mirrorPath = path.join(mirror, relative);

    if (!(await exists(sourcePath))) {
      differences.push(`${relative} (mirror only)`);
      continue;
    }
    if (!(await exists(mirrorPath))) {
      differences.push(`${relative} (canonical only)`);
      continue;
    }

    const [sourceContent, mirrorContent] = await Promise.all([
      readFile(sourcePath),
      readFile(mirrorPath),
    ]);
    if (!sourceContent.equals(mirrorContent)) differences.push(relative);
  }

  return differences;
}

async function validateMappedPaths(docMap) {
  const errors = [];

  for (const topic of docMap.topics) {
    for (const relative of [...topic.code, ...topic.skill]) {
      if (!(await exists(path.join(repoRoot, relative)))) {
        errors.push(`${topic.id}: missing ${relative}`);
      }
    }

    if (!topic.notion.url.startsWith("https://app.notion.com/")) {
      errors.push(`${topic.id}: invalid Notion URL ${topic.notion.url}`);
    }
  }

  return errors;
}

const docMap = JSON.parse(await readFile(mapPath, "utf8"));
const canonical = path.join(repoRoot, docMap.canonicalSkill);

if (!(await exists(path.join(canonical, "SKILL.md")))) {
  console.error(`qgrid canonical skill not found: ${docMap.canonicalSkill}`);
  process.exit(1);
}

if (shouldSync) {
  for (const relativeMirror of docMap.skillMirrors) {
    const mirror = path.join(repoRoot, relativeMirror);
    await rm(mirror, { recursive: true, force: true });
    await cp(canonical, mirror, { recursive: true });
    console.log(`qgrid skill synced: ${relativeMirror}`);
  }
}

const errors = await validateMappedPaths(docMap);

for (const relativeMirror of docMap.skillMirrors) {
  const mirror = path.join(repoRoot, relativeMirror);
  const differences = await compareDirectories(canonical, mirror);
  for (const difference of differences) {
    errors.push(`${relativeMirror}: ${difference}`);
  }
}

if (errors.length > 0) {
  console.error("qgrid documentation consistency check failed:");
  for (const error of errors) console.error(`- ${error}`);
  console.error("Run `mise run qgrid-docs:sync` after updating the canonical skill.");
  process.exit(1);
}

console.log("qgrid skill mirror and documentation map are consistent.");
