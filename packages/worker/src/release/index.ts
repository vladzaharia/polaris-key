/// <reference types="@cloudflare/workers-types" />

/**
 * Release-distribution entrypoint. One handler fronts a product's GitHub Releases
 * (binary, DMG, Sparkle appcast, version, changelog) and serves a templated installer.
 *
 * Everything is product-scoped via `release_config` (404 if the product has no release
 * config). The GitHub side authenticates as a GitHub App installation (token cached in
 * KV); all GitHub calls go through an injectable `fetchImpl` so the parent can pass the
 * platform `fetch` in prod and tests can pass a stub. Storage-redirect re-fetches are
 * SSRF-guarded to GitHub's own hosts (see github.ts `streamAsset`/`fetchTextAsset`).
 */

import type { Env } from "../env.js";
import type { Db } from "../db/types.js";
import type { Product } from "../product.js";
import { bearer, errorResponse, json, notFound } from "../http.js";
import { validateDeviceToken } from "../licenseCore.js";
import { clientIp, rateLimitOk } from "../rateLimit.js";
import { appSecurityHeaders } from "../securityHeaders.js";
import { type FetchImpl, getInstallationToken } from "./githubApp.js";
import {
  type Release,
  fetchTextAsset,
  listReleases,
  NotFoundError,
  resolveRelease,
  streamAsset,
  UpstreamRateLimitedError,
} from "./github.js";
import { verifySparkleSignature } from "./sparkle.js";
import {
  type ChannelSelector,
  classifyChannel,
  isMovingSelector,
  parseManualChannels,
  resolveChannel,
} from "./channels.js";
import {
  type Arch,
  findBinaryAsset,
  matchAsset,
  normalizeArch,
} from "./assets.js";
import { type ChangelogEntry, extractSummary } from "./changelog.js";
import {
  buildAppcastItem,
  renderAppcast,
  sigAssetName,
  versionFromTag,
} from "./appcast.js";
import { type InstallContext, renderInstallScript } from "./install.js";

export type ReleaseKind =
  | "appcast"
  | "channelAppcast"
  | "cli"
  | "dmg"
  | "version"
  | "changelog"
  | "install";

export interface ReleaseParams {
  /** Version/channel selector (cli/dmg/appcast); `latest` when omitted. */
  version?: string;
  /** Channel name for channelAppcast / channel selector. */
  channel?: string;
  /** Requested architecture (cli/dmg). */
  arch?: Arch;
}

interface ReleaseConfigRow {
  product: string;
  gh_owner: string | null;
  gh_repo: string | null;
  gh_installation_id: number | null;
  channel_workflow: string | null;
  beta_branch: string;
  manual_channels_json: string | null;
  binary_name: string | null;
  install_template: string | null;
  sparkle_ed25519_pub: string | null;
  summary_marker: string;
  artifact_policy_json: string | null;
  metadata_access?: string | null;
  artifacts_access?: string | null;
}

/** The only Content-Type a streamed CLI binary is ever served as (R6-04). */
const ARTIFACT_CONTENT_TYPE = "application/octet-stream";
const MOVING_CACHE = "public, max-age=120";
const PINNED_CACHE = "public, max-age=86400, immutable";
const APPCAST_CACHE = "public, max-age=300";

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
 *   ARTIFACTS (cli / dmg) — 120/min. Not cached (they stream bodies up to 2 GB), and the
 *   legitimate shape is bursty: a NAT'd office on release day, or one client issuing parallel
 *   Range requests for a resumable download. Too tight a cap here would 429 real downloads,
 *   which is the outage this finding is about, so the artifact lane is deliberately loose —
 *   GitHub's own storage host, not our quota, absorbs the bytes.
 */
const METADATA_RATE_LIMIT = { limit: 30, windowSec: 60 } as const;
const ARTIFACT_RATE_LIMIT = { limit: 120, windowSec: 60 } as const;

type ReleaseAccessMode = "public" | "authenticated" | "licensed";

function readAccessMode(value: unknown): ReleaseAccessMode {
  if (value === "authenticated") return "authenticated";
  if (value === "licensed") return "licensed";
  return "public";
}

/**
 * Resolve the effective artifact policy.
 *
 * `requireSparkleSignature` is OPERATOR-owned (R6-03): `parseManifest` no longer carries the
 * field, so a `.pkey/release.*` push can never write `false` into `artifact_policy_json` and
 * disarm the platform's own signing requirement. Only an operator editing the row directly
 * can opt a product out, and the default is always "required".
 */
function artifactPolicy(cfg: ReleaseConfigRow): {
  requireSparkleSignature: boolean;
  access: { metadata: ReleaseAccessMode; artifacts: ReleaseAccessMode };
} {
  const defaults = {
    requireSparkleSignature: true,
    access: { metadata: "public", artifacts: "public" } as const,
  };
  const columnAccess = {
    metadata: readAccessMode(cfg.metadata_access),
    artifacts: readAccessMode(cfg.artifacts_access),
  };
  if (!cfg.artifact_policy_json) {
    return { ...defaults, access: columnAccess };
  }
  try {
    const parsed = JSON.parse(cfg.artifact_policy_json) as {
      requireSparkleSignature?: unknown;
    };
    return {
      requireSparkleSignature: parsed.requireSparkleSignature !== false,
      access: columnAccess,
    };
  } catch {
    return { ...defaults, access: columnAccess };
  }
}

async function enforceReleaseAccess(
  req: Request,
  env: Env,
  db: Db,
  product: Product,
  cfg: ReleaseConfigRow,
  kind: ReleaseKind,
  now: number,
): Promise<Response | null> {
  if (accessModeFor(artifactPolicy(cfg), kind) === "public") return null;

  const valid = await validateDeviceToken(env, db, product, bearer(req), now);
  if ("error" in valid) {
    return errorResponse(
      401,
      "download_auth_required",
      "a valid license is required to download this release artifact",
    );
  }
  return null;
}

export async function getReleaseConfig(
  db: Db,
  product: string,
): Promise<ReleaseConfigRow | null> {
  return db.first<ReleaseConfigRow>(
    "SELECT * FROM release_config WHERE product = ?",
    product,
  );
}

/** A release config that has the GitHub coordinates needed to talk to the API. */
interface ResolvedConfig extends ReleaseConfigRow {
  gh_owner: string;
  gh_repo: string;
  gh_installation_id: number;
}

function isResolved(cfg: ReleaseConfigRow): cfg is ResolvedConfig {
  return Boolean(cfg.gh_owner && cfg.gh_repo && cfg.gh_installation_id);
}

// ── Edge cache (R10-05) ──────────────────────────────────────────────────────

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
 * is meant to stop. Only the inputs that actually change the response are encoded.
 */
function releaseCacheKey(
  origin: string,
  product: string,
  kind: ReleaseKind,
  params: ReleaseParams,
): Request {
  const url = new URL(`${origin}/__pkey-release-cache`);
  url.searchParams.set("p", product);
  url.searchParams.set("k", kind);
  if (params.version) url.searchParams.set("v", params.version);
  if (params.channel) url.searchParams.set("c", params.channel);
  return new Request(url.toString(), { method: "GET" }) as unknown as Request;
}

/**
 * Handle a release request. `kind` selects the surface; `params` carries the
 * version/channel/arch. Returns a clean 404 for anything missing or private.
 */
export async function handleRelease(
  req: Request,
  env: Env,
  db: Db,
  product: Product,
  kind: ReleaseKind,
  params: ReleaseParams,
  fetchImpl: FetchImpl = fetch,
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

  const res = await computeRelease(
    req,
    env,
    db,
    product,
    cfg,
    kind,
    params,
    origin,
    now,
    fetchImpl,
  );
  if (cache && cacheKey && res.status === 200) {
    // `put` consumes a body, so store the clone and return the original. A cache failure is
    // never allowed to fail the request.
    await cache.put(cacheKey, res.clone()).catch(() => undefined);
  }
  return res;
}

/** Which access mode governs a surface: metadata for the informational reads, else artifacts. */
function accessModeFor(
  policy: ReturnType<typeof artifactPolicy>,
  kind: ReleaseKind,
): ReleaseAccessMode {
  return kind === "version" || kind === "changelog" || kind === "install"
    ? policy.access.metadata
    : policy.access.artifacts;
}

/** The surface switch: everything past access control, rate limiting and the edge cache. */
async function computeRelease(
  req: Request,
  env: Env,
  db: Db,
  product: Product,
  cfg: ReleaseConfigRow,
  kind: ReleaseKind,
  params: ReleaseParams,
  origin: string,
  now: number,
  fetchImpl: FetchImpl,
): Promise<Response> {
  try {
    // Every branch is AWAITED inside the try: `return <promise>` resolves *after* the try
    // block exits, so the NotFoundError -> 404 mapping below never fired for the async
    // surfaces and a private/absent release 500'd instead of 404'ing (R9-14).
    switch (kind) {
      case "install":
        return harden(handleInstall(cfg, product, origin));
      case "version":
        return harden(
          await handleVersion(env, db, cfg, product, params, now, fetchImpl),
        );
      case "changelog":
        return harden(
          await handleChangelog(env, db, cfg, product, now, fetchImpl),
        );
      case "cli":
        return harden(
          await handleBinary(
            env,
            db,
            cfg,
            product,
            params,
            "cli",
            req,
            now,
            origin,
            fetchImpl,
          ),
        );
      case "dmg":
        return harden(
          await handleBinary(
            env,
            db,
            cfg,
            product,
            params,
            "dmg",
            req,
            now,
            origin,
            fetchImpl,
          ),
        );
      case "appcast":
        return harden(
          await handleAppcast(
            env,
            db,
            cfg,
            product,
            { ...params, channel: "stable" },
            origin,
            now,
            fetchImpl,
          ),
        );
      case "channelAppcast":
        return harden(
          await handleAppcast(
            env,
            db,
            cfg,
            product,
            params,
            origin,
            now,
            fetchImpl,
          ),
        );
      default:
        return harden(notFound());
    }
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

/**
 * Apply the platform security headers to a release response (R6-04). `appSecurityHeaders`
 * existed but was applied nowhere under `release/`, so artifacts, appcasts and the installer
 * all shipped without `nosniff`, CSP or `X-Frame-Options` from an origin that also hosts the
 * admin SPA and the customer portal.
 */
function harden(res: Response): Response {
  const headers = appSecurityHeaders(new Headers(res.headers));
  return new Response(res.body, { status: res.status, headers });
}

/**
 * The installation token for this product's repo.
 *
 * R5-03: the scope is the repo coordinates, not the product slug. The slug was never a
 * security boundary here — GitHub scopes a token to `(installation, repositories)` — and
 * passing it made the KV cache entry collide with every other product on the same org-wide
 * installation. `channelWorkflow` asks for the two extra read permissions only when this
 * product actually resolves channels through the Actions API.
 */
async function token(
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

/** Resolve a version/channel selector to a concrete release. */
async function resolveSelector(
  env: Env,
  cfg: ResolvedConfig,
  selector: string | undefined,
  now: number,
  fetchImpl: FetchImpl,
): Promise<{ release: Release; sel: ChannelSelector }> {
  const manual = parseManualChannels(cfg.manual_channels_json);
  const sel = classifyChannel(selector, manual);
  if (!sel) throw new NotFoundError(`unknown selector: ${selector}`);
  const tok = await token(env, cfg, now, fetchImpl);

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

  const releases = await listReleases(
    tok,
    cfg.gh_owner,
    cfg.gh_repo,
    100,
    fetchImpl,
  );
  const channelTags = await channelTagsFor(env, cfg, sel, now, fetchImpl);
  const release = resolveChannel(sel, releases, channelTags);
  if (!release) throw new NotFoundError(`no release for selector: ${selector}`);
  return { release, sel };
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
  const tok = await token(env, cfg, now, fetchImpl);
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
function channelSuffix(sel: ChannelSelector): string | undefined {
  if (sel.kind === "stable") return undefined;
  if (sel.kind === "pr") return sel.raw; // pr-<n>
  return sel.raw; // beta / manual name
}

function cacheHeader(sel: ChannelSelector): string {
  return isMovingSelector(sel) ? MOVING_CACHE : PINNED_CACHE;
}

// ── Surfaces ─────────────────────────────────────────────────────────────────

function handleInstall(
  cfg: ReleaseConfigRow,
  product: Product,
  origin: string,
): Response {
  const binaryName = cfg.binary_name ?? product.slug;
  const ctx: InstallContext = {
    origin,
    cliBase: `/${product.slug}/cli`,
    binaryName,
    channels: ["staging", "beta"],
    versionEnv: `${binaryName.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_VERSION`,
  };
  // Null means a field (repo-owned `binary_name`, or the request-derived origin) fell outside
  // the installer's safe character classes. Serving a script we cannot prove safe is how
  // R6-01 reached end users, so fail closed instead.
  const body = renderInstallScript(cfg.install_template, ctx);
  if (body === null) return notFound();
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/x-shellscript; charset=utf-8",
      "cache-control": "public, max-age=300",
    },
  });
}

async function handleVersion(
  env: Env,
  db: Db,
  cfg: ReleaseConfigRow,
  product: Product,
  params: ReleaseParams,
  now: number,
  fetchImpl: FetchImpl,
): Promise<Response> {
  if (!isResolved(cfg)) return notFound();
  const { release, sel } = await resolveSelector(
    env,
    cfg,
    params.version ?? params.channel,
    now,
    fetchImpl,
  );
  return json(
    {
      version: versionFromTag(release.tag_name),
      tag: release.tag_name,
      url: release.html_url,
    },
    { headers: { "cache-control": cacheHeader(sel) } },
  );
}

async function handleChangelog(
  env: Env,
  db: Db,
  cfg: ReleaseConfigRow,
  product: Product,
  now: number,
  fetchImpl: FetchImpl,
): Promise<Response> {
  if (!isResolved(cfg)) return notFound();
  const tok = await token(env, cfg, now, fetchImpl);
  const releases = await listReleases(
    tok,
    cfg.gh_owner,
    cfg.gh_repo,
    50,
    fetchImpl,
  );
  const entries: ChangelogEntry[] = releases
    .filter((r) => !r.draft)
    .map((r) => ({
      version: versionFromTag(r.tag_name),
      tag: r.tag_name,
      date: r.published_at,
      summary: extractSummary(r.body, cfg.summary_marker),
      url: r.html_url,
    }));
  return json(
    { entries },
    { headers: { "cache-control": "public, max-age=300" } },
  );
}

async function handleBinary(
  env: Env,
  db: Db,
  cfg: ReleaseConfigRow,
  product: Product,
  params: ReleaseParams,
  kind: "cli" | "dmg",
  req: Request,
  now: number,
  origin: string,
  fetchImpl: FetchImpl,
): Promise<Response> {
  if (!isResolved(cfg)) return notFound();
  // The router accepts `aarch64` / `amd64` aliases; canonicalise them here so the arch
  // never reaches `ARCH_TOKENS[…]` as an unknown key (which used to be an unhandled
  // TypeError -> 500 on a public, unauthenticated route). R6-08.
  const arch = normalizeArch(params.arch);
  if (!arch) return notFound();
  const binaryName = cfg.binary_name ?? product.slug;
  const { release, sel } = await resolveSelector(
    env,
    cfg,
    params.version ?? params.channel,
    now,
    fetchImpl,
  );

  const suffix = channelSuffix(sel);
  const asset =
    kind === "cli"
      ? findBinaryAsset(release.assets, binaryName, arch, suffix)
      : matchAsset(release.assets, {
          arch,
          ext: "dmg",
          binaryName,
          channelSuffix: suffix,
        });
  if (!asset) return notFound();

  const tok = await token(env, cfg, now, fetchImpl);

  // `?checksum=sha256` serves the artifact's published `<asset>.sha256` sidecar so the
  // installer can verify what it downloaded (R6-02). No sidecar -> 404, and the script
  // refuses to install rather than proceeding unverified.
  if (new URL(req.url).searchParams.get("checksum") === "sha256") {
    return handleChecksum(tok, cfg, release, asset.name, sel, fetchImpl);
  }

  const res = await streamAsset(
    tok,
    cfg.gh_owner,
    cfg.gh_repo,
    asset.id,
    req,
    {
      filename: asset.name,
      // Never the repo-chosen upstream `content_type` (R6-04).
      contentType:
        kind === "dmg"
          ? "application/x-apple-diskimage"
          : ARTIFACT_CONTENT_TYPE,
    },
    fetchImpl,
  );
  // Preserve streamed headers; add our cache policy.
  const headers = new Headers(res.headers);
  if (!headers.has("cache-control"))
    headers.set("cache-control", cacheHeader(sel));
  return new Response(res.body, { status: res.status, headers });
}

/** Serve the `<asset>.sha256` sidecar as a bare lowercase hex digest. */
async function handleChecksum(
  tok: string,
  cfg: ResolvedConfig,
  release: Release,
  assetName: string,
  sel: ChannelSelector,
  fetchImpl: FetchImpl,
): Promise<Response> {
  const sidecar = release.assets.find((a) => a.name === `${assetName}.sha256`);
  if (!sidecar) return notFound();
  const text = await fetchTextAsset(
    tok,
    cfg.gh_owner,
    cfg.gh_repo,
    sidecar.id,
    fetchImpl,
  );
  // `shasum`-style sidecars are `<digest>  <filename>`; take the digest and nothing else so
  // no repo-controlled bytes reach the installer.
  const digest = text.trim().split(/\s+/)[0] ?? "";
  if (!/^[0-9a-f]{64}$/i.test(digest)) return notFound();
  return new Response(`${digest.toLowerCase()}\n`, {
    status: 200,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": cacheHeader(sel),
      "x-content-type-options": "nosniff",
    },
  });
}

async function handleAppcast(
  env: Env,
  db: Db,
  cfg: ReleaseConfigRow,
  product: Product,
  params: ReleaseParams,
  origin: string,
  now: number,
  fetchImpl: FetchImpl,
): Promise<Response> {
  if (!isResolved(cfg)) return notFound();
  const binaryName = cfg.binary_name ?? product.slug;
  const selectorStr = params.channel ?? params.version ?? "stable";
  const { release, sel } = await resolveSelector(
    env,
    cfg,
    selectorStr,
    now,
    fetchImpl,
  );

  const suffix = channelSuffix(sel);
  // Pick the arm64 DMG as the primary enclosure (Sparkle feeds are per-arch; arm64 is
  // the default mac arch and the convention here).
  const dmg = matchAsset(release.assets, {
    arch: "arm64",
    ext: "dmg",
    binaryName,
    channelSuffix: suffix,
  });
  if (!dmg) return notFound();

  // The EdDSA signature lives in a sibling `<dmg>.sig` asset uploaded by the pipeline.
  // Signed Sparkle appcasts are required by default; only an operator (never a `.pkey/`
  // push) can opt a product out. R6-03.
  const policy = artifactPolicy(cfg);
  if (policy.requireSparkleSignature && !cfg.sparkle_ed25519_pub) {
    return notFound();
  }
  const tok = await token(env, cfg, now, fetchImpl);
  const sig = release.assets.find((a) => a.name === sigAssetName(dmg.name));
  if (!sig && (cfg.sparkle_ed25519_pub || policy.requireSparkleSignature)) {
    return notFound();
  }
  let edSignature: string | undefined;
  if (sig) {
    const claimed = (
      await fetchTextAsset(tok, cfg.gh_owner, cfg.gh_repo, sig.id, fetchImpl)
    ).trim();
    // The sidecar is repo-controlled. Verify it against the configured public key over the
    // DMG's own bytes before it goes anywhere near the feed — the pubkey used to be a mere
    // presence flag, so any string in the `.sig` shipped as `sparkle:edSignature`.
    const verified = cfg.sparkle_ed25519_pub
      ? await verifySparkleSignature(env, product.slug, {
          token: tok,
          owner: cfg.gh_owner,
          repo: cfg.gh_repo,
          assetId: dmg.id,
          signature: claimed,
          publicKey: cfg.sparkle_ed25519_pub,
          fetchImpl,
        })
      : false;
    // Fail closed: the item is dropped and the feed 404s rather than shipping an
    // unverifiable enclosure. No log line — the worker deliberately carries no logging
    // sink, so the 404 (and the release health check) is the signal.
    if (!verified) return notFound();
    edSignature = claimed;
  }

  // Stable feeds (latest/stable/pinned) point the enclosure at the concrete version so
  // the DMG URL is immutable; moving channels point at their channel segment.
  const segment =
    sel.kind === "stable" ? versionFromTag(release.tag_name) : selectorStr;
  const enclosureUrl = `${origin}/${product.slug}/dmg/${segment}/${dmg.name}`;
  const channelTitle =
    sel.kind === "stable" ? binaryName : `${binaryName} (${sel.raw})`;
  const item = buildAppcastItem(release, dmg, edSignature, enclosureUrl, {
    title: `${binaryName} ${versionFromTag(release.tag_name)}`,
  });
  const xml = renderAppcast({ channelTitle, link: origin, items: [item] });

  return new Response(xml, {
    status: 200,
    headers: {
      "content-type": "application/xml; charset=utf-8",
      "cache-control": APPCAST_CACHE,
    },
  });
}
