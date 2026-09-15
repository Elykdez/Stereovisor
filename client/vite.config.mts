import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The dev proxy follows the service port so both sides read one value.
const SERVICE_PORT = process.env.STEREOVISOR_SERVICE_PORT?.trim() || "5772";
const CLIENT_ROOT = fileURLToPath(new URL(".", import.meta.url));
// versions.json is the single source both package.json and the service read,
// so the renderer's fallback version cannot drift from the shipped build.
const CLIENT_VERSION = JSON.parse(
  readFileSync(new URL("../versions.json", import.meta.url), "utf8")
).client;

export default defineConfig({
  root: CLIENT_ROOT,
  base: "./",
  plugins: [react()],
  define: {
    __CLIENT_VERSION__: JSON.stringify(CLIENT_VERSION)
  },
  resolve: {
    // Keep client tests independent of their depth under client/tests.
    alias: {
      "@": path.join(CLIENT_ROOT, "src")
    }
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // ws:true is required: /api/events upgrades to a WebSocket.
      "/api": { target: `http://127.0.0.1:${SERVICE_PORT}`, ws: true }
    }
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: "./tests/setup.ts"
  }
});
