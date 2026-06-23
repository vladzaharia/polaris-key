import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// The admin SPA is served by the Worker under `/admin/`, so assets are emitted with that
// base. Dev proxies the API/auth surface to a local `wrangler dev` on :8787.
export default defineConfig({
  base: "/admin/",
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    proxy: {
      "/admin/api": "http://127.0.0.1:8787",
      "/admin/login": "http://127.0.0.1:8787",
      "/admin/callback": "http://127.0.0.1:8787",
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    include: ["test/**/*.test.{ts,tsx}", "src/**/*.test.{ts,tsx}"],
  },
});
