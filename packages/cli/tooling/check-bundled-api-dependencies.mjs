import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import semver from "semver";
import { parse } from "yaml";

export function findRuntimeDependencyIssues(apiPackage, cliPackage, workspace = {}) {
  const apiDependencies = apiPackage.dependencies ?? {};
  const cliDependencies = cliPackage.dependencies ?? {};

  return Object.entries(apiDependencies)
    .flatMap(([name, rawApiSpecifier]) => {
      const apiSpecifier = resolveCatalogSpecifier(name, rawApiSpecifier, workspace);

      if (!(name in cliDependencies)) {
        return [{ apiSpecifier, cliSpecifier: null, name, reason: "missing" }];
      }

      const cliSpecifier = resolveCatalogSpecifier(name, cliDependencies[name], workspace);
      if (
        apiSpecifier === null ||
        cliSpecifier === null ||
        !isCompatibleRuntimeRange(apiSpecifier, cliSpecifier)
      ) {
        return [{ apiSpecifier, cliSpecifier, name, reason: "incompatible-range" }];
      }

      return [];
    })
    .toSorted((left, right) => left.name.localeCompare(right.name));
}

async function readPackage(url) {
  return JSON.parse(await readFile(url, "utf8"));
}

export function resolveCatalogSpecifier(name, specifier, workspace) {
  if (typeof specifier !== "string" || !specifier.startsWith("catalog:")) {
    return specifier;
  }

  const catalogName = specifier.slice("catalog:".length);
  const catalog = catalogName ? workspace.catalogs?.[catalogName] : workspace.catalog;
  return catalog?.[name] ?? null;
}

function isCompatibleRuntimeRange(apiSpecifier, cliSpecifier) {
  if (apiSpecifier === cliSpecifier) {
    return true;
  }

  if (semver.validRange(apiSpecifier) === null || semver.validRange(cliSpecifier) === null) {
    return false;
  }

  // The copied API has no package manifest of its own at install time. The CLI
  // range must therefore be a subset of the range the API declares as valid.
  return semver.subset(cliSpecifier, apiSpecifier);
}

async function main() {
  const [apiPackage, cliPackage, workspace] = await Promise.all([
    readPackage(new URL("../../api/package.json", import.meta.url)),
    readPackage(new URL("../package.json", import.meta.url)),
    readFile(new URL("../../../pnpm-workspace.yaml", import.meta.url), "utf8").then(parse),
  ]);
  const issues = findRuntimeDependencyIssues(apiPackage, cliPackage, workspace);

  if (issues.length === 0) {
    console.log("CLI bundle dependency contract is satisfied.");
    return;
  }

  console.error(
    [
      "CLI runtime dependencies do not satisfy the copied API bundle:",
      ...issues.map(formatIssue),
      "Align packages/cli/package.json with packages/api/package.json before publishing.",
    ].join("\n"),
  );
  process.exitCode = 1;
}

function formatIssue(issue) {
  if (issue.reason === "missing") {
    return `- ${issue.name}: missing from CLI (API requires ${issue.apiSpecifier})`;
  }

  return `- ${issue.name}: incompatible ranges (API ${issue.apiSpecifier}, CLI ${issue.cliSpecifier})`;
}

const entryPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (entryPath === import.meta.url) {
  await main();
}
