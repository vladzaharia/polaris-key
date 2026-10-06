/**
 * THE SLOT BOARD (A-18j; notes/S-15 §7.4, §8.1 step 4; A-18d's rule "every output is previewed
 * and accepted before any push; none is pushed unseen").
 *
 *     GET  …/distribution/storefronts/slots                         the board: every image slot
 *                                                                    of the listing model, grouped
 *                                                                    by store, with its asset
 *     GET  …/distribution/storefronts/slots/image?slot=&locale=     the asset's bytes, for the
 *                                                                    preview (an image type only)
 *     POST …/distribution/storefronts/slots/accept                  {slot, locale?, sha256}:
 *                                                                    accept exactly those bytes
 *
 * A slot is one of three kinds, from what `pkey listing assets` (A-18d) registered:
 *
 *   - `human`: a master a person makes (icon master, key art, wordmark, screenshots). Missing is
 *     red, with the store's specification (`SLOT_SPECS` below, from S-15 §7.4);
 *   - `derived`: resized from a master (icons). Shown green once accepted;
 *   - `composed`: laid out from key art and the wordmark, or a screenshot fitted (cropped or
 *     padded) to a store's rule. Shown with its preview until accepted.
 *
 * Acceptance is the digest the operator looked at (`accepted_sha256`, migration 0083): new bytes
 * are unaccepted again with no write. An asset the operator uploaded (`source = 'admin'`) is
 * theirs and counts as accepted. The store pushes read `acceptedAssets` and send nothing else.
 * Nothing is deleted here; the console offers no delete (owner rule).
 */

import { ErrorCode } from "../../../core/errors.js";
import type { Db } from "../../../core/platform.js";
import type { ServiceContext } from "../../../core/registry.js";
import type { AdminSession } from "../../../core/adminApi.js";
import { adminJson, audit, err, readBody } from "../../../core/adminApi.js";
import {
  LISTING_ASSET_SLOTS,
  listingAssetRule,
  SCREENSHOT_CLASSES,
} from "../../../core/storefront/listingModel.js";
import { listAssets, type DistListingAssetRow } from "../listing/store.js";

type AdminCtx = ServiceContext & { session: AdminSession };

/** Slots that are not images on the board: packs are downloads, the trailer is a link or video. */
const NOT_IMAGES = /^(pack:|trailer-master$|youtube-url$)/;

/** The masters a person makes. */
const MASTERS: ReadonlySet<string> = new Set([
  "icon-master",
  "icon-adaptive-fg",
  "icon-adaptive-bg",
  "icon-adaptive-mono",
  "wordmark",
  "key-art",
  "key-art-portrait",
  ...SCREENSHOT_CLASSES.map((c) => `screenshot:${c}`),
]);

/**
 * Each image slot's store specification, in S-15 §7.4's words: what the operator (for a human
 * slot) or `pkey listing assets` (for the rest) has to make. A test keeps every image slot of
 * `LISTING_ASSET_SLOTS` here, so a new slot cannot reach the board without its specification.
 */
export const SLOT_SPECS: Readonly<Record<string, string>> = {
  "icon-master": "1024×1024 PNG, square, the mark on a full-bleed background",
  "icon-adaptive-fg":
    "432×432 PNG, the mark inside the central 66 dp (derived when the master allows)",
  "icon-adaptive-bg": "432×432 PNG, no text",
  "icon-adaptive-mono": "432×432 PNG, one colour on transparency",
  wordmark: "PNG on transparency, at least 1280 wide or 720 tall",
  "key-art": "16:9, at least 3840×2160, no logo or text",
  "key-art-portrait": "2:3, at least 1440×2160, no logo or text",
  "screenshot:phone-portrait":
    "iPhone 6.9″ (1320×2868) or 6.7″ (1290×2796), no alpha",
  "screenshot:tablet": "iPad 13″ (2064×2752) or 12.9″ (2048×2732), no alpha",
  "screenshot:desktop-16x9": "16:9, at least 1920×1080",
  "screenshot:desktop-16x10": "16:10, 2880×1800 or 2560×1600",
  "screenshot:tv": "16:9, 1920×1080 or 3840×2160",
  "screenshot:wear": "1:1, at least 384×384",
  "screenshot:xr": "16:9, at least 1920×1080",
  "play:icon": "512×512 PNG with alpha, at most 1 MB",
  "play:feature-graphic": "1024×500 JPEG or 24-bit PNG, no alpha",
  "ms-store:tile": "300×300 PNG",
  "ms-store:super-hero": "1920×1080 or 3840×2160, no title or other text",
  "ms-store:poster": "720×1080 or 1440×2160, the title in the top two thirds",
  "ms-store:box-art": "1080×1080 or 2160×2160, the title in the top two thirds",
  "steam:header-capsule": "920×430",
  "steam:main-capsule": "1232×706",
  "steam:vertical-capsule": "748×896",
  "steam:small-capsule": "462×174, the logo nearly filling it",
  "steam:library-capsule": "600×900",
  "steam:library-header": "920×430",
  "steam:library-hero": "3840×1240, no text, safe area 860×380",
  "steam:library-logo": "1280 wide or 720 tall, transparent",
  "steam:page-background": "1438×810",
  "steam:community-icon": "184×184 JPEG",
  "steam:shortcut-icon": "256×256 PNG",
  "itch:cover": "630×500 (315:250)",
  "snap:banner": "1920×640 (3:1)",
  "snap:icon": "512×512 PNG",
  "flathub:icon": "512×512 PNG",
  "winget:icon": "256×256 PNG",
  "fdroid:icon": "512×512 PNG",
  "fdroid:feature-graphic": "1024×500, no alpha",
};

/** The image slots of the model (every fixed slot but packs and the trailer). */
export const IMAGE_SLOTS: readonly string[] = Object.keys(
  LISTING_ASSET_SLOTS,
).filter((s) => !NOT_IMAGES.test(s));

/** The specification of a numbered store screenshot: its class master's. */
function specOf(slot: string): string | null {
  const direct = SLOT_SPECS[slot];
  if (direct) return direct;
  const m = /^[a-z-]+:screenshot:([a-z0-9-]+):\d+$/.exec(slot);
  return m ? (SLOT_SPECS[`screenshot:${m[1]}`] ?? null) : null;
}

/** The board's group of a slot: `masters`, or the store prefix (`play`, `ms-store`…). */
export function groupOf(slot: string): string {
  if (MASTERS.has(slot)) return "masters";
  const i = slot.indexOf(":");
  return i > 0 ? slot.slice(0, i) : "masters";
}

export type SlotKind = "human" | "derived" | "composed";
export type SlotState = "missing" | "review" | "accepted";

export interface SlotView {
  slot: string;
  /** `null`: every locale. */
  locale: string | null;
  group: string;
  kind: SlotKind;
  state: SlotState;
  spec: string | null;
  textAllowed: string;
  asset: {
    sha256: string;
    width: number | null;
    height: number | null;
    alpha: boolean;
    derivedFrom: string | null;
    source: string;
    modifiedAt: number;
    /** The preview's console path (same origin, so the console's CSP admits it). */
    image: string;
    acceptedAt: number | null;
    acceptedBy: string | null;
  } | null;
}

function kindOf(slot: string, row: DistListingAssetRow | null): SlotKind {
  if (MASTERS.has(slot)) return "human";
  const from = row?.derived_from ?? null;
  if (from && from.startsWith("screenshot:")) return "composed";
  const rule = row?.text_allowed ?? listingAssetRule(slot);
  return rule === "free" ? "derived" : "composed";
}

/** Is this row's current bytes accepted (or the operator's own upload)? */
export function isAccepted(row: DistListingAssetRow): boolean {
  return row.source === "admin" || row.accepted_sha256 === row.sha256;
}

/** The product's assets a push may send: accepted ones only. */
export async function acceptedAssets(
  db: Db,
  product: string,
): Promise<DistListingAssetRow[]> {
  return (await listAssets(db, product)).filter(isAccepted);
}

const enc = encodeURIComponent;

/** The board for one product: every fixed image slot, plus every stored numbered screenshot. */
export async function slotBoard(db: Db, product: string): Promise<SlotView[]> {
  const rows = await listAssets(db, product);
  const base = `/manage/api/products/${enc(product)}/distribution/storefronts/slots/image`;
  const out: SlotView[] = [];
  const seen = new Set<string>();
  const push = (slot: string, row: DistListingAssetRow | null) => {
    out.push({
      slot,
      locale: row && row.locale !== "" ? row.locale : null,
      group: groupOf(slot),
      kind: kindOf(slot, row),
      state: !row ? "missing" : isAccepted(row) ? "accepted" : "review",
      spec: specOf(slot),
      textAllowed: row?.text_allowed ?? listingAssetRule(slot) ?? "free",
      asset: row
        ? {
            sha256: row.sha256,
            width: row.width,
            height: row.height,
            alpha: row.alpha === 1,
            derivedFrom: row.derived_from,
            source: row.source,
            modifiedAt: row.modified_at,
            image: `${base}?slot=${enc(row.slot)}&locale=${enc(row.locale)}`,
            acceptedAt: isAccepted(row) ? (row.accepted_at ?? null) : null,
            acceptedBy: isAccepted(row) ? (row.accepted_by ?? null) : null,
          }
        : null,
    });
  };
  for (const slot of IMAGE_SLOTS) {
    const mine = rows.filter((r) => r.slot === slot);
    if (mine.length === 0) push(slot, null);
    for (const r of mine) {
      push(slot, r);
      seen.add(`${r.slot}\u0000${r.locale}`);
    }
  }
  for (const r of rows) {
    if (seen.has(`${r.slot}\u0000${r.locale}`) || NOT_IMAGES.test(r.slot))
      continue;
    push(r.slot, r);
  }
  return out;
}

const HEX64 = /^[0-9a-f]{64}$/;
const LOCALE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/;

/** The largest asset previewed (Play's image cap; a listing image is far smaller). */
const PREVIEW_MAX_BYTES = 15 * 1024 * 1024;

/** PNG, JPEG or WebP by their magic bytes; null for anything else. */
export function imageTypeOf(b: Uint8Array): string | null {
  if (
    b.length >= 8 &&
    b[0] === 0x89 &&
    b[1] === 0x50 &&
    b[2] === 0x4e &&
    b[3] === 0x47
  )
    return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff)
    return "image/jpeg";
  if (
    b.length >= 12 &&
    String.fromCharCode(...b.subarray(0, 4)) === "RIFF" &&
    String.fromCharCode(...b.subarray(8, 12)) === "WEBP"
  )
    return "image/webp";
  return null;
}

function slotKey(
  slot: unknown,
  locale: unknown,
): { slot: string; locale: string } | null {
  if (typeof slot !== "string" || listingAssetRule(slot) === undefined)
    return null;
  if (locale === undefined || locale === null || locale === "")
    return { slot, locale: "" };
  return typeof locale === "string" && LOCALE.test(locale)
    ? { slot, locale }
    : null;
}

async function rowOf(
  db: Db,
  product: string,
  k: { slot: string; locale: string },
): Promise<DistListingAssetRow | null> {
  return db.first<DistListingAssetRow>(
    "SELECT * FROM dist_listing_assets WHERE product = ? AND slot = ? AND locale = ?",
    product,
    k.slot,
    k.locale,
  );
}

/** The `slots` routes; `null` when the path is not one. */
export async function handleSlotsAdmin(
  ctx: AdminCtx,
): Promise<Response | null> {
  const { req, rest } = ctx;
  if (rest[0] !== "storefronts" || rest[1] !== "slots") return null;
  const notAllowed = () => err(405, ErrorCode.BadRequest, "method not allowed");
  if (rest.length === 2)
    return req.method === "GET"
      ? adminJson({ slots: await slotBoard(ctx.db, ctx.product.slug) })
      : notAllowed();
  if (rest.length === 3 && rest[2] === "image")
    return req.method === "GET" ? image(ctx) : notAllowed();
  if (rest.length === 3 && rest[2] === "accept")
    return req.method === "POST" ? accept(ctx) : notAllowed();
  return null;
}

async function image(ctx: AdminCtx): Promise<Response> {
  const url = new URL(ctx.req.url);
  const k = slotKey(
    url.searchParams.get("slot"),
    url.searchParams.get("locale"),
  );
  if (!k) return err(422, ErrorCode.BadRequest, "no such listing slot");
  const row = await rowOf(ctx.db, ctx.product.slug, k);
  if (!row || !ctx.env.BLOBS)
    return err(404, "not_found", "the slot has no asset");
  const obj = await ctx.env.BLOBS.get(row.blob);
  if (!obj)
    return err(404, "not_found", "the asset is gone from the blob store");
  if (obj.size > PREVIEW_MAX_BYTES)
    return err(413, ErrorCode.BadRequest, "the asset is too large to preview");
  const bytes = new Uint8Array(await obj.arrayBuffer());
  // The type comes from the bytes (blob objects are content-addressed and untyped), and only an
  // image type is ever served, so a stored object cannot become a page on this origin.
  const type = imageTypeOf(bytes);
  if (!type)
    return err(
      415,
      ErrorCode.BadRequest,
      "the asset is not a previewable image",
    );
  return new Response(bytes, {
    headers: {
      "content-type": type,
      "x-content-type-options": "nosniff",
      "content-disposition": "inline",
      "cache-control": "private, max-age=300",
      "content-security-policy": "default-src 'none'; sandbox",
    },
  });
}

async function accept(ctx: AdminCtx): Promise<Response> {
  const body = await readBody(ctx.req);
  const k = slotKey(body.slot, body.locale);
  if (!k)
    return err(422, ErrorCode.BadRequest, "slot must be a listing slot", {
      fields: ["slot"],
    });
  if (typeof body.sha256 !== "string" || !HEX64.test(body.sha256))
    return err(422, ErrorCode.BadRequest, "sha256 must be the asset's digest", {
      fields: ["sha256"],
    });
  const row = await rowOf(ctx.db, ctx.product.slug, k);
  if (!row) return err(404, "not_found", "the slot has no asset");
  // Accept exactly what the operator saw: newer bytes since the preview refuse.
  if (row.sha256 !== body.sha256)
    return err(
      409,
      "asset_changed",
      "the asset changed since it was shown: look at it again",
      { reason: "asset_changed" },
    );
  if (isAccepted(row)) return adminJson({ ok: true, accepted: true });
  await ctx.db.run(
    `UPDATE dist_listing_assets SET accepted_sha256 = ?, accepted_at = ?, accepted_by = ?
      WHERE product = ? AND slot = ? AND locale = ? AND sha256 = ?`,
    row.sha256,
    ctx.now,
    ctx.session.sub,
    ctx.product.slug,
    k.slot,
    k.locale,
    row.sha256,
  );
  await audit(
    ctx.db,
    ctx.product.slug,
    ctx.session,
    ctx.now,
    "distribution.storefronts.accept",
    { kind: "listing-asset", id: `${k.slot}@${k.locale}` },
    `Accepted the ${k.slot} listing asset${k.locale ? ` (${k.locale})` : ""}`,
  );
  return adminJson({ ok: true, accepted: true });
}
