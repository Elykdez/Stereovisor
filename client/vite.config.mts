import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The dev proxy follows the service port so both sides read one value.
const SERVICE_PORT = process.env.STEREOVISOR_SERVICE_PORT?.trim() || "5772";
const CLIENT_ROOT = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: CLIENT_ROOT,
  base: "./",
  plugins: [react()],
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
