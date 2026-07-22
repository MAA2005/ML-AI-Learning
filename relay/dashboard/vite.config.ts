/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The Relay gateway runs on 127.0.0.1:8787 in dev. We proxy the read-only
// status endpoints so the dashboard can call them same-origin (no CORS, and
// the browser never needs to know the gateway's real address).
//
// Port is configurable: `relay dev` passes the gateway's actual address via
// RELAY_GATEWAY_URL so a non-default RELAY_PORT still proxies correctly.
const GATEWAY =
  process.env.RELAY_GATEWAY_URL ??
  `http://127.0.0.1:${process.env.RELAY_PORT ?? "8787"}`;

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/health": { target: GATEWAY, changeOrigin: true },
      "/v1": { target: GATEWAY, changeOrigin: true },
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    css: false,
  },
});
