import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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

/**
 * Rubik (the brand package's WOFF2 files and their licence) at a stable, unhashed path, for the
 * Worker's server-rendered pages (packages/worker/src/core/brandHtml.ts): their stylesheet is a
 * build constant allowed by its hash, so it cannot follow Vite's content-hashed font names. The
 * SPAs themselves keep loading the hashed copies their CSS imports.
 */
const BRAND_FONT_DIR = "assets/branding/fonts";
const BRAND_FONT_FILES: readonly string[] = [
  "rubik-latin-400.woff2",
  "rubik-latin-700.woff2",
  "OFL.txt",
];

const brandFonts = dirname(
  createRequire(import.meta.url).resolve(
    "@polaris-key/brand/fonts/rubik-latin-400.woff2",
  ),
);

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
  woff2: "font/woff2",
  txt: "text/plain; charset=utf-8",
};

const BRAND_DIRS: readonly {
  dir: string;
  files: readonly string[];
  from: string;
}[] = [
  { dir: BRAND_WEB_DIR, files: BRAND_WEB_FILES, from: brandWebKey },
  { dir: BRAND_FONT_DIR, files: BRAND_FONT_FILES, from: brandFonts },
];

function brandWebAssets(): Plugin {
  return {
    name: "polaris-key-brand-web-assets",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = req.url?.split("?")[0] ?? "";
        for (const { dir, files, from } of BRAND_DIRS) {
          const prefix = `/${dir}/`;
          const name = path.startsWith(prefix) ? path.slice(prefix.length) : "";
          if (!files.includes(name)) continue;
          const ext = name.split(".").pop() ?? "";
          res.setHeader(
            "content-type",
            CONTENT_TYPES[ext] ?? "application/octet-stream",
          );
          res.end(readFileSync(join(from, name)));
          return;
        }
        next();
      });
    },
    generateBundle() {
      for (const { dir, files, from } of BRAND_DIRS) {
        for (const name of files) {
          this.emitFile({
            type: "asset",
            fileName: `${dir}/${name}`,
            source: readFileSync(join(from, name)),
          });
        }
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
    alias: [
      // Radix's scroll lock (react-remove-scroll) injects its CSS with react-style-singleton, a
      // <style> element the Worker's `style-src 'self'` blocks. The shim keeps the API and
      // applies the CSS through a constructable stylesheet instead (src/lib/styleSingleton.ts).
      {
        find: /^react-style-singleton$/,
        replacement: fileURLToPath(
          new URL("./src/lib/styleSingleton.ts", import.meta.url),
        ),
      },
    ],
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        portal: "index.html",
        manage: "manage.html",
      },
      output: {
        // Third-party code both SPAs share (React, Radix, lucide…) gets a stable, honest name;
        // left to Rollup, the shared chunk was named after its first module (styles-*.js).
        manualChunks(id) {
          if (!id.includes("/node_modules/")) return undefined;
          // Split the shared third-party code so no chunk crosses Vite's 500 kB warning: the
          // Radix primitives and the console's data and palette libraries ship on their own.
          if (id.includes("/@radix-ui/") || id.includes("/radix-ui/"))
            return "vendor-radix";
          if (id.includes("/@tanstack/")) return "vendor-query";
          if (id.includes("/cmdk/")) return "vendor-cmdk";
          return "vendor";
        },
        // The app code both entries import (the components/ui kit, lib/, the stylesheet's JS
        // stub) is one Rollup-made chunk; name it for what it is.
        chunkFileNames: (chunk) =>
          chunk.name.startsWith("vendor")
            ? "assets/[name]-[hash].js"
            : chunk.isDynamicEntry
              ? "assets/[name]-[hash].js"
              : "assets/shared-[hash].js",
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
