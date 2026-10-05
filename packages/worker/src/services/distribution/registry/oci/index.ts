/**
 * The OCI feed (F-08, plans/F-01.md §6.8) as a `FeedAdapter` (`../adapter.ts`): its renderer
 * (`render.ts`, the tag list and the tag pointers) and its pull routes under `/v2/` (`routes.ts`).
 * Publishing is the CLI's: `pkey release publish` reads an OCI image layout and uploads every blob
 * through upload tickets (`packages/cli/src/package/oci.ts`); or a native `docker push` (F-23),
 * whose routes are Release's (`services/release/packages/ociPush.ts`), since a push publishes.
 */

import { FEED_SETUP, PACKAGE_ECOSYSTEM_RULES } from "@polaris-key/manifest";
import {
  extInteger,
  rendererOf,
  defineFeedAdapter,
  type FeedAdapter,
} from "../adapter.js";
import type { RegistryRenderer } from "../materialise.js";
import { renderOci } from "./render.js";
import { OCI_ROUTES } from "./routes.js";
import { OCI_TOKEN_ROUTE } from "./token.js";

export const OCI_ADAPTER: FeedAdapter<"oci"> = defineFeedAdapter({
  ecosystem: "oci",
  label: "OCI",
  // The protocol fixes the root at `/v2/`; the repository sits under the owner.
  hostPrefix: "/v2/",
  feedPath: (owner) => `/v2/${owner}/`,
  routes: OCI_ROUTES,
  // F-21: the token service `docker login` and every pull of a non-public feed go through.
  ownerlessRoutes: [OCI_TOKEN_ROUTE],
  renderer: { render: (pkg) => renderOci(pkg), stamp: "package" },
  ingest: PACKAGE_ECOSYSTEM_RULES.oci,
  settings: { ext: { retainUntaggedDays: extInteger(0, 3650) } },
  capabilities: {
    // A yank removes the version tag; the image stays pullable by digest.
    yank: true,
    deprecate: { unsupported: "OCI has no deprecation state" },
    yankPolicy: false,
    channels: "tags",
    signing: false,
    immutableVersions: true,
    delete: false,
    search: false,
    authChallenge: "oci-bearer",
  },
  setup: FEED_SETUP.oci,
  openapi: [
    // F-21: the token service, an owner-less route (its owners are in `scope`).
    ["/v2/token", ["get", "head"], "oci.token"],
    [
      "/v2/{owner}/{repository}/manifests/{reference}",
      ["get", "head"],
      "oci.manifests",
    ],
    ["/v2/{owner}/{repository}/blobs/{digest}", ["get", "head"], "oci.blobs"],
    ["/v2/{owner}/{repository}/tags/list", ["get", "head"], "oci.tags"],
  ],
  harness: {
    clients: [
      "oci",
      "oci-conformance",
      "oci-crane",
      "oci-docker",
      "oci-podman",
    ],
  },
});

/** The materialiser's view of the adapter. */
export const OCI_RENDERER: RegistryRenderer = rendererOf(OCI_ADAPTER);
