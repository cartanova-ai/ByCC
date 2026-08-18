import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  findRuntimeDependencyIssues,
  resolveCatalogSpecifier,
} from "./check-bundled-api-dependencies.mjs";

test("reports API runtime dependencies missing from the CLI package", () => {
  const apiPackage = {
    dependencies: {
      alpha: "^1.0.0",
      beta: "^2.0.0",
    },
  };
  const cliPackage = {
    dependencies: {
      alpha: "^1.0.0",
    },
  };

  assert.deepEqual(findRuntimeDependencyIssues(apiPackage, cliPackage), [
    {
      apiSpecifier: "^2.0.0",
      cliSpecifier: null,
      name: "beta",
      reason: "missing",
    },
  ]);
});

test("ignores API development-only dependencies", () => {
  const apiPackage = {
    dependencies: {
      runtime: "^1.0.0",
    },
    devDependencies: {
      testOnly: "^1.0.0",
    },
  };
  const cliPackage = {
    dependencies: {
      runtime: "^1.0.0",
    },
  };

  assert.deepEqual(findRuntimeDependencyIssues(apiPackage, cliPackage), []);
});

test("reports CLI ranges that can install versions outside the API range", () => {
  const apiPackage = {
    dependencies: {
      runtime: "^2.0.0",
    },
  };
  const cliPackage = {
    dependencies: {
      runtime: "^1.0.0",
    },
  };

  assert.deepEqual(findRuntimeDependencyIssues(apiPackage, cliPackage), [
    {
      apiSpecifier: "^2.0.0",
      cliSpecifier: "^1.0.0",
      name: "runtime",
      reason: "incompatible-range",
    },
  ]);
});

test("accepts a narrower CLI range and resolves workspace catalog entries", () => {
  const apiPackage = {
    dependencies: {
      catalogRuntime: "catalog:",
      pinnedRuntime: "^2.0.0",
    },
  };
  const cliPackage = {
    dependencies: {
      catalogRuntime: "~1.6.0",
      pinnedRuntime: "2.1.0",
    },
  };
  const workspace = {
    catalog: {
      catalogRuntime: "~1.6.0",
    },
  };

  assert.deepEqual(findRuntimeDependencyIssues(apiPackage, cliPackage, workspace), []);
});

test("the CLI declares every runtime dependency used by its copied API bundle", async () => {
  const [apiPackage, cliPackage, workspace] = await Promise.all([
    readPackage(new URL("../../api/package.json", import.meta.url)),
    readPackage(new URL("../package.json", import.meta.url)),
    readWorkspace(new URL("../../../pnpm-workspace.yaml", import.meta.url)),
  ]);

  assert.deepEqual(findRuntimeDependencyIssues(apiPackage, cliPackage, workspace), []);
  assert.equal(cliPackage.scripts.prepack, "pnpm run test && pnpm run bundle");
  assert.equal(cliPackage.scripts.prepublishOnly, undefined);
});

test("keeps the Better Auth runtime packages on one catalog cohort", async () => {
  const [apiPackage, cliPackage, workspace] = await Promise.all([
    readPackage(new URL("../../api/package.json", import.meta.url)),
    readPackage(new URL("../package.json", import.meta.url)),
    readWorkspace(new URL("../../../pnpm-workspace.yaml", import.meta.url)),
  ]);
  const sharedCohort = ["better-auth", "@better-auth/passkey", "@better-auth/sso"];
  const packageCohorts = [
    [apiPackage, sharedCohort],
    [cliPackage, ["@better-auth/core", ...sharedCohort]],
  ];

  for (const [packageJson, cohort] of packageCohorts) {
    const ranges = cohort.map((name) =>
      resolveCatalogSpecifier(name, packageJson.dependencies[name], workspace),
    );
    assert.equal(new Set(ranges).size, 1);
    assert.equal(ranges[0], workspace.catalog["better-auth"]);
  }

  assert.equal(workspace.catalog["@better-auth/core"], workspace.catalog["better-auth"]);
});

async function readPackage(url) {
  return JSON.parse(await readFile(url, "utf8"));
}

async function readWorkspace(url) {
  const { parse } = await import("yaml");
  return parse(await readFile(url, "utf8"));
}
