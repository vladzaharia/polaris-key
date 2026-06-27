import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// The customer portal is served at `/`; the operator console is served at `/manage`.
// Both are emitted from one Vite build and served by the Worker assets binding.
export default defineConfig({
  base: "/",
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        portal: "index.html",
        manage: "manage.html",
      },
    },
  },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:8787",
      "/login": "http://127.0.0.1:8787",
      "/callback": "http://127.0.0.1:8787",
      "/logout": "http://127.0.0.1:8787",
      "/magic": "http://127.0.0.1:8787",
      "/download": "http://127.0.0.1:8787",
      "/manage/api": "http://127.0.0.1:8787",
      "/manage/login": "http://127.0.0.1:8787",
      "/manage/callback": "http://127.0.0.1:8787",
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    include: ["test/**/*.test.{ts,tsx}", "src/**/*.test.{ts,tsx}"],
  },
});
