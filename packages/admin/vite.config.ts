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
 * The kit's horizontal Polaris Key lockup as 2x PNGs, for the Worker's branded emails
 * (packages/worker/src/services/identity/portal/email.ts; BRAND.md §2 "Emails": mail clients do
 * not render SVG reliably, so email uses the kit PNGs). Served next to the web identity, from
 * `@polaris-key/brand/lockups/key/`: `light` (for light grounds) is the default, `dark` (for dark
 * grounds) is swapped in by the email's dark palette.
 */
const BRAND_LOCKUP_FILES: readonly string[] = [
  "key-horizontal-light-944.png",
  "key-horizontal-dark-944.png",
];

/**
 * Rubik and JetBrains Mono (the brand package's variable WOFF2 files, latin subset, and their
 * licences) at a stable, unhashed path, for the
 * Worker's server-rendered pages (packages/worker/src/platform/brandHtml.ts): their stylesheet is a
 * build constant allowed by its hash, so it cannot follow Vite's content-hashed font names. The
 * SPAs themselves keep loading the hashed copies their CSS imports.
 */
const BRAND_FONT_DIR = "assets/branding/fonts";
const BRAND_FONT_FILES: readonly string[] = [
  "rubik-var-latin.woff2",
  "jetbrains-mono-var-latin.woff2",
  "OFL.txt",
  "OFL-JetBrainsMono.txt",
];

const brandFonts = dirname(
  createRequire(import.meta.url).resolve(
    "@polaris-key/brand/fonts/rubik-var-latin.woff2",
  ),
);

const brandWebKey = dirname(
  createRequire(import.meta.url).resolve(
    "@polaris-key/brand/web/key/favicon.svg",
  ),
);

const brandLockupKey = dirname(
  createRequire(import.meta.url).resolve(
    "@polaris-key/brand/lockups/key/key-horizontal-light-944.png",
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
  { dir: BRAND_WEB_DIR, files: BRAND_LOCKUP_FILES, from: brandLockupKey },
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

/**
 * sonner (the console's toasts) injects its stylesheet at import time with a `<style>` element,
 * which the Worker's `style-src 'self'` blocks. Neutralise the injector; `styles.css` imports the
 * same CSS (`sonner/dist/styles.css`) as a bundled, same-origin stylesheet instead.
 */
function sonnerNoInlineCss(): Plugin {
  const marker = "function __insertCSS(code) {";
  return {
    name: "polaris-key-sonner-no-inline-css",
    enforce: "pre",
    transform(code, id) {
      if (!/[\\/]sonner[\\/]dist[\\/]index\.m?js/.test(id)) return null;
      if (!code.includes(marker)) {
        this.error(
          "sonner no longer defines __insertCSS: re-check its CSS injection against the CSP",
        );
      }
      return { code: code.replace(marker, `${marker} return;`), map: null };
    },
  };
}

/**
 * CodeMirror (the lazy `CodeEditor`) styles itself through style-mod, which adopts a
 * constructable stylesheet only for shadow roots and, for a document, appends a `<style>`
 * element to `<head>` that the Worker's `style-src 'self'` blocks (the editor would render
 * unstyled and log a violation). Let it adopt the sheet on the document too; browsers without
 * `adoptedStyleSheets` (and jsdom) keep the original `<style>` path.
 */
function styleModAdoptedSheets(): Plugin {
  const marker =
    "if (!root.head && root.adoptedStyleSheets && win.CSSStyleSheet) {";
  return {
    name: "polaris-key-style-mod-adopted-sheets",
    enforce: "pre",
    transform(code, id) {
      if (!/[\\/]style-mod[\\/]src[\\/]style-mod\.js/.test(id)) return null;
      if (!code.includes(marker)) {
        this.error(
          "style-mod changed how it mounts styles: re-check CodeMirror against the CSP",
        );
      }
      return {
        code: code.replace(
          marker,
          "if (root.adoptedStyleSheets && win.CSSStyleSheet) {",
        ),
        map: null,
      };
    },
  };
}

/**
 * Radix Select's viewport renders an inline `<style>` (hiding its scrollbar) that the Worker's
 * `style-src 'self'` blocks. Drop the element; `styles.css` carries the same two rules.
 */
function radixSelectNoInlineStyle(): Plugin {
  const pattern =
    /jsx\(\s*"style",\s*\{\s*dangerouslySetInnerHTML:\s*\{\s*__html:\s*`\[data-radix-select-viewport\][^`]*`\s*\},\s*nonce\s*\}\s*\)/;
  return {
    name: "polaris-key-radix-select-no-inline-style",
    enforce: "pre",
    transform(code, id) {
      if (!/[\\/]@radix-ui[\\/]react-select[\\/]dist[\\/]index\.mjs/.test(id))
        return null;
      if (!pattern.test(code)) {
        this.error(
          "Radix Select changed its viewport <style>: re-check it against the CSP",
        );
      }
      return { code: code.replace(pattern, "null"), map: null };
    },
  };
}

// The customer portal is served at `/`; the operator console is served at `/manage`.
// Both are emitted from one Vite build and served by the Worker assets binding.
export default defineConfig({
  base: "/",
  plugins: [
    sonnerNoInlineCss(),
    styleModAdoptedSheets(),
    radixSelectNoInlineStyle(),
    react(),
    tailwindcss(),
    brandWebAssets(),
  ],
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
          // CodeMirror is only reached through the lazy CodeEditor: leave it to that chunk.
          if (id.includes("/@codemirror/") || id.includes("/@lezer/"))
            return undefined;
          return "vendor";
        },
        // The app code both entries import (the ui/ kit, lib/, the stylesheet's JS
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
    // Room for several 10 s async waits (test/setup.ts) inside one test; CI runners run the
    // whole turbo test graph in parallel and are much slower than a laptop.
    testTimeout: 40_000,
  },
});
