/**
 * The npm feed (F-04, plans/F-01.md §6.8) as a `FeedAdapter` (`../adapter.ts`): its renderer
 * (`render.ts`, the full and abbreviated packuments) and its routes (`routes.ts`). Everything
 * npm-specific stays in this directory; `registry/index.ts` lists the adapter in `FEED_ADAPTERS`.
 */

import { FEED_SETUP, PACKAGE_ECOSYSTEM_RULES } from "@polaris-key/manifest";
import { rendererOf, defineFeedAdapter, type FeedAdapter } from "../adapter.js";
import type { RegistryRenderer } from "../materialise.js";
import { renderNpm } from "./render.js";
import { npmRoutes } from "./routes.js";

export const NPM_ADAPTER: FeedAdapter<"npm"> = defineFeedAdapter({
  ecosystem: "npm",
  label: "npm",
  hostPrefix: "/npm/",
  feedPath: (owner) => `/npm/${owner}/`,
  routes: npmRoutes(() => NPM_RENDERER),
  renderer: { render: renderNpm, stamp: "package" },
  ingest: PACKAGE_ECOSYSTEM_RULES.npm,
  settings: { ext: {} },
  capabilities: {
    // npm has no yank that keeps lockfiles working; its `deprecated` message stands in.
    yank: {
      unsupported:
        "npm has no yank that keeps lockfiles working; deprecate the version instead",
    },
    deprecate: true,
    yankPolicy: false,
    channels: "dist-tags",
    signing: false,
    immutableVersions: true,
    delete: false,
    search: false,
    authChallenge: "basic",
  },
  setup: FEED_SETUP.npm,
  openapi: [
    // Both spellings of a scoped name; the escaped one carries %2f in {escapedName}.
    ["/npm/{owner}/{escapedName}", ["get", "head"], "npm.packument"],
    ["/npm/{owner}/{scope}/{name}", ["get", "head"], "npm.packument"],
    ["/npm/{owner}/{escapedName}/-/{tarball}", ["get", "head"], "npm.tarball"],
    ["/npm/{owner}/{scope}/{name}/-/{tarball}", ["get", "head"], "npm.tarball"],
  ],
  harness: {
    // F-22: npm-publish publishes natively (Release's route), then installs back.
    clients: ["npm", "pnpm", "yarn", "bun", "npm-publish"],
  },
});

/** The materialiser's view of the adapter. */
export const NPM_RENDERER: RegistryRenderer = rendererOf(NPM_ADAPTER);
