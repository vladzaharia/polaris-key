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
 *   6. describe: an image's width and height from the Images binding's `.info()`, when bound,
 *      or from a row of the same product that already holds these bytes;
 *   7. vary (HA-03): the slot's WebP width ladder (`VARIANT_LADDERS`), never upscaled, each
 *      variant stored content-addressed like the original, or the ladder a row of the same
 *      product already built from these bytes in the same family. Best effort: see VARIANTS;
 *   8. ref: the `hosted_assets` row (with `variants_json`), its `hosted-asset` refs
 *      (`<slot>@<locale>`: the original and every variant), the drop of the refs a replaced copy
 *      held, and the `assets.ingest` audit row, in ONE D1 batch.
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
 * ── VARIANTS (HA-03; notes/S-20 §6.6, owner decision 4) ──────────────────────────────────────
 *
 * Sizes are generated once, here, and never on a request: the binding bills per unique
 * transformation, so one ingest costs at most one transformation per ladder width. A ladder is
 * built once per (product, original, family): a re-ingest of the same bytes reuses the variants
 * it already has, and the same bytes in another slot of the same family (`presentation.icon` and
 * `listing.icon`) reuse that slot's variants, with refs of their own (`<slot>@<locale>`, which
 * the image host checks). Never across products: a product never learns that another one holds
 * the same bytes. Only the slot families in `VARIANT_LADDERS` get a ladder (store-exact art
 * stays with the CLI, A-18d). A width above the original's is never requested, and
 * `fit: "scale-down"` would refuse to enlarge anyway.
 *
 * The ladder is all or nothing and never fails the ingest. Without the binding, without the
 * original's width, on error 9422 (the account's transformations are used up) or on any other
 * binding or store error, `variants_json` is `[]` and every consumer uses the original. A
 * variant whose bytes do not sniff as WebP, or exceed the slot's cap, voids the ladder too.
 *
 * A ready copy whose ladder is owed (`ladderOwedSql`: a ladder slot, `[]`, a width that admits a
 * rung or is unknown) is retried by HA-05's pull queue while the binding is bound: `rebuildLadder`
 * reads the stored original back (never the source) and builds only the ladder, with the pulls'
 * back-off (`core/hostedAssetPulls.ts`).
 *
 * ── SIZES ───────────────────────────────────────────────────────────────────────────────────
 *
 * Image slots are capped at 20 MiB at most, so their bytes are read into memory, hashed and put
 * as one buffer. Video and release-file slots are streamed into R2 without buffering, and so
 * need the hash and the length BEFORE the put (the key is named by the hash): a streamed ingest
 * without an expected SHA-256 and a known length is refused as `unverifiable`. Every release
 * file has one (GitHub's `digest` and the descriptor's `sha256`, S-20 §5). A pull may name the
 * length it expects (`expectedSize`): a source that declares another `Content-Length` is refused
 * as `size-mismatch` before a byte is read, and one that declares none is held to it.
 *
 * A release file's pull (HA-08, `services/release/mirror.ts`) gets a longer time budget than an
 * image's, scaled by its size (`releaseFileTimeoutMs`, at most `SAFE_FETCH_FILE_TIMEOUT_MS`): 30
 * seconds cannot move a gigabyte. Its caller may also narrow the hosts a redirect may reach
 * (`allowHost`, a GitHub asset's storage hosts), on top of the guard.
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
  SAFE_FETCH_FILE_TIMEOUT_MS,
  SAFE_FETCH_TIMEOUT_MS,
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

/** The slowest transfer a release file's time budget allows for (10 MiB/s). */
const RELEASE_FILE_MIN_BYTES_PER_SECOND = 10 * MiB;

/**
 * The time budget of a release file's pull (HA-08): the ordinary 30 s plus a second per 10 MiB of
 * the file, at most `SAFE_FETCH_FILE_TIMEOUT_MS` (which an unknown size gets).
 */
export function releaseFileTimeoutMs(size: number | null): number {
  if (size === null || !Number.isSafeInteger(size) || size < 0)
    return SAFE_FETCH_FILE_TIMEOUT_MS;
  return Math.min(
    SAFE_FETCH_TIMEOUT_MS +
      Math.ceil((size / RELEASE_FILE_MIN_BYTES_PER_SECOND) * 1000),
    SAFE_FETCH_FILE_TIMEOUT_MS,
  );
}

const PRODUCT_RE = /^[a-z0-9-]{1,64}$/;
const LOCALE_RE = /^(?:[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3})?$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const SCREENSHOT_RE = /^listing\.screenshot:([1-9][0-9]?)$/;
/** The listing's screenshot slots: `listing.screenshot:1` to `listing.screenshot:16`. */
const MAX_SCREENSHOTS = 16;
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
  if (shot) return Number(shot[1]) <= MAX_SCREENSHOTS ? SLOT_CLASSES.art : null;
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
      /**
       * The length the bytes must have, when the caller knows it (a release file's descriptor or
       * GitHub size). A source declaring another `Content-Length` is refused unread
       * (`size-mismatch`); one declaring none is held to this length.
       */
      expectedSize?: number | null;
      /** A host rule on top of the guard, for every hop (`safeFetch`'s `allowHost`): only narrows. */
      allowHost?: (host: string) => boolean;
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

/** Is `locale` a hosted-asset locale: `''` (every locale) or a language tag? */
export function isHostedAssetLocale(locale: unknown): locale is string {
  return typeof locale === "string" && LOCALE_RE.test(locale);
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
  /** The bytes, for an image slot (buffered), so the ladder can be built from them. */
  bytes?: Uint8Array;
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
  // The dimensions are `ingest`'s step 6: the same bytes may already be described.
  return {
    sha256,
    size: bytes.byteLength,
    contentType,
    width: null,
    height: null,
    bytes,
  };
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

// ── The variant ladder (HA-03) ────────────────────────────────────────────────────────────

/** The fixed WebP width ladders, per slot family (S-20 §6.6). Code constants. */
export const VARIANT_LADDERS = {
  icon: [64, 128, 256, 512, 1024],
  header: [640, 1280, 1920],
  screenshots: [480, 960, 1920],
} as const satisfies Record<string, readonly number[]>;

export type VariantFamily = keyof typeof VARIANT_LADDERS;

/** The one output format of a variant. */
export const VARIANT_FORMAT = "image/webp";

/** The binding's error code when the account's transformations are used up. */
export const IMAGES_QUOTA_ERROR = 9422;

/**
 * The first back-off step of a slot's retry, a pull or a ladder (HA-05, re-exported by
 * `core/hostedAssetPulls.ts`); it doubles per failure. Defined here because an ingest that leaves
 * a new copy owing its ladder records that failure as the ladder's first attempt.
 */
export const PULL_BACKOFF_BASE_SECONDS = 15 * 60;

/** One entry of `hosted_assets.variants_json`. */
export interface HostedAssetVariant {
  w: number;
  format: typeof VARIANT_FORMAT;
  sha256: string;
  size: number;
}

/** The ladder family of `slot`, or `null` when the slot gets no variants. */
export function variantFamily(slot: string): VariantFamily | null {
  if (slot === "presentation.icon" || slot === "listing.icon") return "icon";
  if (slot === "listing.header") return "header";
  if (SCREENSHOT_RE.test(slot) && slotClass(slot) !== null)
    return "screenshots";
  return null;
}

/** The ladder widths for `slot` at an original `width` px wide: never wider (no upscale). */
export function ladderWidths(slot: string, width: number | null): number[] {
  const family = variantFamily(slot);
  if (!family || width === null || !Number.isSafeInteger(width) || width < 1)
    return [];
  return VARIANT_LADDERS[family].filter((w) => w <= width);
}

/** A row's `variants_json`, read defensively: anything malformed reads as no variants. */
export function parseVariants(json: string | null): HostedAssetVariant[] {
  if (!json) return [];
  try {
    const v: unknown = JSON.parse(json);
    if (!Array.isArray(v)) return [];
    const ok = v.every(
      (e: Partial<HostedAssetVariant> | null) =>
        !!e &&
        Number.isSafeInteger(e.w) &&
        e.format === VARIANT_FORMAT &&
        typeof e.sha256 === "string" &&
        /^[0-9a-f]{64}$/.test(e.sha256) &&
        Number.isSafeInteger(e.size),
    );
    return ok ? (v as HostedAssetVariant[]) : [];
  } catch {
    return [];
  }
}

/** Store one variant's bytes content-addressed, as the original is; `false` when it cannot. */
async function storeVariant(
  ctx: IngestContext,
  bucket: R2Bucket,
  bytes: Uint8Array,
  sha256: string,
): Promise<boolean> {
  const key = blobKey(sha256);
  const expect = { sha256, size: bytes.byteLength };
  const opts = { contentType: VARIANT_FORMAT };
  const put = await putVerified(bucket, key, bytes, expect, opts);
  let alreadyStored = false;
  if (!put.ok) {
    if (put.reason !== "exists") return false;
    if (!(await existingMatches(bucket, key, sha256, bytes.byteLength)))
      return false;
    alreadyStored = true;
  }
  return recordAndConfirm(
    ctx,
    bucket,
    key,
    expect,
    alreadyStored,
    async () => (await putVerified(bucket, key, bytes, expect, opts)).ok,
  );
}

/**
 * Build `slot`'s ladder from the original's bytes. All or nothing, and never throws: `[]` when
 * the binding is missing, the width unknown, the quota used up (9422), or anything else fails.
 */
async function buildLadder(
  ctx: IngestContext,
  bucket: R2Bucket,
  cls: SlotClass,
  slot: string,
  original: Uint8Array,
  width: number | null,
): Promise<HostedAssetVariant[]> {
  const images = ctx.env.IMAGES;
  const widths = ladderWidths(slot, width);
  if (!images || widths.length === 0) return [];
  const out: HostedAssetVariant[] = [];
  try {
    for (const w of widths) {
      const result = await images
        .input(new Response(original).body as ReadableStream<Uint8Array>)
        .transform({ width: w, fit: "scale-down" })
        .output({ format: VARIANT_FORMAT });
      const bytes = await readAll(cappedStream(result.image(), cls.maxBytes));
      if (sniffContentType(bytes.subarray(0, SNIFF_BYTES)) !== VARIANT_FORMAT)
        return [];
      const sha256 = hexOf(await crypto.subtle.digest("SHA-256", bytes));
      if (!(await storeVariant(ctx, bucket, bytes, sha256))) return [];
      out.push({ w, format: VARIANT_FORMAT, sha256, size: bytes.byteLength });
    }
  } catch {
    // 9422 (`IMAGES_QUOTA_ERROR`: the month's transformations are used up), a binding failure,
    // an over-cap output or a store error: no variants; the original still serves.
    return [];
  }
  return out;
}

/** A row of the product that holds the same original bytes (any slot, any locale). */
interface SameBytesRow {
  slot: string;
  locale: string;
  width: number | null;
  height: number | null;
  variants_json: string | null;
}

/** The product's rows whose copy is the original `sha256`. Never another product's. */
async function sameBytes(
  db: Db,
  product: string,
  sha256: string,
): Promise<SameBytesRow[]> {
  return db.all<SameBytesRow>(
    `SELECT slot, locale, width, height, variants_json FROM hosted_assets
      WHERE product = ? AND sha256 = ? ORDER BY slot, locale`,
    product,
    sha256,
  );
}

/** The first known dimensions among `rows`, or `null`. */
function knownDims(
  rows: readonly SameBytesRow[],
): { width: number; height: number | null } | null {
  const row = rows.find(
    (r) => r.width !== null && Number.isSafeInteger(r.width),
  );
  return row ? { width: row.width!, height: row.height } : null;
}

/**
 * A ladder of `family` that a row among `rows` (the same product, the same original) already
 * built, and still holds every variant of through its own refs; `[]` when there is none. At a
 * known `width` the ladder must be exactly the widths that width yields today.
 */
async function reusableLadder(
  db: Db,
  product: string,
  slot: string,
  width: number | null,
  rows: readonly SameBytesRow[],
): Promise<HostedAssetVariant[]> {
  const family = variantFamily(slot);
  if (!family) return [];
  const want = width === null ? null : ladderWidths(slot, width).join(",");
  for (const row of rows) {
    if (variantFamily(row.slot) !== family) continue;
    const variants = parseVariants(row.variants_json);
    if (variants.length === 0) continue;
    if (want !== null && variants.map((v) => v.w).join(",") !== want) continue;
    const keys = [...new Set(variants.map((v) => blobKey(v.sha256)))];
    const held = await db.first<{ n: number }>(
      `SELECT COUNT(DISTINCT storage_key) AS n FROM blob_refs
        WHERE product = ? AND ref_kind = ? AND ref_id = ?
          AND storage_key IN (${keys.map(() => "?").join(", ")})`,
      product,
      HOSTED_ASSET_REF,
      hostedAssetRefId(row.slot, row.locale),
      ...keys,
    );
    if (held?.n === keys.length) return variants;
  }
  return [];
}

/**
 * SQL over a `hosted_assets` row (its columns prefixed by `p`, e.g. `"h."`): does the row owe its
 * ladder? A ready copy in a ladder slot (`variantFamily`) with `variants_json = '[]'`, whose width
 * admits at least one rung of its family, or is unknown (the binding was absent or failed at
 * ingest). A copy narrower than its family's smallest rung owes nothing: its `[]` is the ladder.
 * Only code constants are inlined. Whether the binding is bound is the caller's question.
 */
export function ladderOwedSql(p = ""): string {
  const min = (f: VariantFamily) => Math.min(...VARIANT_LADDERS[f]);
  const shots = Array.from(
    { length: MAX_SCREENSHOTS },
    (_, i) => `'listing.screenshot:${i + 1}'`,
  ).join(", ");
  return `(${p}status = 'ready' AND ${p}sha256 IS NOT NULL AND ${p}variants_json = '[]'
    AND COALESCE(${p}width, ${Number.MAX_SAFE_INTEGER}) >= CASE
      WHEN ${p}slot IN ('presentation.icon', 'listing.icon') THEN ${min("icon")}
      WHEN ${p}slot = 'listing.header' THEN ${min("header")}
      WHEN ${p}slot IN (${shots}) THEN ${min("screenshots")}
    END)`;
}

/** Does a ready copy of `slot` at `width`, with `variants`, owe its ladder (`ladderOwedSql`)? */
function owesLadder(
  slot: string,
  width: number | null,
  variants: readonly HostedAssetVariant[],
): boolean {
  if (variants.length > 0 || variantFamily(slot) === null) return false;
  return width === null || ladderWidths(slot, width).length > 0;
}

/** The stored original, read back and checked against its name; `null` when it cannot be. */
async function readOriginal(
  bucket: R2Bucket,
  sha256: string,
  size: number | null,
  maxBytes: number,
): Promise<Uint8Array | null> {
  try {
    const obj = await bucket.get(blobKey(sha256));
    if (!obj || !("body" in obj)) return null;
    if (
      checksumHex(obj) !== sha256 ||
      (size !== null && obj.size !== size) ||
      obj.size > maxBytes
    ) {
      await obj.body.cancel().catch(() => undefined);
      return null;
    }
    const bytes = await readAll(cappedStream(obj.body, maxBytes));
    const got = hexOf(await crypto.subtle.digest("SHA-256", bytes));
    return got === sha256 ? bytes : null;
  } catch {
    return null;
  }
}

/** What a ladder rebuild did. */
export type LadderOutcome =
  /** The ladder was written: built from the stored original, or reused from a sibling slot. */
  | "built"
  /** The original's width, now known, admits no rung: recorded; the copy owes no ladder. */
  | "none"
  /** The row no longer owes this ladder (new bytes, a ladder already built, a removed slot). */
  | "superseded"
  /** The original could not be read back, or the binding failed again (9422 included). */
  | "failed"
  /** No blob store or no Images binding: nothing attempted. */
  | "unavailable";

/**
 * Build the ladder a ready copy owes (`ladderOwedSql`) from the stored original, for HA-05's
 * retry: never a pull, never a new original. The same product's same bytes in the same family
 * lend their ladder first (no transformation at all); otherwise the original is read back from
 * the store, checked against its name, and transformed as `ingest` would. The row, the slot's
 * new refs and the `assets.variants` audit row are written in ONE batch, and only while the row
 * still holds `sha256` with an empty ladder. Throws `HostedAssetError` for a product, slot,
 * locale or hash no caller should pass.
 */
export async function rebuildLadder(
  ctx: IngestContext,
  product: string,
  slot: string,
  locale: string,
  sha256: string,
): Promise<LadderOutcome> {
  if (!PRODUCT_RE.test(product))
    throw new HostedAssetError("product must be a product slug");
  const cls = slotClass(slot);
  if (!cls || variantFamily(slot) === null)
    throw new HostedAssetError(`${slot} is not a slot with a variant ladder`);
  if (!LOCALE_RE.test(locale))
    throw new HostedAssetError("locale must be a language tag or ''");
  if (!SHA256_RE.test(sha256))
    throw new HostedAssetError("sha256 must be 64 hex characters");
  const bucket = ctx.env.BLOBS;
  if (!bucket || !ctx.env.IMAGES) return "unavailable";
  const row = await ctx.db.first<{
    size: number | null;
    width: number | null;
    height: number | null;
  }>(
    `SELECT size, width, height FROM hosted_assets
      WHERE product = ? AND slot = ? AND locale = ? AND sha256 = ? AND ${ladderOwedSql()}`,
    product,
    slot,
    locale,
    sha256,
  );
  if (!row) return "superseded";

  const same = await sameBytes(ctx.db, product, sha256);
  let dims: { width: number | null; height: number | null } = {
    width: row.width,
    height: row.height,
  };
  if (dims.width === null) dims = knownDims(same) ?? dims;
  // A failure keeps a width learned on the way (from the same bytes or `.info()`), on the same
  // copy only, so the next retry neither asks the binding again nor re-reads for it.
  const failed = async (): Promise<LadderOutcome> => {
    if (row.width === null && dims.width !== null)
      await ctx.db.run(
        `UPDATE hosted_assets SET width = ?, height = ?
          WHERE product = ? AND slot = ? AND locale = ? AND sha256 = ? AND width IS NULL`,
        dims.width,
        dims.height,
        product,
        slot,
        locale,
        sha256,
      );
    return "failed";
  };
  let variants: HostedAssetVariant[] = [];
  let source = "the stored copy";
  // A width already known to admit no rung needs no read and no build: record it ("none").
  if (dims.width === null || ladderWidths(slot, dims.width).length > 0) {
    variants = await reusableLadder(ctx.db, product, slot, dims.width, same);
    if (variants.length > 0) source = "an identical copy";
    else {
      const original = await readOriginal(
        bucket,
        sha256,
        row.size,
        cls.maxBytes,
      );
      if (!original) return failed();
      if (dims.width === null) dims = await imageInfo(ctx.env, original);
      if (dims.width === null) return "failed";
      if (ladderWidths(slot, dims.width).length > 0) {
        variants = await buildLadder(
          ctx,
          bucket,
          cls,
          slot,
          original,
          dims.width,
        );
        if (variants.length === 0) return failed();
      }
    }
  }

  // Every statement is guarded by the same condition, read before the last one (the row's
  // update) changes it: all of them apply, or none (a re-ingest or a removal got there first).
  const guard = `EXISTS (SELECT 1 FROM hosted_assets
    WHERE product = ? AND slot = ? AND locale = ? AND sha256 = ?
      AND status = 'ready' AND variants_json = '[]')`;
  const guardParams = [product, slot, locale, sha256];
  const refId = hostedAssetRefId(slot, locale);
  const statements: DbStatement[] = [
    ...variants.map((v) => ({
      sql: `INSERT INTO blob_refs (product, storage_key, ref_kind, ref_id, created_at)
            SELECT ?, ?, ?, ?, ? WHERE ${guard}
            ON CONFLICT(product, storage_key, ref_kind, ref_id) DO UPDATE SET
              created_at = MAX(blob_refs.created_at, excluded.created_at)`,
      params: [
        product,
        blobKey(v.sha256),
        HOSTED_ASSET_REF,
        refId,
        ctx.now,
        ...guardParams,
      ],
    })),
  ];
  if (variants.length > 0)
    statements.push({
      sql: `INSERT INTO audit (product, id, at, actor_sub, actor_name, actor_email, action,
              target_kind, target_id, parent_id, summary)
            SELECT ?, ?, ?, ?, ?, NULL, 'assets.variants', 'hosted-asset', ?, NULL, ? WHERE ${guard}`,
      params: [
        product,
        randomId("aud"),
        ctx.now,
        SYSTEM_ACTOR.sub,
        SYSTEM_ACTOR.name,
        refId,
        `${slot}: sizes ${variants.map((v) => v.w).join(", ")} from ${source}`,
        ...guardParams,
      ],
    });
  statements.push({
    sql: `UPDATE hosted_assets SET variants_json = ?, width = COALESCE(width, ?),
            height = COALESCE(height, ?), modified_at = ?
           WHERE product = ? AND slot = ? AND locale = ? AND sha256 = ?
             AND status = 'ready' AND variants_json = '[]'`,
    params: [
      JSON.stringify(variants),
      dims.width,
      dims.height,
      ctx.now,
      ...guardParams,
    ],
  });
  if (ctx.db.batchChanges) {
    const changes = await ctx.db.batchChanges(statements);
    if (changes.at(-1) === 0) return "superseded";
  } else await ctx.db.batch(statements);
  return variants.length > 0 ? "built" : "none";
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
  const expectedSize =
    input.kind === "pull" ? (input.expectedSize ?? null) : null;
  if (
    expectedSize !== null &&
    (!Number.isSafeInteger(expectedSize) || expectedSize < 0)
  )
    throw new HostedAssetError("expectedSize must be a non-negative integer");
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
      ...(cls.name === "release-file"
        ? { releaseFile: true, timeoutMs: releaseFileTimeoutMs(expectedSize) }
        : {}),
      ...(input.allowHost ? { allowHost: input.allowHost } : {}),
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
    if (
      expectedSize !== null &&
      res.length !== null &&
      res.length !== expectedSize
    ) {
      await res.body.cancel().catch(() => undefined);
      return fail(
        ctx,
        product,
        slot,
        locale,
        prev,
        source,
        actor,
        "size-mismatch",
      );
    }
    body = res.body;
    declared = res.length ?? expectedSize;
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

  // 6. Describe, and 7. vary. The product's rows that already hold these bytes (this slot's own
  // previous copy among them) lend their dimensions, and in the same family their ladder, with
  // refs of this slot's own: no binding call is repeated for bytes the product already holds.
  const same =
    cls.accept === "image"
      ? await sameBytes(ctx.db, product, stored.sha256)
      : [];
  if (stored.bytes && cls.accept === "image") {
    const dims = knownDims(same) ?? (await imageInfo(ctx.env, stored.bytes));
    stored.width = dims.width;
    stored.height = dims.height;
  }
  const reused = await reusableLadder(
    ctx.db,
    product,
    slot,
    stored.width,
    same,
  );
  const variants =
    reused.length > 0 || !stored.bytes
      ? reused
      : await buildLadder(ctx, bucket, cls, slot, stored.bytes, stored.width);

  // 8. The row, the refs, the drop of a replaced copy's refs, the audit: one batch.
  const key = blobKey(stored.sha256);
  const refId = hostedAssetRefId(slot, locale);
  const keys = [key, ...variants.map((v) => blobKey(v.sha256))];
  // A NEW copy (other bytes than the row held, whatever way in) starts with a clean back-off:
  // none, or, when it owes its ladder while the binding is bound, this ingest as the ladder's
  // first failed attempt (HA-05 retries it one step later). The same bytes keep the row's.
  const owed = !!ctx.env.IMAGES && owesLadder(slot, stored.width, variants);
  await ctx.db.batch([
    {
      sql: `INSERT INTO hosted_assets (product, slot, locale, origin, source_kind, source_ref,
              source_etag, sha256, size, content_type, width, height, variants_json, status, error,
              checked_at, modified_at, attempts, next_attempt_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', NULL, ?, ?, ?, ?)
            ON CONFLICT(product, slot, locale) DO UPDATE SET
              origin = excluded.origin, source_kind = excluded.source_kind,
              source_ref = excluded.source_ref, source_etag = excluded.source_etag,
              sha256 = excluded.sha256, size = excluded.size,
              content_type = excluded.content_type, width = excluded.width,
              height = excluded.height, variants_json = excluded.variants_json,
              status = 'ready', error = NULL, checked_at = excluded.checked_at,
              modified_at = excluded.modified_at,
              attempts = CASE WHEN hosted_assets.sha256 IS excluded.sha256
                THEN hosted_assets.attempts ELSE excluded.attempts END,
              next_attempt_at = CASE WHEN hosted_assets.sha256 IS excluded.sha256
                THEN hosted_assets.next_attempt_at ELSE excluded.next_attempt_at END`,
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
        JSON.stringify(variants),
        ctx.now,
        ctx.now,
        owed ? 1 : 0,
        owed ? ctx.now + PULL_BACKOFF_BASE_SECONDS : null,
      ],
    },
    // The slot's refs are exactly the original and the variants in `variants_json`: a replaced
    // copy's refs (its original and its variants) are dropped in this batch, and unchanged bytes
    // keep theirs, as the row keeps its variants.
    {
      sql: `DELETE FROM blob_refs
             WHERE product = ? AND ref_kind = ? AND ref_id = ?
               AND storage_key NOT IN (${keys.map(() => "?").join(", ")})`,
      params: [product, HOSTED_ASSET_REF, refId, ...keys],
    },
    ...keys.map((storageKey) =>
      stmtRecordRef(
        { product, storageKey, refKind: HOSTED_ASSET_REF, refId },
        ctx.now,
      ),
    ),
    auditRow(
      product,
      slot,
      locale,
      actor,
      ctx.now,
      `${slot}: hosted from ${source.kind} (${stored.contentType}, ${stored.size} bytes${
        variants.length > 0
          ? `; sizes ${variants.map((v) => v.w).join(", ")}`
          : ""
      })`,
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
