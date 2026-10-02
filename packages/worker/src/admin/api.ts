/**
 * The admin JSON API dispatcher: `handleAdminApi(req, env, db, path, now)` where `path` is
 * everything AFTER `/manage` (e.g. `/api/me`, `/api/products/djdl/licenses`). Two route
 * families:
 *
 *   /api/me                                  — the signed-in identity + CSRF + grants
 *   /api/products                            — PLATFORM registry CRUD (platform admins only)
 *   /api/products/<slug>/...                 — per-product admin (platform admins only)
 *
 * Per-product resources are grouped by the SERVICE that owns them (plan §R1, spec §4.2). What is
 * left at the top level here is core/platform — the things a product has whether or not it runs
 * any service: `secrets/*`, `outlet-credentials/*`, `ci-publisher`, `ci-tokens/*`, `keys/rotate`,
 * `activity`, `services[/revert]`, `bundles`, `blob-gc[/bundles]`. Everything
 * else is dispatched into a `ServiceDescriptor.adminHandle` with the full remaining path:
 *
 *   license/{licenses…,tiers…,policy[/revert]}   config/{catalog,profiles…}
 *   release/{health,resync,releases}             update/settings        identity/portal
 *
 * Security posture, enforced on EVERY request (never trusting the SPA):
 *   - **Session-gated**: a valid signed cookie session is required (401 otherwise).
 *   - **Group-gated**: every route — platform and per-product alike — requires
 *     `PLATFORM_ADMIN_GROUP`. There is no product-level admin: a product's `admin_group`
 *     column grants nothing. 403 otherwise.
 *   - **Rate-limited**: per-session-subject budget on the whole surface, plus a much tighter
 *     one on the audited 403 branch (R1-04).
 *   - **CSRF**: mutations must echo `X-PKey-CSRF`; mismatch ⇒ 403. Logout is a POST so that
 *     it goes through that check rather than around it (R1-03).
 *   - **Product-scoped D1**: every per-product query carries the slug — no cross-tenant read.
 *   - **Catalog-validated**: config/secret/flag values validate against the active catalog
 *     before any write (422 on failure).
 *   - **Secrets are write-only**: responses NEVER echo a stored secret value.
 *   - **Audited**: every mutation appends an audit row with the verified actor.
 *
 * This module is intentionally thin: session/CSRF gating plus top-level routing to the
 * focused handler modules under ./handlers. Shared helpers live under ./lib.
 */

import type { Env } from "../env.js";
import type { Db } from "../db/types.js";
import { getProduct } from "../repo.js";
import { rateLimitOk } from "../core/rateLimit.js";
import { canAdminProduct } from "./authz.js";
import { audit } from "./audit.js";

/** Admin limiter shard. One global Durable Object for the whole platform — see the note in
 *  rateLimitDo.ts; sub-sharding it is tracked as R10-04a. */
const ADMIN_RL_SHARD = "_admin";
import {
  buildClearCookie,
  CSRF_HEADER,
  sessionFromRequest,
  type AdminSession,
} from "./session.js";
import {
  AdminBodyError,
  adminJson,
  err,
  forbidden,
  isMutation,
  notFound,
  unauthorized,
} from "./lib/respond.js";
import { handleMe } from "./handlers/me.js";
import {
  handleProducts,
  handleProductScopedResource,
} from "./handlers/products.js";
import { handleActivity } from "./handlers/activity.js";
import { handleCiPublisher, handleCiTokens } from "./handlers/ciPublishing.js";
import { handleProductDevices } from "./handlers/devices.js";
import { handleServicesAdmin } from "../core/servicesAdmin.js";
import { handleBundleMint } from "../core/bundles.js";
import { handleBlobGcAdmin } from "../core/blobGc.js";
import { loadProduct } from "../core/products.js";
import { buildHooks } from "../core/hooks.js";
import { manifestIngestFor } from "../core/registry.js";
import { SERVICES } from "../mount.js";
import type { ServiceSlug } from "../core/services.js";

// ── per-product routing ────────────────────────────────────────────────────────
async function handleProductScoped(
  req: Request,
  env: Env,
  db: Db,
  session: AdminSession,
  slug: string,
  rest: string[],
  now: number,
): Promise<Response> {
  const product = await getProduct(db, slug);
  if (!product) return notFound();
  if (!canAdminProduct(env, session)) {
    // Authenticated-but-unauthorized access is low-volume + high-signal, so we audit it
    // (attributed to the verified actor). NOTE: we intentionally do NOT audit the
    // unauthenticated credential-path 401s — that would be a D1-write DoS amplifier.
    //
    // R1-04: the same reasoning applies here. The 403 branch is a GET, so no CSRF token is
    // required, and one D1 write per request is an amplifier for any actor holding a session
    // that fails this gate. The audit row is therefore budgeted: a few per actor+product per
    // window is all the signal an operator needs — the burst itself is the interesting event,
    // not each request in it — and beyond that the 403 is still returned, just not written.
    if (
      await rateLimitOk(
        env,
        ADMIN_RL_SHARD,
        {
          bucket: "adminAccessDenied",
          id: `${session.sub}:${slug}`,
          limit: 3,
          windowSec: 300,
        },
        now,
      )
    ) {
      await audit(
        db,
        slug,
        session,
        now,
        "access.denied",
        { kind: "product", id: slug },
        `Denied admin access to product ${slug}`,
      );
    }
    return forbidden("not an admin of this product");
  }

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
  // reach a service's settings in order to configure it before turning it on, and the console is
  // already behind the platform-admin gate above; hiding a disabled service from an authenticated
  // platform admin would protect nothing and would make "enable then configure" impossible.
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

  // Platform-owned per-product resources — they exist for a product running NO service at all,
  // which is why they are not under one:
  //   PUT  /products/<slug>/secrets/<name>
  //   POST /products/<slug>/keys/rotate
  //   GET|PUT|DELETE /products/<slug>/outlet-credentials[/<id>]   (P5-01)
  if (
    resource === "secrets" ||
    resource === "keys" ||
    resource === "outlet-credentials"
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

  // Trusted publishing (P2-02): the publisher policy and static CI tokens. CORE, like the
  // secrets: the credential store serves Release now and Distribution (P2b-03) later.
  //   GET|PUT /products/<slug>/ci-publisher
  //   GET|POST /products/<slug>/ci-tokens, DELETE /products/<slug>/ci-tokens/<tokenId>
  if (resource === "ci-publisher")
    return handleCiPublisher(req, env, db, session, slug, id, now);
  if (resource === "ci-tokens")
    return handleCiTokens(req, env, db, session, slug, id, now);

  // Which Polaris Key services this product runs (plan §R4). A CORE resource, not a per-service
  // one: a service cannot own its own off switch, because it would have to be running to be
  // turned off. `id` carries the single sub-action (`revert`).
  if (resource === "services") {
    return handleServicesAdmin(req, env, db, session, slug, id, now);
  }

  // Offline activation bundles (wire v3 §7). CORE for the same reason `services` is: one bundle
  // carries the License document AND the Config document, either of which may be absent, so it
  // belongs to neither service — a config-only product mints one with no license in it at all.
  if (resource === "bundles") {
    return handleBundleMint(req, env, db, session, slug, id, now);
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

  return notFound();
}

/**
 * Admin API dispatcher. `path` is everything AFTER `/manage` (so it begins with `/api`).
 * Verifies the session, CSRF-checks mutations, then routes. Returns 401/403 cleanly.
 */
export async function handleAdminApi(
  req: Request,
  env: Env,
  db: Db,
  path: string,
  now: number,
): Promise<Response> {
  const session = await sessionFromRequest(env, req, now);
  if (!session) return unauthorized();

  // R1-04: the admin API had NO rate limiter of any kind — only /manage/login and
  // /manage/callback were limited — while several of its routes write to D1. The budget is
  // keyed by the VERIFIED session subject, not the IP, so it follows the actor rather than
  // the network path, and it is generous enough that the SPA's normal fan-out never trips it.
  // Fails OPEN (see rateLimit.ts): a signed-in operator must not be locked out of the console
  // by a limiter outage, and the session gate above is the real access control here.
  if (
    !(await rateLimitOk(
      env,
      ADMIN_RL_SHARD,
      {
        bucket: "adminApi",
        id: session.sub,
        limit: 600,
        windowSec: 60,
      },
      now,
    ))
  ) {
    return err(429, "rate_limited", "too many admin API requests");
  }

  // Strip the `/api` prefix; tolerate trailing slash.
  let p = path.startsWith("/api") ? path.slice(4) : path;
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  const segments = p.split("/").filter(Boolean);

  // CSRF on every mutation (double-submit; SameSite=Strict is the primary defense).
  if (isMutation(req.method)) {
    const presented = req.headers.get(CSRF_HEADER);
    if (!presented || presented !== session.csrf) return forbidden("csrf");
  }

  const [head, ...rest] = segments;

  if (head === "me") return handleMe(env, db, session);
  if (head === "logout") {
    // R1-03: logout clears the session, so it is a mutation and must go through the CSRF
    // check above — which `isMutation` only applies to non-GET methods. As a GET it was a
    // state-changing route that skipped the gate entirely; cross-site exploitation was
    // blocked only by `SameSite=Strict`, i.e. by a cookie attribute that a future relax to
    // `SameSite=Lax` (the usual fix for post-OIDC redirects) would quietly remove.
    if (req.method !== "POST")
      return err(405, "method_not_allowed", "logout requires POST");
    return adminJson({ ok: true }, 200, { "set-cookie": buildClearCookie() });
  }
  if (head === "products") {
    // /products, /products/link-repo, or /products/<slug>/...
    // `link-repo` is a single-segment action, NOT a slug — handleProducts special-cases it
    // (with its platform-admin gate) before treating the segment as a product slug.
    try {
      if (rest.length <= 1)
        return await handleProducts(req, env, db, session, rest, now);
      const [slug, ...productRest] = rest;
      return await handleProductScoped(
        req,
        env,
        db,
        session,
        slug!,
        productRest,
        now,
      );
    } catch (e) {
      if (e instanceof AdminBodyError)
        return err(e.status, e.code, e.message, e.extra);
      throw e;
    }
  }

  return notFound();
}
