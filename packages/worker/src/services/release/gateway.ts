/// <reference types="@cloudflare/workers-types" />

/**
 * The release gateway — everything both services do around their own surface handler.
 *
 * One request pipeline, in this order, for the surfaces that still run through it (Release's
 * changelog, Update's appcasts and version check; the byte routes are Distribution's since
 * P2b-04 and run the same steps in `services/distribution/bytes.ts`):
 *
 *     edge cache (public surfaces only) → rate limit → access enforcement → compute → cache put
 *
 * and, wrapped around the compute step, the two upstream error mappings (a withdrawn release is
 * a 404, an exhausted GitHub quota is a 503) plus `harden`.
 *
 * The limiter runs BEFORE access enforcement, not after. Enforcement first meant a caller the
 * platform refuses paid nothing for being refused: on a `licensed` or `entitled` product an
 * unauthenticated client could collect 401s and 403s forever, at whatever rate it liked, and
 * enumerate selectors (which versions exist, which channels a grant covers) for free. The budget
 * exists to bound work done on behalf of a stranger, and deciding to refuse a stranger is work
 * (a token validation, a licence read, an entitlement merge). The cache lookup stays ahead of
 * both: a hit costs nothing and is never metered. Access is still enforced before a single byte
 * of release state is computed.
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

import type { Env } from "../../platform/env.js";
import type { Db } from "../../db/types.js";
import { appSecurityHeaders } from "../../core/securityHeaders.js";
import { BLOB_CSP } from "../../core/assets/blobs.js";
import { json } from "../../core/errors.js";
import { rateLimitOk } from "../../core/rateLimit.js";
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
  policyChannelOf,
  resolutionPolicy,
  resolveChannel,
  semverOfTag,
} from "./channels.js";
import {
  getChannelFloor,
  isBelowFloor,
  type ReleaseChannelFloorRow,
  storedAppReleases,
} from "./store.js";
import {
  compareSemver,
  parseSemver,
} from "../../core/licensing/entitlements.js";
import type { ResolvedConfig } from "./config.js";
import { legacyPolicyFor, type LegacyPolicy } from "./resolve.js";
import { cachedResolution } from "./ghCache.js";

export type { ReleaseParams } from "./access.js";

/** The only Content-Type a streamed CLI binary is ever served as (R6-04). */
export const ARTIFACT_CONTENT_TYPE = "application/octet-stream";
const MOVING_CACHE = "public, max-age=120";
const PINNED_CACHE = "public, max-age=86400, immutable";
export const APPCAST_CACHE = "public, max-age=300";

/**
 * The per-PRODUCT upstream budget — the thing the two per-IP lanes above are proxies for.
 *
 * The per-IP lanes bound what ONE caller costs. Nothing bounded what the product costs in
 * total, so the defence was bypassable by the cheapest possible means: more source addresses.
 * A GitHub App installation gets ~5,000 requests/hour, shared by every product on it, and the
 * consequence of exhausting it is not a slow appcast — it is `install.sh`, every artifact
 * download and every auto-update answering 503 for all of them at once.
 *
 * So this is charged ONCE PER GITHUB CALL (see `meterUpstreamCalls`), not once per request, and
 * keyed on the product slug alone — never on the caller — because it is the QUOTA it is
 * measuring, not anybody's share of it. 4,000/hour leaves ~20% of the real quota as headroom
 * for the paths that do not run through this gateway (repo linking, the `.pkey/` resync, the
 * truth-store sync, the webhook, the release health check).
 *
 * FAIL MODE: `open`, registered in `core/rateLimit.ts`'s `FAIL_MODE` beside its two per-IP
 * siblings. This budget guards a cost, not a secret, and the failure it exists to prevent is a
 * software-distribution outage — so a Durable Object blip must not itself become one.
 */
export const UPSTREAM_RATE_LIMIT = { limit: 4000, windowSec: 3600 } as const;

/**
 * The host whose requests are charged against the installation quota.
 *
 * Only `api.github.com` counts: `streamAsset` and `fetchAsset` follow GitHub's 302 into
 * `objects.githubusercontent.com` (SSRF-guarded), and that second hop is a signed CDN URL which
 * carries no Authorization and is not billed to the App's REST quota. Charging it would meter
 * the one call that does not cost anything.
 */
const UPSTREAM_METERED_HOST = "api.github.com";

function isUpstreamApiCall(url: string): boolean {
  try {
    return new URL(url).hostname === UPSTREAM_METERED_HOST;
  } catch {
    return false;
  }
}

/**
 * Wrap a fetch so every GitHub REST call it issues is charged to the product's upstream budget
 * before it leaves the isolate.
 *
 * The seam is the injected fetch, deliberately. Charging inside `resolveSelector` (or any other
 * helper) would meter the call sites that exist TODAY and silently under-count the next one —
 * `installationToken`'s mint on a cold KV cache and `channelTagsFor`'s pull-request and
 * workflow-run lookups are exactly the calls a per-request charge forgets. A surface reaches
 * GitHub only through the fetch it is handed, so there is no call site to forget. The wrapper
 * is applied wherever a request's fetch is born: here in `serveReleaseSurface` (the changelog,
 * the appcasts, the version check), in `releaseCatalog` (`openSource` and `repositoryPublic`:
 * Distribution's byte routes, Update's artifact bytes and the portal's repository gate) and in
 * the mirror consumer.
 *
 * Exhaustion throws `UpstreamRateLimitedError`, which `runSurface` and `source.ts` already map
 * to the 503 `upstream_rate_limited` body: an exhausted quota is a platform condition, identical
 * in kind to GitHub answering 403 with `X-RateLimit-Remaining: 0`, and must not be reported as
 * "no such release" — the confusion the 503 mapping exists to remove, and must not bring back.
 */
export function meterUpstreamCalls<I extends Request | string>(
  env: Env,
  product: string,
  now: number,
  fetchImpl: (input: I, init?: RequestInit) => Promise<Response>,
): (input: I, init?: RequestInit) => Promise<Response> {
  return async (input, init) => {
    if (isUpstreamApiCall(typeof input === "string" ? input : input.url)) {
      const ok = await rateLimitOk(
        env,
        product,
        { bucket: "releaseUpstream", id: product, ...UPSTREAM_RATE_LIMIT },
        now,
      );
      if (!ok) {
        // The fixed window rolls at the next multiple of `windowSec`, so this is the real wait.
        const { windowSec } = UPSTREAM_RATE_LIMIT;
        throw new UpstreamRateLimitedError(
          "product upstream budget exhausted",
          windowSec - (now % windowSec),
        );
      }
    }
    return fetchImpl(input, init);
  };
}

/**
 * Apply the platform security headers to a release response (R6-04). `appSecurityHeaders`
 * existed but was applied nowhere under `release/`, so artifacts, appcasts and the installer
 * all shipped without `nosniff`, CSP or `X-Frame-Options` from an origin that also hosts the
 * admin SPA and the customer portal.
 */
export function harden(res: Response): Response {
  // A byte response (`blobResponse`) already carries the sandbox CSP, which is strictly tighter
  // than the app CSP: keep it rather than loosen it (P2-05).
  const sandboxed = res.headers.get("content-security-policy") === BLOB_CSP;
  const headers = appSecurityHeaders(new Headers(res.headers));
  if (sandboxed) headers.set("content-security-policy", BLOB_CSP);
  return new Response(res.body, { status: res.status, headers });
}

/**
 * The answer to an exhausted GitHub quota: 503 with `Retry-After` when GitHub gave one. Shared
 * with `source.ts`, which maps the same failure for the bytes Distribution streams through the
 * `releaseCatalog` hook, so a download and an appcast say the same thing.
 */
export function upstreamUnavailable(err: UpstreamRateLimitedError): Response {
  const headers: Record<string, string> = { "cache-control": "no-store" };
  if (err.retryAfterSeconds !== undefined) {
    headers["retry-after"] = String(Math.ceil(err.retryAfterSeconds));
  }
  return json(
    {
      error: "upstream_rate_limited",
      message: "release metadata is temporarily unavailable",
    },
    { status: 503, headers },
  );
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
 *
 * The channel policy (P2-05) applies on top, so these legacy routes agree with the new
 * per-platform resolution (`resolve.ts`):
 *   - a YANKED release is never offered on a moving selector (a pinned version still names it);
 *   - a PINNED channel serves exactly its pointer, yanked or not (yanks resolve only by pin), and
 *     a pinned pointer that no longer exists on GitHub is a 404, never a silent fallback;
 *   - an unpinned pointer (a promote) is one more candidate, served when it is the newest.
 *
 * The result is cached for `RESOLUTION_TTL` per (product, selector, release generation)
 * (`ghCache.ts`), so a download, an appcast and a version check cost at most one resolution per
 * selector per 90 s, and any policy change or sync invalidates it at once (the edge cache in
 * front of the version check and appcasts is a separate, unpurged layer: `releaseCacheKey`).
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
  const release = await cachedResolution(
    env,
    cfg.product,
    // Keyed by what the selector MEANS, not how it was spelled: `latest`, `stable` and an
    // omitted selector are one resolution, and so are `beta` and its legacy spellings.
    `selector:${policyChannelOf(sel) ?? `version:${sel.raw}`}`,
    () => resolveSelectorLive(env, db, cfg, sel, now, fetchImpl),
  );
  if (!release) throw new NotFoundError(`no release for selector: ${selector}`);
  return { release, sel };
}

/** `resolveSelector` without the cache. */
async function resolveSelectorLive(
  env: Env,
  db: Db,
  cfg: ResolvedConfig,
  sel: ChannelSelector,
  now: number,
  fetchImpl: FetchImpl,
): Promise<Release | null> {
  const tok = await installationToken(env, cfg, now, fetchImpl);

  // A pinned stable tag can be resolved directly; moving selectors scan the release list.
  if (!isMovingSelector(sel)) {
    return resolveRelease(tok, cfg.gh_owner, cfg.gh_repo, sel.raw, fetchImpl);
  }

  const policy = await legacyPolicyFor(db, cfg.product, policyChannelOf(sel));
  if (policy.pinned && policy.pointer) {
    const pinned = await getReleaseByTag(
      tok,
      cfg.gh_owner,
      cfg.gh_repo,
      policy.pointer,
      fetchImpl,
    );
    return pinned && !pinned.draft ? pinned : null;
  }

  const moving = await resolveMovingSelector(
    env,
    db,
    cfg,
    tok,
    sel,
    now,
    fetchImpl,
    policy,
  );
  if (!policy.pointer || policy.yanked.has(policy.pointer))
    return moving.release;
  // An unpinned pointer (promote) is a member of the channel: one more candidate.
  // By tag, not from `moving.listed`: a cached listing carries no assets. The whole result is
  // cached one level up, so this costs one call per 90 s at most.
  const pointer = await getReleaseByTag(
    tok,
    cfg.gh_owner,
    cfg.gh_repo,
    policy.pointer,
    fetchImpl,
  );
  if (!pointer || pointer.draft) return moving.release;
  if (!moving.release) return pointer;
  return resolutionPolicy(cfg).compare(pointer, moving.release) > 0
    ? pointer
    : moving.release;
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
 *    semver precedence — `resolutionPolicy`), minus every YANKED tag (P2-05, `policy`).
 * 2. Read release pages until one holds a candidate for this selector, capped at
 *    `RELEASE_PAGE_CAP.live` (3), and pick the highest candidate among the pages read. A repo
 *    whose first page already holds one — every normal repo — still costs ONE list call.
 * 3. Apply the channel floor (R6-10): one D1 read; and only when the pick is BELOW the floor,
 *    one GitHub tag lookup for the floor's release. Still there (it sat on a page not read) ⇒
 *    serve it. Gone ⇒ `release: null`, `regressed: true` — the caller 404s rather than
 *    silently promoting an older build to `latest` with a public cache header. A floor whose
 *    release was YANKED is lowered, not removed: it drops to the newest unyanked release the
 *    store holds below it (`yankedFloorFallback`), so the channel falls back to that release
 *    instead of 404ing, and a later upstream deletion of it still 404s the channel.
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
  policy?: Pick<LegacyPolicy, "yanked">,
): Promise<MovingResolution> {
  // The yanks always apply (P2-05): a caller that did not read them gets them read here, so the
  // health check's per-channel regression checks and the live routes can never disagree.
  const yanks =
    policy ?? (await legacyPolicyFor(db, cfg.product, policyChannelOf(sel)));
  // Cached like `resolveSelector` (`ghCache.ts`): the health check and the download paths pay
  // at most one live resolution — list pages plus a floor lookup — per channel per 90 s
  // (README §9.1 issue #3). The cached `listed` keeps what the health check reads of each
  // release (tag, flags, date) but not its notes or assets; `release` and `offered` are whole.
  // A channel that resolves to nothing (nothing matches, or an R6-10 regression) is never
  // cached: it is re-checked live, so a 404 cannot stick.
  const holder: { live?: MovingResolution } = {};
  const cached = await cachedResolution<MovingResolution>(
    env,
    cfg.product,
    `moving:${policyChannelOf(sel) ?? sel.raw}`,
    async () => {
      const live = await resolveMovingSelectorLive(
        env,
        db,
        cfg,
        tok,
        sel,
        now,
        fetchImpl,
        yanks,
      );
      holder.live = live;
      if (!live.release) return null;
      return {
        ...live,
        listed: live.listed.map((r) => ({ ...r, body: null, assets: [] })),
      };
    },
  );
  // On a miss, the caller gets the live result itself (assets and notes included).
  return holder.live ?? (cached as MovingResolution);
}

async function resolveMovingSelectorLive(
  env: Env,
  db: Db,
  cfg: ResolvedConfig,
  tok: string,
  sel: ChannelSelector,
  now: number,
  fetchImpl: FetchImpl,
  policy: Pick<LegacyPolicy, "yanked">,
): Promise<MovingResolution> {
  const candidates = resolutionPolicy(cfg);
  const yanked = policy.yanked;
  const unyanked = (releases: Release[]) =>
    yanked.size > 0
      ? releases.filter((r) => !yanked.has(r.tag_name))
      : releases;
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
            resolveChannel(sel, unyanked(page), channelTags, candidates) !==
            null,
        });
  const offered = resolveChannel(
    sel,
    unyanked(listed),
    channelTags,
    candidates,
  );

  const floorName = floorChannelOf(sel, cfg);
  const recorded = floorName
    ? await getChannelFloor(db, cfg.product, floorName)
    : null;
  // A floor whose release was YANKED is LOWERED, never removed (R6-10, P2-05 review): it drops
  // to the newest unyanked release the store holds below it, so the most common yank — the
  // newest release, which is also the floor — still leaves the channel protected.
  const floor =
    recorded && recorded.release_id && yanked.has(recorded.release_id)
      ? await yankedFloorFallback(db, cfg, sel, recorded, yanked)
      : recorded;
  if (!floor || !isBelowFloor(offered, floor)) {
    return { release: offered, offered, floor, regressed: false, listed };
  }
  const held = await floorRelease(tok, cfg, floor, fetchImpl);
  // The floor's release must still be something this selector would pick: a tag since added to
  // `ignoreTags`, or re-flagged as a prerelease, no longer holds the stable channel up.
  if (held && resolveChannel(sel, [held], channelTags, candidates)) {
    return { release: held, offered, floor, regressed: false, listed };
  }
  return { release: null, offered, floor, regressed: true, listed };
}

/**
 * The floor a channel effectively has when its recorded floor release has been yanked: the
 * newest release the STORE holds at or below the recorded floor version that is not yanked and
 * that this selector would pick, or null when there is none (the channel then serves its
 * newest unyanked candidate, as it would with no floor at all).
 *
 * Read from the store, not the live list, on purpose: a release deleted upstream after the yank
 * keeps its store row, so it still holds the channel up and its deletion 404s the channel —
 * exactly what the same deletion does to an unyanked floor. Computed per resolution rather than
 * written back to `release_channel_floors`, because the sync (which does not read yanks) would
 * otherwise raise the floor straight back to the yanked release on the next resync.
 *
 * Costs one D1 read, only when the recorded floor is yanked.
 */
async function yankedFloorFallback(
  db: Db,
  cfg: ResolvedConfig,
  sel: ChannelSelector,
  recorded: ReleaseChannelFloorRow,
  yanked: ReadonlySet<string>,
): Promise<ReleaseChannelFloorRow | null> {
  if (!parseSemver(recorded.version)) return null;
  const below = (await storedAppReleases(db, cfg.product)).filter((r) => {
    if (yanked.has(r.tag_name)) return false;
    const v = semverOfTag(r.tag_name);
    return v !== null && compareSemver(v, recorded.version) <= 0;
  });
  // No channel-workflow tags: a floored selector never resolves through them (`floorChannelOf`).
  const pick = resolveChannel(sel, below, undefined, resolutionPolicy(cfg));
  const version = pick ? semverOfTag(pick.tag_name) : null;
  if (!pick || version === null) return null;
  return { ...recorded, version, release_id: pick.tag_name };
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
export async function channelTagsFor(
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

/**
 * The pull requests of the channel workflow's last 10 successful pull-request runs
 * (P2-12.7 lead decision): one runs call, and the installation token the product already holds.
 * GitHub gives each run its `pull_requests[].number` (empty for a fork's). Answers the numbers
 * newest first, deduplicated; `[]` when the product has no channel workflow or GitHub answers
 * anything but a runs list. A refusal is the caller's fetch wrapper's to observe, not thrown here.
 */
export async function recentChannelPullRequests(
  env: Env,
  cfg: ResolvedConfig,
  now: number,
  fetchImpl: FetchImpl,
): Promise<number[]> {
  if (!cfg.channel_workflow) return [];
  const tok = await installationToken(env, cfg, now, fetchImpl);
  const workflow = encodeURIComponent(cfg.channel_workflow);
  const res = await fetchImpl(
    `https://api.github.com/repos/${cfg.gh_owner}/${cfg.gh_repo}/actions/workflows/${workflow}/runs?event=pull_request&status=success&per_page=10`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${tok}`,
        "User-Agent": "polaris-key-release",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );
  if (!res.ok) return [];
  const data = (await res.json().catch(() => null)) as {
    workflow_runs?: Array<{ pull_requests?: Array<{ number?: unknown }> }>;
  } | null;
  if (!data || !Array.isArray(data.workflow_runs)) return [];
  const out = new Set<number>();
  for (const run of data.workflow_runs)
    for (const pr of Array.isArray(run.pull_requests) ? run.pull_requests : [])
      if (
        typeof pr?.number === "number" &&
        Number.isSafeInteger(pr.number) &&
        pr.number > 0
      )
        out.add(pr.number);
  return [...out];
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
