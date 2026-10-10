/// <reference types="@cloudflare/workers-types" />

/**
 * The F-Droid repository relay (P2b-05, notes/E2 §C2): one repository per channel at
 * `/<p>/distribution/fdroid/<channel>/repo`, beta including stable.
 *
 * The repository is SIGNED BY CI with the product's repo key (`pkey feeds fdroid` runs
 * `apksigner` on `entry.jar`), and Polaris Key never holds that key. So the Worker generates
 * nothing here: CI builds `index-v2.json`, `entry.json`, `entry.jar` and diffs from the inputs the
 * CI read route hands it, uploads them through P2-02's upload ticket (`distribution:feeds`), and
 * registers the set; the relay then serves only REGISTERED files, plus the APKs the index names.
 *
 *     GET  /<p>/distribution/fdroid/<channel>/repo/<path>   public, the relay
 *     GET  /<p>/distribution/feeds/fdroid/<channel>         `pkeyci_` + distribution:feeds — the
 *                                                           generator's inputs
 *     POST /<p>/distribution/feeds/fdroid/<channel>         `pkeyci_` + distribution:feeds —
 *                                                           register the uploaded file set
 *
 * ── THE RELAY ───────────────────────────────────────────────────────────────────────────────
 *
 *   - A path failing `isSafeAssetPath` is not-found, before any lookup.
 *   - A registered file is served from the blob store (content-addressed, this product's `feed`
 *     ref, the stored checksum re-checked by `blobResponse`) with the type the Worker chose at
 *     registration from the extension — `application/json`, `application/java-archive`,
 *     `image/png`, … — never one CI sent, never HTML, XML or SVG; `nosniff` and the sandbox CSP on
 *     every answer. Only while the object passes the blob route's strictest-mode rule
 *     (`objectIsPublic`): one a non-public deliverable's release carries is not-found. The paths are MUTABLE (a new `entry.jar` replaces the old), so the cache is
 *     short and the ETag (the SHA-256) revalidates.
 *   - An APK the index lists (`/<name>.apk`: named by the REGISTERED `index-v2.json`, and a
 *     payload of a release the channel's F-Droid feed selects now) is a 302 to its immutable
 *     delivery URL — the bytes host when there is one. A name the registered index does not list
 *     is not-found without a selection, and the redirect is kept in the feed cache (`cache.ts`),
 *     so neither a guessed nor a repeated name costs a selection per request.
 *   - Anything else is not-found. So is everything while the app's delivery access is not
 *     public, or the product has no live `fdroid-repo` outlet.
 *
 * ── REGISTRATION ────────────────────────────────────────────────────────────────────────────
 *
 * `{ticket?, files: [{path, sha256, size}]}` must name `entry.jar`, `entry.json` and
 * `index-v2.json`, at most 256 files. Every file is `blobs/sha256/<sha256>`: one an earlier
 * register already earned (this product's `feed` ref — a release's or a pack's ref does NOT
 * count, since naming a digest is no proof of holding it), or an object of the caller's ticket,
 * verified in staging and promoted here — the same earn-a-ref rule as the release submit
 * (THREAT-MODEL §3). No file may be an object a non-public deliverable's release carries (the
 * blob route's strictest-mode rule), and the relay re-applies that rule on every request.
 * The (product, `fdroid`, channel) set and its `feed` refs are then REPLACED in one batch, so a
 * client never reads a new `entry.jar` beside an old index.
 */

import { APP_DELIVERABLE_ID } from "@polaris-key/manifest";
import type { Db, DbStatement } from "../../../db/types.js";
import type { Env } from "../../../platform/env.js";
import { isSafeAssetPath } from "../../../platform/http.js";
import { randomId } from "../../../platform/crypto.js";
import { appSecurityHeaders } from "../../../core/securityHeaders.js";
import {
  errorResponse,
  ErrorCode,
  json,
  notFound,
} from "../../../core/errors.js";
import {
  BLOB_CSP,
  blobKey,
  blobResponse,
  hasRef,
  promote,
  stagingKey,
  stmtRecordRef,
  storedObjects,
  verifyStaged,
} from "../../../core/assets/blobs.js";
import {
  claimUploadTicket,
  findUploadTicket,
  releaseUploadTicket,
  type CiTokenRecord,
} from "../../../core/publisher.js";
import { ciActor, type CiPrincipal } from "../../../core/ciScope.js";
import type { ReleaseCatalog } from "../../../core/hooks.js";
import { publicKeyIsPublic } from "../blobAccess.js";
import { appendAudit } from "../../../core/repo.js";
import { cachedFeedText, feedCacheKey, feedStateStamp } from "./cache.js";
import {
  feedReaders,
  pickOutlet,
  selectFeed,
  type FeedReadContext,
  type FeedSelection,
} from "./select.js";

export const FDROID_FEED = "fdroid";
/** The files every registered repository must carry. */
export const FDROID_REQUIRED_FILES = [
  "entry.jar",
  "entry.json",
  "index-v2.json",
] as const;
export const MAX_FEED_FILES = 256;
/** A repository file is small: an index, a signed jar, an icon. APKs are never registered. */
export const MAX_FEED_FILE_BYTES = 32 * 1024 * 1024;
const MAX_FEED_PATH = 200;

/** The relay's types, by extension. Anything else cannot be registered. */
export const FEED_FILE_TYPES: Readonly<Record<string, string>> = {
  json: "application/json",
  jar: "application/java-archive",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  asc: "application/pgp-signature",
};

/** The relay's cache: the paths are mutable, the ETag revalidates. */
const RELAY_CACHE = "public, max-age=300, no-transform";

/** The content type a repository path is served with, or `null` when it may not be registered. */
export function feedFileType(path: string): string | null {
  if (path.length > MAX_FEED_PATH || !isSafeAssetPath(`/${path}`)) return null;
  const ext = /\.([a-z0-9]+)$/.exec(path)?.[1];
  return ext ? (FEED_FILE_TYPES[ext] ?? null) : null;
}

/** The F-Droid feed's selection: the fdroid-repo outlet's Android builds, with metadata. */
export function selectFdroid(
  ctx: FeedReadContext,
  channel: string,
  outletId?: string | null,
): Promise<FeedSelection | null> {
  return selectFeed(ctx, channel, {
    kinds: ["fdroid-repo"],
    outletId: outletId ?? null,
    platform: "android",
    liveness: "availability",
  });
}

interface FeedFileRow {
  path: string;
  sha256: string;
  size: number;
  content_type: string;
}

async function feedFiles(
  db: Db,
  product: string,
  channel: string,
): Promise<FeedFileRow[]> {
  return db.all<FeedFileRow>(
    `SELECT path, sha256, size, content_type FROM dist_feed_files
      WHERE product = ? AND feed = ? AND channel = ? ORDER BY path`,
    product,
    FDROID_FEED,
    channel,
  );
}

/**
 * Whether an object may be served to anyone: the blob route's rule (`blobAccess.ts`) at its
 * loosest — every holder of its public key, app side and pack alike (P4-05), requires nothing;
 * the app side is the strictest delivery mode of the deliverables whose releases carry it (the
 * `app` mode when none do). A registered file passes this at registration AND on every relay
 * request, so neither an earlier register nor a later access change can make the relay hand out
 * a non-public deliverable's bytes.
 */
export function objectIsPublic(
  db: Db,
  product: string,
  catalog: ReleaseCatalog,
  sha256: string,
): Promise<boolean> {
  return publicKeyIsPublic(db, product, catalog, sha256);
}

/** Whether this product already holds a `feed` ref to `key` — an object an earlier register
 *  earned from its own ticket. Any other ref (a release artifact, a pack object) does not count:
 *  naming a digest is no proof of holding its bytes. */
async function hasFeedRef(
  db: Db,
  product: string,
  key: string,
): Promise<boolean> {
  const row = await db.first<{ one: number }>(
    `SELECT 1 AS one FROM blob_refs
      WHERE product = ? AND storage_key = ? AND ref_kind = 'feed' LIMIT 1`,
    product,
    key,
  );
  return row !== null;
}

function harden(res: Response): Response {
  const sandboxed = res.headers.get("content-security-policy") === BLOB_CSP;
  const headers = appSecurityHeaders(new Headers(res.headers));
  if (sandboxed) headers.set("content-security-policy", BLOB_CSP);
  headers.set("x-content-type-options", "nosniff");
  return new Response(res.body, { status: res.status, headers });
}

// ── The relay ────────────────────────────────────────────────────────────────────────────────

export interface RelayContext extends FeedReadContext {
  req: Request;
  env: Env;
}

/** `GET|HEAD /<p>/distribution/fdroid/<channel>/repo/<path…>`. */
export async function serveFdroidRelay(
  ctx: RelayContext,
  rawChannel: string,
  segments: readonly string[],
): Promise<Response> {
  const { req, env, db, product } = ctx;
  if (req.method !== "GET" && req.method !== "HEAD")
    return new Response(null, {
      status: 405,
      headers: { allow: "GET, HEAD", "cache-control": "no-store" },
    });
  const path = segments.join("/");
  // Decoding never happens: a `%` fails the safe-path check, so no encoded `..` survives.
  if (!path || !isSafeAssetPath(`/${path}`)) return harden(notFound());
  const readers = await feedReaders(ctx);
  if (!readers) return harden(notFound());
  if (!(await pickOutlet(db, product.slug, { kinds: ["fdroid-repo"] })))
    return harden(notFound());
  const history = await readers.catalog.channelReleases(
    APP_DELIVERABLE_ID,
    rawChannel,
  );
  if (!history) return harden(notFound());
  const channel = history.channel;

  const file = await db.first<FeedFileRow>(
    `SELECT path, sha256, size, content_type FROM dist_feed_files
      WHERE product = ? AND feed = ? AND channel = ? AND path = ?`,
    product.slug,
    FDROID_FEED,
    channel,
    path,
  );
  if (file) {
    const key = blobKey(file.sha256);
    if (
      !env.BLOBS ||
      !(await hasRef(db, product.slug, key)) ||
      !(await objectIsPublic(db, product.slug, readers.catalog, file.sha256))
    )
      return harden(notFound());
    const res = await blobResponse(req, env.BLOBS, key, {
      sha256: file.sha256,
      gated: false,
      env,
      host: "console",
      filename: path.split("/").pop() ?? path,
    });
    if (res.status !== 200 && res.status !== 206 && res.status !== 304)
      return harden(res);
    const headers = new Headers(res.headers);
    headers.set("cache-control", RELAY_CACHE);
    if (res.status !== 304) {
      headers.set("content-type", file.content_type);
      headers.delete("content-disposition");
    }
    return harden(new Response(res.body, { status: res.status, headers }));
  }

  // An APK the registered index names: 302 to its immutable delivery URL.
  if (
    segments.length === 1 &&
    path.endsWith(".apk") &&
    env.BLOBS &&
    (await registeredIndexLists(env.BLOBS, db, product.slug, channel, path))
  ) {
    const key = feedCacheKey(
      ctx.origin,
      new URL(req.url).pathname,
      null,
      await feedStateStamp(
        db,
        product.slug,
        readers.catalog,
        readers.notesPublic,
      ),
    );
    const location = await cachedFeedText(key, async () => {
      const selection = await selectFdroid(ctx, channel);
      return selection?.entries.find((e) => e.name === path)?.url ?? null;
    });
    if (location)
      return harden(
        new Response(null, {
          status: 302,
          headers: { location, "cache-control": RELAY_CACHE },
        }),
      );
  }
  return harden(notFound());
}

/** The largest registered index the relay reads to learn which APK names it lists. */
const MAX_INDEX_READ_BYTES = 8 * 1024 * 1024;

/**
 * Does the channel's registered `index-v2.json` list `/<name>` as a version's file? The index is
 * what clients download from, so an APK it does not name is never asked for by one.
 */
async function registeredIndexLists(
  blobs: R2Bucket,
  db: Db,
  product: string,
  channel: string,
  name: string,
): Promise<boolean> {
  const row = await db.first<{ sha256: string; size: number }>(
    `SELECT sha256, size FROM dist_feed_files
      WHERE product = ? AND feed = ? AND channel = ? AND path = 'index-v2.json'`,
    product,
    FDROID_FEED,
    channel,
  );
  if (!row || row.size > MAX_INDEX_READ_BYTES) return false;
  const obj = await blobs.get(blobKey(row.sha256));
  if (!obj) return false;
  let index: unknown;
  try {
    index = JSON.parse(await obj.text());
  } catch {
    return false;
  }
  const packages = (index as { packages?: unknown })?.packages;
  if (!packages || typeof packages !== "object") return false;
  for (const pkg of Object.values(packages as Record<string, unknown>)) {
    const versions = (pkg as { versions?: unknown })?.versions;
    if (!versions || typeof versions !== "object") continue;
    for (const v of Object.values(versions as Record<string, unknown>))
      if ((v as { file?: { name?: unknown } })?.file?.name === `/${name}`)
        return true;
  }
  return false;
}

// ── The CI read: the generator's inputs ──────────────────────────────────────────────────────

/** `GET /<p>/distribution/feeds/fdroid/<channel>` — what `pkey feeds fdroid` builds from. */
export async function fdroidInputs(
  ctx: FeedReadContext & { env: Env },
  rawChannel: string,
): Promise<Response> {
  const selection = await selectFdroid(ctx, rawChannel);
  if (!selection)
    return errorResponse(404, ErrorCode.NotFound, "no F-Droid feed here", {
      reason: "no_feed",
    });
  const delivery = ctx.hooks.delivery();
  const keys = delivery ? await delivery.keys({ purpose: "fdroid-repo" }) : [];
  // Which listed releases the stable channel serves: the rest are tagged `releaseChannels:
  // ["Beta"]` in the index, so a client's "suggested version" stays on stable.
  const stable = new Set(
    (
      (await ctx.hooks
        .releaseCatalog()
        ?.channelReleases(APP_DELIVERABLE_ID, "stable")) ?? { releases: [] }
    ).releases.map((r) => r.releaseId),
  );
  const repoUrl = `${ctx.origin}/${ctx.product.slug}/distribution/fdroid/${encodeURIComponent(selection.channel)}/repo`;
  return json({
    product: ctx.product.slug,
    channel: selection.channel,
    outlet: selection.outlet.id,
    packageName:
      typeof selection.outlet.identity.packageName === "string"
        ? selection.outlet.identity.packageName
        : null,
    repo: {
      address: repoUrl,
      fingerprints: keys.map((k) => k.sha256).sort(),
    },
    productName: ctx.product.name,
    listing: selection.outlet.listing,
    versions: selection.entries.map((e) => ({
      releaseId: e.releaseId,
      version: e.version,
      stable: stable.has(e.releaseId),
      publishedAt: e.publishedAt,
      notes: e.notes,
      apk: { name: e.name, sha256: e.sha256, size: e.size, url: e.url },
      metadata: e.metadata,
    })),
    files: (await feedFiles(ctx.db, ctx.product.slug, selection.channel)).map(
      (f) => ({ path: f.path, sha256: f.sha256, size: f.size }),
    ),
  });
}

// ── The CI register ──────────────────────────────────────────────────────────────────────────

export interface RegisterContext extends FeedReadContext {
  env: Env;
  now: number;
  principal: CiPrincipal;
}

function bad(
  reason: string,
  message: string,
  extra: Record<string, unknown> = {},
) {
  return errorResponse(400, ErrorCode.BadRequest, message, {
    reason,
    ...extra,
  });
}

interface RegisterFile {
  path: string;
  sha256: string;
  size: number;
  contentType: string;
}

function parseFiles(raw: unknown): RegisterFile[] | Response {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_FEED_FILES)
    return bad(
      "bad_files",
      `files must be an array of 1 to ${MAX_FEED_FILES} {path, sha256, size} entries`,
    );
  const out: RegisterFile[] = [];
  const seen = new Set<string>();
  for (const [i, f] of raw.entries()) {
    const o = f as Record<string, unknown> | null;
    if (!o || typeof o !== "object" || Array.isArray(o))
      return bad("bad_files", `files[${i}] must be an object`);
    const path = o.path;
    const contentType = typeof path === "string" ? feedFileType(path) : null;
    if (typeof path !== "string" || !contentType)
      return bad(
        "bad_feed_path",
        `files[${i}].path must be a safe relative path ending in .${Object.keys(FEED_FILE_TYPES).join(", .")}`,
        { index: i },
      );
    if (seen.has(path))
      return bad("bad_files", `files[${i}].path ${path} appears twice`);
    seen.add(path);
    if (typeof o.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(o.sha256))
      return bad("bad_files", `files[${i}].sha256 must be 64 lower-case hex`);
    if (
      typeof o.size !== "number" ||
      !Number.isSafeInteger(o.size) ||
      o.size < 0 ||
      o.size > MAX_FEED_FILE_BYTES
    )
      return bad(
        "bad_files",
        `files[${i}].size must be an integer from 0 to ${MAX_FEED_FILE_BYTES}`,
      );
    out.push({ path, sha256: o.sha256, size: o.size, contentType });
  }
  const missing = FDROID_REQUIRED_FILES.filter((p) => !seen.has(p));
  if (missing.length)
    return bad(
      "incomplete_repository",
      `a repository needs ${missing.join(", ")}`,
      { missing },
    );
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function asTokenRecord(p: CiPrincipal): CiTokenRecord | null {
  return "tokenHash" in p && "expiresAt" in p
    ? (p as unknown as CiTokenRecord)
    : null;
}

/** `POST /<p>/distribution/feeds/fdroid/<channel>` — `{ticket?, files}`. */
export async function registerFdroid(
  ctx: RegisterContext,
  rawChannel: string,
  body: Record<string, unknown>,
): Promise<Response> {
  const { env, db, product, now, principal } = ctx;
  const bucket = env.BLOBS;
  if (!bucket)
    return errorResponse(404, ErrorCode.NotFound, "no blob store here", {
      reason: "no_blob_store",
    });
  const catalog = ctx.hooks.releaseCatalog();
  const delivery = ctx.hooks.delivery();
  const history =
    catalog && delivery
      ? await catalog.channelReleases(APP_DELIVERABLE_ID, rawChannel)
      : null;
  if (!catalog || !delivery || !history)
    return errorResponse(404, ErrorCode.NotFound, "no such channel", {
      reason: "unknown_channel",
    });
  const channel = history.channel;
  if (!(await pickOutlet(db, product.slug, { kinds: ["fdroid-repo"] })))
    return errorResponse(
      404,
      ErrorCode.NotFound,
      "the product declares no live fdroid-repo outlet",
      { reason: "unknown_outlet" },
    );
  const files = parseFiles(body.files);
  if (files instanceof Response) return files;

  // The relay serves every file to anyone, so no file may be an object a non-public deliverable's
  // release carries (the blob route's strictest-mode rule; the relay re-checks it per request).
  for (const f of files)
    if (!(await objectIsPublic(db, product.slug, catalog, f.sha256)))
      return errorResponse(
        403,
        ErrorCode.Forbidden,
        `${f.path}: that object belongs to a deliverable that is not public`,
        { reason: "not_public", path: f.path },
      );

  // Which objects an earlier register already earned (a `feed` ref), with the size and hash
  // promote verified. Every other object comes from the caller's own ticket, even one the product
  // already stores for a release: knowing a digest is not holding its bytes (THREAT-MODEL §3).
  const keys = files.map((f) => blobKey(f.sha256));
  const stored = await storedObjects(db, keys);
  const needed = new Map<string, RegisterFile>();
  for (const f of files) {
    const key = blobKey(f.sha256);
    if (await hasFeedRef(db, product.slug, key)) {
      const s = stored.get(key);
      if (!s || s.size !== f.size)
        return bad(
          "stored_object_mismatch",
          `${f.path}: the stored object with that sha256 is not ${f.size} bytes`,
          { path: f.path },
        );
      continue;
    }
    needed.set(key, f);
  }

  let claim: { ticketHash: string } | null = null;
  if (needed.size > 0) {
    const holder = asTokenRecord(principal);
    if (!holder)
      return errorResponse(401, ErrorCode.Unauthorized, "unknown CI token", {
        reason: "invalid_ci_token",
      });
    const found = await findUploadTicket(env, db, {
      ticket: body.ticket,
      product: product.slug,
      holder,
      now,
    });
    if (!found.ok)
      return errorResponse(
        found.status,
        found.status === 409
          ? ErrorCode.BadRequest
          : found.status === 403
            ? ErrorCode.Forbidden
            : ErrorCode.BadRequest,
        found.message,
        { reason: found.reason },
      );
    const ticket = found.ticket;
    for (const [key, f] of needed) {
      if (
        !ticket.objects.some(
          (o) => o.sha256 === f.sha256 && o.size === f.size && !o.gated,
        )
      )
        return bad(
          "object_not_in_ticket",
          `${f.path} (${key}) is not an object of this ticket`,
          { path: f.path },
        );
      const v = await verifyStaged(
        bucket,
        stagingKey(product.slug, ticket.ticketId, f.sha256),
        { sha256: f.sha256, size: f.size },
      );
      if (!v.ok)
        return bad(
          v.reason === "missing"
            ? "staged_object_missing"
            : "staged_object_mismatch",
          `${f.path} was ${v.reason === "missing" ? "not uploaded" : "uploaded with another sha256 or size"}`,
          { path: f.path },
        );
    }
    if (!(await claimUploadTicket(db, ticket.ticketHash, now)))
      return bad("ticket_redeemed", "this upload ticket was already redeemed");
    claim = { ticketHash: ticket.ticketHash };
    for (const [key, f] of needed) {
      const res = await promote(
        bucket,
        stagingKey(product.slug, ticket.ticketId, f.sha256),
        key,
        { sha256: f.sha256, size: f.size },
        { db, now, product: product.slug },
      );
      if (!res.ok) {
        await releaseUploadTicket(db, ticket.ticketHash, now);
        return errorResponse(
          409,
          ErrorCode.BadRequest,
          `${f.path} could not be promoted`,
          {
            reason: "promote_failed",
            path: f.path,
            retryable: true,
          },
        );
      }
    }
  }

  const refPrefix = `${FDROID_FEED}/${channel}/`;
  const stmts: DbStatement[] = [
    {
      sql: "DELETE FROM dist_feed_files WHERE product = ? AND feed = ? AND channel = ?",
      params: [product.slug, FDROID_FEED, channel],
    },
    {
      sql: `DELETE FROM blob_refs
             WHERE product = ? AND ref_kind = 'feed' AND substr(ref_id, 1, ?) = ?`,
      params: [product.slug, refPrefix.length, refPrefix],
    },
  ];
  for (const f of files) {
    stmts.push(
      {
        sql: `INSERT INTO dist_feed_files
                (product, feed, channel, path, sha256, size, content_type, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [
          product.slug,
          FDROID_FEED,
          channel,
          f.path,
          f.sha256,
          f.size,
          f.contentType,
          now,
        ],
      },
      stmtRecordRef(
        {
          product: product.slug,
          storageKey: blobKey(f.sha256),
          refKind: "feed",
          refId: `${refPrefix}${f.path}`,
        },
        now,
      ),
    );
  }
  try {
    await db.batch(stmts);
  } catch (e) {
    if (claim) await releaseUploadTicket(db, claim.ticketHash, now);
    throw e;
  }
  await appendAudit(db, {
    product: product.slug,
    id: randomId("aud"),
    at: now,
    actor_sub: ciActor(principal),
    actor_name: "CI",
    actor_email: null,
    action: "distribution.feeds.register",
    target_kind: "feed",
    target_id: `${FDROID_FEED}/${channel}`,
    parent_id: null,
    summary: `Registered ${files.length} F-Droid repository files for ${channel}`,
  });
  return json({
    ok: true,
    feed: FDROID_FEED,
    channel,
    files: files.map((f) => ({
      path: f.path,
      sha256: f.sha256,
      size: f.size,
      contentType: f.contentType,
    })),
  });
}
