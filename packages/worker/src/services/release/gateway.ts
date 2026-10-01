/// <reference types="@cloudflare/workers-types" />

/**
 * The release gateway — everything both services do around their own surface handler.
 *
 * One request pipeline, in this order, for all seven surfaces:
 *
 *     edge cache (public surfaces only) → access enforcement → rate limit → compute → cache put
 *
 * and, wrapped around the compute step, the two upstream error mappings (a withdrawn release is
 * a 404, an exhausted GitHub quota is a 503) plus `harden`.
 *
 * ── WHY IT IS SHARED, AND WHY BY CALLBACK ───────────────────────────────────────────────────
 *
 * D-05 splits truth (Release) from feed (Update), but not the gateway: the budget being defended
 * is ONE product's GitHub installation quota, and an appcast miss and a DMG miss spend from the
 * same 5,000/hour. Two copies of this pipeline would be two places to get the rate-limit lane,
 * the cache-ability rule or the `public`-only caching invariant wrong.
 *
 * Update imports it — the one sanctioned cross-service edge (`test/boundaries.test.ts`). It
 * takes the surface handler as a CALLBACK rather than dispatching on `kind` itself, because
 * dispatching would mean Release importing Update's appcast renderer, which is that edge
 * pointing the wrong way.
 *
 * Selector resolution lives here too, for the same reason: `/release/dl/beta/...`,
 * `/update/beta/appcast.xml` and `/update/version?…` must resolve `beta` to the same release,
 * through the same channel-workflow lookup, or the feed would advertise a build the download
 * route would not serve.
 */

import type { Env, Db } from "../../core/platform.js";
import { appSecurityHeaders } from "../../core/platform.js";
import type { Product } from "../../core/products.js";
import { errorResponse, json, notFound } from "../../core/errors.js";
import { clientIp, rateLimitOk } from "../../core/rateLimit.js";
import { type FetchImpl, getInstallationToken } from "./githubApp.js";
import {
  type Release,
  getReleaseByTag,
  listReleases,
  NotFoundError,
  RELEASE_PAGE_CAP,
  resolveRelease,
  UpstreamRateLimitedError,
} from "./github.js";
import {
  type ChannelSelector,
  classifyChannel,
  floorChannelOf,
  isMovingSelector,
  parseManualChannels,
  resolutionPolicy,
  resolveChannel,
} from "./channels.js";
import {
  getChannelFloor,
  isBelowFloor,
  type ReleaseChannelFloorRow,
} from "./store.js";
import {
  accessModeFor,
  artifactPolicy,
  getReleaseConfig,
  type ReleaseConfigRow,
  type ReleaseKind,
  type ResolvedConfig,
} from "./config.js";
import { enforceReleaseAccess, type ReleaseParams } from "./access.js";

export type { ReleaseParams } from "./access.js";

/** The only Content-Type a streamed CLI binary is ever served as (R6-04). */
export const ARTIFACT_CONTENT_TYPE = "application/octet-stream";
const MOVING_CACHE = "public, max-age=120";
const PINNED_CACHE = "public, max-age=86400, immutable";
export const APPCAST_CACHE = "public, max-age=300";

/**
 * Per-IP budgets for release requests that MISS the edge cache (R10-05).
 *
 * The release surface is public by default and every miss costs 1-3 GitHub subrequests
 * against an installation quota of 5,000/hour, so before this an unauthenticated client at
 * ~1 req/s could exhaust the product's entire quota in ~20 minutes and 404 every download and
 * auto-update on the platform.
 *
 * Two budgets, because the two surfaces have very different legitimate shapes:
 *
 *   METADATA (appcast / version / changelog / install) — 30/min, matching `/activate`. These
 *   are cached, so only a client walking distinct selectors (i.e. probing) misses repeatedly;
 *   a Sparkle updater makes one call per check and `install.sh` three in total.
 *
 *   ARTIFACTS (dl) — 120/min. Not cached (they stream bodies up to 2 GB), and the legitimate
 *   shape is bursty: a NAT'd office on release day, or one client issuing parallel Range
 *   requests for a resumable download. Too tight a cap here would 429 real downloads, which is
 *   the outage this finding is about, so the artifact lane is deliberately loose — GitHub's own
 *   storage host, not our quota, absorbs the bytes.
 */
const METADATA_RATE_LIMIT = { limit: 30, windowSec: 60 } as const;
const ARTIFACT_RATE_LIMIT = { limit: 120, windowSec: 60 } as const;

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
  return new Request(url.toString(), { method: "GET" }) as unknown as Request;
}

/**
 * Apply the platform security headers to a release response (R6-04). `appSecurityHeaders`
 * existed but was applied nowhere under `release/`, so artifacts, appcasts and the installer
 * all shipped without `nosniff`, CSP or `X-Frame-Options` from an origin that also hosts the
 * admin SPA and the customer portal.
 */
export function harden(res: Response): Response {
  const headers = appSecurityHeaders(new Headers(res.headers));
  return new Response(res.body, { status: res.status, headers });
}

/** Everything a surface handler is given once the gateway has cleared the request. */
export interface SurfaceContext {
  req: Request;
  env: Env;
  db: Db;
  product: Product;
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
  product: Product,
  kind: ReleaseKind,
  params: ReleaseParams,
  fetchImpl: FetchImpl,
  compute: (ctx: SurfaceContext) => Promise<Response>,
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
    accessModeFor(artifactPolicy(cfg), kind) === "public";
  const cache = cacheable ? edgeCache() : null;
  const cacheKey = cache
    ? releaseCacheKey(origin, product.slug, kind, params)
    : null;
  if (cache && cacheKey) {
    const hit = await cache.match(cacheKey).catch(() => undefined);
    if (hit) return hit;
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
  );
  if (denied) return harden(denied);

  // Only cache MISSES are metered: the budget exists to bound GitHub subrequests, and a hit
  // issues none. `install` is included even though it makes no GitHub call — it is the entry
  // point of the download flow and shares the same public surface.
  const isArtifact = kind === "cli" || kind === "dmg";
  if (
    !(await rateLimitOk(
      env,
      product.slug,
      {
        bucket: isArtifact ? "releaseArtifact" : "release",
        id: clientIp(req),
        ...(isArtifact ? ARTIFACT_RATE_LIMIT : METADATA_RATE_LIMIT),
      },
      now,
    ))
  ) {
    return harden(
      errorResponse(429, "rate_limited", "too many release requests"),
    );
  }

  const res = await runSurface(compute, {
    req,
    env,
    db,
    product,
    cfg,
    params,
    origin,
    now,
    fetchImpl,
  });
  if (cache && cacheKey && res.status === 200) {
    // `put` consumes a body, so store the clone and return the original. A cache failure is
    // never allowed to fail the request.
    await cache.put(cacheKey, res.clone()).catch(() => undefined);
  }
  return res;
}

/** The compute step plus the two upstream error mappings, hardened. */
async function runSurface(
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
    if (err instanceof UpstreamRateLimitedError) {
      const headers: Record<string, string> = { "cache-control": "no-store" };
      if (err.retryAfterSeconds !== undefined) {
        headers["retry-after"] = String(Math.ceil(err.retryAfterSeconds));
      }
      return harden(
        json(
          {
            error: "upstream_rate_limited",
            message: "release metadata is temporarily unavailable",
          },
          { status: 503, headers },
        ),
      );
    }
    if (err instanceof NotFoundError) return harden(notFound());
    throw err;
  }
}

// ── Selector resolution ──────────────────────────────────────────────────────

/**
 * The installation token for this product's repo.
 *
 * R5-03: the scope is the repo coordinates, not the product slug. The slug was never a
 * security boundary here — GitHub scopes a token to `(installation, repositories)` — and
 * passing it made the KV cache entry collide with every other product on the same org-wide
 * installation. `channelWorkflow` asks for the two extra read permissions only when this
 * product actually resolves channels through the Actions API.
 */
export async function installationToken(
  env: Env,
  cfg: ResolvedConfig,
  now: number,
  fetchImpl: FetchImpl,
): Promise<string> {
  return getInstallationToken(
    env,
    {
      owner: cfg.gh_owner,
      repo: cfg.gh_repo,
      channelWorkflow: Boolean(cfg.channel_workflow),
    },
    cfg.gh_installation_id,
    now,
    fetchImpl,
  );
}

/**
 * Resolve a version/channel selector to a concrete release.
 *
 * Pinned `X.Y.Z` goes straight to the tag (`v<version>`, then `<version>`); every moving selector
 * goes through `resolveMovingSelector`, the ONE resolution function the download route, the
 * appcast, the version check and `checkReleaseHealth` share. A moving selector that resolves to
 * nothing — including a channel whose floor release has disappeared (R6-10) — is a 404.
 */
export async function resolveSelector(
  env: Env,
  db: Db,
  cfg: ResolvedConfig,
  selector: string | undefined,
  now: number,
  fetchImpl: FetchImpl,
): Promise<{ release: Release; sel: ChannelSelector }> {
  const manual = parseManualChannels(cfg.manual_channels_json);
  const sel = classifyChannel(selector, manual);
  if (!sel) throw new NotFoundError(`unknown selector: ${selector}`);
  const tok = await installationToken(env, cfg, now, fetchImpl);

  // A pinned stable tag can be resolved directly; moving selectors scan the release list.
  if (sel.kind === "stable" && sel.raw !== "latest" && sel.raw !== "stable") {
    const release = await resolveRelease(
      tok,
      cfg.gh_owner,
      cfg.gh_repo,
      sel.raw,
      fetchImpl,
    );
    return { release, sel };
  }

  const { release } = await resolveMovingSelector(
    env,
    db,
    cfg,
    tok,
    sel,
    now,
    fetchImpl,
  );
  if (!release) throw new NotFoundError(`no release for selector: ${selector}`);
  return { release, sel };
}

/** What a moving selector resolved to, and why. */
export interface MovingResolution {
  /** The release to serve, or null (nothing matches, or the channel regressed below its floor). */
  release: Release | null;
  /** The highest candidate among the pages read, before the floor was applied. */
  offered: Release | null;
  /** The channel's floor row, when it has one. */
  floor: ReleaseChannelFloorRow | null;
  /** True when `offered` sits below the floor and the floor's release is gone. */
  regressed: boolean;
  /** Everything read from the release list (for the health check's "listed N" line). */
  listed: Release[];
}

/**
 * Resolve a MOVING selector (latest/stable, beta, pr-<n>, a manual channel): the single
 * resolution function P0-02 asks for.
 *
 * 1. Filter + order with the product's candidate policy (`stableTagPattern`, `ignoreTags`,
 *    semver precedence — `resolutionPolicy`).
 * 2. Read release pages until one holds a candidate for this selector, capped at
 *    `RELEASE_PAGE_CAP.live` (3), and pick the highest candidate among the pages read. A repo
 *    whose first page already holds one — every normal repo — still costs ONE list call.
 * 3. Apply the channel floor (R6-10): one D1 read; and only when the pick is BELOW the floor,
 *    one GitHub tag lookup for the floor's release. Still there (it sat on a page not read) ⇒
 *    serve it. Gone ⇒ `release: null`, `regressed: true` — the caller 404s rather than
 *    silently promoting an older build to `latest` with a public cache header.
 *
 * `tok` is passed in so `checkReleaseHealth` can call this with the token it already holds.
 */
export async function resolveMovingSelector(
  env: Env,
  db: Db,
  cfg: ResolvedConfig,
  tok: string,
  sel: ChannelSelector,
  now: number,
  fetchImpl: FetchImpl,
): Promise<MovingResolution> {
  const policy = resolutionPolicy(cfg);
  const channelTags = await channelTagsFor(env, cfg, sel, now, fetchImpl);
  // `pr-<n>` without workflow tags can never resolve; do not spend three pages learning that.
  const listed =
    sel.kind === "pr" && !channelTags
      ? []
      : await listReleases(tok, cfg.gh_owner, cfg.gh_repo, 100, fetchImpl, {
          maxPages: RELEASE_PAGE_CAP.live,
          // Every selector's match is a per-release predicate, so "the pages so far hold a
          // match" is "the NEW page holds one": look at each release once here (R10-09 — each
          // look may run an operator regex), not once per page read.
          stopWhen: (_soFar, page) =>
            resolveChannel(sel, page, channelTags, policy) !== null,
        });
  const offered = resolveChannel(sel, listed, channelTags, policy);

  const floorName = floorChannelOf(sel, cfg);
  const floor = floorName
    ? await getChannelFloor(db, cfg.product, floorName)
    : null;
  if (!floor || !isBelowFloor(offered, floor)) {
    return { release: offered, offered, floor, regressed: false, listed };
  }
  const held = await floorRelease(tok, cfg, floor, fetchImpl);
  // The floor's release must still be something this selector would pick: a tag since added to
  // `ignoreTags`, or re-flagged as a prerelease, no longer holds the stable channel up.
  if (held && resolveChannel(sel, [held], channelTags, policy)) {
    return { release: held, offered, floor, regressed: false, listed };
  }
  return { release: null, offered, floor, regressed: true, listed };
}

/**
 * Look a floor's release up: by its recorded tag (one call), or — for a floor an operator
 * lowered to a version the store never recorded — by the pinned `v<version>` / `<version>`
 * lookup. `null` when it no longer exists. The truth-store sync uses it too, for a repo whose
 * release list it could not read to the end (`sync.ts`), so the store and the live route agree.
 */
export async function floorRelease(
  tok: string,
  cfg: ResolvedConfig,
  floor: ReleaseChannelFloorRow,
  fetchImpl: FetchImpl,
): Promise<Release | null> {
  if (floor.release_id) {
    return getReleaseByTag(
      tok,
      cfg.gh_owner,
      cfg.gh_repo,
      floor.release_id,
      fetchImpl,
    );
  }
  try {
    return await resolveRelease(
      tok,
      cfg.gh_owner,
      cfg.gh_repo,
      floor.version,
      fetchImpl,
    );
  } catch (err) {
    if (err instanceof NotFoundError) return null;
    throw err;
  }
}

/**
 * For beta/pr selectors, derive the set of release tags produced by a successful run of
 * the channel workflow from the relevant branch/PR head. Returns undefined when no
 * channel workflow is configured (callers then fall back to prerelease heuristics).
 */
async function channelTagsFor(
  env: Env,
  cfg: ResolvedConfig,
  sel: ChannelSelector,
  now: number,
  fetchImpl: FetchImpl,
): Promise<Set<string> | undefined> {
  if (sel.kind !== "beta" && sel.kind !== "pr") return undefined;
  if (!cfg.channel_workflow) return undefined;
  const tok = await installationToken(env, cfg, now, fetchImpl);
  const base = `https://api.github.com/repos/${cfg.gh_owner}/${cfg.gh_repo}`;
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${tok}`,
    "User-Agent": "polaris-key-release",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  // `channel_workflow` is repo-owned. Encoding it keeps dot-segments from steering this
  // installation-token-bearing GET off the workflow-runs endpoint (R6-07) — `beta_branch`
  // on the same line was already encoded.
  const workflow = encodeURIComponent(cfg.channel_workflow);
  let runsUrl: string;
  if (sel.kind === "beta") {
    runsUrl = `${base}/actions/workflows/${workflow}/runs?branch=${encodeURIComponent(cfg.beta_branch)}&status=success&per_page=10`;
  } else {
    const prRes = await fetchImpl(`${base}/pulls/${sel.pr}`, { headers });
    if (!prRes.ok) throw new NotFoundError(`pr lookup failed: ${prRes.status}`);
    const pr = (await prRes.json()) as { head: { sha: string } };
    runsUrl = `${base}/actions/workflows/${workflow}/runs?event=pull_request&head_sha=${encodeURIComponent(pr.head.sha)}&status=success&per_page=10`;
  }

  const res = await fetchImpl(runsUrl, { headers });
  if (!res.ok)
    throw new NotFoundError(`channel runs lookup failed: ${res.status}`);
  const data = (await res.json()) as {
    workflow_runs?: Array<{ head_branch: string | null; head_sha: string }>;
  };
  // An off-shape response (wrong endpoint, empty body) used to throw an unhandled TypeError
  // on the iteration below and 500 the route.
  if (!Array.isArray(data.workflow_runs)) return undefined;
  // Map runs -> their associated release tags. Channel runs publish a tag named after
  // the run's head ref/sha; we accept any release whose tag references that head sha.
  const tags = new Set<string>();
  for (const run of data.workflow_runs) {
    if (run.head_branch) tags.add(`v${run.head_branch}`);
    tags.add(run.head_sha.slice(0, 7));
  }
  return tags.size ? tags : undefined;
}

/** Channel suffix used in asset names / install paths for non-stable selectors. */
export function channelSuffix(sel: ChannelSelector): string | undefined {
  if (sel.kind === "stable") return undefined;
  if (sel.kind === "pr") return sel.raw; // pr-<n>
  return sel.raw; // beta / manual name
}

export function cacheHeader(sel: ChannelSelector): string {
  return isMovingSelector(sel) ? MOVING_CACHE : PINNED_CACHE;
}
