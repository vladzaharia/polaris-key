import { defineConfig } from "vite";
import { aliases, server } from "./vite.shared.mjs";

// A sandboxed preload loads no ES modules from node_modules: Forge's Vite plugin bundles it
// into one CommonJS file.
export default defineConfig({ resolve: { alias: aliases }, server });
