import { defineConfig } from "tsdown";

export default defineConfig({
  entry: { cli: "src/cli.ts" },
  format: ["esm"],
  clean: true,
  fixedExtension: false,
  target: "node20",
});
