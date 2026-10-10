/// <reference types="@cloudflare/workers-types" />

/**
 * Files that are not on the web (HA-06; notes/S-20 §6.3 "Upload in the console" and "Push from
 * CI", owner decision 11): the two ways in beside HA-05's pulls, and the console's Revert and
 * delete-a-copy. Every byte still goes through `ingest` (HA-01): cap, sniff, hash, put, one batch.
 *
 *   console   `POST /manage/api/products/<p>/assets/<slot>[?locale=]`   a streamed body; the
 *             upload CLAIMS the slot (`origin = 'console'`)        (console/handlers/hostedAssets.ts)
 *   console   `DELETE …/assets/<slot>[?locale=]`                 Revert (a claim with a manifest
 *             source goes back to it) or delete-a-copy
 *   CI        `POST /<p>/assets`  `pkeyci_` + `assets:write`     objects staged through P2-02's
 *             upload ticket, then ingested                      (`handleAssetsPush`, below)
 *
 * ── PRECEDENCE (S-20 §6.3, S-18 model C) ────────────────────────────────────────────────────
 *
 *   1. A console upload claims the slot. A resync records what the manifest wants and pulls
 *      nothing (`core/assets/hostedAssetPulls.ts`), a pull in flight yields (`yieldsTo: ["console"]`) and
 *      a CI push is answered `kept`. Revert drops the claim.
 *   2. Otherwise the manifest's source.
 *   3. Otherwise a CI push: it yields to a claim and to any slot a manifest declares
 *      (`wanted_ref`), checked before the bytes are read and again inside `ingest`'s batch.
 *
 * ── STORE SLOTS (A-18) ──────────────────────────────────────────────────────────────────────
 *
 * A slot of the shared listing model (`listingAssetRule`: `icon-master`, `play:feature-graphic`,
 * `<store>:screenshot:<class>:<n>`, …) is also written into `dist_listing_assets`, with
 * `source = 'admin'` for a console upload and `'import'` for a CI push, through a
 * `ListingSlotMirror` the composition root hands in (the table is Distribution's; Core never
 * imports a service). A-18j's slot board and the store pushers then see the same bytes.
 *
 * ── REVERT AND DELETE ───────────────────────────────────────────────────────────────────────
 *
 * Revert applies to a console claim whose slot a manifest still declares (`wanted_ref`): the
 * console's copy and its refs are dropped at once, the row returns to the manifest as `pending`
 * (no copy served, a pull owed), and the pull is queued (`reason: "operator"`). Anything else is
 * delete-a-copy: the row and its refs go, so the image host stops answering for this slot at once
 * (its tenancy check is never cached); the bytes fall to the collector after the age lock. It is
 * per slot: the same bytes held by another slot of the product (the listing icon that falls back
 * to the product icon) keep serving at the same content-addressed URL. A manifest-declared slot is
 * pulled again at the next resync. Neither touches a developer's source.
 */

import type { Db, DbStatement } from "../../db/types.js";
import type { Env } from "../../platform/env.js";
import { randomId } from "../../platform/crypto.js";
import { errorResponse, ErrorCode, json, notFound } from "../errors.js";
import { blobKey, stagingKey } from "./blobs.js";
import {
  claimUploadTicket,
  findUploadTicket,
  releaseUploadTicket,
  type CiTokenRecord,
} from "../publisher.js";
import {
  ciActor,
  readCiJson,
  requireCiScope,
  type CiPrincipal,
} from "../ciScope.js";
import {
  HOSTED_ASSET_REF,
  getHostedAsset,
  hostedAssetRefId,
  ingest,
  isHostedAssetLocale,
  slotClass,
  type HostedAssetRow,
  type IngestActor,
  type IngestContext,
  type IngestReason,
  type IngestResult,
} from "./hostedAssets.js";
import {
  enqueueAssetPulls,
  parseWantedRef,
  PULL_BACKOFF_BASE_SECONDS,
  type AssetPullMessage,
} from "./hostedAssetPulls.js";
import { gitShaOrNull } from "../manifestSnapshot.js";
import { listingAssetRule } from "../storefront/listingModel.js";

/** Notes images (HA-16) are written from release notes, never uploaded. */
const NOTES_IMAGE_RE = /^notes-image:/;

/**
 * Can an operator upload (and delete) this slot, and can CI push it? Every IMAGE slot of
 * `slotClass` but the release-notes images: `presentation.icon`, `listing.icon`,
 * `listing.header`, `listing.screenshot:<1..16>` and every listing-model image slot. Never a
 * release file (HA-08 mirrors those), a video (HA-17), a store pack or the trailer link.
 */
export function isUploadSlot(slot: string): boolean {
  const cls = slotClass(slot);
  return cls !== null && cls.accept === "image" && !NOTES_IMAGE_RE.test(slot);
}

/** Is `slot` one of the shared listing model's image slots (A-18), mirrored into it? */
export function isListingModelSlot(slot: string): boolean {
  return isUploadSlot(slot) && listingAssetRule(slot) !== undefined;
}

/** The byte cap of an upload slot (`SLOT_CLASSES`), or `null` for any other slot. */
export function uploadSlotMaxBytes(slot: string): number | null {
  return isUploadSlot(slot) ? slotClass(slot)!.maxBytes : null;
}

// ── Image header facts (the listing model's width, height and alpha) ─────────────────────────

/** How many leading bytes `imageHeaderInfo` reads: enough for every header it parses. */
export const IMAGE_HEADER_BYTES = 64 * 1024;

export interface ImageHeaderInfo {
  width: number | null;
  height: number | null;
  /** Does the image carry transparency? `false` when the header cannot say. */
  alpha: boolean;
}

const u16be = (b: Uint8Array, i: number) => (b[i]! << 8) | b[i + 1]!;
const u16le = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8);
const u24le = (b: Uint8Array, i: number) =>
  b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16);
const u32be = (b: Uint8Array, i: number) =>
  ((b[i]! << 24) >>> 0) + ((b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!);
const tag = (b: Uint8Array, i: number) =>
  String.fromCharCode(b[i]!, b[i + 1]!, b[i + 2]!, b[i + 3]!);

/**
 * Width, height and alpha from an image's first bytes (PNG, JPEG, GIF, WebP; AVIF answers no
 * dimensions and no alpha). Header parsing only, never a decode: the Worker has no image library,
 * and the Images binding's `.info()` is preferred whenever `ingest` had it. Anything malformed or
 * cut short answers what it could read.
 */
export function imageHeaderInfo(
  b: Uint8Array,
  type: string | null,
): ImageHeaderInfo {
  const none: ImageHeaderInfo = { width: null, height: null, alpha: false };
  try {
    if (type === "image/png" && b.length >= 26) {
      const colour = b[25]!;
      const out: ImageHeaderInfo = {
        width: u32be(b, 16),
        height: u32be(b, 20),
        alpha: colour === 4 || colour === 6,
      };
      // A tRNS chunk before the first IDAT gives a palette or a colour key transparency.
      for (let i = 8; !out.alpha && i + 8 <= b.length; ) {
        const len = u32be(b, i);
        const name = tag(b, i + 4);
        if (name === "tRNS") out.alpha = true;
        if (name === "IDAT" || name === "IEND") break;
        i += 12 + len;
      }
      return out;
    }
    if (type === "image/gif" && b.length >= 10) {
      let alpha = false;
      // A Graphic Control Extension with the transparency flag.
      for (let i = 13; i + 4 < b.length; i++)
        if (b[i] === 0x21 && b[i + 1] === 0xf9 && b[i + 2] === 0x04) {
          if ((b[i + 3]! & 1) === 1) alpha = true;
          break;
        }
      return { width: u16le(b, 6), height: u16le(b, 8), alpha };
    }
    if (type === "image/webp" && b.length >= 30) {
      const chunk = tag(b, 12);
      if (chunk === "VP8X")
        return {
          width: u24le(b, 24) + 1,
          height: u24le(b, 27) + 1,
          alpha: (b[20]! & 0x10) !== 0,
        };
      if (chunk === "VP8L" && b[20] === 0x2f) {
        const bits =
          (b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24)) >>> 0;
        return {
          width: (bits & 0x3fff) + 1,
          height: ((bits >>> 14) & 0x3fff) + 1,
          alpha: ((bits >>> 28) & 1) === 1,
        };
      }
      if (chunk === "VP8 ")
        return {
          width: u16le(b, 26) & 0x3fff,
          height: u16le(b, 28) & 0x3fff,
          alpha: false,
        };
      return none;
    }
    if (type === "image/jpeg") {
      for (let i = 2; i + 9 < b.length; ) {
        if (b[i] !== 0xff) return none;
        const marker = b[i + 1]!;
        if (marker === 0xff) {
          i++;
          continue;
        }
        if (
          marker === 0xd8 ||
          marker === 0x01 ||
          (marker >= 0xd0 && marker <= 0xd7)
        ) {
          i += 2;
          continue;
        }
        const sof =
          marker >= 0xc0 &&
          marker <= 0xcf &&
          marker !== 0xc4 &&
          marker !== 0xc8 &&
          marker !== 0xcc;
        if (sof)
          return {
            width: u16be(b, i + 7),
            height: u16be(b, i + 5),
            alpha: false,
          };
        i += 2 + u16be(b, i + 2);
      }
    }
  } catch {
    // Cut short: what was read stands.
  }
  return none;
}

// ── The listing model (A-18), through the composition root ────────────────────────────────────

/** One copy written into the shared listing model's slot. */
export interface ListingSlotCopy {
  product: string;
  slot: string;
  locale: string;
  sha256: string;
  width: number | null;
  height: number | null;
  alpha: boolean;
  /** `admin` for a console upload, `import` for a CI push (the model's two sources). */
  source: "admin" | "import";
  /** The audit actor (`modified_by`). */
  by: string;
  now: number;
}

/**
 * Distribution's writer for `dist_listing_assets` (`services/distribution/listing/hostedMirror.ts`),
 * handed to Core by the composition root (`dispatch.ts`, the admin handler).
 */
export interface ListingSlotMirror {
  /**
   * Write `copy` into its slot, with its `listing-asset` ref. An `import` never replaces an
   * `admin` row or a console-claimed slot (`"kept"`).
   */
  write(db: Db, copy: ListingSlotCopy): Promise<"written" | "kept">;
  /** Drop the slot's row, and its ref, when it holds `sha256` (a row of other bytes is kept). */
  drop(
    db: Db,
    at: { product: string; slot: string; locale: string; sha256: string },
  ): Promise<void>;
  /** Is the slot's row an operator's upload (`source = 'admin'`)? */
  isAdmin(
    db: Db,
    at: { product: string; slot: string; locale: string },
  ): Promise<boolean>;
}

/** The stored copy's header facts, read back from the blob store (at most `IMAGE_HEADER_BYTES`). */
async function storedHeaderInfo(
  bucket: R2Bucket,
  sha256: string,
  type: string | null,
): Promise<ImageHeaderInfo> {
  try {
    const obj = await bucket.get(blobKey(sha256), {
      range: { offset: 0, length: IMAGE_HEADER_BYTES },
    });
    if (!obj || !("body" in obj))
      return { width: null, height: null, alpha: false };
    return imageHeaderInfo(new Uint8Array(await obj.arrayBuffer()), type);
  } catch {
    return { width: null, height: null, alpha: false };
  }
}

/** Mirror a ready copy of a listing-model slot into `dist_listing_assets`. */
async function mirrorCopy(
  ctx: IngestContext,
  mirror: ListingSlotMirror | undefined,
  product: string,
  slot: string,
  locale: string,
  result: Extract<IngestResult, { status: "ready" }>,
  source: "admin" | "import",
  by: string,
): Promise<"written" | "kept" | null> {
  if (!mirror || !isListingModelSlot(slot) || !ctx.env.BLOBS) return null;
  const head = await storedHeaderInfo(
    ctx.env.BLOBS,
    result.sha256,
    result.contentType,
  );
  return mirror.write(ctx.db, {
    product,
    slot,
    locale,
    sha256: result.sha256,
    width: result.width ?? head.width,
    height: result.height ?? head.height,
    alpha: head.alpha,
    source,
    by,
    now: ctx.now,
  });
}

// ── Console: upload ───────────────────────────────────────────────────────────────────────────

/**
 * An operator's upload into `slot` (the console route): `ingest` with `origin = 'console'`, which
 * claims the slot, yields to nobody, and answers a refusal without marking the slot's current
 * copy. A listing-model slot is mirrored as an `admin` row. The caller checks the slot
 * (`isUploadSlot`), the locale and the declared length against the cap first.
 */
export async function uploadHostedAsset(
  ctx: IngestContext,
  product: string,
  slot: string,
  locale: string,
  body: ReadableStream,
  size: number,
  actor: IngestActor,
  mirror?: ListingSlotMirror,
): Promise<IngestResult> {
  const result = await ingest(ctx, product, slot, {
    kind: "stream",
    body,
    size,
    origin: "console",
    sourceKind: "upload",
    locale,
    actor,
    recordRefusal: false,
  });
  if (result.ok && result.status === "ready")
    await mirrorCopy(
      ctx,
      mirror,
      product,
      slot,
      locale,
      result,
      "admin",
      actor.sub ?? actor.name ?? "console",
    );
  return result;
}

// ── Console: Revert and delete-a-copy ─────────────────────────────────────────────────────────

export type ReleaseOutcome =
  /** A console claim went back to the manifest's source; `pulling` when the pull was queued. */
  | { outcome: "reverted"; pulling: boolean }
  /** The copy (and its row) were dropped. */
  | { outcome: "deleted" }
  /** No row for the slot. */
  | { outcome: "missing" }
  /** The slot changed after it was read (a Replace or a pull landed first): nothing was done. */
  | { outcome: "changed" };

export interface ReleaseContext {
  env: Pick<Env, "HOSTED_ASSET_QUEUE">;
  db: Db;
  now: number;
}

/**
 * Drop the console's claim on `slot` (Revert), or the slot's copy (delete-a-copy): see the module
 * comment. Every write of each is one batch guarded on the row the decision was made from, so a
 * concurrent upload or pull is never undone by a stale decision.
 */
export async function releaseHostedAsset(
  ctx: ReleaseContext,
  product: string,
  slot: string,
  locale: string,
  actor: IngestActor,
  mirror?: ListingSlotMirror,
): Promise<ReleaseOutcome> {
  // Only an upload slot is the console's to revert or delete. A release file's copy
  // (`release-file:<sha256>`, HA-08) is also held by its `release-artifact` ref, which keeps it
  // serving at the release's download, so dropping its row here would "delete" a copy that still
  // serves. The route refuses such a slot first (`bad_slot`); this is the same rule at the core.
  if (!isUploadSlot(slot)) return { outcome: "missing" };
  const row = await getHostedAsset(ctx.db, product, slot, locale);
  if (!row) return { outcome: "missing" };
  const refId = hostedAssetRefId(slot, locale);
  const wanted = parseWantedRef(row.wanted_ref);
  if (row.origin === "console" && wanted && locale === "")
    return revert(ctx, product, slot, row, wanted, actor);

  // Delete-a-copy: guarded on the copy this decision saw (the same bytes and origin).
  const guard = `EXISTS (SELECT 1 FROM hosted_assets
    WHERE product = ? AND slot = ? AND locale = ? AND origin = ? AND sha256 IS ?)`;
  const guardParams = [product, slot, locale, row.origin, row.sha256];
  const statements: DbStatement[] = [
    {
      sql: `DELETE FROM blob_refs WHERE product = ? AND ref_kind = ? AND ref_id = ? AND ${guard}`,
      params: [product, HOSTED_ASSET_REF, refId, ...guardParams],
    },
    auditStatement(
      product,
      refId,
      actor,
      ctx.now,
      "assets.delete",
      `${slot}${locale ? ` (${locale})` : ""}: hosted copy deleted (it was the ${originWords(row.origin)})`,
      guard,
      guardParams,
    ),
    {
      sql: `DELETE FROM hosted_assets
             WHERE product = ? AND slot = ? AND locale = ? AND origin = ? AND sha256 IS ?`,
      params: guardParams,
    },
  ];
  if (!(await applied(ctx.db, statements))) return { outcome: "changed" };
  if (mirror && row.sha256 && isListingModelSlot(slot))
    await mirror.drop(ctx.db, { product, slot, locale, sha256: row.sha256 });
  return { outcome: "deleted" };
}

function originWords(origin: string): string {
  switch (origin) {
    case "console":
      return "console's upload";
    case "ci":
      return "CI's push";
    case "manifest":
      return "manifest's copy";
    default:
      return `${origin} copy`;
  }
}

/** Run a guarded batch; `true` when its last statement changed a row. */
async function applied(db: Db, statements: DbStatement[]): Promise<boolean> {
  if (db.batchChanges) {
    const changes = await db.batchChanges(statements);
    return (changes.at(-1) ?? 0) > 0;
  }
  await db.batch(statements);
  return true;
}

function auditStatement(
  product: string,
  refId: string,
  actor: IngestActor,
  now: number,
  action: string,
  summary: string,
  guard: string,
  guardParams: readonly (string | null)[],
): DbStatement {
  return {
    sql: `INSERT INTO audit (product, id, at, actor_sub, actor_name, actor_email, action,
            target_kind, target_id, parent_id, summary)
          SELECT ?, ?, ?, ?, ?, ?, ?, 'hosted-asset', ?, NULL, ? WHERE ${guard}`,
    params: [
      product,
      randomId("aud"),
      now,
      actor.sub,
      actor.name,
      actor.email ?? null,
      action,
      refId,
      summary,
      ...guardParams,
    ],
  };
}

async function revert(
  ctx: ReleaseContext,
  product: string,
  slot: string,
  row: HostedAssetRow,
  wanted: NonNullable<ReturnType<typeof parseWantedRef>>,
  actor: IngestActor,
): Promise<ReleaseOutcome> {
  const wantedRef = row.wanted_ref!;
  const refId = hostedAssetRefId(slot, "");
  // A repo path is read at the product's last applied commit, as the nightly re-check reads it.
  let commit: string | null = null;
  if (wanted.kind === "repo") {
    const snap = await ctx.db.first<{ applied_sha: string | null }>(
      "SELECT applied_sha FROM product_manifest_snapshot WHERE product = ?",
      product,
    );
    commit = gitShaOrNull(snap?.applied_sha ?? null);
  }
  const queued =
    !!ctx.env.HOSTED_ASSET_QUEUE && (wanted.kind === "url" || commit !== null);
  // Pinned to the copy this decision saw, as delete is: a Replace from another tab that lands
  // first is a newer claim, and this Revert must not remove it.
  const guard = `EXISTS (SELECT 1 FROM hosted_assets
    WHERE product = ? AND slot = ? AND locale = '' AND origin = 'console' AND wanted_ref = ?
      AND sha256 IS ?)`;
  const guardParams = [product, slot, wantedRef, row.sha256];
  const statements: DbStatement[] = [
    {
      sql: `DELETE FROM blob_refs WHERE product = ? AND ref_kind = ? AND ref_id = ? AND ${guard}`,
      params: [product, HOSTED_ASSET_REF, refId, ...guardParams],
    },
    auditStatement(
      product,
      refId,
      actor,
      ctx.now,
      "assets.revert",
      `${slot}: returned to the manifest (${wanted.src}); the console's copy was deleted`,
      guard,
      guardParams,
    ),
    // The row goes back to the manifest with no copy and a pull owed: `pullOwedSql` holds
    // (`pulled_ref` NULL, `pending`), so the queued pull, a resync or the nightly re-check fills
    // it. Held off one back-off step only while the pull is actually queued.
    {
      sql: `UPDATE hosted_assets SET origin = 'manifest', source_kind = ?, source_ref = ?,
              source_etag = NULL, sha256 = NULL, size = NULL, content_type = NULL, width = NULL,
              height = NULL, variants_json = NULL, status = 'pending', error = NULL,
              checked_at = NULL, modified_at = ?, pulled_ref = NULL, source_blob = NULL,
              attempts = 0, next_attempt_at = ?
             WHERE product = ? AND slot = ? AND locale = '' AND origin = 'console'
               AND wanted_ref = ? AND sha256 IS ?`,
      params: [
        wanted.kind,
        wanted.kind === "repo" && commit
          ? `${wanted.src}@${commit}`
          : wanted.src,
        ctx.now,
        queued ? ctx.now + PULL_BACKOFF_BASE_SECONDS : null,
        product,
        slot,
        wantedRef,
        row.sha256,
      ],
    },
  ];
  if (!(await applied(ctx.db, statements))) return { outcome: "changed" };
  if (!queued) return { outcome: "reverted", pulling: false };
  const message: AssetPullMessage = {
    v: 1,
    product,
    slot,
    locale: "",
    wanted: wantedRef,
    ...(wanted.kind === "repo" ? { commit: commit! } : {}),
    reason: "operator",
  };
  try {
    await enqueueAssetPulls(ctx.env, [message]);
    return { outcome: "reverted", pulling: true };
  } catch {
    // The row says a pull is owed; let the nightly re-check send it now rather than after a hold.
    await ctx.db.run(
      `UPDATE hosted_assets SET next_attempt_at = NULL
        WHERE product = ? AND slot = ? AND locale = '' AND origin = 'manifest' AND wanted_ref = ?`,
      product,
      slot,
      wantedRef,
    );
    return { outcome: "reverted", pulling: false };
  }
}

// ── CI: `POST /<p>/assets` ──────────────────────────────────────────────────────────────────

/** At most this many assets per push: a manifest's 18 slots and a few store slots. */
export const MAX_PUSH_ASSETS = 32;
/** The push body: 32 entries of a few hundred bytes. */
export const MAX_PUSH_BODY_BYTES = 16 * 1024;

interface PushAsset {
  slot: string;
  locale: string;
  sha256: string;
  size: number;
}

export interface PushedAsset {
  slot: string;
  locale: string;
  sha256: string;
  size: number;
  contentType: string;
  width: number | null;
  height: number | null;
}

export interface KeptAsset {
  slot: string;
  locale: string;
  reason: "console" | "manifest";
}

export interface RefusedAsset {
  slot: string;
  locale: string;
  reason: IngestReason;
}

function bad(
  reason: string,
  message: string,
  extra: Record<string, unknown> = {},
): Response {
  return errorResponse(400, ErrorCode.BadRequest, message, {
    reason,
    ...extra,
  });
}

function parsePush(raw: unknown): PushAsset[] | Response {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_PUSH_ASSETS)
    return bad(
      "bad_assets",
      `assets must be an array of 1 to ${MAX_PUSH_ASSETS} entries`,
    );
  const out: PushAsset[] = [];
  const seen = new Set<string>();
  for (const [i, entry] of raw.entries()) {
    const o = entry as Record<string, unknown> | null;
    if (!o || typeof o !== "object" || Array.isArray(o))
      return bad("bad_assets", `assets[${i}] must be an object`, { index: i });
    const locale = o.locale === undefined || o.locale === null ? "" : o.locale;
    if (
      typeof o.slot !== "string" ||
      typeof locale !== "string" ||
      typeof o.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(o.sha256) ||
      typeof o.size !== "number" ||
      !Number.isSafeInteger(o.size)
    )
      return bad(
        "bad_assets",
        `assets[${i}] must be {slot, locale?, sha256 (64 lower-case hex), size}`,
        { index: i },
      );
    if (!isUploadSlot(o.slot))
      return bad(
        "unknown_slot",
        `assets[${i}]: ${JSON.stringify(o.slot.slice(0, 200))} is not a slot CI can push (presentation.icon, listing.icon, listing.header, listing.screenshot:<1-16> or a listing image slot)`,
        { index: i },
      );
    if (!isHostedAssetLocale(locale))
      return bad("bad_assets", `assets[${i}].locale must be a language tag`, {
        index: i,
      });
    const cap = uploadSlotMaxBytes(o.slot)!;
    if (o.size < 1 || o.size > cap)
      return bad(
        "bad_assets",
        `assets[${i}].size must be from 1 to ${cap} bytes for ${o.slot}`,
        { index: i, maxBytes: cap },
      );
    const id = hostedAssetRefId(o.slot, locale);
    if (seen.has(id))
      return bad(
        "bad_assets",
        `assets[${i}]: ${o.slot} appears twice in one locale`,
        { index: i },
      );
    seen.add(id);
    out.push({ slot: o.slot, locale, sha256: o.sha256, size: o.size });
  }
  return out;
}

function asTokenRecord(p: CiPrincipal): CiTokenRecord | null {
  return "tokenHash" in p && "expiresAt" in p
    ? (p as unknown as CiTokenRecord)
    : null;
}

/** The keys among `keys` this product holds a `hosted-asset` ref to (any slot). */
async function hostedRefKeys(
  db: Db,
  product: string,
  keys: readonly string[],
): Promise<Set<string>> {
  const unique = [...new Set(keys)];
  if (unique.length === 0) return new Set();
  const rows = await db.all<{ storage_key: string }>(
    `SELECT DISTINCT storage_key FROM blob_refs
      WHERE product = ? AND ref_kind = ? AND storage_key IN (${unique.map(() => "?").join(", ")})`,
    product,
    HOSTED_ASSET_REF,
    ...unique,
  );
  return new Set(rows.map((r) => r.storage_key));
}

/** Who holds `slot` against a CI push, if anyone (S-20 §6.3). */
async function heldAgainstCi(
  db: Db,
  mirror: ListingSlotMirror | undefined,
  product: string,
  a: PushAsset,
): Promise<KeptAsset["reason"] | null> {
  const row = await getHostedAsset(db, product, a.slot, a.locale);
  if (row?.origin === "console") return "console";
  if (row && row.wanted_ref !== null) return "manifest";
  if (
    mirror &&
    isListingModelSlot(a.slot) &&
    (await mirror.isAdmin(db, {
      product,
      slot: a.slot,
      locale: a.locale,
    }))
  )
    return "console";
  return null;
}

/**
 * `POST /<p>/assets` (S-20 §6.3 "Push from CI"): `{ticket?, assets: [{slot, locale?, sha256,
 * size}]}` with a `pkeyci_` token holding `assets:write` (opt-in). Each object comes from the
 * caller's own upload ticket (P2-02's uploads route accepts `assets:write`), staged at
 * `staging/<p>/<ticketId>/<sha256>`, or is one this product already holds a `hosted-asset` ref to;
 * either way `ingest` reads and hashes every byte against the declared digest and length. A slot a
 * console claim or a manifest holds is answered `kept`; a refused file is answered with its reason
 * and changes nothing. Audited as `assets.push` (and `assets.ingest` per file).
 */
export async function handleAssetsPush(
  req: Request,
  env: Env,
  db: Db,
  product: string,
  now: number,
  mirror?: ListingSlotMirror,
): Promise<Response> {
  if (req.method !== "POST") return notFound();
  const principal = await requireCiScope(
    req,
    env,
    db,
    product,
    "assets:write",
    now,
  );
  if (principal instanceof Response) return principal;
  const body = await readCiJson(req, MAX_PUSH_BODY_BYTES);
  if (body instanceof Response) return body;
  const bucket = env.BLOBS;
  if (!bucket)
    return errorResponse(404, ErrorCode.NotFound, "no blob store here", {
      reason: "no_blob_store",
    });
  const assets = parsePush(body.assets);
  if (assets instanceof Response) return assets;

  const by = ciActor(principal);
  const actor: IngestActor = { sub: by, name: "CI" };
  const kept: KeptAsset[] = [];
  const todo: PushAsset[] = [];
  for (const a of assets) {
    const holder = await heldAgainstCi(db, mirror, product, a);
    if (holder) kept.push({ slot: a.slot, locale: a.locale, reason: holder });
    else todo.push(a);
  }

  // Where each object's bytes are read from: an object this product already hosts, or the ticket.
  const held = await hostedRefKeys(
    db,
    product,
    todo.map((a) => blobKey(a.sha256)),
  );
  const fromTicket = todo.filter((a) => !held.has(blobKey(a.sha256)));
  let claim: { ticketHash: string; ticketId: string } | null = null;
  if (fromTicket.length > 0) {
    const holder = asTokenRecord(principal);
    if (!holder)
      return errorResponse(401, ErrorCode.Unauthorized, "unknown CI token", {
        reason: "invalid_ci_token",
      });
    const found = await findUploadTicket(env, db, {
      ticket: body.ticket,
      product,
      holder,
      now,
    });
    if (!found.ok)
      return errorResponse(
        found.status,
        found.status === 403 ? ErrorCode.Forbidden : ErrorCode.BadRequest,
        found.message,
        { reason: found.reason },
      );
    const ticket = found.ticket;
    for (const a of fromTicket) {
      if (
        !ticket.objects.some(
          (o) => o.sha256 === a.sha256 && o.size === a.size && !o.gated,
        )
      )
        return bad(
          "object_not_in_ticket",
          `${a.slot} (${a.sha256}) is not an object of this ticket`,
          { slot: a.slot },
        );
      const head = await bucket.head(
        stagingKey(product, ticket.ticketId, a.sha256),
      );
      if (!head)
        return bad("staged_object_missing", `${a.slot} was not uploaded`, {
          slot: a.slot,
        });
      if (head.size !== a.size)
        return bad(
          "staged_object_mismatch",
          `${a.slot} was uploaded with another size`,
          { slot: a.slot },
        );
    }
    if (!(await claimUploadTicket(db, ticket.ticketHash, now)))
      return bad("ticket_redeemed", "this upload ticket was already redeemed");
    claim = { ticketHash: ticket.ticketHash, ticketId: ticket.ticketId };
  }

  const ctx: IngestContext = { env, db, now };
  const stored: PushedAsset[] = [];
  const refused: RefusedAsset[] = [];
  const consumed = new Set<string>();
  for (const a of todo) {
    const key =
      claim && !held.has(blobKey(a.sha256))
        ? stagingKey(product, claim.ticketId, a.sha256)
        : blobKey(a.sha256);
    const obj = await bucket.get(key);
    if (!obj || !("body" in obj)) {
      refused.push({ slot: a.slot, locale: a.locale, reason: "retry" });
      continue;
    }
    const result = await ingest(ctx, product, a.slot, {
      kind: "stream",
      body: obj.body,
      size: a.size,
      origin: "ci",
      sourceKind: "ci",
      locale: a.locale,
      expectedSha256: a.sha256,
      actor,
      yieldsTo: ["console", "manifest"],
      recordRefusal: false,
    });
    if (result.ok && result.status === "ready") {
      if (key.startsWith("staging/")) consumed.add(key);
      await mirrorCopy(
        ctx,
        mirror,
        product,
        a.slot,
        a.locale,
        result,
        "import",
        by,
      );
      stored.push({
        slot: a.slot,
        locale: a.locale,
        sha256: result.sha256,
        size: result.size,
        contentType: result.contentType,
        width: result.width,
        height: result.height,
      });
    } else if (!result.ok && result.reason === "claimed") {
      // A console upload (or a manifest pull) got there while this push ran.
      const row = await getHostedAsset(db, product, a.slot, a.locale);
      kept.push({
        slot: a.slot,
        locale: a.locale,
        reason: row?.origin === "console" ? "console" : "manifest",
      });
    } else if (!result.ok) {
      refused.push({ slot: a.slot, locale: a.locale, reason: result.reason });
    }
  }
  // A transient failure gives the ticket back, so the same upload can be pushed again.
  if (claim && refused.some((r) => r.reason === "retry"))
    await releaseUploadTicket(db, claim.ticketHash, now);
  // The staged copies are no longer needed (the bucket's lifecycle rule expires the rest).
  for (const key of consumed) await bucket.delete(key).catch(() => undefined);

  const list = (xs: { slot: string }[]) => xs.map((x) => x.slot).join(", ");
  await db.batch([
    {
      sql: `INSERT INTO audit (product, id, at, actor_sub, actor_name, actor_email, action,
              target_kind, target_id, parent_id, summary)
            VALUES (?, ?, ?, ?, 'CI', NULL, 'assets.push', 'product', ?, NULL, ?)`,
      params: [
        product,
        randomId("aud"),
        now,
        by,
        product,
        [
          `Pushed ${stored.length} hosted asset${stored.length === 1 ? "" : "s"} from CI` +
            (stored.length ? ` (${list(stored)})` : ""),
          kept.length ? `kept ${kept.length} (${list(kept)})` : "",
          refused.length
            ? `refused ${refused.length} (${refused.map((r) => `${r.slot}: ${r.reason}`).join(", ")})`
            : "",
        ]
          .filter(Boolean)
          .join("; "),
      ],
    },
  ]);
  return json({ ok: refused.length === 0, stored, kept, refused });
}
