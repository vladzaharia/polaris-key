/**
 * The per-product admin resources, `/manage/api/products/<slug>/<resource>/…`, routed to their
 * handler modules. The dispatcher (`./api.ts`) has already matched the route table
 * (`./routes.ts`), loaded the product and checked the row's area with `can()`, so nothing here
 * authorizes: it only picks the handler.
 *
 * Per-product resources are grouped by the SERVICE that owns them (plan §R1, spec §4.2). What is
 * left at this level is Core's: the things a product has whether or not it runs any service.
 * Everything else is dispatched into a `ServiceDescriptor.adminHandle` with the full remaining
 * path.
 */

import { getProduct } from "../core/repo.js";
import { notFound } from "../core/console/respond.js";
import { handleFeedsAdmin } from "./handlers/feeds.js";
import { handleProductScopedResource } from "./handlers/products.js";
import { handleActivity } from "./handlers/activity.js";
import { handleProductSettingsBackfill } from "./handlers/settingsBackfill.js";
import { handleCiPublisher, handleCiTokens } from "./handlers/ciPublishing.js";
import { handleProductDevices } from "./handlers/devices.js";
import { handleProductUsers } from "./handlers/users.js";
import { handleRefusals } from "./handlers/refusals.js";
import { handleHostedAssets } from "./handlers/hostedAssets.js";
import { handleTrustPolicy } from "./handlers/trustPolicy.js";
import { handleProductSettings } from "./handlers/productSettings.js";
import { handleServicesAdmin } from "./handlers/servicesAdmin.js";
import { handleBundleMint } from "./handlers/bundles.js";
import { handleBlobGcAdmin } from "../core/assets/blobGc.js";
import { loadProduct } from "../core/products.js";
import { handleProductStorefronts } from "./handlers/polarisKeyStorefront.js";
import { buildHooks } from "../core/hooks.js";
import { manifestIngestFor } from "../core/registry.js";
import { licenseDeleteFor } from "../core/licensing/licenseDelete.js";
import { SERVICES, SETTINGS } from "../mount.js";
import type { ServiceSlug } from "../core/services.js";
import type { AdminCtx } from "./routes.js";

export async function handleProductScoped(c: AdminCtx): Promise<Response> {
  const { req, env, db, session, now } = c;
  const product = c.product!;
  const slug = product.slug;
  // The segments after `/products/<slug>`.
  const rest = c.segments.slice(2);

  // §R1 regrouped the customer-portal settings under Identity. The console spells the canonical
  // `identity/portal`, and the transitional `portal` → `identity/portal` rewrite is GONE: the
  // bare spelling now falls through to the 404 every other unknown resource gets. Everything
  // else in §R1's admin table moved the same way — `licenses`/`tiers`/`policy` are License's,
  // `schema`/`profiles` are Config's — with no aliases left behind.
  const [resource, id] = rest;

  // ── per-SERVICE admin (design spec §4.2) ────────────────────────────────────────────────
  //
  // `/manage/api/products/<slug>/<service>/…` is the service's own, dispatched through the same
  // descriptor the public router uses (`ServiceDescriptor.adminHandle`). The FULL remaining path
  // is handed over, not the five destructured positions below — a service routes itself.
  //
  // Enablement is NOT checked here, unlike the public dispatcher. An operator has to be able to
  // reach a service's settings in order to configure it before turning it on, and the console has
  // already checked the service's area; hiding a disabled service from an authorized admin would
  // protect nothing and would make "enable then configure" impossible.
  // F-11: the Feeds admin API in product scope, `…/distribution/feeds/…`. Spelled under
  // Distribution (its sidebar section), but composed in the admin layer, because a yank writes
  // Release's package rows and the settings are Distribution's (`handlers/feeds.ts` explains).
  if (resource === "distribution" && rest[1] === "feeds") {
    // The system product's feeds are the platform's: reachable only from Platform → Package feeds
    // (`/manage/api/platform/feeds/…`), never as a product scope.
    const owner = await getProduct(db, slug);
    if (!owner || owner.system === 1) return notFound();
    return handleFeedsAdmin(
      req,
      env,
      db,
      session,
      { kind: "product", slug },
      rest.slice(2),
      now,
    );
  }

  if (resource && SERVICES.has(resource as ServiceSlug)) {
    const descriptor = SERVICES.get(resource as ServiceSlug)!;
    if (descriptor.adminHandle) {
      const loaded = await loadProduct(env, db, slug);
      if (!loaded) return notFound();
      const res = await descriptor.adminHandle({
        req,
        env,
        db,
        product: loaded,
        rest: rest.slice(1),
        now,
        session,
        // Core's ingest pipeline over the same registry (P2b-02): Release's resync route runs it.
        ingest: manifestIngestFor(SERVICES),
        // Core's licence-deletion collector (`core/licensing/licenseDelete.ts`): License's delete route.
        licenseDelete: licenseDeleteFor(SERVICES),
        // ST-04: the settings registry, for the handlers that write through `writeSetting()`.
        settings: SETTINGS,
        // Same gate as the public path: a hook whose providing service is off answers `null`,
        // even though the admin route itself is reachable while its own service is off.
        hooks: buildHooks(SERVICES, loaded.services, {
          env,
          db,
          product: loaded,
          now,
        }),
      });
      if (res) return res;
    }
    return notFound();
  }

  // The settings backfill (ST-01c, S-18 §4.14, owner decision D19). CORE, like `claims`: it
  // moves the product onto ST-01b's claim model once and keeps its reports. Ahead of the
  // generic `settings/<key>` routes (LX-06, S-18 §4.7), which would read `backfill` as a key.
  //   POST /products/<slug>/settings/backfill?dryRun=1|0
  //   GET  /products/<slug>/settings/backfill[/<reportId>]
  if (resource === "settings" && rest[1] === "backfill")
    return handleProductSettingsBackfill(
      req,
      env,
      db,
      session,
      slug,
      rest.slice(2),
      now,
    );

  // Platform-owned per-product resources — they exist for a product running NO service at all,
  // which is why they are not under one:
  //   PUT  /products/<slug>/secrets/<name>
  //   POST /products/<slug>/keys/rotate
  //   GET|PUT|DELETE /products/<slug>/outlet-credentials[/<id>]   (P5-01)
  //   DELETE /products/<slug>/claims/<key>   (ST-01b: Revert a console claim to the manifest)
  if (
    resource === "secrets" ||
    resource === "keys" ||
    resource === "outlet-credentials" ||
    resource === "claims"
  ) {
    return handleProductScopedResource(
      req,
      env,
      db,
      session,
      slug,
      resource,
      id,
      now,
    );
  }

  // The product settings API's first slice (LX-06, S-18 §4.7): the row-backed claimable settings
  // of every service in one store. CORE, like `claims`: a console edit claims, Revert hands back.
  //   GET /products/<slug>/settings/effective[?area=]
  //   PATCH|DELETE /products/<slug>/settings/<key>
  if (resource === "settings")
    return handleProductSettings(
      req,
      env,
      db,
      session,
      product,
      rest.slice(1),
      now,
    );

  // Trusted publishing (P2-02): the publisher policy and static CI tokens. CORE, like the
  // secrets: the credential store serves Release now and Distribution (P2b-03) later.
  //   GET|PUT /products/<slug>/ci-publisher
  //   GET|POST /products/<slug>/ci-tokens, DELETE /products/<slug>/ci-tokens/<tokenId>
  if (resource === "ci-publisher")
    return handleCiPublisher(req, env, db, session, slug, id, now);
  if (resource === "ci-tokens")
    return handleCiTokens(req, env, db, session, slug, id, now);

  // The device-trust policy (P6-02): which operations require an attested device, enforced or
  // log-only, and the App Attest / Play Integrity settings. CORE, like the device trust level.
  //   GET|PUT|DELETE /products/<slug>/trust-policy
  if (resource === "trust-policy")
    return handleTrustPolicy(req, env, db, session, slug, id, now);

  // Which Polaris Key services this product runs (plan §R4). A CORE resource, not a per-service
  // one: a service cannot own its own off switch, because it would have to be running to be
  // turned off. `id` carries the single sub-action (`revert`).
  if (resource === "services") {
    return handleServicesAdmin(req, env, db, session, slug, id, now, SETTINGS);
  }

  // Offline activation bundles (wire v3 §7). CORE for the same reason `services` is: one bundle
  // carries the License document AND the Config document, either of which may be absent, so it
  // belongs to neither service — a config-only product mints one with no license in it at all.
  if (resource === "bundles") {
    return handleBundleMint(req, env, db, session, slug, id, now, SETTINGS);
  }

  // The blob collector's dry run and the bundle live-data ratios (P4-14). CORE, like the blob
  // store itself: liveness is read through the product's hooks, as the nightly collector reads it.
  //   GET /products/<slug>/blob-gc, GET /products/<slug>/blob-gc/bundles
  if (resource === "blob-gc") {
    const loaded = await loadProduct(env, db, slug);
    if (!loaded) return notFound();
    const hooks = buildHooks(SERVICES, loaded.services, {
      env,
      db,
      product: loaded,
      now,
    });
    return handleBlobGcAdmin(req, env, db, slug, hooks, id, now);
  }

  if (resource === "activity") {
    return handleActivity(req, db, slug);
  }

  // UX-15: the refusal log (`core/licensing/refusals.ts`). CORE, like `activity`: the refusal site is
  // Core's `authorizeDevice`, whichever service (License, Identity) asked it for a seat.
  //   GET /products/<slug>/refusals[?refusedSince=&licenseId=&limit=]
  if (resource === "refusals") {
    return handleRefusals(req, db, slug, rest.slice(1), now);
  }

  // PS-06: the Polaris Key storefront's console panel (notes/S-21 §6.6). CORE, like `assets`:
  // every product can list on Polaris Key whether or not it runs Distribution (S-21 §6.2), and
  // the panel composes Identity's listing and engine with Distribution's listing model.
  //   GET  /products/<slug>/storefronts/polaris-key
  //   POST /products/<slug>/storefronts/polaris-key/preview
  //   GET  /products/<slug>/storefronts/polaris-key/analytics
  if (resource === "storefronts") {
    return handleProductStorefronts(
      req,
      env,
      db,
      session,
      slug,
      rest.slice(1),
      now,
    );
  }

  // HA-05, HA-06: the product's hosted assets (`core/assets/hostedAssetPulls.ts`,
  // `core/assets/hostedAssetUploads.ts`). CORE, like `activity`: a product hosts its presentation icon
  // whether or not it runs Distribution. HA-08: the operator's "mirror now" for release files
  // (`services/release/mirror.ts`).
  //   GET  /products/<slug>/assets
  //   POST /products/<slug>/assets/mirror
  //   POST|DELETE /products/<slug>/assets/<slot>[?locale=]
  if (resource === "assets") {
    return handleHostedAssets(req, env, db, session, slug, rest.slice(1), now);
  }

  // Every device of the product, licensed or not. CORE: a product that issues no licenses (open
  // or requires-identity registration) still has devices, and License's per-license route cannot
  // reach them.
  if (resource === "devices") {
    return handleProductDevices(
      req,
      env,
      db,
      session,
      slug,
      rest.slice(1),
      now,
    );
  }

  // The product's users, keyed by pairwise subject (I-12). CORE: the account is platform-level,
  // so a product with Identity off still has users (its licence owners).
  if (resource === "users") {
    return handleProductUsers(req, env, db, session, slug, rest.slice(1), now);
  }

  return notFound();
}
