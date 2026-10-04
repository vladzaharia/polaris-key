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

import { defineConfig, passthroughImageService } from "astro/config";
import starlight from "@astrojs/starlight";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  site: "https://key.plrs.im",
  base: "/docs",
  trailingSlash: "ignore",
  image: { service: passthroughImageService() },
  build: {
    format: "directory",
    inlineStylesheets: "never",
  },
  vite: {
    plugins: [tailwindcss()],
    ssr: {
      // Expressive Code's chunk inlines postcss (CJS), whose `require("nanoid/non-secure")`
      // gets rewritten to a DEFAULT import; nanoid v3's ESM build has no default export, so
      // route generation crashes unless nanoid is bundled too (Rollup's CJS interop then
      // resolves the require correctly).
      noExternal: ["nanoid"],
    },
  },
  integrations: [
    starlight({
      title: "Polaris Key",
      description:
        "Licensing, managed config, releases, distribution, updates, and identity for multi-product apps — one worker, six services, five SDKs.",
      // The brand (docs/design/BRAND.md §2): tokens and Rubik from @polaris-key/brand, then the
      // Starlight mapping in global.css. All three are bundled stylesheets (no inline style).
      customCss: [
        "@polaris-key/brand/tokens.css",
        "@polaris-key/brand/fonts.css",
        "./src/styles/global.css",
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
        SiteTitle: "./src/components/SiteTitle.astro",
        PageFrame: "./src/components/PageFrame.astro",
        PageTitle: "./src/components/PageTitle.astro",
      },
      sidebar: [
        {
          label: "Start here",
          items: [{ autogenerate: { directory: "start" } }],
        },
        {
          label: "For users",
          collapsed: true,
          items: [{ autogenerate: { directory: "users" } }],
        },
        {
          label: "Services",
          items: [
            {
              label: "Core",
              items: [{ autogenerate: { directory: "services/core" } }],
              collapsed: true,
            },
            {
              label: "License",
              items: [{ autogenerate: { directory: "services/license" } }],
              collapsed: true,
            },
            {
              label: "Config",
              items: [{ autogenerate: { directory: "services/config" } }],
              collapsed: true,
            },
            {
              label: "Release",
              items: [{ autogenerate: { directory: "services/release" } }],
              collapsed: true,
            },
            {
              label: "Distribution",
              items: [{ autogenerate: { directory: "services/distribution" } }],
              collapsed: true,
            },
            {
              label: "Update",
              items: [{ autogenerate: { directory: "services/update" } }],
              collapsed: true,
            },
            {
              label: "Identity",
              items: [{ autogenerate: { directory: "services/identity" } }],
              collapsed: true,
            },
          ],
        },
        {
          label: "Build on it",
          items: [{ autogenerate: { directory: "build" } }],
        },
        {
          label: "Administer",
          collapsed: true,
          items: [{ autogenerate: { directory: "admin" } }],
        },
        {
          label: "For AI agents",
          collapsed: true,
          items: [{ autogenerate: { directory: "agents" } }],
        },
        {
          label: "Reference",
          collapsed: true,
          items: [{ autogenerate: { directory: "reference" } }],
        },
        {
          label: "Contribute",
          collapsed: true,
          items: [{ autogenerate: { directory: "contribute" } }],
        },
      ],
    }),
  ],
});
