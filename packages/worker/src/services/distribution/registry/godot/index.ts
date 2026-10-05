/**
 * The Godot feed (F-09, plans/F-01.md §6.8) as a `FeedAdapter` (`../adapter.ts`): the renderer
 * F-02's materialiser runs for the `godot` ecosystem, and its routes on the registry host. See
 * `documents.ts` for the two editor API shapes and `routes.ts` for the URL layout.
 */

import { FEED_SETUP, PACKAGE_ECOSYSTEM_RULES } from "@polaris-key/manifest";
import {
  extInteger,
  rendererOf,
  defineFeedAdapter,
  type FeedAdapter,
  type FeedOpenApiRow,
} from "../adapter.js";
import type { RegistryRenderer } from "../materialise.js";
import { renderGodot } from "./render.js";
import { GODOT_ROUTES } from "./routes.js";

/** Each row, then its tokenised twin under `/godot/{owner}/t/{token}/…`, served by one route. */
function withTokenisedPaths(
  rows: readonly FeedOpenApiRow[],
): readonly FeedOpenApiRow[] {
  return rows.flatMap((row) => [
    row,
    [
      row[0].replace("/godot/{owner}/", "/godot/{owner}/t/{token}/"),
      row[1],
      row[2],
    ] as const,
  ]);
}

export const GODOT_ADAPTER: FeedAdapter<"godot"> = defineFeedAdapter({
  ecosystem: "godot",
  label: "Godot",
  hostPrefix: "/godot/",
  feedPath: (owner) => `/godot/${owner}/`,
  routes: GODOT_ROUTES,
  // The documents carry the publisher, category and support level from the feed's settings.
  renderer: { render: renderGodot, stamp: "package+feed" },
  ingest: PACKAGE_ECOSYSTEM_RULES.godot,
  settings: {
    ext: {
      categoryId: extInteger(0, 1_000_000),
      supportLevel: (v) =>
        typeof v === "string" && /^[a-z][a-z-]{0,31}$/.test(v),
      // Shown as the asset's license (≤ 4.6 `cost`, 4.7 `license_type`).
      license: (v) =>
        typeof v === "string" && v.trim() !== "" && v.length <= 64,
      // Editors older than this, or of another major version, see nothing.
      minGodotVersion: (v) =>
        typeof v === "string" && /^\d{1,2}\.\d{1,2}(?:\.\d{1,2})?$/.test(v),
    },
  },
  capabilities: {
    // A yanked version leaves the asset listings.
    yank: true,
    deprecate: { unsupported: "Godot has no deprecation state" },
    yankPolicy: false,
    channels: "tags",
    signing: false,
    immutableVersions: true,
    delete: false,
    search: true,
    authChallenge: "basic",
  },
  setup: FEED_SETUP.godot,
  // F-21: every path also answers under `/godot/{owner}/t/{token}/…` (a URL token, §6.3).
  openapi: withTokenisedPaths([
    [
      "/godot/{owner}/asset-library/api/configure",
      ["get", "head"],
      "godotLegacyConfigure",
    ],
    [
      "/godot/{owner}/asset-library/api/asset",
      ["get", "head"],
      "godotLegacySearch",
    ],
    [
      "/godot/{owner}/asset-library/api/asset/{id}",
      ["get", "head"],
      "godotLegacyAsset",
    ],
    ["/godot/{owner}/store/api/v1/", ["get", "head"], "godotStoreOverview"],
    ["/godot/{owner}/store/api/v1/tags/", ["get", "head"], "godotStoreTags"],
    [
      "/godot/{owner}/store/api/v1/licenses/",
      ["get", "head"],
      "godotStoreLicenses",
    ],
    [
      "/godot/{owner}/store/api/v1/search/query/",
      ["get", "head"],
      "godotStoreSearch",
    ],
    [
      "/godot/{owner}/store/api/v1/assets/{publisher}/{asset}/",
      ["get", "head"],
      "godotStoreAsset",
    ],
    [
      "/godot/{owner}/store/api/v1/releases/{publisher}/{asset}/",
      ["get", "head"],
      "godotStoreReleases",
    ],
    ["/godot/{owner}/index.json", ["get", "head"], "godotIndex"],
    ["/godot/{owner}/files/{sha256}/{file}", ["get", "head"], "godotZip"],
    ["/godot/{owner}/icons/{sha256}.png", ["get", "head"], "godotIcon"],
  ]),
  // `godot-editor` drives real 4.6 and 4.7 editors, which CI does not have.
  harness: { clients: ["godot"], local: ["godot-editor"] },
});

/** The materialiser's view of the adapter. */
export const GODOT_RENDERER: RegistryRenderer = rendererOf(GODOT_ADAPTER);
