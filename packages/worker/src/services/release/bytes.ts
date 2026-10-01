/// <reference types="@cloudflare/workers-types" />

/**
 * Release's three byte routes (P2-05, README §3.5):
 *
 *     GET|HEAD /<p>/release/builds/<selector>/<buildId>   the payload of a declared build in
 *              [?deliverable=<id>] [?checksum=sha256]     the release the selector resolves
 *              [?redirect=1]                              to (`resolve.ts`, per platform)
 *     GET|HEAD /<p>/release/files/<releaseId>/<name>      one exact file of one release,
 *              [?redirect=1]                              sidecars included; immutable
 *     GET|HEAD /<p>/release/blobs/sha256/<hash>           a content-addressed object, only if
 *                                                         THIS product references it
 *
 * They answer on the console host through Release's own router (`routes.ts`) and on the bytes
 * host (`dl.plrs.im`) through `RELEASE_BYTE_ROUTES`, which the composition root registers in
 * `mount.ts` `BYTE_ROUTES`. One handler serves both; what differs is decided from the request,
 * not by the caller: `blobResponse` derives the host from `req.url`, and the bytes host's own
 * dispatcher (`core/bytesHost.ts`) adds CORS, the inert-type rule and its hardening headers.
 *
 * ── THE PIPELINE ────────────────────────────────────────────────────────────────────────────
 *
 * Every request goes through the release gateway (`serveReleaseSurface`): the product's release
 * configuration must exist, the `artifacts` access mode is enforced (a pinned selector or a
 * file's release is version-checked under `entitled`, and a version the window cannot order,
 * such as a four-part `1.2.3.4`, is refused whenever the window is bounded: `access.ts`; a
 * file's release is checked by its STORED version as a fixed, pinned version (`fixedVersion`),
 * never re-read as a selector, so a release tagged `latest`, `stable`, `beta`, `pr-5` or a manual
 * channel's name cannot pass as a moving channel; a blob is served under `entitled` only if a
 * release of this product carrying that digest passes the same check, `entitledBlobRefusal`), and
 * the request counts against the ARTIFACT rate-limit lane. Nothing here is put in the edge cache.
 *
 * ── WHERE THE BYTES COME FROM ───────────────────────────────────────────────────────────────
 *
 * An artifact's `locations_json` (P2-04's descriptor) names hash-pinned locations, tried in this
 * order: R2 (`blobResponse`, only for a key this product holds a ref to) → GitHub (`streamAsset`,
 * with the cached signed URL, so a `Range` chunk costs no API call) → an external `https://` URL
 * (302). A legacy artifact with no locations is its GitHub asset. A `store` location carries no
 * bytes and is skipped.
 *
 * Streaming is the default because winget refuses redirects and App Installer and zsync need
 * `Range` (notes/E3 §F). `?redirect=1` is an opt-in for a PUBLIC artifact of a PUBLIC repository
 * only: a 302 to GitHub's own `browser_download_url`, never to a signed storage URL (which, for
 * a private repository, would be a bearer credential).
 */

import { APP_DELIVERABLE_ID } from "@polaris-key/manifest";
import type { Db, Env } from "../../core/platform.js";
import { isAllowedStorageHost } from "../../core/platform.js";
import type { ProductPublic } from "../../core/products.js";
import { notFound } from "../../core/errors.js";
import {
  blobKey,
  blobResponse,
  BYTES_HOST_TYPES,
  hasRef,
  parseKey,
} from "../../core/blobs.js";
import { isBytesHost } from "../../core/bytesHost.js";
import type { ByteRoute, ByteRouteMatch } from "../../core/bytesHost.js";
import {
  accessModeFor,
  artifactPolicy,
  isResolved,
  type ReleaseKind,
} from "./config.js";
import { installationToken, serveReleaseSurface } from "./gateway.js";
import type { SurfaceContext } from "./gateway.js";
import { enforceReleaseAccess, type ReleaseParams } from "./access.js";
import type { FetchImpl } from "./githubApp.js";
import { NotFoundError, streamAsset } from "./github.js";
import {
  dropCachedSignedUrl,
  getCachedSignedUrl,
  isPublicRepository,
  putCachedSignedUrl,
} from "./ghCache.js";
import { listArtifactsForBuild } from "./model.js";
import { isVersionSelector, resolveBuild } from "./resolve.js";
import type { ReleaseArtifactRow, ReleaseMetadataRow } from "./store.js";

// ── Targets ──────────────────────────────────────────────────────────────────────────────────

export type ByteTarget =
  | {
      kind: "build";
      selector: string;
      buildId: string;
    }
  | { kind: "file"; releaseId: string; name: string }
  | { kind: "blob"; sha256: string };

const SHA256_HEX = /^[0-9a-f]{64}$/;
const PRODUCT_SLUG = /^[a-z0-9-]{1,64}$/;

function decode(segment: string): string | null {
  try {
    const v = decodeURIComponent(segment);
    return v.length > 0 && v.length <= 256 ? v : null;
  } catch {
    return null;
  }
}

/**
 * The target named by the segments after `/<p>/release`, or null when they name none. Shared by
 * the console router and the bytes-host matcher so the two can never disagree about a path.
 */
export function byteTargetOf(rest: readonly string[]): ByteTarget | null {
  if (rest.length !== 3) return null;
  const [area, a, b] = rest as [string, string, string];
  if (area === "blobs") {
    return a === "sha256" && SHA256_HEX.test(b)
      ? { kind: "blob", sha256: b }
      : null;
  }
  const first = decode(a);
  const second = decode(b);
  if (!first || !second) return null;
  if (area === "builds")
    return { kind: "build", selector: first, buildId: second };
  if (area === "files") return { kind: "file", releaseId: first, name: second };
  return null;
}

// ── Cache headers ────────────────────────────────────────────────────────────────────────────

/** A moving selector's URL changes content when the channel moves; revalidate soon. */
const MOVING_BYTES_CACHE = "public, max-age=120, no-transform";
/** A file of a release, a pinned version, a blob: the bytes behind the URL never change. */
const FIXED_BYTES_CACHE = "public, max-age=31536000, immutable, no-transform";
/** Anything not public: never stored by a shared cache, never recompressed. */
const PRIVATE_BYTES_CACHE = "private, no-store, no-transform";

function withCache(res: Response, value: string): Response {
  // Errors keep whatever the error builder set (`no-store`).
  if (res.status >= 400) return res;
  const headers = new Headers(res.headers);
  headers.set("cache-control", value);
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

// ── Serving one artifact ─────────────────────────────────────────────────────────────────────

interface Location {
  provider: "r2" | "github" | "external" | "store";
  key?: string;
  asset?: number | string;
  url?: string;
}

/** The README §3.5 location order: R2, then GitHub, then an external URL. */
const LOCATION_RANK: Record<Location["provider"], number> = {
  r2: 0,
  github: 1,
  external: 2,
  store: 3,
};

/** `locations_json` in serving order, tolerantly; a legacy row (no locations) is its GitHub
 *  asset. */
function locationsOf(a: ReleaseArtifactRow): Location[] {
  return parseLocations(a).sort(
    (x, y) => LOCATION_RANK[x.provider] - LOCATION_RANK[y.provider],
  );
}

function parseLocations(a: ReleaseArtifactRow): Location[] {
  if (a.locations_json) {
    try {
      const parsed: unknown = JSON.parse(a.locations_json);
      if (Array.isArray(parsed)) {
        const out: Location[] = [];
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
async function githubAssetId(
  db: Db,
  a: ReleaseArtifactRow,
  loc: Location,
): Promise<number | null> {
  if (typeof loc.asset === "number")
    return Number.isSafeInteger(loc.asset) ? loc.asset : null;
  if (typeof loc.asset === "string" && loc.asset !== a.name) {
    const row = await db.first<{ artifact_id: string }>(
      `SELECT artifact_id FROM release_artifacts
        WHERE product = ? AND release_id = ? AND name = ?`,
      a.product,
      a.release_id,
      loc.asset,
    );
    return row && /^\d+$/.test(row.artifact_id)
      ? Number(row.artifact_id)
      : null;
  }
  return /^\d+$/.test(a.artifact_id) ? Number(a.artifact_id) : null;
}

/** The type a GitHub-streamed artifact is served as: the gateway's own choice (R6-04). On the
 *  console host only the two types the legacy route ever served; on the bytes host anything on
 *  the inert allowlist. */
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

/**
 * Serve one artifact from the first location that has it. `cache` is the Cache-Control the
 * route wants for a success; non-public products always get `PRIVATE_BYTES_CACHE`.
 */
async function serveArtifact(
  ctx: SurfaceContext,
  artifact: ReleaseArtifactRow,
  cache: string,
): Promise<Response> {
  const { req, env, db, cfg, product, now, fetchImpl } = ctx;
  const publicMode = accessModeFor(artifactPolicy(cfg), "file") === "public";
  const effectiveCache = publicMode ? cache : PRIVATE_BYTES_CACHE;
  const url = new URL(req.url);
  const onBytesHost = isBytesHost(url, env);

  for (const loc of locationsOf(artifact)) {
    if (loc.provider === "r2") {
      // Hash-pinned: the key must be the content address of THIS artifact's sha256, and this
      // product must hold a ref to it (a ref is earned per product, THREAT-MODEL §3).
      if (!env.BLOBS || !artifact.sha256 || !loc.key) continue;
      const parsed = parseKey(loc.key);
      // A `gated/` key is entitlement-gated content, authorised PER REQUEST (THREAT-MODEL §3) —
      // and that per-request check (P2b-04 / P4-05) does not exist yet. The product-wide access
      // mode is not it: under a `public` product it would hand gated bytes to anyone. So these
      // routes fail closed on a gated location until that check lands (P2-05 review).
      if (
        !parsed ||
        parsed.area !== "locked" ||
        parsed.kind !== "blob" ||
        parsed.gated ||
        parsed.sha256 !== artifact.sha256
      )
        continue;
      if (!(await hasRef(db, product.slug, loc.key))) continue;
      const res = await blobResponse(req, env.BLOBS, loc.key, {
        sha256: artifact.sha256,
        gated: !publicMode,
        env,
        ...(artifact.content_type
          ? { contentType: artifact.content_type }
          : {}),
        filename: artifact.name,
      });
      if (res.status === 404) {
        await res.body?.cancel().catch(() => undefined);
        continue;
      }
      return withCache(res, effectiveCache);
    }

    if (loc.provider === "github") {
      if (!isResolved(cfg)) continue;
      const assetId = await githubAssetId(db, artifact, loc);
      if (assetId === null) continue;
      const token = () => installationToken(env, cfg, now, fetchImpl);

      // Opt-in redirect, PUBLIC artifacts of PUBLIC repositories only: a 302 to GitHub's own
      // stable download URL (never the signed storage URL).
      if (
        url.searchParams.get("redirect") === "1" &&
        publicMode &&
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
          headers: { location: artifact.source_url, "cache-control": cache },
        });
      }

      const repo = `${cfg.gh_owner}/${cfg.gh_repo}`;
      try {
        const res = await streamAsset(
          token,
          cfg.gh_owner,
          cfg.gh_repo,
          assetId,
          req,
          {
            filename: artifact.name,
            contentType: streamedType(artifact, onBytesHost),
          },
          fetchImpl,
          {
            get: () =>
              getCachedSignedUrl(env, product.slug, repo, assetId, now),
            put: (u) =>
              putCachedSignedUrl(env, product.slug, repo, assetId, u, now),
            drop: () => dropCachedSignedUrl(env, product.slug, repo, assetId),
          },
        );
        return withCache(await headOnly(req, res), effectiveCache);
      } catch (err) {
        // Not at this location: try the next one. Quota exhaustion is not "absent" and
        // propagates to the gateway's 503 mapping.
        if (err instanceof NotFoundError) continue;
        throw err;
      }
    }

    if (loc.provider === "external" && loc.url) {
      let target: URL;
      try {
        target = new URL(loc.url);
      } catch {
        continue;
      }
      if (target.protocol !== "https:") continue;
      return new Response(null, {
        status: 302,
        headers: {
          location: target.toString(),
          "cache-control": effectiveCache,
        },
      });
    }
  }
  return notFound();
}

// ── The three routes ─────────────────────────────────────────────────────────────────────────

/** The digest line `?checksum=sha256` answers with (the legacy route's format). */
function checksumResponse(
  sha256: string,
  onBytesHost: boolean,
  cache: string,
): Response {
  return new Response(`${sha256}\n`, {
    status: 200,
    headers: {
      // The bytes host serves no text type at all (`core/bytesHost.ts`); the console keeps the
      // legacy route's `text/plain`.
      "content-type": onBytesHost
        ? "application/octet-stream"
        : "text/plain; charset=utf-8",
      "cache-control": cache,
      "x-content-type-options": "nosniff",
    },
  });
}

async function computeBuild(
  ctx: SurfaceContext,
  target: Extract<ByteTarget, { kind: "build" }>,
): Promise<Response> {
  const { req, db, cfg, product, env } = ctx;
  const url = new URL(req.url);
  const deliverable = url.searchParams.get("deliverable") ?? APP_DELIVERABLE_ID;
  const resolved = await resolveBuild(
    db,
    product.slug,
    { deliverable, selector: target.selector, buildId: target.buildId },
    cfg,
  );
  if (!resolved?.build) return notFound();
  const artifacts = await listArtifactsForBuild(
    db,
    product.slug,
    resolved.release.release_id,
    resolved.build.build_id,
  );
  const payload = artifacts.find((a) => a.role === "payload");
  if (!payload) return notFound();
  const cache = isVersionSelector(target.selector)
    ? FIXED_BYTES_CACHE
    : MOVING_BYTES_CACHE;

  if (url.searchParams.get("checksum") === "sha256") {
    if (!payload.sha256 || !SHA256_HEX.test(payload.sha256)) return notFound();
    const publicMode = accessModeFor(artifactPolicy(cfg), "build") === "public";
    return checksumResponse(
      payload.sha256,
      isBytesHost(url, env),
      publicMode ? cache.replace(", no-transform", "") : "private, no-store",
    );
  }
  return serveArtifact(ctx, payload, cache);
}

async function computeFile(
  ctx: SurfaceContext,
  target: Extract<ByteTarget, { kind: "file" }>,
): Promise<Response> {
  // Joined to its release row: the access decision checked that row's version, so an artifact
  // whose release row is missing is not served on the strength of a check that saw nothing.
  const artifact = await ctx.db.first<ReleaseArtifactRow>(
    `SELECT a.* FROM release_artifacts a
       JOIN release_metadata m
         ON m.product = a.product AND m.release_id = a.release_id
      WHERE a.product = ? AND a.release_id = ? AND a.name = ?
      ORDER BY a.artifact_id ASC LIMIT 1`,
    ctx.product.slug,
    target.releaseId,
    target.name,
  );
  if (!artifact) return notFound();
  return serveArtifact(ctx, artifact, FIXED_BYTES_CACHE);
}

/** The most releases one hash is checked against (identical bytes reused across releases). */
const BLOB_RELEASES_CHECKED = 16;

/**
 * `entitled` on the blob route. The gateway's decision for a blob names no channel and no
 * version, so it proves only that the device holds a usable licence — and a hash is never a
 * secret (THREAT-MODEL §3: signed manifests publish it). Without a per-release decision every
 * R2-held payload the build and file routes window-check would be one hash away. So the blob is
 * served only if at least one release of THIS product whose artifact has this digest passes the
 * same check `/release/files` applies to that release's version (`enforceReleaseAccess` with the
 * stored version as `fixedVersion`, so a release tagged `latest` or `pr-5` is window-checked
 * rather than read as a moving channel, and a version the window cannot order is refused). A
 * hash no release artifact carries (only a
 * pack object, say) answers the flat not-found until per-request authorisation exists
 * (P2b-04 / P4-05). Returns `null` to serve, or the refusal.
 */
async function entitledBlobRefusal(
  ctx: SurfaceContext,
  sha256: string,
): Promise<Response | null> {
  const { req, env, db, cfg, product, now } = ctx;
  const releases = await db.all<Pick<ReleaseMetadataRow, "version">>(
    `SELECT DISTINCT m.version AS version
       FROM release_artifacts a
       JOIN release_metadata m
         ON m.product = a.product AND m.release_id = a.release_id
      WHERE a.product = ? AND a.sha256 = ?
      ORDER BY m.version ASC
      LIMIT ${BLOB_RELEASES_CHECKED}`,
    product.slug,
    sha256,
  );
  let first: Response | null = null;
  for (const { version } of releases) {
    const denied = await enforceReleaseAccess(
      req,
      env,
      db,
      product,
      cfg,
      "blob",
      // The release's STORED version, pinned — never re-read as a selector (`fixedVersion`).
      { fixedVersion: version },
      now,
    );
    if (!denied) return null;
    first ??= denied;
  }
  return first ?? notFound();
}

async function computeBlob(
  ctx: SurfaceContext,
  target: Extract<ByteTarget, { kind: "blob" }>,
): Promise<Response> {
  const { req, env, db, cfg, product } = ctx;
  if (!env.BLOBS) return notFound();
  const key = blobKey(target.sha256);
  // Cross-tenant: served only when an artifact (or pack object) of THIS product references it.
  // Another product's copy of the same bytes does not count, and the answer is the plain
  // not-found either way, so the route is no oracle for what other tenants store.
  if (!(await hasRef(db, product.slug, key))) return notFound();
  const mode = accessModeFor(artifactPolicy(cfg), "blob");
  if (mode === "entitled") {
    const refused = await entitledBlobRefusal(ctx, target.sha256);
    if (refused) return refused;
  }
  const publicMode = mode === "public";
  return blobResponse(req, env.BLOBS, key, {
    sha256: target.sha256,
    gated: !publicMode,
    env,
  });
}

/**
 * Serve a byte target for `product` (console or bytes host). `fetchImpl` is injectable for the
 * suites; production passes the platform `fetch`.
 */
export async function serveReleaseBytes(
  req: Request,
  env: Env,
  db: Db,
  product: ProductPublic,
  target: ByteTarget,
  fetchImpl: FetchImpl = fetch,
): Promise<Response> {
  if (req.method !== "GET" && req.method !== "HEAD")
    return new Response(null, {
      status: 405,
      headers: { allow: "GET, HEAD", "cache-control": "no-store" },
    });

  // What `entitled` checks here: a version selector is pinned; a moving selector resolves after
  // the decision (as on `/release/dl`). A file's release is one FIXED release, so its stored
  // version goes in as `fixedVersion`, never as a selector: a release tagged `latest` stores the
  // version `latest`, which as a selector would be the moving stable channel with no window
  // check. A file whose release row is missing is checked as an empty fixed version (refused
  // under a bounded window) and then answers not-found (`computeFile` joins the row). A blob
  // names neither, so this decision proves only a usable licence; `computeBlob` then checks the
  // releases that carry the hash (`entitledBlobRefusal`).
  let params: ReleaseParams = {};
  if (target.kind === "build") params = { version: target.selector };
  if (target.kind === "file") {
    const release = await db.first<Pick<ReleaseMetadataRow, "version">>(
      "SELECT version FROM release_metadata WHERE product = ? AND release_id = ?",
      product.slug,
      target.releaseId,
    );
    params = { fixedVersion: release?.version ?? "" };
  }

  const kind: ReleaseKind = target.kind;
  return serveReleaseSurface(
    req,
    env,
    db,
    product,
    kind,
    params,
    fetchImpl,
    (ctx) => {
      switch (target.kind) {
        case "build":
          return computeBuild(ctx, target);
        case "file":
          return computeFile(ctx, target);
        case "blob":
          return computeBlob(ctx, target);
      }
    },
  );
}

// ── The bytes-host registration ──────────────────────────────────────────────────────────────

const BYTE_PATH =
  /^\/([a-z0-9-]{1,64})\/release\/(builds|files|blobs)\/([^/]+)\/([^/]+)$/;

function matchArea(
  area: ByteTarget["kind"],
): (pathname: string) => ByteRouteMatch | null {
  const segment = `${area}s`;
  return (pathname) => {
    const m = BYTE_PATH.exec(pathname);
    if (!m || m[2] !== segment || !PRODUCT_SLUG.test(m[1] as string))
      return null;
    const target = byteTargetOf([m[2], m[3] as string, m[4] as string]);
    if (!target) return null;
    return {
      product: m[1] as string,
      params: Object.fromEntries(
        Object.entries(target).map(([k, v]) => [k, String(v)]),
      ),
    };
  };
}

function targetFromParams(params: Record<string, string>): ByteTarget | null {
  switch (params.kind) {
    case "build":
      return params.selector && params.buildId
        ? { kind: "build", selector: params.selector, buildId: params.buildId }
        : null;
    case "file":
      return params.releaseId && params.name
        ? { kind: "file", releaseId: params.releaseId, name: params.name }
        : null;
    case "blob":
      return params.sha256 ? { kind: "blob", sha256: params.sha256 } : null;
    default:
      return null;
  }
}

function byteRoute(area: ByteTarget["kind"]): ByteRoute {
  return {
    name: `release.${area}`,
    service: "release",
    match: matchArea(area),
    handle: async (req, ctx) => {
      const target = targetFromParams(ctx.params);
      if (!target) return notFound();
      return serveReleaseBytes(req, ctx.env, ctx.db, ctx.product, target);
    },
  };
}

/**
 * Release's entries in the bytes-host allowlist (`mount.ts` `BYTE_ROUTES`). Each names
 * `service: "release"`, so a product with Release off serves none of them there: the dispatcher
 * answers the host's flat not-found before any of this code runs.
 */
export const RELEASE_BYTE_ROUTES: readonly ByteRoute[] = [
  byteRoute("build"),
  byteRoute("file"),
  byteRoute("blob"),
];
