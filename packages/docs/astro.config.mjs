// The Polaris Key docs site. Built once, served by the worker at key.plrs.im/docs behind the
// platform-admin session gate (packages/worker/src/docs.ts) — there is no public docs origin,
// which is why the site may carry the real runbook/deployment material.
//
// Build knobs that exist for the WORKER, not for taste:
//   - `base: "/docs"` — the worker maps /docs/* straight onto the assembled asset root.
//   - `format: "directory"` — page URLs end in `/`; the worker resolves extension-less paths
//     to `<path>/index.html` (docs.ts#docsAssetPath).
//   - `inlineStylesheets: "never"` — inline <style> would each need a CSP hash; external
//     stylesheets keep the hash set small and stable (scripts/collect-csp-hashes.mjs).
//   - passthrough image service — no sharp native dependency; the site's images are SVGs and
//     screenshots served as-is.

import { fileURLToPath } from "node:url";
import { defineConfig, passthroughImageService } from "astro/config";
import react from "@astrojs/react";
import starlight from "@astrojs/starlight";
import tailwindcss from "@tailwindcss/vite";
import { loadMap, redirectsFor } from "./scripts/site-map.mjs";
import { starlightSidebar } from "./src/lib/doors.ts";
import importedMarkdown from "./scripts/imported-markdown.mjs";
import { helpCodeRedirects } from "./src/lib/helpMessages.ts";

export default defineConfig({
  site: "https://key.plrs.im",
  base: "/docs",
  trailingSlash: "ignore",
  // Moved pages. Each key is the old route (without the base); the value is the full new URL,
  // base included. Astro writes a meta-refresh page at the old path, so old links and console
  // help links keep working and check:links still sees a target. The table is derived from
  // site-map.json (scripts/site-map.mjs): a row redirects once its old page is gone.
  // Plus /help/code/<id> for every message id (docs plan §3.1, §7.4): kits and own-UI apps link
  // there, and each lands on the id's own anchor. Static pages, so both hosts serve them with
  // the existing tier gate (the /docs/help/ prefix is public) and no Worker route.
  redirects: { ...redirectsFor(loadMap()), ...helpCodeRedirects() },
  image: { service: passthroughImageService() },
  build: {
    format: "directory",
    inlineStylesheets: "never",
  },
  vite: {
    plugins: [
      importedMarkdown(),
      tailwindcss(),
      {
        // Expressive Code's `<Code>` component resolves ec.config.mjs relative to a virtual
        // module, finds nothing, and renders with the defaults, so a block from `<Code>`
        // (Snippet, InstallSteps) would not match one from Markdown. Point it at the file.
        name: "pk-ec-config",
        enforce: "pre",
        resolveId(id) {
          if (id === "virtual:astro-expressive-code/ec-config")
            return fileURLToPath(new URL("./ec.config.mjs", import.meta.url));
        },
      },
    ],
    resolve: {
      // The console's ui/ components (packages/admin/src/ui, docs plan 8.2) import React from the
      // admin package; the docs render them with their own. One copy, or elements built by one
      // are rejected by the other's renderer.
      dedupe: ["react", "react-dom"],
    },
    ssr: {
      // Expressive Code's chunk inlines postcss (CJS), whose `require("nanoid/non-secure")`
      // gets rewritten to a DEFAULT import; nanoid v3's ESM build has no default export, so
      // route generation crashes unless nanoid is bundled too (Rollup's CJS interop then
      // resolves the require correctly).
      noExternal: ["nanoid"],
    },
  },
  integrations: [
    // Renders the console's static ui/ components at build time (no client: directive, so no
    // component ships JavaScript). See src/components/console.ts for the set.
    react(),
    starlight({
      title: "Polaris Key",
      description:
        "Licensing, managed config, releases, distribution, updates and sign-in for apps built on Polaris Key.",
      // The brand (docs/design/BRAND.md §2): tokens and Rubik from @polaris-key/brand, then the
      // Starlight mapping in global.css. All three are bundled stylesheets (no inline style).
      customCss: [
        "@polaris-key/brand/tokens.css",
        "@polaris-key/brand/fonts.css",
        "./src/styles/global.css",
        "./src/styles/help.css",
        "./src/styles/chrome.css",
        "./src/styles/search.css",
      ],
      // The launch kit's Pinned K web identity, copied into public/branding/key/ by
      // scripts/copy-artifacts.mjs (no terminal bit on favicons; BRAND.md §6 rule 0).
      favicon: "/branding/key/favicon.svg",
      head: [
        {
          tag: "link",
          attrs: {
            rel: "icon",
            type: "image/x-icon",
            sizes: "16x16 24x24 32x32 48x48 64x64 128x128 256x256",
            href: "/docs/branding/key/favicon.ico",
          },
        },
        {
          tag: "link",
          attrs: {
            rel: "apple-touch-icon",
            sizes: "180x180",
            href: "/docs/branding/key/app-icon-dark-180.png",
          },
        },
        {
          tag: "meta",
          attrs: {
            name: "theme-color",
            content: "#060912",
            media: "(prefers-color-scheme: dark)",
          },
        },
        {
          tag: "meta",
          attrs: {
            name: "theme-color",
            content: "#f6f8ff",
            media: "(prefers-color-scheme: light)",
          },
        },
      ],
      components: {
        Header: "./src/components/Header.astro",
        // The search dialog on Pagefind's JS API (src/components/Search.astro).
        Search: "./src/components/Search.astro",
        ThemeProvider: "./src/components/ThemeProvider.astro",
        SiteTitle: "./src/components/SiteTitle.astro",
        PageFrame: "./src/components/PageFrame.astro",
        PageTitle: "./src/components/PageTitle.astro",
        // Help's chrome (docs.help-*, docs.mobile-menu): each override draws Starlight's own on every
        // other door.
        Footer: "./src/components/Footer.astro",
        MobileMenuFooter: "./src/components/MobileMenuFooter.astro",
        Sidebar: "./src/components/Sidebar.astro",
        SocialIcons: "./src/components/SocialIcons.astro",
        ThemeSelect: "./src/components/ThemeSelect.astro",
      },
      // "On this page" for the Help messages pages, whose headings come from components rather
      // than from Markdown (src/routeData.ts).
      routeMiddleware: ["./src/routeData.ts", "./src/routeToc.ts"],
      // The three doors' trees (src/lib/doors.ts), in door order. Stubs are hidden by their own
      // frontmatter. DOC-02b's Sidebar override renders only the current door's tree.
      sidebar: starlightSidebar(),
    }),
  ],
});
