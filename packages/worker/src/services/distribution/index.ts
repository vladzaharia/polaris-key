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
 *   - its manifest contributor (`ingest.ts`) applies `.pkey/distribution` — outlets and transports (P2b-02,
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
 *   - P6-01 built the commerce bridge here; CM-29 moved it to the Commerce service
 *     (`services/commerce/`), which requires License. Distribution reads Commerce's store-product
 *     map only through the `storeProducts` hook.
 *   - P6-03 gave it update health: the telemetry auto-halt on the same cron (`autoHalt.ts`,
 *     halt-only, off by default), the Sentry alert hook (`/distribution/hooks/sentry`,
 *     `sentry.ts`) that opens halt candidates an operator confirms, and the funnel in the console
 *     (`updateHealthAdmin.ts`), all reading `core/updateHealth.ts`.
 *
 * It reads Release only through `ctx.hooks.releaseCatalog()` — never by import. The boundary
 * test allows exactly one cross-service edge (`update → release`) and this service is not it.
 */

import { distributionManifest } from "./ingest.js";
import { feedAccessCustomersJob } from "./feedAccessJob.js";
import type { HookContext, OutletCapabilities } from "../../core/hooks.js";
import type {
  DiscoveryContext,
  ScheduledServiceContext,
  ServiceDescriptor,
} from "../../core/registry.js";
import type {} from "@polaris-key/manifest";
import { parseJsonColumn } from "../../platform/json.js";
import type {} from "../../db/types.js";
import { bytesHostname } from "../../core/assets/bytesHost.js";
import { handleDistributionAdmin } from "./admin.js";
import { registryMaterialiser } from "./registryMaterialiser.js";
import { defaultCapabilities, effectiveCapabilities } from "./capabilities.js";
import { delivery } from "./delivery.js";
import { DISTRIBUTION_ROUTES } from "./routes.js";
import { refreshReadiness } from "./readiness.js";
import { pollConnectors } from "./connectors/index.js";
import { runAutoHalt, type AutoHaltOutcome } from "./autoHalt.js";
import { getOutlet } from "./outlets.js";
import { DISTRIBUTION_SETTINGS_SLICE } from "./settings.js";
import {
  syncManifestListingAssets,
  type ManifestListingSync,
} from "./listing/manifestAssets.js";

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

/**
 * The connector cron (P5-02): every store connector's poll for this product. A connector that
 * is not set up for the product skips itself before any call. A connector's error is collected
 * and thrown after every connector ran, so the cron invocation records it.
 */
async function scheduled(
  ctx: ScheduledServiceContext,
): Promise<Record<string, unknown>> {
  const outcomes = await pollConnectors(ctx);
  // P6-03: the telemetry auto-halt, after the connectors (a connector may have just mirrored a
  // store rollout, which the auto-halt must then only alert on). Off by default; fault-isolated
  // from the connectors like they are from one another.
  let autoHalt: AutoHaltOutcome;
  try {
    autoHalt = await runAutoHalt({
      env: ctx.env,
      db: ctx.db,
      product: ctx.product.slug,
      hooks: ctx.hooks,
      now: ctx.now,
    });
  } catch (e) {
    autoHalt = {
      ran: true,
      halted: 0,
      alerted: 0,
      error: e instanceof Error ? e.message : "auto-halt failed",
    };
  }
  // P4-14: refresh the readiness snapshot (`dist_readiness`) after the connectors, which may have
  // just written store availability (an approved asset pack). The hold is computed on read; this
  // keeps the console's view, the audit trail of state changes and P5-08's input current, and
  // catches Release-side triggers (an app publish or promote, a re-resolved set) within a tick.
  let readiness: { refreshed: number } | { error: string };
  try {
    readiness = {
      refreshed: await refreshReadiness({
        db: ctx.db,
        product: ctx.product.slug,
        hooks: ctx.hooks,
        now: ctx.now,
        actor: "system:readiness",
      }),
    };
  } catch (e) {
    readiness = {
      error: `readiness: ${e instanceof Error ? e.message : "refresh failed"}`,
    };
  }
  // HA-07: the manifest's hosted art as listing rows (`listing/manifestAssets.ts`): catches a
  // slot the manifest stopped declaring (dropped at resync) and anything the pull consumer's own
  // sync missed. Idempotent and fault-isolated like the rest.
  let listingArt: ManifestListingSync | { error: string };
  try {
    listingArt = await syncManifestListingAssets(
      ctx.db,
      ctx.product.slug,
      ctx.now,
    );
  } catch (e) {
    listingArt = {
      error: `listing art: ${e instanceof Error ? e.message : "sync failed"}`,
    };
  }
  const errors = [
    ...outcomes.filter((o) => o.error).map((o) => `${o.connector}: ${o.error}`),
    ...("error" in listingArt ? [listingArt.error] : []),
    ...(autoHalt.error ? [autoHalt.error] : []),
    ...("error" in readiness ? [readiness.error] : []),
  ];
  if (errors.length) throw new Error(errors.join("; "));
  return { connectors: outcomes, autoHalt, readiness, listingArt };
}

import { distributionIntegration } from "./integration.js";
import { distributionMaintenance } from "./maintenance.js";

import { distributionProductDeletion } from "./productDeletion.js";
import { listingTruthJob } from "./listingTruthJob.js";

export const distributionService: ServiceDescriptor = {
  slug: "distribution",
  contributes: {
    manifest: distributionManifest,
    productDeletion: distributionProductDeletion,
    integration: distributionIntegration,
    maintenance: distributionMaintenance,
    // P0-49: run by an operator through the migration runner, never by a tick.
    migrations: [feedAccessCustomersJob, listingTruthJob],
  },
  /** ST-03: this service's settings registry slice (`settings.ts`). */
  settings: DISTRIBUTION_SETTINGS_SLICE,
  /** `routes.ts`: the byte routes and the CI rollout routes. `null` = Core's not-found. */
  handle: DISTRIBUTION_ROUTES.handle,
  /**
   * The canonical surface `routes.ts` dispatches; what `routeCoverage` pins. The installer, the
   * download and the three byte routes are the ones Release's old `/{product}/release/…`
   * spellings rewrite to; the last three of those also answer on the bytes host.
   */
  surface: DISTRIBUTION_ROUTES.surface,
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
  /** `/manage/api/products/<slug>/distribution/…` (`admin.ts`). */
  adminHandle: handleDistributionAdmin,
  /** The store-connector poll, on the connector cron (`connectors/`). */
  scheduled,
  /** The package-feed render queue's consumer (`registryMaterialiser.ts`, plans/F-01.md §6.5). */
  registryMaterialiser,
};

export { DISTRIBUTION_BYTE_ROUTES } from "./bytes.js";
export { DOWNLOAD_PAGE_ROUTE } from "./page/index.js";
export {
  DISTRIBUTION_OWNERLESS_ROUTES,
  DISTRIBUTION_REGISTRY_ROUTES,
} from "./registry/index.js";
