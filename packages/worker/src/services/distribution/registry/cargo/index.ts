/**
 * The Cargo feed (F-30, plans/F-01.md §6.8) as a `FeedAdapter` (`../adapter.ts`): its renderer
 * (`render.ts`, the sparse index's JSON-lines files) and its routes (`routes.ts`, `config.json`,
 * the index files and the `dl` downloads). Everything Cargo-specific stays in this directory;
 * `registry/index.ts` lists it in `FEED_ADAPTERS`.
 */

import { FEED_SETUP, PACKAGE_ECOSYSTEM_RULES } from "@polaris-key/manifest";
import { rendererOf, defineFeedAdapter, type FeedAdapter } from "../adapter.js";
import type { RegistryRenderer } from "../materialise.js";
import { renderCargo } from "./render.js";
import { CARGO_ROUTES } from "./routes.js";

export const CARGO_ADAPTER: FeedAdapter<"cargo"> = defineFeedAdapter({
  ecosystem: "cargo",
  label: "Cargo",
  hostPrefix: "/cargo/",
  feedPath: (owner) => `/cargo/${owner}/`,
  routes: CARGO_ROUTES,
  // The index files read the package rows and the host's origin, never the feed settings.
  renderer: { render: renderCargo, stamp: "package" },
  ingest: PACKAGE_ECOSYSTEM_RULES.cargo,
  settings: { ext: {} },
  capabilities: {
    // Cargo's own yank: the line stays with `yanked: true`, so a lockfile that pins it builds.
    yank: true,
    deprecate: { unsupported: "Cargo has no deprecation state; yank instead" },
    yankPolicy: false,
    channels: "none",
    signing: false,
    immutableVersions: true,
    delete: false,
    search: false,
    // Cargo sends the token bare (`Authorization: <token>`) after any 401; the realm is ignored.
    authChallenge: "basic",
  },
  setup: FEED_SETUP.cargo,
  openapi: [
    ["/cargo/{owner}/config.json", ["get", "head"], "cargo.config"],
    ["/cargo/{owner}/1/{name}", ["get", "head"], "cargo.index"],
    ["/cargo/{owner}/2/{name}", ["get", "head"], "cargo.index"],
    ["/cargo/{owner}/3/{first}/{name}", ["get", "head"], "cargo.index"],
    [
      "/cargo/{owner}/{prefix1}/{prefix2}/{name}",
      ["get", "head"],
      "cargo.index",
    ],
    ["/cargo/{owner}/files/{sha256}/{file}", ["get", "head"], "cargo.files"],
  ],
  harness: { clients: ["cargo"] },
});

/** The materialiser's view of the adapter. */
export const CARGO_RENDERER: RegistryRenderer = rendererOf(CARGO_ADAPTER);
