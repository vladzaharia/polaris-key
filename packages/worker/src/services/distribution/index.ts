/// <reference types="@cloudflare/workers-types" />

/**
 * The Distribution service descriptor — how releases REACH devices and outlets, and what state
 * they are in there (P2b-01, README §3.2 and §3.8).
 *
 * The chain is release ← distribution ← update: Release answers "what exists", Distribution
 * "how does it reach devices and outlets", Update "what should this installed copy do next".
 * Distribution will own outlets and transports, all byte delivery, availability per outlet,
 * outlet-scoped rollouts and halts, storefront feeds and the key inventory (P2b-02 to P2b-06,
 * P4-05, P4-14, P5-*).
 *
 * P2b-01 shipped the SKELETON every later package builds on; P2b-02 gave it outlets; P2b-04 gave
 * it its first routes and the rest of the `delivery` hook:
 *
 *   - `handle` (`routes.ts`) serves ALL byte delivery (`bytes.ts`): the installer, the legacy
 *     download, and P2-05's build, file and blob routes, at canonical `/<p>/distribution/…`
 *     paths. The old `/<p>/release/…` spellings and `/<p>/install.sh` are permanent aliases the
 *     router rewrites. The byte routes also answer on the bytes host
 *     (`DISTRIBUTION_BYTE_ROUTES`, registered in `mount.ts`). It also serves the CI rollout
 *     routes (`pkeyci_` + `distribution:rollout`).
 *   - its discovery fragment advertises the download, install, builds and blobs URLs.
 *   - `manifestIngest` applies `.pkey/distribution` — outlets and transports (P2b-02,
 *     `outlets.ts`) — and the manifest's `release.access.artifacts` into the `app` row of
 *     `dist_access` unless an operator owns it (P2b-04, `access.ts`).
 *   - it implements two of Core's descriptor hooks (`core/hooks.ts`): `delivery` (`delivery.ts`:
 *     the default transport, rollouts, delivery access and delivery URLs; availability is
 *     P2b-03's) and `outletCapabilities` (P2b-02, `capabilities.ts`).
 *   - its admin surface (`admin.ts`) lists the outlets, narrows their capabilities, controls
 *     outlet rollouts and sets delivery access per deliverable.
 *   - P5-02 gave it store connectors (`connectors/`): the App Store Connect webhook
 *     (`/distribution/hooks/asc`), a poller on the connector cron (`scheduled`) and operator
 *     controls under the admin surface. They write availability, submissions and mirrored
 *     rollouts through the same writers CI and the console use.
 *
 * It reads Release only through `ctx.hooks.releaseCatalog()` — never by import. The boundary
 * test allows exactly one cross-service edge (`update → release`) and this service is not it.
 */

import type { HookContext, OutletCapabilities } from "../../core/hooks.js";
import type {
  DiscoveryContext,
  ScheduledServiceContext,
  ServiceDescriptor,
} from "../../core/registry.js";
import type { ParsedManifest } from "@polaris-key/manifest";
import type { DbStatement } from "../../core/platform.js";
import { bytesHostname } from "../../core/bytesHost.js";
import { handleDistributionAdmin } from "./admin.js";
import { defaultCapabilities, effectiveCapabilities } from "./capabilities.js";
import { delivery } from "./delivery.js";
import { accessIngestStatements } from "./access.js";
import { releaseKeyObservationStatements } from "./availability.js";
import { handleDistributionRoutes } from "./routes.js";
import { pollConnectors } from "./connectors/index.js";
import {
  getOutlet,
  manifestIngestStatements as outletIngestStatements,
  parseJsonColumn,
} from "./outlets.js";

/**
 * `core/hooks.ts` `outletCapabilities`: the capabilities in force for one of this product's live
 * outlets — its kind's default, narrowed by an operator's override. `null` for an outlet the
 * product does not declare (or has removed), and for a kind this build does not know: an unknown
 * outlet must never read as a permissive one.
 */
async function outletCapabilities(
  ctx: HookContext,
  outletId: string,
): Promise<OutletCapabilities | null> {
  const row = await getOutlet(ctx.db, ctx.product.slug, outletId);
  if (!row || row.removed_at !== null) return null;
  const defaults = defaultCapabilities(row.kind);
  if (!defaults) return null;
  const override =
    row.capabilities_source === "admin"
      ? parseJsonColumn(row.capabilities_json)
      : null;
  return { outletId, ...effectiveCapabilities(defaults, override) };
}

/** Distribution's `manifestIngest` (enabled only): outlets and transports, and the declared
 *  release keys as key-inventory observations (P3-03). */
function manifestIngest(
  parsed: ParsedManifest,
  product: string,
  now: number,
): DbStatement[] {
  return [
    ...outletIngestStatements(parsed, product, now),
    ...releaseKeyObservationStatements(parsed, product, now),
  ];
}

/**
 * The connector cron (P5-02): every store connector's poll for this product. A connector that
 * is not set up for the product skips itself before any call. A connector's error is collected
 * and thrown after every connector ran, so the cron invocation records it.
 */
async function scheduled(
  ctx: ScheduledServiceContext,
): Promise<Record<string, unknown>> {
  const outcomes = await pollConnectors(ctx);
  const errors = outcomes.filter((o) => o.error);
  if (errors.length)
    throw new Error(errors.map((o) => `${o.connector}: ${o.error}`).join("; "));
  return { connectors: outcomes };
}

export const distributionService: ServiceDescriptor = {
  slug: "distribution",
  /** `routes.ts`: the byte routes and the CI rollout routes. `null` = Core's not-found. */
  handle: handleDistributionRoutes,
  /**
   * Distribution's slice of `/.well-known/polaris.json`: the CANONICAL byte URLs (an alias exists
   * so shipped binaries and published curl lines keep working, not so new clients learn it).
   * `builds` and `blobs` are advertised on the bytes host when there is one, so a client
   * downloads from `dl.plrs.im` and never from the origin that holds the console's sessions.
   * `configured` says whether anything is there to download: the product needs a release
   * configuration (Release's, read through the catalog hook).
   */
  discoveryFragment: async ({
    product,
    env,
    base,
    hooks,
  }: DiscoveryContext) => {
    const catalog = hooks.releaseCatalog();
    const configured = catalog
      ? (await catalog.metadataAccess()) !== null
      : false;
    const bytesBase =
      bytesHostname(env) && env.BLOB_ORIGIN
        ? `${new URL(env.BLOB_ORIGIN).origin}/${product.slug}`
        : base;
    return {
      enabled: true,
      configured,
      endpoints: {
        download: `${base}/distribution/dl`,
        install: `${base}/distribution/install.sh`,
        // Templated: `{selector}` is a channel or a version, `{buildId}` an artifact-map id.
        builds: `${bytesBase}/distribution/builds/{selector}/{buildId}`,
        blobs: `${bytesBase}/distribution/blobs/sha256/{sha256}`,
      },
    };
  },
  /** `core/hooks.ts` `Delivery` (`delivery.ts`). */
  delivery,
  /** `core/hooks.ts` `OutletCapabilities` (P2b-02). */
  outletCapabilities,
  /** `.pkey/distribution` → `dist_outlets` / `dist_transports`, while Distribution is on. */
  manifestIngest,
  /**
   * `release.access.artifacts` → the `app` row of `dist_access`, on every link and resync
   * WHATEVER Distribution's enablement (`core/registry.ts` `manifestIngestAlways`): turning
   * Distribution on runs no ingest, so the row must already hold the manifest's answer then, or
   * a Release-only product's `licensed` downloads would open (or, with no row, close) the moment
   * an operator enables Distribution.
   */
  manifestIngestAlways: accessIngestStatements,
  /** `/manage/api/products/<slug>/distribution/…` (`admin.ts`). */
  adminHandle: handleDistributionAdmin,
  /** The store-connector poll, on the connector cron (`connectors/`). */
  scheduled,
};

export { DISTRIBUTION_BYTE_ROUTES } from "./bytes.js";
export { DOWNLOAD_PAGE_ROUTE } from "./page/index.js";
