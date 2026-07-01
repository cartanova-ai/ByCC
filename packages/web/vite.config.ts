import path from "path";

import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import dotenv from "dotenv";
import Icons from "unplugin-icons/vite";
import { defineConfig } from "vite";

dotenv.config({ path: ".sonamu.env" });

// https://vitejs.dev/config/
export default defineConfig(({ command, isSsrBuild }) => ({
  clearScreen: false,
  plugins: [
    tanstackRouter({
      autoCodeSplitting: true,
      generatedRouteTree: "./src/routeTree.gen.ts",
      routeFileIgnorePattern: ".*(generated|test|spec).*",
    }),
    react(),
    Icons({
      compiler: "jsx",
      jsx: "react",
      autoInstall: true,
    }),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    host: "0.0.0.0",
    proxy: {
      "/api": `http://${process.env.API_HOST}:${process.env.API_PORT}`,
    },
  },
  build: {
    outDir: "dist/client",
    emptyOutDir: true,
    rollupOptions: {
      output: isSsrBuild
        ? {}
        : {
            manualChunks(id) {
              if (id.includes("node_modules/react-dom") || id.includes("node_modules/react/")) {
                return "vendor-react";
              }
              if (id.includes("@tanstack/react-query") || id.includes("@tanstack/react-router")) {
                return "vendor-tanstack";
              }
              return undefined;
            },
          },
    },
  },
  ssr: {
    noExternal: command === "build" ? true : undefined, // Production build includes all dependencies in bundle
  },
}));
