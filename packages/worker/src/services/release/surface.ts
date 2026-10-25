/// <reference types="@cloudflare/workers-types" />

/**
 * The release surface pipeline (P2-12.3, plan D3): everything both services do around their own
 * surface handler. It moved here from `gateway.ts` unchanged; the gateway keeps the GitHub-side
 * helpers (`harden`, the upstream meter, the live selector resolution).
 *
 *     edge cache (public surfaces only) → rate limit → access enforcement → compute → cache put
 *
 * and, wrapped around the compute step, the two upstream error mappings (a withdrawn release is
 * a 404, an exhausted GitHub quota is a 503) plus `harden`. See `gateway.ts` for why the limiter
 * runs before access enforcement and why the handler is a callback.
 */

import type { ReleaseAccess } from "@polaris-key/protocol/release";
import type { Env } from "../../platform/env.js";
import type { Db } from "../../db/types.js";
import type { ProductPublic } from "../../core/products.js";
import { errorResponse, notFound } from "../../core/errors.js";
import { clientNetwork, rateLimitOk } from "../../core/rateLimit.js";
import type { FetchImpl } from "./githubApp.js";
import { NotFoundError, UpstreamRateLimitedError } from "./github.js";
import {
  accessModeFor,
  artifactPolicy,
  getReleaseConfig,
  type ReleaseConfigRow,
  type ReleaseKind,
} from "./config.js";
import { enforceReleaseAccess, type ReleaseParams } from "./access.js";
import { harden, meterUpstreamCalls, upstreamUnavailable } from "./gateway.js";

/**
 * Per-IP budgets for release requests that MISS the edge cache (R10-05).
 *
 * The release surface is public by default and every miss costs GitHub subrequests against an
 * installation quota of 5,000/hour, so before this an unauthenticated client at ~1 req/s could
 * exhaust the product's entire quota in ~20 minutes and 404 every download and auto-update on
 * the platform.
 *
 * COUNT THE SUBREQUESTS, NOT THE REQUESTS. A download makes TWO calls, not one: `resolveSelector`
 * (`/releases/tags/…`, or `/releases?per_page=…` plus the channel-workflow lookups for a moving
 * selector) and then `streamAsset` (`/releases/assets/<id>`); a metadata miss makes one to
 * three. Sizing a per-IP budget as if a request were one call is how the per-IP lane ended up
 * ABOVE the quota it was introduced to protect.
 *
 * Two budgets, because the two surfaces have very different legitimate shapes:
 *
 *   METADATA (appcast / version / changelog / install) — 30/min, matching `/activate`. These
 *   are cached, so only a client walking distinct selectors (i.e. probing) misses repeatedly;
 *   a Sparkle updater makes one call per check and `install.sh` three in total.
 *
 *   ARTIFACTS (dl) — 60 per 2 minutes. Not cached (they stream bodies up to 2 GB), and the
 *   legitimate shape is bursty: a NAT'd office on release day, or one client issuing parallel
 *   Range requests for a resumable download. Too tight a cap would 429 real downloads, which
 *   is the outage this budget exists to prevent — so the window is widened rather than the rate
 *   raised. A 60-request burst still clears in one window, but the SUSTAINED ceiling is 30/min
 *   ⇒ 1,800 requests/hour ⇒ 3,600 GitHub calls/hour from one address, which sits under
 *   `UPSTREAM_RATE_LIMIT`, so no single address can spend the product's whole upstream budget.
 *   The previous 120/min was 7,200 requests/hour ⇒ 14,400 calls/hour: one unauthenticated
 *   address, inside its own budget, could drain a 5,000/hour quota nearly three times over.
 *
 * The byte routes (`services/distribution/bytes.ts`) charge the same two buckets with the same
 * numbers; the two copies cannot share a constant, because Distribution may not import Release.
 */
const METADATA_RATE_LIMIT = { limit: 30, windowSec: 60 } as const;
const ARTIFACT_RATE_LIMIT = { limit: 60, windowSec: 120 } as const;

/**
 * The surfaces whose responses are small, deterministic for a given selector, and pure
 * functions of GitHub state — i.e. the ones worth absorbing in the Cache API.
 *
 * `cli`/`dmg` are excluded on purpose: they stream an artifact body (often hundreds of MB,
 * with Range and If-None-Match passed through end-to-end), which is not something to buffer
 * into a cache entry. They are covered by the rate limit instead, and GitHub's own storage
 * redirect is already CDN-fronted.
 */
const CACHEABLE_KINDS = new Set<ReleaseKind>([
  "appcast",
  "channelAppcast",
  "version",
  "changelog",
]);

/**
 * Cloudflare's shared per-colo cache. Absent outside workerd (the Node test environment, and
 * any future non-Workers host), so every call site treats `null` as "no cache" and degrades
 * to the pre-cache behaviour rather than throwing.
 */
function edgeCache(): Cache | null {
  const c = (globalThis as { caches?: { default?: Cache } }).caches;
  return c?.default ?? null;
}

/**
 * A canonical cache key for a release read.
 *
 * Deliberately synthesised rather than reusing `req.url`: the real URL carries an
 * attacker-controlled query string, so `?x=1`, `?x=2`, … would mint unbounded distinct cache
 * entries and every one of them would miss — turning the cache itself into the amplifier it
 * is meant to stop. Only the inputs that actually change the response are encoded — which, as
 * of P2.T4, includes `arch`: the appcast serves a different enclosure per architecture, and a
 * key that ignored it would hand an Intel Mac the arm64 DMG (or the reverse).
 *
 * The release GENERATION (`ghCache.ts`) is deliberately NOT part of the key: reading it would put
 * a KV read in front of every hit and cost R10-05 its zero-binding hit. The price is that a yank,
 * pin or promote reaches a public product's version check and appcasts only when this entry
 * expires (`MOVING_CACHE` 120 s, `APPCAST_CACHE` 300 s, per colo), which the channels docs page
 * states. The byte routes and the download route are never edge-cached.
 */
function releaseCacheKey(
  origin: string,
  product: string,
  kind: ReleaseKind,
  params: ReleaseParams,
): Request {
  const url = new URL(`${origin}/__polaris-release-cache`);
  url.searchParams.set("p", product);
  url.searchParams.set("k", kind);
  if (params.version) url.searchParams.set("v", params.version);
  if (params.channel) url.searchParams.set("c", params.channel);
  if (params.arch) url.searchParams.set("a", params.arch);
  if (params.fixedVersion !== undefined)
    url.searchParams.set("f", params.fixedVersion);
  return new Request(url.toString(), { method: "GET" }) as unknown as Request;
}

/** The surfaces that stream bytes: the artifact rate-limit lane, never the edge cache. */
export const ARTIFACT_KINDS: ReadonlySet<ReleaseKind> = new Set<ReleaseKind>([
  "cli",
  "dmg",
  "build",
  "file",
  "blob",
]);

/** Everything a surface handler is given once the gateway has cleared the request. */
export interface SurfaceContext {
  req: Request;
  env: Env;
  db: Db;
  product: ProductPublic;
  cfg: ReleaseConfigRow;
  params: ReleaseParams;
  origin: string;
  now: number;
  fetchImpl: FetchImpl;
}

/**
 * Serve one release surface. `compute` renders it; everything else is this function's.
 *
 * Returns a clean 404 for anything missing or private.
 */
export async function serveReleaseSurface(
  req: Request,
  env: Env,
  db: Db,
  product: ProductPublic,
  kind: ReleaseKind,
  params: ReleaseParams,
  fetchImpl: FetchImpl,
  compute: (ctx: SurfaceContext) => Promise<Response>,
  opts: {
    /**
     * The ARTIFACTS access mode for this request, from Distribution's `delivery.accessMode()`
     * (P2b-04). Required for an artifacts-governed surface (the appcasts); without it such a
     * surface fails closed to `entitled` and is never edge-cached (`artifactPolicy`).
     */
    artifactsAccess?: ReleaseAccess;
  } = {},
): Promise<Response> {
  const cfg = await getReleaseConfig(db, product.slug);
  if (!cfg) return harden(notFound());

  const now = Math.floor(Date.now() / 1000);
  const origin = new URL(req.url).origin;

  // R10-05. Cache lookup runs FIRST and only for surfaces that are public for this product —
  // a hit costs zero GitHub subrequests and zero limiter round-trips, so serving it is the
  // most available thing we can do. A response is only ever cached when the effective access
  // mode is `public`, so a hit can never bypass `enforceReleaseAccess`.
  const cacheable =
    req.method === "GET" &&
    CACHEABLE_KINDS.has(kind) &&
    accessModeFor(artifactPolicy(cfg, opts.artifactsAccess), kind) === "public";
  const cache = cacheable ? edgeCache() : null;
  const cacheKey = cache
    ? releaseCacheKey(origin, product.slug, kind, params)
    : null;
  if (cache && cacheKey) {
    const hit = await cache.match(cacheKey).catch(() => undefined);
    if (hit) return hit;
  }

  // Only cache MISSES are metered: the budget exists to bound GitHub subrequests, and a hit
  // issues none. `install` is included even though it makes no GitHub call — it is the entry
  // point of the download flow and shares the same public surface.
  //
  // This precedes `enforceReleaseAccess` on purpose. A refusal is not free — it is a token
  // validation, a licence read and an entitlement merge — and charging for it only after it has
  // been decided means the callers the platform turns away are the only ones that never pay.
  // Access is still enforced before a single byte of release state is computed.
  const isArtifact = ARTIFACT_KINDS.has(kind);
  if (
    !(await rateLimitOk(
      env,
      product.slug,
      {
        bucket: isArtifact ? "releaseArtifact" : "release",
        id: clientNetwork(req),
        ...(isArtifact ? ARTIFACT_RATE_LIMIT : METADATA_RATE_LIMIT),
      },
      now,
    ))
  ) {
    return harden(
      errorResponse(429, "rate_limited", "too many release requests"),
    );
  }

  const denied = await enforceReleaseAccess(
    req,
    env,
    db,
    product,
    cfg,
    kind,
    params,
    now,
    opts.artifactsAccess,
  );
  if (denied) return harden(denied);

  const res = await runSurface(compute, {
    req,
    env,
    db,
    product,
    cfg,
    params,
    origin,
    now,
    // The surface handlers never see the raw fetch: every GitHub REST call they make, directly
    // or through a helper, is charged to this product's upstream budget first.
    fetchImpl: meterUpstreamCalls(env, product.slug, now, fetchImpl),
  });
  if (cache && cacheKey && res.status === 200) {
    // `put` consumes a body, so store the clone and return the original. A cache failure is
    // never allowed to fail the request.
    await cache.put(cacheKey, res.clone()).catch(() => undefined);
  }
  return res;
}

/** The compute step plus the two upstream error mappings, hardened. */
export async function runSurface(
  compute: (ctx: SurfaceContext) => Promise<Response>,
  ctx: SurfaceContext,
): Promise<Response> {
  try {
    // AWAITED inside the try: `return <promise>` resolves *after* the try block exits, so the
    // NotFoundError -> 404 mapping below never fired for the async surfaces and a private or
    // absent release 500'd instead of 404'ing (R9-14).
    return harden(await compute(ctx));
  } catch (err) {
    // R10-05. GitHub quota exhaustion is a platform condition, not "no such release": it hits
    // every product on the installation at once and previously surfaced as a 404, which is
    // indistinguishable from a withdrawn release and silently stops auto-updaters.
    if (err instanceof UpstreamRateLimitedError)
      return harden(upstreamUnavailable(err));
    if (err instanceof NotFoundError) return harden(notFound());
    throw err;
  }
}
