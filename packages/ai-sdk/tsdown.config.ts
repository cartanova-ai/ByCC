import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  dts: true,
  clean: true,
  format: "esm",
  external: ["ai", "@ai-sdk/provider", "@ai-sdk/provider-utils"],
});
