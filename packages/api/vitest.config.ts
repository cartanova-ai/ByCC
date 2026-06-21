import { defineConfig, type ViteUserConfig } from "vitest/config";

import { PrioritySequencer } from "./custom-sequencer";

type VitestTestConfig = NonNullable<ViteUserConfig["test"]>;

type SonamuVitestHelpersModule = {
  getSonamuTestConfig: (options: VitestTestConfig) => Promise<VitestTestConfig>;
};

type SonamuReporterModule = {
  NaiteVitestReporter: NonNullable<VitestTestConfig["reporters"]>[number];
};

async function loadSonamuTestingModules() {
  const helpersUrl = new URL(
    "./node_modules/sonamu/dist/testing/vitest-helpers.js",
    import.meta.url,
  );
  const reporterUrl = new URL(
    "./node_modules/sonamu/dist/testing/naite-vitest-reporter.js",
    import.meta.url,
  );

  const [{ getSonamuTestConfig }, { NaiteVitestReporter }] = await Promise.all([
    import(helpersUrl.href) as Promise<SonamuVitestHelpersModule>,
    import(reporterUrl.href) as Promise<SonamuReporterModule>,
  ]);

  return { getSonamuTestConfig, NaiteVitestReporter };
}

export default defineConfig(async () => {
  const { getSonamuTestConfig, NaiteVitestReporter } = await loadSonamuTestingModules();

  return {
    plugins: [],
    test: await getSonamuTestConfig({
      include: ["src/**/*.test.ts"],
      exclude: ["src/**/*.test-hold.ts", "**/node_modules/**", "**/.yarn/**", "**/dist/**"],
      globals: true,
      globalSetup: ["./src/testing/global.ts"],
      setupFiles: ["./src/testing/setup-mocks.ts"],
      sequence: {
        sequencer: PrioritySequencer,
      },
      reporters: ["default", NaiteVitestReporter],
      restoreMocks: true,
      typecheck: {
        enabled: true,
        tsconfig: "./tsconfig.json",
        include: ["src/**/*type-safety.test.ts"],
      },
      coverage: {
        provider: "v8",
        reporter: ["text", "html"],
        include: ["src/**/*.ts"],
        exclude: ["**/*.test.ts", "**/testing/**", "**/node_modules/**", "**/dist/**"],
      },
      includeTaskLocation: true,
      server: {
        deps: {
          inline: ["sonamu"],
        },
      },
    }),
  };
});
