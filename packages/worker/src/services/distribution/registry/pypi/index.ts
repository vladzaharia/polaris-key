/**
 * The PyPI feed (F-05, plans/F-01.md §6.8) as a `FeedAdapter` (`../adapter.ts`): its renderer
 * (`render.ts`, the PEP 691 JSON and PEP 503 HTML pages) and its routes (`routes.ts`). Everything
 * PyPI-specific stays in this directory; `registry/index.ts` lists it in `FEED_ADAPTERS`.
 */

import { FEED_SETUP, PACKAGE_ECOSYSTEM_RULES } from "@polaris-key/manifest";
import {
  extBoolean,
  rendererOf,
  defineFeedAdapter,
  type FeedAdapter,
} from "../adapter.js";
import type { RegistryRenderer } from "../materialise.js";
import { renderPypi } from "./render.js";
import { PYPI_ROUTES } from "./routes.js";

export const PYPI_ADAPTER: FeedAdapter<"pypi"> = defineFeedAdapter({
  ecosystem: "pypi",
  label: "PyPI",
  hostPrefix: "/pypi/",
  feedPath: (owner) => `/pypi/${owner}/simple/`,
  routes: PYPI_ROUTES,
  renderer: { render: (pkg) => renderPypi(pkg), stamp: "package" },
  ingest: PACKAGE_ECOSYSTEM_RULES.pypi,
  settings: { ext: { htmlFallback: extBoolean } },
  capabilities: {
    // PEP 592: a yanked version stays installable when pinned exactly.
    yank: true,
    deprecate: { unsupported: "PyPI has no deprecation state" },
    yankPolicy: false,
    channels: "none",
    signing: false,
    immutableVersions: true,
    delete: false,
    search: false,
    authChallenge: "basic",
  },
  setup: FEED_SETUP.pypi,
  openapi: [
    ["/pypi/{owner}/simple/", ["get", "head"], "pypi.simple.index"],
    ["/pypi/{owner}/simple/{project}/", ["get", "head"], "pypi.simple.project"],
    ["/pypi/{owner}/files/{sha256}/{filename}", ["get", "head"], "pypi.files"],
  ],
  harness: { clients: ["pip", "uv", "poetry"] },
});

/** The materialiser's view of the adapter. */
export const PYPI_RENDERER: RegistryRenderer = rendererOf(PYPI_ADAPTER);
