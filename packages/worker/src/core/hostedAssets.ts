/// <reference types="@cloudflare/workers-types" />

/**
 * Hosted assets: Polaris Key's own copy of a developer's file (HA-01; notes/S-20 §6.2, §6.3).
 *
 * `ingest(ctx, product, slot, input)` is the ONE path by which a file a developer hosts — at a
 * URL, in a repo, on a GitHub release, in a console upload or a CI push — becomes a copy in the
 * Core blob store. Every way in (HA-05's pulls, HA-06's uploads, HA-08's release mirroring)
 * converges on the same steps:
 *
 *   1. guard and fetch (a pull only): `core/safeFetch.ts`;
 *   2. cap: the slot's byte cap, a code constant (`SLOT_CLASSES`; security bounds, S-18 §5.6);
 *   3. sniff: the type comes from the magic number (`core/sniff.ts`), never from a declared type.
 *      Image slots take PNG, JPEG, WebP, GIF or AVIF; video slots MP4; release files anything.
 *      SVG and HTML are never accepted;
 *   4. hash: SHA-256 over every byte, compared with the caller's expected hash when there is one;
 *   5. put: `putVerified` at `blobs/sha256/<hex>` with the sniffed `Content-Type`. The key is
 *      content-addressed, so a re-ingest of the same bytes stores nothing new and adds the ref;
 *   6. describe: an image's width and height from the Images binding's `.info()`, when bound;
 *   7. ref: the `hosted_assets` row, its `hosted-asset` ref (`<slot>@<locale>`), the drop of the
 *      refs a replaced copy held, and the `assets.ingest` audit row, in ONE D1 batch.
 *
 * ── POSSESSION (THREAT-MODEL §3) ────────────────────────────────────────────────────────────
 *
 * A product earns a ref only to bytes it has proven it holds. `ingest` therefore reads and hashes
 * EVERY byte, every time, even when the object is already stored (by this product or any other):
 * an expected hash is a claim to check, never a reason to skip the read. Whether the bytes were
 * already stored never leaves this module.
 *
 * ── FAILURE ─────────────────────────────────────────────────────────────────────────────────
 *
 * A refusal is a stable reason code (`IngestReason`), stored in `hosted_assets.error` and in the
 * audit row. A slot that already had a good copy KEEPS it: the row keeps its `sha256` and its
 * refs, and goes `failed` (or `stale`, when the source answered 404 or 410: the source is gone).
 *
 * ── SIZES ───────────────────────────────────────────────────────────────────────────────────
 *
 * Image slots are capped at 20 MiB at most, so their bytes are read into memory, hashed and put
 * as one buffer. Video and release-file slots are streamed into R2 without buffering, and so
 * need the hash and the length BEFORE the put (the key is named by the hash): a streamed ingest
 * without an expected SHA-256 and a known length is refused as `unverifiable`. Every release
 * file has one (GitHub's `digest` and the descriptor's `sha256`, S-20 §5).
 */

import type { Db, DbStatement } from "../db/types.js";
import type { Env } from "../env.js";
import { auditStatement } from "../repo.js";
import { randomId } from "../crypto.js";
import {
  blobKey,
  checksumHex,
  putVerified,
  recordObject,
  stmtRecordRef,
  streamSha256,
} from "./blobs.js";
import {
  bodyFailureReason,
  cappedStream,
  safeFetch,
  type FetchImpl,
  type SafeFetchReason,
} from "./safeFetch.js";
import {
  IMAGE_TYPES,
  peekStream,
  sniffContentType,
  SNIFF_BYTES,
  VIDEO_TYPES,
} from "./sniff.js";
import { listingAssetRule } from "./storefront/listingModel.js";

/** What a hosted asset's `blob_refs` rows are held as (`ref_id` = `<slot>@<locale>`). */
export const HOSTED_ASSET_REF = "hosted-asset";

const MiB = 1024 * 1024;

/** What a slot accepts and how much of it. Code constants: security bounds, not settings. */
export interface SlotClass {
  name: "icon" | "art" | "notes-image" | "video" | "release-file";
  maxBytes: number;
  accept: "image" | "video" | "any";
}

export const SLOT_CLASSES = {
  icon: { name: "icon", maxBytes: 10 * MiB, accept: "image" },
  art: { name: "art", maxBytes: 20 * MiB, accept: "image" },
  "notes-image": { name: "notes-image", maxBytes: 5 * MiB, accept: "image" },
  video: { name: "video", maxBytes: 512 * MiB, accept: "video" },
  // R2's single-put limit (4.995 GiB); multipart is out of scope until a product needs it.
  "release-file": {
    name: "release-file",
    maxBytes: Math.floor(4.995 * 1024 * MiB),
    accept: "any",
  },
} as const satisfies Record<string, SlotClass>;

/** The largest slot whose bytes are read into memory; anything larger is streamed. */
const BUFFER_MAX = 32 * MiB;

const PRODUCT_RE = /^[a-z0-9-]{1,64}$/;
const LOCALE_RE = /^(?:[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3})?$/;
const SCREENSHOT_RE = /^listing\.screenshot:([1-9][0-9]?)$/;
const NOTES_IMAGE_RE = /^notes-image:[0-9a-f]{16,64}$/;
const RELEASE_FILE_RE = /^release-file(?::[A-Za-z0-9._@-]{1,160})?$/;
/** Listing slots that are not images Polaris Key hosts: store packs (ZIPs) and a link. */
const NOT_HOSTED = /^pack:|^youtube-url$/;

/**
 * The class of `slot`, or `null` when it is not a hosted-asset slot. The one list of slots:
 *
 *   presentation.icon, listing.icon                     icon          10 MiB, image
 *   listing.header, listing.screenshot:<1..16>          art           20 MiB, image
 *   every A-18 listing image slot (`play:icon`, …)      icon or art   by name
 *   notes-image:<urlhash>                               notes-image    5 MiB, image
 *   trailer-master                                      video        512 MiB, MP4
 *   release-file, release-file:<id>                     release-file 4.995 GiB, any type
 */
export function slotClass(slot: string): SlotClass | null {
  if (typeof slot !== "string" || slot.length > 200) return null;
  if (slot === "presentation.icon" || slot === "listing.icon")
    return SLOT_CLASSES.icon;
  if (slot === "listing.header") return SLOT_CLASSES.art;
  const shot = SCREENSHOT_RE.exec(slot);
  if (shot) return Number(shot[1]) <= 16 ? SLOT_CLASSES.art : null;
  if (NOTES_IMAGE_RE.test(slot)) return SLOT_CLASSES["notes-image"];
  if (RELEASE_FILE_RE.test(slot)) return SLOT_CLASSES["release-file"];
  if (slot === "trailer-master") return SLOT_CLASSES.video;
  if (NOT_HOSTED.test(slot)) return null;
  if (listingAssetRule(slot) !== undefined)
    return /icon/.test(slot) ? SLOT_CLASSES.icon : SLOT_CLASSES.art;
  return null;
}

export type HostedAssetOrigin =
  | "manifest"
  | "console"
  | "ci"
  | "release-mirror";
export type HostedAssetSourceKind =
  | "url"
  | "repo"
  | "upload"
  | "ci"
  | "github-asset";
export type HostedAssetStatus = "pending" | "ready" | "failed" | "stale";

/** Every reason an ingest is refused, as stored in `hosted_assets.error`. Stable strings. */
export type IngestReason =
  | SafeFetchReason
  | "too-large"
  | "not-an-image"
  | "not-a-video"
  | "sha256-mismatch"
  | "size-mismatch"
  /** A streamed (video or release-file) ingest without an expected SHA-256 and a known length. */
  | "unverifiable"
  /** The store refused or raced the write (the collector, a concurrent ingest): try again. */
  | "retry"
  /** Over the product's hosting quota (HA-10 enforces it; reserved here). */
  | "quota"
  /** No blob store is bound: nothing was attempted and no row was written. */
  | "unavailable";

/** Who asked, for the audit row. A pull at register or resync is the system's. */
export interface IngestActor {
  sub: string | null;
  name: string | null;
}

interface IngestCommon {
  origin: HostedAssetOrigin;
  /** `''` (the default) is every locale. */
  locale?: string;
  /** The SHA-256 the bytes must have (the manifest's, GitHub's `digest`, the descriptor's). */
  expectedSha256?: string | null;
  actor?: IngestActor;
}

export type IngestInput =
  | (IngestCommon & {
      kind: "pull";
      url: string;
      /** `url` unless the caller names a different kind (a repo path's raw URL is `repo`). */
      sourceKind?: HostedAssetSourceKind;
      /** What to record as the source; the URL by default (`<path>@<commit>` for a repo). */
      sourceRef?: string;
      /** Extra request headers. `authorization` reaches the first hop only (`safeFetch`). */
      headers?: Record<string, string>;
      /** Pull even when the source's validator says the stored copy is current. */
      force?: boolean;
    })
  | (IngestCommon & {
      kind: "stream";
      body: ReadableStream;
      /** The declared length; the bytes must be exactly this long. */
      size: number;
      sourceKind: HostedAssetSourceKind;
      sourceRef?: string | null;
      sourceEtag?: string | null;
    });

export type IngestResult =
  | {
      ok: true;
      status: "ready";
      sha256: string;
      size: number;
      contentType: string;
      width: number | null;
      height: number | null;
    }
  /** The source answered 304 to the stored validator: the copy is current, nothing changed. */
  | { ok: true; status: "unchanged"; sha256: string | null }
  | { ok: false; reason: IngestReason };

export interface IngestContext {
  env: Pick<Env, "BLOBS" | "IMAGES">;
  db: Db;
  now: number;
  /** A test seam for pulls; the global `fetch` otherwise. */
  fetchImpl?: FetchImpl;
}

/** A programming error: a product, slot or locale no caller should pass. Nothing is written. */
export class HostedAssetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostedAssetError";
  }
}

export interface HostedAssetRow {
  product: string;
  slot: string;
  locale: string;
  origin: string;
  source_kind: string;
  source_ref: string | null;
  source_etag: string | null;
  sha256: string | null;
  size: number | null;
  content_type: string | null;
  width: number | null;
  height: number | null;
  variants_json: string | null;
  status: string;
  error: string | null;
  checked_at: number | null;
  modified_at: number;
}

/** One hosted asset's row, or `null`. */
export async function getHostedAsset(
  db: Db,
  product: string,
  slot: string,
  locale = "",
): Promise<HostedAssetRow | null> {
  return db.first<HostedAssetRow>(
    `SELECT product, slot, locale, origin, source_kind, source_ref, source_etag, sha256, size,
            content_type, width, height, variants_json, status, error, checked_at, modified_at
       FROM hosted_assets WHERE product = ? AND slot = ? AND locale = ?`,
    product,
    slot,
    locale,
  );
}

/** The `ref_id` of a slot's refs. */
export function hostedAssetRefId(slot: string, locale = ""): string {
  return `${slot}@${locale}`;
}

const SYSTEM_ACTOR: IngestActor = { sub: null, name: "Polaris Key" };
const PULL_USER_AGENT = "polaris-key-asset-puller/1";

function hexOf(buf: ArrayBuffer): string {
  let out = "";
  for (const b of new Uint8Array(buf)) out += b.toString(16).padStart(2, "0");
  return out;
}

/** Read a (capped) stream into one buffer. */
async function readAll(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
  } catch (err) {
    await reader.cancel().catch(() => undefined);
    throw err;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

/** A pass-through that remembers the first error its source raised (the cap, the timeout). */
function monitored(stream: ReadableStream<Uint8Array>): {
  stream: ReadableStream<Uint8Array>;
  error: () => unknown;
} {
  const reader = stream.getReader();
  let failure: unknown;
  return {
    error: () => failure,
    stream: new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const r = await reader.read();
          if (r.done) controller.close();
          else controller.enqueue(r.value);
        } catch (err) {
          failure ??= err;
          controller.error(err);
        }
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    }),
  };
}

function acceptReason(
  cls: SlotClass,
  type: string,
): "not-an-image" | "not-a-video" | null {
  if (cls.accept === "image" && !IMAGE_TYPES.has(type)) return "not-an-image";
  if (cls.accept === "video" && !VIDEO_TYPES.has(type)) return "not-a-video";
  return null;
}

async function imageInfo(
  env: IngestContext["env"],
  bytes: Uint8Array,
): Promise<{ width: number | null; height: number | null }> {
  if (!env.IMAGES) return { width: null, height: null };
  try {
    const info = await env.IMAGES.info(
      new Response(bytes).body as ReadableStream<Uint8Array>,
    );
    if ("width" in info && Number.isSafeInteger(info.width))
      return { width: info.width, height: info.height };
  } catch {
    // Not an image to the binding, or the binding failed: the copy is still good.
  }
  return { width: null, height: null };
}

interface Stored {
  sha256: string;
  size: number;
  contentType: string;
  width: number | null;
  height: number | null;
}

/** Record the stored object, then confirm it is still there (the collector race, `promote`). */
async function recordAndConfirm(
  ctx: IngestContext,
  bucket: R2Bucket,
  key: string,
  stored: { sha256: string; size: number },
  alreadyStored: boolean,
  rePut: (() => Promise<boolean>) | null,
): Promise<boolean> {
  const recorded = await recordObject(
    ctx.db,
    {
      storageKey: key,
      sha256: stored.sha256,
      size: stored.size,
      kind: "blob",
      gated: false,
    },
    ctx.now,
  );
  if (!recorded) return false;
  if (!alreadyStored) return true;
  // The bytes were confirmed before the row was recorded; the sweep may have deleted them in
  // between. `recordObject` has now cleared `unreferenced_since`, so this look is authoritative.
  const again = await bucket.head(key);
  if (again)
    return again.size === stored.size && checksumHex(again) === stored.sha256;
  return rePut ? rePut() : false;
}

/** An existing object at `key` that IS these bytes (`putVerified` answered `exists`). */
async function existingMatches(
  bucket: R2Bucket,
  key: string,
  sha256: string,
  size: number,
): Promise<boolean> {
  const head = await bucket.head(key);
  return !!head && head.size === size && checksumHex(head) === sha256;
}

/** Buffered path: image slots (≤ 20 MiB). */
async function storeBuffered(
  ctx: IngestContext,
  bucket: R2Bucket,
  cls: SlotClass,
  body: ReadableStream<Uint8Array>,
  declared: number | null,
  expected: string | null,
): Promise<Stored | IngestReason> {
  let bytes: Uint8Array;
  try {
    bytes = await readAll(body);
  } catch (err) {
    return bodyFailureReason(err);
  }
  if (declared !== null && bytes.byteLength !== declared)
    return "size-mismatch";
  const contentType = sniffContentType(bytes.subarray(0, SNIFF_BYTES));
  const refused = acceptReason(cls, contentType);
  if (refused) return refused;
  const sha256 = hexOf(await crypto.subtle.digest("SHA-256", bytes));
  if (expected && expected !== sha256) return "sha256-mismatch";
  const key = blobKey(sha256);
  const expect = { sha256, size: bytes.byteLength };
  const put = await putVerified(bucket, key, bytes, expect, { contentType });
  let alreadyStored = false;
  if (!put.ok) {
    if (put.reason !== "exists") return "retry";
    if (!(await existingMatches(bucket, key, sha256, bytes.byteLength)))
      return "retry";
    alreadyStored = true;
  }
  const confirmed = await recordAndConfirm(
    ctx,
    bucket,
    key,
    expect,
    alreadyStored,
    async () =>
      (await putVerified(bucket, key, bytes, expect, { contentType })).ok,
  );
  if (!confirmed) return "retry";
  const dims =
    cls.accept === "image"
      ? await imageInfo(ctx.env, bytes)
      : { width: null, height: null };
  return { sha256, size: bytes.byteLength, contentType, ...dims };
}

/** Streamed path: video and release-file slots, verified by R2 against the expected hash. */
async function storeStreamed(
  ctx: IngestContext,
  bucket: R2Bucket,
  cls: SlotClass,
  body: ReadableStream<Uint8Array>,
  declared: number | null,
  expected: string | null,
): Promise<Stored | IngestReason> {
  if (!expected || declared === null) {
    await body.cancel().catch(() => undefined);
    return "unverifiable";
  }
  const watched = monitored(body);
  let head: Uint8Array;
  let stream: ReadableStream<Uint8Array>;
  try {
    ({ head, stream } = await peekStream(watched.stream, SNIFF_BYTES));
  } catch (err) {
    return bodyFailureReason(err);
  }
  const contentType = sniffContentType(head);
  const refused = acceptReason(cls, contentType);
  if (refused) {
    await stream.cancel().catch(() => undefined);
    return refused;
  }
  const key = blobKey(expected);
  const expect = { sha256: expected, size: declared };
  const existing = await existingMatches(bucket, key, expected, declared);
  if (existing) {
    // Already stored. Possession still has to be proven: hash every byte.
    let got: { sha256: string; bytes: number };
    try {
      got = await streamSha256(stream);
    } catch (err) {
      return bodyFailureReason(watched.error() ?? err);
    }
    if (got.bytes !== declared) return "size-mismatch";
    if (got.sha256 !== expected) return "sha256-mismatch";
  } else {
    const put = await putVerified(bucket, key, stream, expect, {
      contentType,
    });
    if (!put.ok) {
      const failure = watched.error();
      if (failure !== undefined) return bodyFailureReason(failure);
      if (put.reason === "rejected") return "sha256-mismatch";
      return "retry";
    }
  }
  const confirmed = await recordAndConfirm(
    ctx,
    bucket,
    key,
    expect,
    existing,
    null,
  );
  if (!confirmed) return "retry";
  return {
    sha256: expected,
    size: declared,
    contentType,
    width: null,
    height: null,
  };
}

function auditRow(
  product: string,
  slot: string,
  locale: string,
  actor: IngestActor,
  now: number,
  summary: string,
): DbStatement {
  return auditStatement({
    product,
    id: randomId("aud"),
    at: now,
    actor_sub: actor.sub,
    actor_name: actor.name,
    actor_email: null,
    action: "assets.ingest",
    target_kind: "hosted-asset",
    target_id: hostedAssetRefId(slot, locale),
    parent_id: null,
    summary,
  });
}

/**
 * Ingest one file into `slot` of `product` (S-20 §6.3). Throws `HostedAssetError` for a product,
 * slot or locale no caller should pass; every other failure is an `IngestResult` refusal, recorded
 * on the row and audited.
 */
export async function ingest(
  ctx: IngestContext,
  product: string,
  slot: string,
  input: IngestInput,
): Promise<IngestResult> {
  if (!PRODUCT_RE.test(product))
    throw new HostedAssetError("product must be a product slug");
  const cls = slotClass(slot);
  if (!cls) throw new HostedAssetError(`${slot} is not a hosted-asset slot`);
  const locale = input.locale ?? "";
  if (!LOCALE_RE.test(locale))
    throw new HostedAssetError("locale must be a language tag or ''");
  const expected = input.expectedSha256?.toLowerCase() ?? null;
  if (expected !== null && !/^[0-9a-f]{64}$/.test(expected))
    throw new HostedAssetError("expectedSha256 must be 64 hex characters");
  const bucket = ctx.env.BLOBS;
  if (!bucket) {
    if (input.kind === "stream")
      await input.body.cancel().catch(() => undefined);
    return { ok: false, reason: "unavailable" };
  }
  const actor = input.actor ?? SYSTEM_ACTOR;
  const prev = await getHostedAsset(ctx.db, product, slot, locale);

  const source = {
    origin: input.origin,
    kind:
      input.kind === "pull" ? (input.sourceKind ?? "url") : input.sourceKind,
    ref:
      input.kind === "pull"
        ? (input.sourceRef ?? input.url)
        : (input.sourceRef ?? null),
    etag: input.kind === "stream" ? (input.sourceEtag ?? null) : null,
  };

  // 1. The bytes: a guarded pull, or the caller's stream under the slot's cap.
  let body: ReadableStream<Uint8Array>;
  let declared: number | null;
  if (input.kind === "pull") {
    const current =
      !input.force &&
      prev?.status === "ready" &&
      prev.sha256 !== null &&
      prev.source_ref === source.ref
        ? prev.source_etag
        : null;
    const res = await safeFetch(input.url, {
      maxBytes: cls.maxBytes,
      etag: current,
      headers: {
        "user-agent": PULL_USER_AGENT,
        ...(cls.accept === "image"
          ? { accept: [...IMAGE_TYPES].join(", ") }
          : {}),
        ...(input.headers ?? {}),
      },
      fetchImpl: ctx.fetchImpl,
    });
    if (!res.ok)
      return fail(ctx, product, slot, locale, prev, source, actor, res.reason);
    if (res.status === 304) {
      await ctx.db.batch([
        {
          sql: "UPDATE hosted_assets SET checked_at = ? WHERE product = ? AND slot = ? AND locale = ?",
          params: [ctx.now, product, slot, locale],
        },
        auditRow(
          product,
          slot,
          locale,
          actor,
          ctx.now,
          `${slot}: source unchanged`,
        ),
      ]);
      return { ok: true, status: "unchanged", sha256: prev?.sha256 ?? null };
    }
    body = res.body;
    declared = res.length;
    source.etag = res.etag;
  } else {
    if (!Number.isSafeInteger(input.size) || input.size < 0)
      throw new HostedAssetError("size must be a non-negative integer");
    if (input.size > cls.maxBytes) {
      await input.body.cancel().catch(() => undefined);
      return fail(ctx, product, slot, locale, prev, source, actor, "too-large");
    }
    body = cappedStream(input.body, cls.maxBytes);
    declared = input.size;
  }

  // 2–6. Cap, sniff, hash, put, describe.
  const stored =
    cls.maxBytes <= BUFFER_MAX
      ? await storeBuffered(ctx, bucket, cls, body, declared, expected)
      : await storeStreamed(ctx, bucket, cls, body, declared, expected);
  if (typeof stored === "string")
    return fail(ctx, product, slot, locale, prev, source, actor, stored);

  // 7. The row, the ref, the drop of a replaced copy's refs, the audit: one batch.
  const key = blobKey(stored.sha256);
  const refId = hostedAssetRefId(slot, locale);
  await ctx.db.batch([
    {
      sql: `INSERT INTO hosted_assets (product, slot, locale, origin, source_kind, source_ref,
              source_etag, sha256, size, content_type, width, height, variants_json, status, error,
              checked_at, modified_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', 'ready', NULL, ?, ?)
            ON CONFLICT(product, slot, locale) DO UPDATE SET
              origin = excluded.origin, source_kind = excluded.source_kind,
              source_ref = excluded.source_ref, source_etag = excluded.source_etag,
              sha256 = excluded.sha256, size = excluded.size,
              content_type = excluded.content_type, width = excluded.width,
              height = excluded.height,
              variants_json = CASE WHEN hosted_assets.sha256 IS excluded.sha256
                                   THEN hosted_assets.variants_json ELSE '[]' END,
              status = 'ready', error = NULL, checked_at = excluded.checked_at,
              modified_at = excluded.modified_at`,
      params: [
        product,
        slot,
        locale,
        source.origin,
        source.kind,
        source.ref,
        source.etag,
        stored.sha256,
        stored.size,
        stored.contentType,
        stored.width,
        stored.height,
        ctx.now,
        ctx.now,
      ],
    },
    stmtRecordRef(
      { product, storageKey: key, refKind: HOSTED_ASSET_REF, refId },
      ctx.now,
    ),
    // A replaced copy's refs (its original and its variants) go in the same batch. Unchanged
    // bytes keep their variants' refs, as the row keeps its `variants_json`.
    {
      sql: `DELETE FROM blob_refs
             WHERE product = ? AND ref_kind = ? AND ref_id = ? AND storage_key <> ?
               AND ? <> ?`,
      params: [
        product,
        HOSTED_ASSET_REF,
        refId,
        key,
        prev?.sha256 ?? "",
        stored.sha256,
      ],
    },
    auditRow(
      product,
      slot,
      locale,
      actor,
      ctx.now,
      `${slot}: hosted from ${source.kind} (${stored.contentType}, ${stored.size} bytes)`,
    ),
  ]);
  return {
    ok: true,
    status: "ready",
    sha256: stored.sha256,
    size: stored.size,
    contentType: stored.contentType,
    width: stored.width,
    height: stored.height,
  };
}

/**
 * Record a refusal. A slot with a good copy keeps it (its `sha256`, its source and its refs) and
 * goes `failed`, or `stale` when the source is gone (404, 410); a slot without one gets a `failed`
 * row naming the source that was tried.
 */
async function fail(
  ctx: IngestContext,
  product: string,
  slot: string,
  locale: string,
  prev: HostedAssetRow | null,
  source: {
    origin: HostedAssetOrigin;
    kind: HostedAssetSourceKind;
    ref: string | null;
    etag: string | null;
  },
  actor: IngestActor,
  reason: IngestReason,
): Promise<IngestResult> {
  const gone = reason === "status:404" || reason === "status:410";
  const audit = auditRow(
    product,
    slot,
    locale,
    actor,
    ctx.now,
    `${slot}: refused (${reason})`,
  );
  if (prev?.sha256) {
    await ctx.db.batch([
      {
        sql: `UPDATE hosted_assets SET status = ?, error = ?, checked_at = ?, modified_at = ?
               WHERE product = ? AND slot = ? AND locale = ?`,
        params: [
          gone ? "stale" : "failed",
          reason,
          ctx.now,
          ctx.now,
          product,
          slot,
          locale,
        ],
      },
      audit,
    ]);
  } else {
    await ctx.db.batch([
      {
        sql: `INSERT INTO hosted_assets (product, slot, locale, origin, source_kind, source_ref,
                source_etag, sha256, size, content_type, width, height, variants_json, status,
                error, checked_at, modified_at)
              VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'failed', ?, ?, ?)
              ON CONFLICT(product, slot, locale) DO UPDATE SET
                origin = excluded.origin, source_kind = excluded.source_kind,
                source_ref = excluded.source_ref, status = 'failed', error = excluded.error,
                checked_at = excluded.checked_at, modified_at = excluded.modified_at`,
        params: [
          product,
          slot,
          locale,
          source.origin,
          source.kind,
          source.ref,
          reason,
          ctx.now,
          ctx.now,
        ],
      },
      audit,
    ]);
  }
  return { ok: false, reason };
}
