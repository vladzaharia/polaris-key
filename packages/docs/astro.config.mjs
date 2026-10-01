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
        "Licensing, managed config, releases, updates, and identity for multi-product apps — one worker, five services, four SDKs.",
      customCss: ["./src/styles/global.css"],
      sidebar: [
        {
          label: "Start here",
          autogenerate: { directory: "start" },
        },
        {
          label: "For users",
          collapsed: true,
          autogenerate: { directory: "users" },
        },
        {
          label: "Services",
          items: [
            { label: "Core", autogenerate: { directory: "services/core" }, collapsed: true },
            { label: "License", autogenerate: { directory: "services/license" }, collapsed: true },
            { label: "Config", autogenerate: { directory: "services/config" }, collapsed: true },
            { label: "Release", autogenerate: { directory: "services/release" }, collapsed: true },
            { label: "Distribution", autogenerate: { directory: "services/distribution" }, collapsed: true },
            { label: "Update", autogenerate: { directory: "services/update" }, collapsed: true },
            { label: "Identity", autogenerate: { directory: "services/identity" }, collapsed: true },
          ],
        },
        {
          label: "Build on it",
          autogenerate: { directory: "build" },
        },
        {
          label: "Administer",
          collapsed: true,
          autogenerate: { directory: "admin" },
        },
        {
          label: "For AI agents",
          collapsed: true,
          autogenerate: { directory: "agents" },
        },
        {
          label: "Reference",
          collapsed: true,
          autogenerate: { directory: "reference" },
        },
        {
          label: "Contribute",
          collapsed: true,
          autogenerate: { directory: "contribute" },
        },
      ],
    }),
  ],
});
