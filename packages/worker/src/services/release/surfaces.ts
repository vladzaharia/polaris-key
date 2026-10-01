/// <reference types="@cloudflare/workers-types" />

/**
 * Release's own three surfaces: the installer, the changelog, and artifact download.
 *
 * `/<p>/release/dl/:version/:binary-:arch[.dmg]` replaces the old `/<p>/cli/…` and `/<p>/dmg/…`
 * pair (§R1). They were always the same handler with two content types and two asset matchers;
 * one path with the extension carrying the distinction is what they already meant. The old paths
 * are removed, not aliased — an alias for a route nobody has published (the DMG URL only ever
 * appeared inside a generated appcast, which this release regenerates) buys nothing and would
 * keep two spellings of one thing alive forever.
 */

import type { Env, Db } from "../../core/platform.js";
import type { ProductPublic } from "../../core/products.js";
import { json, notFound } from "../../core/errors.js";
import type { FetchImpl } from "./githubApp.js";
import {
  type Release,
  fetchTextAsset,
  listReleases,
  streamAsset,
} from "./github.js";
import { findBinaryAsset, matchAsset, normalizeArch } from "./assets.js";
import { type ChangelogEntry, extractSummary } from "./changelog.js";
import { type InstallContext, renderInstallScript } from "./install.js";
import { type ChannelSelector, versionFromTag } from "./channels.js";
import {
  isResolved,
  type ReleaseConfigRow,
  type ReleaseKind,
  type ResolvedConfig,
} from "./config.js";
import {
  ARTIFACT_CONTENT_TYPE,
  cacheHeader,
  channelSuffix,
  installationToken,
  resolveSelector,
  serveReleaseSurface,
  type ReleaseParams,
  type SurfaceContext,
} from "./gateway.js";
import {
  dropCachedSignedUrl,
  getCachedSignedUrl,
  putCachedSignedUrl,
} from "./ghCache.js";

/** The surfaces this service serves. Update owns the other three. */
export type ReleaseSurfaceKind = "install" | "changelog" | "cli" | "dmg";

/**
 * Serve a Release surface. The public entry point for the descriptor's router — and for the
 * suites that drive these handlers directly.
 */
export function handleRelease(
  req: Request,
  env: Env,
  db: Db,
  product: ProductPublic,
  kind: ReleaseSurfaceKind,
  params: ReleaseParams,
  fetchImpl: FetchImpl = fetch,
): Promise<Response> {
  return serveReleaseSurface(
    req,
    env,
    db,
    product,
    kind as ReleaseKind,
    params,
    fetchImpl,
    (ctx) => computeRelease(kind, ctx),
  );
}

function computeRelease(
  kind: ReleaseSurfaceKind,
  ctx: SurfaceContext,
): Promise<Response> {
  switch (kind) {
    case "install":
      return Promise.resolve(handleInstall(ctx));
    case "changelog":
      return handleChangelog(ctx);
    case "cli":
    case "dmg":
      return handleBinary(kind, ctx);
  }
}

function handleInstall({ cfg, product, origin }: SurfaceContext): Response {
  const binaryName = cfg.binary_name ?? product.slug;
  const ctx: InstallContext = {
    origin,
    cliBase: `/${product.slug}/release/dl`,
    installPath: `/${product.slug}/release/install.sh`,
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

async function handleChangelog({
  env,
  cfg,
  now,
  fetchImpl,
}: SurfaceContext): Promise<Response> {
  if (!isResolved(cfg)) return notFound();
  const tok = await installationToken(env, cfg, now, fetchImpl);
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
  kind: "cli" | "dmg",
  { req, env, db, cfg, product, params, now, fetchImpl }: SurfaceContext,
): Promise<Response> {
  if (!isResolved(cfg)) return notFound();
  // The download path accepts `aarch64` / `amd64` aliases; canonicalise them here so the arch
  // never reaches `ARCH_TOKENS[…]` as an unknown key (which used to be an unhandled
  // TypeError -> 500 on a public, unauthenticated route). R6-08.
  const arch = normalizeArch(params.arch);
  if (!arch) return notFound();
  const binaryName = cfg.binary_name ?? product.slug;
  const { release, sel } = await resolveSelector(
    env,
    db,
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

  // `?checksum=sha256` serves the artifact's published `<asset>.sha256` sidecar so the
  // installer can verify what it downloaded (R6-02). No sidecar -> 404, and the script
  // refuses to install rather than proceeding unverified.
  if (new URL(req.url).searchParams.get("checksum") === "sha256") {
    const tok = await installationToken(env, cfg, now, fetchImpl);
    return handleChecksum(tok, cfg, release, asset.name, sel, fetchImpl);
  }

  // The token is minted lazily and the signed storage URL is cached (P2-05, `ghCache.ts`), so
  // a `Range` chunk after the first request costs no GitHub API call.
  const repo = `${cfg.gh_owner}/${cfg.gh_repo}`;
  const res = await streamAsset(
    () => installationToken(env, cfg, now, fetchImpl),
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
    {
      get: () => getCachedSignedUrl(env, product.slug, repo, asset.id, now),
      put: (u) => putCachedSignedUrl(env, product.slug, repo, asset.id, u, now),
      drop: () => dropCachedSignedUrl(env, product.slug, repo, asset.id),
    },
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

export type { ReleaseConfigRow };
