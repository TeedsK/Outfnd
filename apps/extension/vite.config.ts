/**
 * Outfnd — Vite config for Chrome Extension
 * Uses @crxjs/vite-plugin to bundle MV3 (background, side-panel, content).
 * Adds tsconfig-paths so we can import from @outfnd/shared/* cleanly.
 */
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { crx } from "@crxjs/vite-plugin";
import tsconfigPaths from "vite-tsconfig-paths";
import manifest from "./manifest.json";

export default defineConfig({
  plugins: [react(), tsconfigPaths(), crx({ manifest })],
  build: {
    outDir: "dist",
    sourcemap: true
  }
});
