import vue from "@vitejs/plugin-vue";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: { "@shared": fileURLToPath(new URL("../connector/src/shared", import.meta.url)) },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // Keep everything as real files: the connector's CSP allows only 'self' scripts.
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
    target: "es2020",
  },
});
