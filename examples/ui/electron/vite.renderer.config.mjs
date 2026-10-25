import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { aliases, define, server } from "./vite.shared.mjs";

export default defineConfig({
  plugins: [react()],
  resolve: { alias: aliases },
  define,
  server,
});
