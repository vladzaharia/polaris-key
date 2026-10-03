import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { defineConfig, type Plugin } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/**
 * The Polaris Key web identity (favicons, touch icon, PWA manifest and its icons) for BOTH SPAs,
 * taken verbatim from `@polaris-key/brand/web/key/` (the launch kit's `04-web/key`; BRAND.md §7.1:
 * the console and the portal are Pinned K surfaces, and one origin installs one identity).
 *
 * They are emitted under `/assets/branding/key/` rather than the kit's suggested `/branding/key/`
 * because the Worker hands the assets binding only `/`, `/index.html`, `/assets/*` and `/manage/*`
 * (packages/worker/src/router.ts); any other top-level segment is a product slug. The manifest's
 * icon `src`s are relative, so they resolve next to it unchanged. Nothing is copied into this
 * package: the plugin reads the brand package's files at build time and serves them in `vite dev`.
 * `index.html` and `manage.html` link exactly these paths (test/brandHead.test.ts).
 */
const BRAND_WEB_DIR = "assets/branding/key";
const BRAND_WEB_FILES: readonly string[] = [
  "favicon.svg",
  "favicon.ico",
  "app-icon-dark-180.png",
  "site.webmanifest",
  "app-icon-dark-192.png",
  "app-icon-dark-512.png",
  "app-icon-dark-maskable-192.png",
  "app-icon-dark-maskable-512.png",
];

const brandWebKey = dirname(
  createRequire(import.meta.url).resolve(
    "@polaris-key/brand/web/key/favicon.svg",
  ),
);

const CONTENT_TYPES: Record<string, string> = {
  svg: "image/svg+xml",
  ico: "image/x-icon",
  png: "image/png",
  webmanifest: "application/manifest+json",
};

function brandWebAssets(): Plugin {
  const prefix = `/${BRAND_WEB_DIR}/`;
  return {
    name: "polaris-key-brand-web-assets",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = req.url?.split("?")[0] ?? "";
        const name = path.startsWith(prefix) ? path.slice(prefix.length) : "";
        if (!BRAND_WEB_FILES.includes(name)) return next();
        const ext = name.split(".").pop() ?? "";
        res.setHeader(
          "content-type",
          CONTENT_TYPES[ext] ?? "application/octet-stream",
        );
        res.end(readFileSync(join(brandWebKey, name)));
      });
    },
    generateBundle() {
      for (const name of BRAND_WEB_FILES) {
        this.emitFile({
          type: "asset",
          fileName: `${BRAND_WEB_DIR}/${name}`,
          source: readFileSync(join(brandWebKey, name)),
        });
      }
    },
  };
}

// The customer portal is served at `/`; the operator console is served at `/manage`.
// Both are emitted from one Vite build and served by the Worker assets binding.
export default defineConfig({
  base: "/",
  plugins: [react(), tailwindcss(), brandWebAssets()],
  resolve: {
    // @polaris-key/brand is a workspace package with its own React 18 dev dependency; its marks
    // must render with THIS package's React 19, never a second copy.
    dedupe: ["react", "react-dom"],
  },
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
    setupFiles: ["test/setup.ts"],
    // Room for several 5 s async waits (test/setup.ts) inside one test.
    testTimeout: 20_000,
  },
});
