/// <reference types="@cloudflare/workers-types" />

/**
 * The bytes only Release can reach, and the installer only Release can render (P2b-04).
 *
 * Distribution serves every byte now (README §3.5: "Release writes records; distribution serves
 * bytes"), but it holds no GitHub token and may not import this service (AGENTS rule 6). So the
 * GitHub-located half of a download stays here, behind the `releaseCatalog` hook's `openSource`,
 * and the installer behind `installScript`:
 *
 *   - `github`: one artifact's GitHub location, streamed with this product's installation token
 *     and `streamAsset`'s SSRF guard (the storage redirect is followed only to an allowlisted
 *     host, with the Authorization header dropped), the signed storage URL cached so a `Range`
 *     chunk costs no API call; or, opt-in, a 302 to GitHub's own `browser_download_url` for a
 *     PUBLIC repository (never the signed storage URL, which for a private repository would be a
 *     bearer credential). This is P2-05's `serveArtifact` GitHub branch, unchanged.
 *   - `dl`: the legacy `/dl/<selector>/<binary>-<arch>[.dmg]` route, which resolves the selector
 *     LIVE against GitHub (`resolveSelector`, with the channel policy applied) and matches the
 *     asset by name; `?checksum=sha256` serves the published `.sha256` sidecar. When the matched
 *     asset's GitHub `digest` names a copy this product holds (HA-08's mirror, `mirror.ts`), that
 *     copy is served from R2 instead of streaming the asset from GitHub: the same bytes, hash for
 *     hash, under the route's own type and cache policy (`mirroredDownload`).
 *
 * Release maps its own upstream failures here, so no Release error type crosses the hook: a
 * withdrawn release or asset is "not at this location" (`null`, or a 404 for `dl`) and an
 * exhausted GitHub quota is the same 503 + `Retry-After` the gateway has always answered. The
 * caller hardens the answer, exactly as the gateway's `runSurface` did.
 */

import { isAllowedStorageHost } from "../../core/platform.js";
import type { Db, Env } from "../../core/platform.js";
import type { ProductPublic } from "../../core/products.js";
import type { CatalogLocation, CatalogSourceRef } from "../../core/hooks.js";
import { notFound } from "../../core/errors.js";
import {
  blobKey,
  blobResponse,
  BYTES_HOST_TYPES,
  hasRef,
} from "../../core/blobs.js";
import { isBytesHost } from "../../core/bytesHost.js";
import { getReleaseConfig, isResolved, type ResolvedConfig } from "./config.js";
import {
  ARTIFACT_CONTENT_TYPE,
  cacheHeader,
  channelSuffix,
  installationToken,
  resolveSelector,
  upstreamUnavailable,
} from "./gateway.js";
import type { FetchImpl } from "./githubApp.js";
import {
  assetSha256,
  fetchTextAsset,
  NotFoundError,
  streamAsset,
  UpstreamRateLimitedError,
  type Release,
  type ReleaseAsset,
} from "./github.js";
import { releaseMirrorEnabled } from "./mirrorSwitch.js";
import {
  dropCachedSignedUrl,
  getCachedSignedUrl,
  isPublicRepository,
  putCachedSignedUrl,
} from "./ghCache.js";
import { findBinaryAsset, matchAsset, normalizeArch } from "./assets.js";
import { type InstallContext, renderInstallScript } from "./install.js";
import type { ChannelSelector } from "./channels.js";
import type { ReleaseArtifactRow } from "./store.js";

// ── Locations ────────────────────────────────────────────────────────────────────────────────

/**
 * `locations_json`, tolerantly; a legacy row with no locations is its GitHub asset (the sync keys
 * artifacts by GitHub asset id). Unknown providers are dropped. No order is applied here: the
 * byte route ranks them (R2, GitHub, external).
 */
export function parseLocations(
  a: Pick<ReleaseArtifactRow, "locations_json" | "artifact_id">,
): CatalogLocation[] {
  if (a.locations_json) {
    try {
      const parsed: unknown = JSON.parse(a.locations_json);
      if (Array.isArray(parsed)) {
        const out: CatalogLocation[] = [];
        for (const raw of parsed) {
          if (!raw || typeof raw !== "object") continue;
          const l = raw as Record<string, unknown>;
          if (
            l.provider === "r2" ||
            l.provider === "github" ||
            l.provider === "external" ||
            l.provider === "store"
          ) {
            out.push({
              provider: l.provider,
              ...(typeof l.key === "string" ? { key: l.key } : {}),
              ...(typeof l.asset === "number" || typeof l.asset === "string"
                ? { asset: l.asset }
                : {}),
              ...(typeof l.url === "string" ? { url: l.url } : {}),
            });
          }
        }
        return out;
      }
    } catch {
      /* fall through to the legacy reading */
    }
  }
  return /^\d+$/.test(a.artifact_id) ? [{ provider: "github" }] : [];
}

/** The GitHub asset id a github location names: its `asset` (an id, or a file name in the
 *  release), else the row's own id (the sync keys artifacts by GitHub asset id). */
export async function githubAssetId(
  db: Db,
  a: ReleaseArtifactRow,
  asset: number | string | undefined,
): Promise<number | null> {
  if (typeof asset === "number")
    return Number.isSafeInteger(asset) ? asset : null;
  if (typeof asset === "string" && asset !== a.name) {
    const row = await db.first<{ artifact_id: string }>(
      `SELECT artifact_id FROM release_artifacts
        WHERE product = ? AND release_id = ? AND name = ?`,
      a.product,
      a.release_id,
      asset,
    );
    return row && /^\d+$/.test(row.artifact_id)
      ? Number(row.artifact_id)
      : null;
  }
  return /^\d+$/.test(a.artifact_id) ? Number(a.artifact_id) : null;
}

/** The type a GitHub-streamed artifact is served as: the gateway's own choice (R6-04). On the
 *  console host only the two types the legacy route ever served; on the bytes host anything on
 *  the inert allowlist. Never the repo-chosen upstream type. */
function streamedType(a: ReleaseArtifactRow, onBytesHost: boolean): string {
  const t = (a.content_type ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (onBytesHost)
    return BYTES_HOST_TYPES.has(t) ? t : "application/octet-stream";
  return t === "application/x-apple-diskimage" ? t : "application/octet-stream";
}

/** A body-less copy for HEAD, cancelling whatever upstream started sending. */
async function headOnly(req: Request, res: Response): Promise<Response> {
  if (req.method !== "HEAD" || res.body === null) return res;
  await res.body.cancel().catch(() => undefined);
  return new Response(null, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
}

// ── openSource ───────────────────────────────────────────────────────────────────────────────

export interface SourceContext {
  env: Env;
  db: Db;
  product: ProductPublic;
  now: number;
}

/**
 * The `releaseCatalog.openSource` implementation. `fetchImpl` defaults to the platform `fetch`
 * at call time (the suites swap the global around a dispatch).
 */
export async function openSource(
  ctx: SourceContext,
  ref: CatalogSourceRef,
  req: Request,
  fetchImpl: FetchImpl = fetch,
): Promise<Response | null> {
  const cfg = await getReleaseConfig(ctx.db, ctx.product.slug);
  if (ref.kind === "dl") {
    if (!cfg || !isResolved(cfg)) return notFound();
    try {
      return await serveLegacyDownload(ctx, cfg, ref, req, fetchImpl);
    } catch (err) {
      if (err instanceof UpstreamRateLimitedError)
        return upstreamUnavailable(err);
      if (err instanceof NotFoundError) return notFound();
      throw err;
    }
  }
  if (!cfg || !isResolved(cfg)) return null;
  try {
    return await serveGithubLocation(ctx, cfg, ref, req, fetchImpl);
  } catch (err) {
    // Not at this location: the caller tries its next one. Quota exhaustion is not "absent".
    if (err instanceof NotFoundError) return null;
    if (err instanceof UpstreamRateLimitedError)
      return upstreamUnavailable(err);
    throw err;
  }
}

/**
 * The `releaseCatalog.repositoryPublic` implementation: is the configured repository public, so
 * that a browser can follow an artifact's stored GitHub download URL? Every failure is `false`
 * (`isPublicRepository`), which keeps a private repository's URLs away from browsers.
 */
export async function repositoryPublic(
  ctx: SourceContext,
  fetchImpl: FetchImpl = fetch,
): Promise<boolean> {
  const cfg = await getReleaseConfig(ctx.db, ctx.product.slug);
  if (!cfg || !isResolved(cfg)) return false;
  return isPublicRepository(
    ctx.env,
    ctx.product.slug,
    cfg.gh_owner,
    cfg.gh_repo,
    () => installationToken(ctx.env, cfg, ctx.now, fetchImpl),
    fetchImpl,
  );
}

async function serveGithubLocation(
  { env, db, product, now }: SourceContext,
  cfg: ResolvedConfig,
  ref: Extract<CatalogSourceRef, { kind: "github" }>,
  req: Request,
  fetchImpl: FetchImpl,
): Promise<Response | null> {
  // Re-read from the store, never taken from the caller: the name, type and `source_url` that
  // reach a header or a redirect are Release's own values.
  const artifact = await db.first<ReleaseArtifactRow>(
    `SELECT * FROM release_artifacts
      WHERE product = ? AND release_id = ? AND artifact_id = ?`,
    product.slug,
    ref.releaseId,
    ref.artifactId,
  );
  if (!artifact) return null;
  const assetId = await githubAssetId(db, artifact, ref.asset);
  if (assetId === null) return null;
  const token = () => installationToken(env, cfg, now, fetchImpl);

  // Opt-in redirect, PUBLIC repositories only (the caller asks only for a public deliverable):
  // a 302 to GitHub's own stable download URL, never the signed storage URL.
  if (
    ref.redirect &&
    artifact.source_url &&
    isAllowedStorageHost(new URL(artifact.source_url).hostname) &&
    (await isPublicRepository(
      env,
      product.slug,
      cfg.gh_owner,
      cfg.gh_repo,
      token,
      fetchImpl,
    ))
  ) {
    return new Response(null, {
      status: 302,
      headers: { location: artifact.source_url },
    });
  }

  const repo = `${cfg.gh_owner}/${cfg.gh_repo}`;
  const res = await streamAsset(
    token,
    cfg.gh_owner,
    cfg.gh_repo,
    assetId,
    req,
    {
      filename: artifact.name,
      contentType: streamedType(artifact, isBytesHost(new URL(req.url), env)),
    },
    fetchImpl,
    {
      get: () => getCachedSignedUrl(env, product.slug, repo, assetId, now),
      put: (u) => putCachedSignedUrl(env, product.slug, repo, assetId, u, now),
      drop: () => dropCachedSignedUrl(env, product.slug, repo, assetId),
    },
  );
  return headOnly(req, res);
}

/** The legacy download: resolve the selector live, match the asset by name, stream it. */
async function serveLegacyDownload(
  { env, db, product, now }: SourceContext,
  cfg: ResolvedConfig,
  ref: Extract<CatalogSourceRef, { kind: "dl" }>,
  req: Request,
  fetchImpl: FetchImpl,
): Promise<Response> {
  // The download path accepts `aarch64` / `amd64` aliases; canonicalise them here so the arch
  // never reaches `ARCH_TOKENS[…]` as an unknown key (which used to be an unhandled
  // TypeError -> 500 on a public, unauthenticated route). R6-08.
  const arch = normalizeArch(ref.arch);
  if (!arch) return notFound();
  const binaryName = cfg.binary_name ?? product.slug;
  const { release, sel } = await resolveSelector(
    env,
    db,
    cfg,
    ref.selector,
    now,
    fetchImpl,
  );

  const suffix = channelSuffix(sel);
  const asset =
    ref.format === "cli"
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
  if (ref.checksum) {
    const tok = await installationToken(env, cfg, now, fetchImpl);
    return checksumSidecar(tok, cfg, release, asset.name, sel, fetchImpl);
  }

  // Never the repo-chosen upstream `content_type` (R6-04).
  const contentType =
    ref.format === "dmg"
      ? "application/x-apple-diskimage"
      : ARTIFACT_CONTENT_TYPE;

  // HA-08 (S-20 §6.8): the asset's own digest names a copy this product holds: serve that.
  const mirrored = await mirroredDownload(
    env,
    db,
    product.slug,
    asset,
    req,
    contentType,
    cacheHeader(sel),
  );
  if (mirrored) return mirrored;

  // The token is minted lazily and the signed storage URL is cached (P2-05, `ghCache.ts`), so
  // a `Range` chunk after the first request costs no GitHub API call.
  const repo = `${cfg.gh_owner}/${cfg.gh_repo}`;
  const res = await streamAsset(
    () => installationToken(env, cfg, now, fetchImpl),
    cfg.gh_owner,
    cfg.gh_repo,
    asset.id,
    req,
    { filename: asset.name, contentType },
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

/**
 * The legacy download from Polaris Key's own copy (HA-08): when the matched asset carries a
 * GitHub `digest` and this product holds a ref to `blobs/sha256/<digest>` (a mirrored copy, or
 * the same bytes published to R2), the copy is served through `blobResponse`, which checks R2's
 * stored checksum against the digest and answers Range, If-Range and If-None-Match. The route
 * keeps its own type and cache policy (a moving selector is not immutable). `null` when there is
 * no such copy, mirroring is off, or the object is missing: the caller streams from GitHub, as
 * before. The digest is GitHub's own hash of the bytes, so the copy is the asset, byte for byte.
 */
async function mirroredDownload(
  env: Env,
  db: Db,
  product: string,
  asset: ReleaseAsset,
  req: Request,
  contentType: string,
  cache: string,
): Promise<Response | null> {
  const digest = assetSha256(asset);
  if (!digest || !env.BLOBS) return null;
  const key = blobKey(digest);
  if (!(await hasRef(db, product, key))) return null;
  if (!(await releaseMirrorEnabled(env, db, product))) return null;
  const res = await blobResponse(req, env.BLOBS, key, {
    sha256: digest,
    gated: false,
    env,
    filename: asset.name,
  });
  if (res.status === 404) {
    await res.body?.cancel().catch(() => undefined);
    return null;
  }
  // 416 keeps `no-store` and carries no type.
  if (res.status === 416) return res;
  const headers = new Headers(res.headers);
  headers.set("cache-control", cache);
  if (headers.has("content-type")) headers.set("content-type", contentType);
  return new Response(res.body, { status: res.status, headers });
}

/** Serve the `<asset>.sha256` sidecar as a bare lowercase hex digest. */
async function checksumSidecar(
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

// ── installScript ────────────────────────────────────────────────────────────────────────────

/**
 * The installer for a product, pointed at `origin`. `null` when there is no release
 * configuration, or when a field (repo-owned `binary_name`, or the request-derived origin) falls
 * outside the installer's safe character classes: serving a script we cannot prove safe is how
 * R6-01 reached end users, so the caller fails closed instead.
 *
 * The download base stays `/<p>/release/dl` — a permanent alias of `/<p>/distribution/dl` — so
 * the script is byte-identical to the one every published `curl … | sh` line already fetches.
 */
export async function installScript(
  db: Db,
  product: ProductPublic,
  origin: string,
): Promise<string | null> {
  const cfg = await getReleaseConfig(db, product.slug);
  if (!cfg) return null;
  const binaryName = cfg.binary_name ?? product.slug;
  const ctx: InstallContext = {
    origin,
    cliBase: `/${product.slug}/release/dl`,
    installPath: `/${product.slug}/release/install.sh`,
    binaryName,
    channels: ["staging", "beta"],
    versionEnv: `${binaryName.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_VERSION`,
  };
  return renderInstallScript(cfg.install_template, ctx);
}
