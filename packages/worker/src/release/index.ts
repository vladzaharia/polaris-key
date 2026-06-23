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
import { json, notFound } from "../http.js";
import { type FetchImpl, getInstallationToken } from "./githubApp.js";
import {
  type Release,
  findAsset,
  fetchTextAsset,
  listReleases,
  NotFoundError,
  resolveRelease,
  streamAsset,
} from "./github.js";
import {
  type ChannelSelector,
  classifyChannel,
  isMovingSelector,
  parseManualChannels,
  resolveChannel,
} from "./channels.js";
import { type Arch, findBinaryAsset, matchAsset } from "./assets.js";
import { type ChangelogEntry, extractSummary } from "./changelog.js";
import { buildAppcastItem, renderAppcast, sigAssetName, versionFromTag } from "./appcast.js";
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
}

const MOVING_CACHE = "public, max-age=120";
const PINNED_CACHE = "public, max-age=86400, immutable";
const APPCAST_CACHE = "public, max-age=300";

export async function getReleaseConfig(db: Db, product: string): Promise<ReleaseConfigRow | null> {
  return db.first<ReleaseConfigRow>("SELECT * FROM release_config WHERE product = ?", product);
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
  if (!cfg) return notFound();

  const now = Math.floor(Date.now() / 1000);
  const origin = new URL(req.url).origin;

  try {
    switch (kind) {
      case "install":
        return handleInstall(cfg, product, origin);
      case "version":
        return handleVersion(env, db, cfg, product, params, now, fetchImpl);
      case "changelog":
        return handleChangelog(env, db, cfg, product, now, fetchImpl);
      case "cli":
        return handleBinary(env, db, cfg, product, params, "cli", req, now, origin, fetchImpl);
      case "dmg":
        return handleBinary(env, db, cfg, product, params, "dmg", req, now, origin, fetchImpl);
      case "appcast":
        return handleAppcast(env, db, cfg, product, { ...params, channel: "stable" }, origin, now, fetchImpl);
      case "channelAppcast":
        return handleAppcast(env, db, cfg, product, params, origin, now, fetchImpl);
      default:
        return notFound();
    }
  } catch (err) {
    if (err instanceof NotFoundError) return notFound();
    throw err;
  }
}

async function token(env: Env, cfg: ResolvedConfig, product: string, now: number, fetchImpl: FetchImpl): Promise<string> {
  return getInstallationToken(env, product, cfg.gh_installation_id, now, fetchImpl);
}

/** Resolve a version/channel selector to a concrete release. */
async function resolveSelector(
  env: Env,
  cfg: ResolvedConfig,
  product: string,
  selector: string | undefined,
  now: number,
  fetchImpl: FetchImpl,
): Promise<{ release: Release; sel: ChannelSelector }> {
  const manual = parseManualChannels(cfg.manual_channels_json);
  const sel = classifyChannel(selector, manual);
  if (!sel) throw new NotFoundError(`unknown selector: ${selector}`);
  const tok = await token(env, cfg, product, now, fetchImpl);

  // A pinned stable tag can be resolved directly; moving selectors scan the release list.
  if (sel.kind === "stable" && sel.raw !== "latest" && sel.raw !== "stable") {
    const release = await resolveRelease(tok, cfg.gh_owner, cfg.gh_repo, sel.raw, fetchImpl);
    return { release, sel };
  }

  const releases = await listReleases(tok, cfg.gh_owner, cfg.gh_repo, 100, fetchImpl);
  const channelTags = await channelTagsFor(env, cfg, product, sel, now, fetchImpl);
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
  product: string,
  sel: ChannelSelector,
  now: number,
  fetchImpl: FetchImpl,
): Promise<Set<string> | undefined> {
  if (sel.kind !== "beta" && sel.kind !== "pr") return undefined;
  if (!cfg.channel_workflow) return undefined;
  const tok = await token(env, cfg, product, now, fetchImpl);
  const base = `https://api.github.com/repos/${cfg.gh_owner}/${cfg.gh_repo}`;
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${tok}`,
    "User-Agent": "polaris-key-release",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  let runsUrl: string;
  if (sel.kind === "beta") {
    runsUrl = `${base}/actions/workflows/${cfg.channel_workflow}/runs?branch=${encodeURIComponent(cfg.beta_branch)}&status=success&per_page=10`;
  } else {
    const prRes = await fetchImpl(`${base}/pulls/${sel.pr}`, { headers });
    if (!prRes.ok) throw new NotFoundError(`pr lookup failed: ${prRes.status}`);
    const pr = (await prRes.json()) as { head: { sha: string } };
    runsUrl = `${base}/actions/workflows/${cfg.channel_workflow}/runs?event=pull_request&head_sha=${pr.head.sha}&status=success&per_page=10`;
  }

  const res = await fetchImpl(runsUrl, { headers });
  if (!res.ok) throw new NotFoundError(`channel runs lookup failed: ${res.status}`);
  const data = (await res.json()) as { workflow_runs: Array<{ head_branch: string | null; head_sha: string }> };
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

function handleInstall(cfg: ReleaseConfigRow, product: Product, origin: string): Response {
  const binaryName = cfg.binary_name ?? product.slug;
  const ctx: InstallContext = {
    origin,
    cliBase: `/${product.slug}/cli`,
    binaryName,
    channels: ["staging", "beta"],
    versionEnv: `${binaryName.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_VERSION`,
  };
  const body = renderInstallScript(cfg.install_template, ctx);
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/x-shellscript; charset=utf-8", "cache-control": "public, max-age=300" },
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
  const { release, sel } = await resolveSelector(env, cfg, product.slug, params.version ?? params.channel, now, fetchImpl);
  return json(
    { version: versionFromTag(release.tag_name), tag: release.tag_name, url: release.html_url },
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
  const tok = await token(env, cfg, product.slug, now, fetchImpl);
  const releases = await listReleases(tok, cfg.gh_owner, cfg.gh_repo, 50, fetchImpl);
  const entries: ChangelogEntry[] = releases
    .filter((r) => !r.draft)
    .map((r) => ({
      version: versionFromTag(r.tag_name),
      tag: r.tag_name,
      date: r.published_at,
      summary: extractSummary(r.body, cfg.summary_marker),
      url: r.html_url,
    }));
  return json({ entries }, { headers: { "cache-control": "public, max-age=300" } });
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
  const arch = params.arch;
  if (!arch) return notFound();
  const binaryName = cfg.binary_name ?? product.slug;
  const { release, sel } = await resolveSelector(env, cfg, product.slug, params.version ?? params.channel, now, fetchImpl);

  const suffix = channelSuffix(sel);
  const asset =
    kind === "cli"
      ? findBinaryAsset(release.assets, binaryName, arch, suffix)
      : matchAsset(release.assets, { arch, ext: "dmg", binaryName, channelSuffix: suffix });
  if (!asset) return notFound();

  const tok = await token(env, cfg, product.slug, now, fetchImpl);
  const res = await streamAsset(tok, cfg.gh_owner, cfg.gh_repo, asset.id, req, fetchImpl);
  // Preserve streamed headers; add our cache policy.
  const headers = new Headers(res.headers);
  if (!headers.has("cache-control")) headers.set("cache-control", cacheHeader(sel));
  return new Response(res.body, { status: res.status, headers });
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
  const { release, sel } = await resolveSelector(env, cfg, product.slug, selectorStr, now, fetchImpl);

  const suffix = channelSuffix(sel);
  // Pick the arm64 DMG as the primary enclosure (Sparkle feeds are per-arch; arm64 is
  // the default mac arch and the convention here).
  const dmg = matchAsset(release.assets, { arch: "arm64", ext: "dmg", binaryName, channelSuffix: suffix });
  if (!dmg) return notFound();

  // The EdDSA signature lives in a sibling `<dmg>.sig` asset uploaded by the pipeline.
  const sig = findAsset(release, sigAssetName(dmg.name));
  const tok = await token(env, cfg, product.slug, now, fetchImpl);
  const edSignature = (await fetchTextAsset(tok, cfg.gh_owner, cfg.gh_repo, sig.id, fetchImpl)).trim();

  // Stable feeds (latest/stable/pinned) point the enclosure at the concrete version so
  // the DMG URL is immutable; moving channels point at their channel segment.
  const segment =
    sel.kind === "stable" ? versionFromTag(release.tag_name) : selectorStr;
  const enclosureUrl = `${origin}/${product.slug}/dmg/${segment}/${dmg.name}`;
  const channelTitle = sel.kind === "stable" ? binaryName : `${binaryName} (${sel.raw})`;
  const item = buildAppcastItem(release, dmg, edSignature, enclosureUrl, {
    title: `${binaryName} ${versionFromTag(release.tag_name)}`,
  });
  const xml = renderAppcast({ channelTitle, link: origin, items: [item] });

  return new Response(xml, {
    status: 200,
    headers: { "content-type": "application/xml; charset=utf-8", "cache-control": APPCAST_CACHE },
  });
}
