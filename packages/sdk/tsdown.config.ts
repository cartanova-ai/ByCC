import { defineConfig } from "tsdown";

export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm"],
  dts: { entry: "src/index.ts" },
  clean: true,
  fixedExtension: false,
  target: "node20",
});
