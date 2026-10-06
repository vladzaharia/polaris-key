/**
 * The Go feed (F-31, plans/F-01.md §6.8, tier 3) as a `FeedAdapter` (`../adapter.ts`): a module
 * proxy at `/go/<owner>/`, with `@v/list`, `@latest` and the `.info` documents rendered on write
 * (`render.ts`) and the `.mod` and `.zip` bytes served by digest (`routes.ts`).
 *
 * A client sets `GOPROXY=https://pkg.plrs.im/go/<owner>,https://proxy.golang.org,direct` and
 * `GONOSUMDB=<the feed's module prefixes>`, never GOPRIVATE (which sets GONOPROXY and so skips
 * this proxy too). Zero-config public use would also need a `go-import` `<meta>` on the module
 * path's own host, which the registry host never serves: it only answers under `/go/`.
 */

import { FEED_SETUP, PACKAGE_ECOSYSTEM_RULES } from "@polaris-key/manifest";
import { rendererOf, defineFeedAdapter, type FeedAdapter } from "../adapter.js";
import type { RegistryRenderer } from "../materialise.js";
import { renderGo } from "./render.js";
import { goRoutes } from "./routes.js";

export const GO_ADAPTER: FeedAdapter<"go"> = defineFeedAdapter({
  ecosystem: "go",
  label: "Go",
  hostPrefix: "/go/",
  feedPath: (owner) => `/go/${owner}/`,
  routes: goRoutes(() => GO_RENDERER),
  renderer: { render: (pkg) => renderGo(pkg), stamp: "package" },
  ingest: PACKAGE_ECOSYSTEM_RULES.go,
  settings: { ext: {} },
  capabilities: {
    // A yank leaves @v/list, @latest and every channel tag, so no query resolves to it; its
    // .info, .mod and .zip stay, so a go.sum that pins it keeps building.
    yank: true,
    deprecate: {
      unsupported:
        "Go reads deprecation from the module's own go.mod (a // Deprecated: comment), which the feed never rewrites",
    },
    yankPolicy: false,
    channels: "tags",
    signing: false,
    immutableVersions: true,
    delete: false,
    search: false,
    authChallenge: "basic",
  },
  setup: FEED_SETUP.go,
  openapi: [
    ["/go/{owner}/{module}/@v/list", ["get", "head"], "go.list"],
    ["/go/{owner}/{module}/@latest", ["get", "head"], "go.latest"],
    ["/go/{owner}/{module}/@v/{version}.info", ["get", "head"], "go.info"],
    ["/go/{owner}/{module}/@v/{version}.mod", ["get", "head"], "go.mod"],
    ["/go/{owner}/{module}/@v/{version}.zip", ["get", "head"], "go.zip"],
  ],
  harness: { clients: ["go"] },
});

/** The materialiser's view of the adapter. */
export const GO_RENDERER: RegistryRenderer = rendererOf(GO_ADAPTER);
