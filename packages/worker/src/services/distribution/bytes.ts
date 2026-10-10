/// <reference types="@cloudflare/workers-types" />

/**
 * Distribution's byte routes (P2b-04, README §3.5: "Release writes records; distribution serves
 * bytes"):
 *
 *     GET  /<p>/distribution/install.sh                      the curl-pipe installer
 *     GET  /<p>/distribution/dl/<version>/<binary>-<arch>[.dmg][?checksum=sha256]
 *     GET|HEAD /<p>/distribution/builds/<selector>/<buildId> the payload of a declared build
 *              [?deliverable=<id>] [?checksum=sha256] [?redirect=1]
 *     GET|HEAD /<p>/distribution/files/<releaseId>/<name>    one exact file of one release
 *              [?redirect=1]
 *     GET|HEAD /<p>/distribution/blobs/sha256/<hash>         a content-addressed object
 *     GET|HEAD /<p>/distribution/packs/<pack>/<variant>/payload/<sha256>
 *              [?via=dcz]                                     a pack's decoded container payload
 *                                                             (P4-18, `payload.ts`)
 *
 * Every old spelling is a PERMANENT alias the core router rewrites to these segments before
 * dispatch (`router.ts`): `/<p>/release/{install.sh,dl,builds,files,blobs}/…` and
 * `/<p>/install.sh`. One handler per surface, so the two spellings cannot answer differently.
 * `builds`, `files` and `blobs` (both spellings) also answer on the bytes host (`BLOB_ORIGIN`,
 * `dl.plrs.im`) through `DISTRIBUTION_BYTE_ROUTES`, which `mount.ts` registers with the
 * distribution slug: a product with Distribution off serves none of them on either host.
 *
 * These are P2-05's and the legacy release routes, MOVED: every guarantee they made holds here,
 * and the suites that pinned them run unchanged against the aliases.
 *
 * ── THE PIPELINE ────────────────────────────────────────────────────────────────────────────
 *
 * The product's release configuration must exist (`releaseCatalog.metadataAccess()` is `null`
 * without one) → the request counts against the same rate-limit lane as before
 * (`releaseArtifact` for bytes, `release` for the installer: one product's GitHub quota is still
 * the budget defended) → the access mode is enforced → compute → harden. P4-05 moved the rate
 * limit ahead of the access decision, so a refused request spends budget too and the reads an
 * access decision costs stay bounded per client. Nothing here is put in the edge cache.
 *
 * ── ONE ACCESS ANSWER ───────────────────────────────────────────────────────────────────────
 *
 * The ARTIFACTS mode is `dist_access`, per deliverable (`delivery.accessMode()`), the same
 * answer the appcast and the portal read; the installer stays under Release's METADATA mode. The
 * refusal is Core's `accessRefusal`, shared with Release's surfaces:
 *
 *   - `dl` and `builds` classify their selector through `releaseCatalog.accessSelector`; a
 *     pinned version is window-checked, and a version the window cannot order (a four-part
 *     `1.2.3.4`) is refused whenever the window is bounded;
 *   - `files` checks the release's STORED version as a fixed, pinned version
 *     (`fixedReleaseSelector`) — never re-read as a selector, so a release tagged `latest`,
 *     `stable`, `beta`, `pr-5` or a manual channel's name cannot pass as a moving channel (the
 *     P2-05 fixedVersion rule); a missing release row is checked as an empty fixed version
 *     (refused under a bounded window) and then answers not-found. On the bytes host only, a
 *     valid portal download ticket (`?ticket=`, `core/downloadTicket.ts`, PX-W3) for exactly
 *     this file stands in for the device bearer; an invalid one is treated as absent;
 *   - `blobs` names no version: it authorises the HOLDERS of the object's key instead
 *     (`blobAccess.ts`, P4-05). The app side keeps P2b-04's rule (under `entitled` a release
 *     of THIS product carrying the digest must pass the `files` check); a pack's objects are
 *     authorised by the pack's own delivery access and, under `gated/`, by its CURRENT gate
 *     (P4-01 decision 35).
 *
 * ── PACKS: THE BLOB ROUTE ONLY ──────────────────────────────────────────────────────────────
 *
 * Every pack object (a variant's `full`, its files index and gaps, deltas, file blobs) is reached
 * by its stored SHA-256 on the blob route (plans/P4-01.md §6). The one other door is P4-18's
 * payload URL (`payload.ts`), which serves a container variant's `full` and payload deltas
 * content-encoded for a browser, under the blob route's own access decision for each object. `files` and
 * `builds` serve the `app` deliverable only: a pack release's file or build answers the plain
 * not-found there, so no pack byte is ever authorised by the app's version window or served
 * outside its pack's gate (closing P4-02's hand-off, under which `files/<packRelease>/<name>`
 * served a pack's ungated objects under the pack's or the app's mode).
 *
 * ── WHERE THE BYTES COME FROM ───────────────────────────────────────────────────────────────
 *
 * An artifact's locations, in README §3.5 order: R2 (Core's `blobResponse`, only for a key this
 * product holds a ref to, and never a `gated/` key on `builds`/`files`: only the blob route
 * authorises gated bytes, per request, and only for a pack) →
 * GitHub (`releaseCatalog.openSource`: Release streams with its own installation token and SSRF
 * guard; Distribution never holds a GitHub token and never imports `github.ts`) → an external
 * `https://` URL (302). `?redirect=1` is honoured only for a PUBLIC deliverable (and Release
 * honours it only for a public repository).
 */

import { APP_DELIVERABLE_ID } from "@polaris-key/manifest";
import type { ReleaseAccess } from "@polaris-key/protocol/release";
import type { Db } from "../../db/types.js";
import type { Env } from "../../env.js";
import { appSecurityHeaders } from "../../securityHeaders.js";
import { bearer } from "../../http.js";
import type { ProductPublic } from "../../core/products.js";
import type {
  CatalogLocation,
  CatalogSourceArtifact,
  ReleaseCatalog,
  ServiceHooks,
} from "../../core/hooks.js";
import { errorResponse, notFound } from "../../core/errors.js";
import {
  BLOB_CSP,
  PUBLIC_BLOB_CACHE,
  blobResponse,
  hasRef,
  parseKey,
} from "../../core/blobs.js";
import { isBytesHost } from "../../core/bytesHost.js";
import {
  DOWNLOAD_TICKET_PARAM,
  verifyDownloadTicket,
} from "../../core/downloadTicket.js";
import type { ByteRoute, ByteRouteMatch } from "../../core/bytesHost.js";
import {
  accessRefusal,
  fixedReleaseSelector,
  type EntitledSelector,
} from "../../core/entitledAccess.js";
import { clientNetwork, rateLimitOk } from "../../core/rateLimit.js";
import { decideBlob, type BlobDecision } from "./blobAccess.js";
import {
  decidePayload,
  servePayload,
  type PayloadDecision,
  type PayloadTarget,
} from "./payload.js";
import { isPackSegment, isVariantSegment } from "./dictionary.js";
import { SHA256SUMS_NAME, sha256sumsBody } from "./checksums.js";

// ── Targets ──────────────────────────────────────────────────────────────────────────────────

export type ByteTarget =
  | { kind: "install" }
  | {
      kind: "dl";
      /** The raw path segment, exactly as the legacy route read it (not percent-decoded). */
      version: string;
      arch: string;
      format: "cli" | "dmg";
    }
  | { kind: "build"; selector: string; buildId: string }
  | { kind: "file"; releaseId: string; name: string }
  | { kind: "blob"; sha256: string }
  | PayloadTarget;

const SHA256_HEX = /^[0-9a-f]{64}$/;
const PRODUCT_SLUG = /^[a-z0-9-]{1,64}$/;
/** `<binary>-<arch>` with the arch aliases the old `/cli/` and `/dmg/` routes accepted. */
const ARCH_SUFFIX = /^(?:[^/]+)-(arm64|aarch64|x86_64|amd64)$/;

function decode(segment: string): string | null {
  try {
    const v = decodeURIComponent(segment);
    return v.length > 0 && v.length <= 256 ? v : null;
  } catch {
    return null;
  }
}

/**
 * The target named by the segments after `/<p>/distribution`, or null when they name none.
 * Shared by the console router and the bytes-host matcher so the two can never disagree.
 */
export function byteTargetOf(rest: readonly string[]): ByteTarget | null {
  if (rest.length === 1 && rest[0] === "install.sh") return { kind: "install" };
  if (rest.length === 5) return payloadTargetOf(rest);
  if (rest.length !== 3) return null;
  const [area, a, b] = rest as [string, string, string];
  if (area === "dl") {
    const format = b.endsWith(".dmg") ? "dmg" : "cli";
    const name = format === "dmg" ? b.slice(0, -".dmg".length) : b;
    const arch = name.match(ARCH_SUFFIX)?.[1];
    return arch ? { kind: "dl", version: a, arch, format } : null;
  }
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

/** `packs/<pack>/<variant>/payload/<sha256>` (P4-18), or null. The variant segment may arrive
 *  percent-encoded (`=` and `;`); it is matched decoded. */
function payloadTargetOf(rest: readonly string[]): PayloadTarget | null {
  const [area, pack, variant, leaf, hash] = rest as [
    string,
    string,
    string,
    string,
    string,
  ];
  if (area !== "packs" || leaf !== "payload" || !SHA256_HEX.test(hash))
    return null;
  const buildId = decode(variant);
  if (!buildId || !isPackSegment(pack) || !isVariantSegment(buildId))
    return null;
  return { kind: "payload", packId: pack, buildId, sha256: hash };
}

// ── Headers ──────────────────────────────────────────────────────────────────────────────────

/** A moving selector's URL changes content when the channel moves; revalidate soon. */
const MOVING_BYTES_CACHE = "public, max-age=120, no-transform";
/** A file of a release, a pinned version, a blob: the bytes behind the URL never change, but who may read them can (SEC-DST-1), so the entry is bounded. */
const FIXED_BYTES_CACHE = PUBLIC_BLOB_CACHE;
/** Anything not public: never stored by a shared cache, never recompressed. */
const PRIVATE_BYTES_CACHE = "private, no-store, no-transform";
/** The installer: small, deterministic per product. */
const INSTALL_CACHE = "public, max-age=300";

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

/**
 * The platform security headers on every answer (R6-04), keeping a byte response's sandbox CSP
 * (`blobResponse`), which is strictly tighter than the app CSP. The release gateway's `harden`,
 * applied at the same points.
 */
function harden(res: Response): Response {
  const sandboxed = res.headers.get("content-security-policy") === BLOB_CSP;
  const headers = appSecurityHeaders(new Headers(res.headers));
  if (sandboxed) headers.set("content-security-policy", BLOB_CSP);
  return new Response(res.body, { status: res.status, headers });
}

// ── Rate limits ──────────────────────────────────────────────────────────────────────────────

/**
 * The release gateway's two budgets (R10-05), under the SAME bucket names: the budget being
 * defended is one product's GitHub installation quota, which an appcast miss and a download miss
 * spend from alike. Bytes are bursty (parallel `Range` requests, a NAT'd office on release day),
 * so their lane is the loose one.
 */
const METADATA_RATE_LIMIT = { limit: 30, windowSec: 60 } as const;
const ARTIFACT_RATE_LIMIT = { limit: 120, windowSec: 60 } as const;

// ── The pipeline ─────────────────────────────────────────────────────────────────────────────

export interface ByteContext {
  req: Request;
  env: Env;
  db: Db;
  product: ProductPublic;
  hooks: ServiceHooks;
  now: number;
}

/** What the access step decided, carried into compute. */
interface Cleared {
  catalog: ReleaseCatalog;
  mode: ReleaseAccess;
  /** For `file`: the resolution already read to decide access. */
  file?: Awaited<ReturnType<typeof resolveFile>>;
  /** For `blob`: which key to serve, decided from its holders (`blobAccess.ts`). */
  blob?: Exclude<BlobDecision, { kind: "refused" }>;
  /** For `payload`: the payload and its `full` object's decision (`payload.ts`). */
  payload?: Extract<PayloadDecision, { kind: "serve" }>;
}

async function resolveFile(
  catalog: ReleaseCatalog,
  t: Extract<ByteTarget, { kind: "file" }>,
) {
  const r = await catalog.resolve({
    kind: "file",
    releaseId: t.releaseId,
    name: t.name,
  });
  return r?.kind === "file"
    ? r
    : { kind: "file" as const, release: null, artifact: null };
}

/**
 * Does the request carry a valid download ticket for this file (PX-W3, plans/PX-W3.md §6.4)?
 * Only on the bytes host, only for a resolved file of the app deliverable with a recorded
 * SHA-256; the console host and every other target ignore `?ticket=`.
 */
async function ticketClears(
  { req, env, product, now }: ByteContext,
  target: Extract<ByteTarget, { kind: "file" }>,
  file: Awaited<ReturnType<typeof resolveFile>>,
): Promise<boolean> {
  const url = new URL(req.url);
  const ticket = url.searchParams.get(DOWNLOAD_TICKET_PARAM);
  if (!ticket || !isBytesHost(url, env)) return false;
  if (!file.release || !file.artifact?.sha256) return false;
  return verifyDownloadTicket(
    env,
    ticket,
    {
      host: url.hostname,
      product: product.slug,
      releaseId: target.releaseId,
      name: target.name,
      sha256: file.artifact.sha256,
    },
    now,
  );
}

/** Serve one byte target for `product`, on either host. */
export async function serveDistributionBytes(
  ctx: ByteContext,
  target: ByteTarget,
): Promise<Response> {
  const { req, env, db, product, hooks, now } = ctx;
  // P2-05's three routes answer only GET and HEAD; the legacy installer and download never
  // checked the method, and still do not.
  if (
    (target.kind === "build" ||
      target.kind === "file" ||
      target.kind === "blob" ||
      target.kind === "payload") &&
    req.method !== "GET" &&
    req.method !== "HEAD"
  )
    return new Response(null, {
      status: 405,
      headers: { allow: "GET, HEAD", "cache-control": "no-store" },
    });

  // Release off (Distribution requires it, so only a broken composition gets here) or no
  // release configuration: the gateway's clean not-found.
  const catalog = hooks.releaseCatalog();
  const delivery = hooks.delivery();
  if (!catalog || !delivery) return harden(notFound());
  const metadataMode = await catalog.metadataAccess();
  if (metadataMode === null) return harden(notFound());

  // The rate limit counts every request BEFORE the access decision (P4-05): a refused request
  // (an anonymous probe of a gated hash, say) still spends the client's budget, so the reads an
  // access decision costs are bounded per client like any download's.
  const isArtifact = target.kind !== "install";
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

  // The access decision, per surface (see the file header).
  let mode: ReleaseAccess = "public";
  let selector: EntitledSelector = {};
  let pinned = false;
  const cleared: Partial<Cleared> = { catalog };
  let decided: Response | null | undefined;
  switch (target.kind) {
    case "install":
      mode = metadataMode;
      selector = await catalog.accessSelector(undefined);
      pinned = Boolean(selector.version);
      break;
    case "dl":
      mode = await delivery.accessMode(APP_DELIVERABLE_ID);
      selector = await catalog.accessSelector(target.version);
      pinned = Boolean(selector.version);
      break;
    case "build": {
      const deliverable =
        new URL(req.url).searchParams.get("deliverable") ?? APP_DELIVERABLE_ID;
      // The app deliverable only: a pack's variants are reached through the blob route (P4-05).
      if (deliverable !== APP_DELIVERABLE_ID) return harden(notFound());
      mode = await delivery.accessMode(deliverable);
      selector = await catalog.accessSelector(target.selector);
      pinned = Boolean(selector.version);
      break;
    }
    case "file": {
      const file = await resolveFile(catalog, target);
      // The app deliverable only: a pack release's objects are reached through the blob route,
      // under the pack's gate, never here under the app's version window (P4-05).
      if (file.release && file.release.deliverableId !== APP_DELIVERABLE_ID)
        return harden(notFound());
      cleared.file = file;
      mode = await delivery.accessMode(APP_DELIVERABLE_ID);
      // The release's STORED version, pinned — never re-read as a selector (`fixedVersion`).
      selector = fixedReleaseSelector(file.release?.version ?? "");
      pinned = true;
      // PX-W3: a download ticket from the portal's redemption stands in for a device bearer, on
      // the bytes host only, for exactly the file (by content) it was minted for. An invalid
      // ticket is treated as absent: the request gets the no-credential answer below, so a
      // probe cannot tell a bad ticket from a missing one. The mode stays non-public, so the
      // answer is still private, sandboxed and forced to download.
      if (await ticketClears(ctx, target, file)) decided = null;
      break;
    }
    case "blob": {
      // Decided from the holders of the object's keys, not from one mode (`blobAccess.ts`).
      const blob = await decideBlob(ctx, catalog, target.sha256);
      if (blob.kind === "refused") decided = blob.response;
      else {
        cleared.blob = blob;
        decided = null;
      }
      break;
    }
    case "payload": {
      // The blob route's decision for the payload's `full` object (`payload.ts`).
      const p = await decidePayload(ctx, catalog, target);
      if (p.kind === "refused") decided = p.response;
      else {
        cleared.payload = p;
        decided = null;
      }
      break;
    }
  }
  cleared.mode = mode;

  const denied =
    decided !== undefined
      ? decided
      : await accessRefusal(
          env,
          db,
          product,
          bearer(req),
          mode,
          selector,
          pinned,
          now,
        );
  if (denied) return harden(denied);

  return harden(await compute(ctx, target, cleared as Cleared));
}

function compute(
  ctx: ByteContext,
  target: ByteTarget,
  cleared: Cleared,
): Promise<Response> {
  switch (target.kind) {
    case "install":
      return computeInstall(ctx, cleared.catalog);
    case "dl":
      return computeDownload(ctx, cleared.catalog, target);
    case "build":
      return computeBuild(ctx, cleared, target);
    case "file":
      return computeFile(ctx, cleared, target);
    case "blob":
      return computeBlob(ctx, cleared, target);
    case "payload":
      return cleared.payload
        ? servePayload(ctx, cleared.catalog, cleared.payload, target)
        : Promise.resolve(notFound());
  }
}

// ── The installer and the legacy download ────────────────────────────────────────────────────

async function computeInstall(
  { req }: ByteContext,
  catalog: ReleaseCatalog,
): Promise<Response> {
  // Null means a field (repo-owned `binary_name`, or the request-derived origin) fell outside
  // the installer's safe character classes (R6-01): fail closed.
  const body = await catalog.installScript(new URL(req.url).origin);
  if (body === null) return notFound();
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/x-shellscript; charset=utf-8",
      "cache-control": INSTALL_CACHE,
    },
  });
}

async function computeDownload(
  { req }: ByteContext,
  catalog: ReleaseCatalog,
  target: Extract<ByteTarget, { kind: "dl" }>,
): Promise<Response> {
  const res = await catalog.openSource(
    {
      kind: "dl",
      selector: target.version,
      arch: target.arch,
      format: target.format,
      checksum: new URL(req.url).searchParams.get("checksum") === "sha256",
    },
    req,
  );
  return res ?? notFound();
}

// ── Serving one artifact ─────────────────────────────────────────────────────────────────────

/** The README §3.5 location order: R2, then GitHub, then an external URL. */
const LOCATION_RANK: Record<CatalogLocation["provider"], number> = {
  r2: 0,
  github: 1,
  external: 2,
  store: 3,
};

/**
 * Serve one artifact from the first location that has it. `cache` is the Cache-Control the
 * route wants for a success; a non-public deliverable always gets `PRIVATE_BYTES_CACHE`.
 */
async function serveArtifact(
  ctx: ByteContext,
  catalog: ReleaseCatalog,
  artifact: CatalogSourceArtifact,
  cache: string,
  publicMode: boolean,
): Promise<Response> {
  const { req, env, db, product } = ctx;
  const effectiveCache = publicMode ? cache : PRIVATE_BYTES_CACHE;
  const url = new URL(req.url);
  const locations = [...artifact.locations].sort(
    (x, y) => LOCATION_RANK[x.provider] - LOCATION_RANK[y.provider],
  );

  for (const loc of locations) {
    if (loc.provider === "r2") {
      // Hash-pinned: the key must be the content address of THIS artifact's sha256, and this
      // product must hold a ref to it (a ref is earned per product, THREAT-MODEL §3).
      if (!env.BLOBS || !artifact.sha256 || !loc.key) continue;
      const parsed = parseKey(loc.key);
      // A `gated/` key is entitlement-gated content, authorised PER REQUEST (THREAT-MODEL §3) by
      // the blob route alone, against a pack's current gate (`blobAccess.ts`). These routes serve
      // the app deliverable, whose access mode is not that check: under a `public` deliverable
      // it would hand gated bytes to anyone. So they never serve a gated location.
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
        ...(artifact.contentType ? { contentType: artifact.contentType } : {}),
        filename: artifact.name,
      });
      if (res.status === 404) {
        await res.body?.cancel().catch(() => undefined);
        continue;
      }
      return withCache(res, effectiveCache);
    }

    if (loc.provider === "github") {
      const res = await catalog.openSource(
        {
          kind: "github",
          releaseId: artifact.releaseId,
          artifactId: artifact.artifactId,
          ...(loc.asset !== undefined ? { asset: loc.asset } : {}),
          // Opt-in, PUBLIC deliverables only (Release adds: public repositories only).
          redirect: url.searchParams.get("redirect") === "1" && publicMode,
        },
        req,
      );
      if (res === null) continue;
      return withCache(res, effectiveCache);
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

// ── The three P2-05 routes ───────────────────────────────────────────────────────────────────

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
  ctx: ByteContext,
  { catalog, mode }: Cleared,
  target: Extract<ByteTarget, { kind: "build" }>,
): Promise<Response> {
  const { req, env } = ctx;
  const url = new URL(req.url);
  const deliverable = url.searchParams.get("deliverable") ?? APP_DELIVERABLE_ID;
  const resolved = await catalog.resolve({
    kind: "build",
    deliverable,
    selector: target.selector,
    buildId: target.buildId,
  });
  if (resolved?.kind !== "build" || !resolved.payload) return notFound();
  const payload = resolved.payload;
  const cache = resolved.moving ? MOVING_BYTES_CACHE : FIXED_BYTES_CACHE;
  const publicMode = mode === "public";

  if (url.searchParams.get("checksum") === "sha256") {
    if (!payload.sha256 || !SHA256_HEX.test(payload.sha256)) return notFound();
    return checksumResponse(
      payload.sha256,
      isBytesHost(url, env),
      publicMode ? cache.replace(", no-transform", "") : "private, no-store",
    );
  }
  return serveArtifact(ctx, catalog, payload, cache, publicMode);
}

async function computeFile(
  ctx: ByteContext,
  { catalog, mode, file }: Cleared,
  target: Extract<ByteTarget, { kind: "file" }>,
): Promise<Response> {
  // DC-15: the generated SHA256SUMS of this release, whatever a developer published by that name.
  // It is read after the same access decision as the files it lists.
  if (target.name === SHA256SUMS_NAME && file?.release) {
    const body = sha256sumsBody(
      await catalog.artifacts(file.release.releaseId),
    );
    if (body === null) return notFound();
    return new Response(ctx.req.method === "HEAD" ? null : body, {
      status: 200,
      headers: {
        // The bytes host serves no text type at all (`core/bytesHost.ts`).
        "content-type": isBytesHost(new URL(ctx.req.url), ctx.env)
          ? "application/octet-stream"
          : "text/plain; charset=utf-8",
        "cache-control":
          mode === "public" ? MOVING_BYTES_CACHE : PRIVATE_BYTES_CACHE,
        "x-content-type-options": "nosniff",
      },
    });
  }
  // The access decision checked this release's version; an artifact whose release row is
  // missing is not served on the strength of a check that saw nothing.
  if (!file?.release || !file.artifact) return notFound();
  return serveArtifact(
    ctx,
    catalog,
    file.artifact,
    FIXED_BYTES_CACHE,
    mode === "public",
  );
}

async function computeBlob(
  ctx: ByteContext,
  { blob }: Cleared,
  target: Extract<ByteTarget, { kind: "blob" }>,
): Promise<Response> {
  const { req, env } = ctx;
  // Cross-tenant: only a key THIS product holds a ref to was decided servable (`decideBlob`);
  // another product's copy of the same bytes does not count, and the answer is the plain
  // not-found either way, so the route is no oracle for what other tenants store.
  if (!env.BLOBS || blob?.kind !== "serve") return notFound();
  return blobResponse(req, env.BLOBS, blob.key, {
    sha256: target.sha256,
    // A `gated/` key is private whatever this says (`blobResponse`).
    gated: !blob.publicCache,
    env,
    // SEC-DST-1: an app artifact's audience can narrow (mode change, withdrawal), so a shared
    // cache holds it for an hour at most, not a year.
    ...(blob.boundedCache ? { publicCache: PUBLIC_BLOB_CACHE } : {}),
  });
}

// ── The bytes-host registration ──────────────────────────────────────────────────────────────

/** Both spellings: the canonical `/distribution/…` and P2-05's live `/release/…` URLs, which
 *  discovery advertised on `dl.plrs.im` and which must keep working. */
const BYTE_PATH =
  /^\/([a-z0-9-]{1,64})\/(distribution|release)\/(builds|files|blobs)\/([^/]+)\/([^/]+)$/;

type HostArea = "build" | "file" | "blob" | "payload";

function matchArea(
  area: HostArea,
): (pathname: string) => ByteRouteMatch | null {
  const segment = `${area}s`;
  return (pathname) => {
    const m = BYTE_PATH.exec(pathname);
    if (!m || m[3] !== segment || !PRODUCT_SLUG.test(m[1] as string))
      return null;
    const target = byteTargetOf([m[3], m[4] as string, m[5] as string]);
    if (!target) return null;
    return {
      product: m[1] as string,
      params: Object.fromEntries(
        Object.entries(target).map(([k, v]) => [k, String(v)]),
      ),
    };
  };
}

/** The payload URL on the bytes host: canonical spelling only (it has no `/release/…` alias). */
const PAYLOAD_PATH =
  /^\/([a-z0-9-]{1,64})\/distribution\/(packs)\/([^/]+)\/([^/]+)\/(payload)\/([^/]+)$/;

function matchPayload(pathname: string): ByteRouteMatch | null {
  const m = PAYLOAD_PATH.exec(pathname);
  if (!m || !PRODUCT_SLUG.test(m[1] as string)) return null;
  const target = byteTargetOf(m.slice(2) as string[]);
  if (target?.kind !== "payload") return null;
  return {
    product: m[1] as string,
    params: {
      kind: "payload",
      packId: target.packId,
      buildId: target.buildId,
      sha256: target.sha256,
    },
  };
}

function targetFromParams(params: Record<string, string>): ByteTarget | null {
  switch (params.kind) {
    case "payload":
      return params.packId && params.buildId && params.sha256
        ? {
            kind: "payload",
            packId: params.packId,
            buildId: params.buildId,
            sha256: params.sha256,
          }
        : null;
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

function byteRoute(area: HostArea): ByteRoute {
  return {
    name: `distribution.${area}`,
    service: "distribution",
    match: area === "payload" ? matchPayload : matchArea(area),
    handle: async (req, ctx) => {
      const target = targetFromParams(ctx.params);
      if (!target) return notFound();
      return serveDistributionBytes(
        {
          req,
          env: ctx.env,
          db: ctx.db,
          product: ctx.product,
          hooks: ctx.hooks,
          now: ctx.now,
        },
        target,
      );
    },
  };
}

/**
 * Distribution's entries in the bytes-host allowlist (`mount.ts` `BYTE_ROUTES`), each matching
 * the canonical `/<p>/distribution/…` path and its `/<p>/release/…` alias. Each names
 * `service: "distribution"`, so a product with Distribution off serves none of them there: the
 * dispatcher answers the host's flat not-found before any of this code runs.
 */
export const DISTRIBUTION_BYTE_ROUTES: readonly ByteRoute[] = [
  byteRoute("build"),
  byteRoute("file"),
  byteRoute("blob"),
  byteRoute("payload"),
];
