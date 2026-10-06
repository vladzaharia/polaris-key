/**
 * Serving hosted images (HA-07; notes/S-20 §6.8, §6.5): which of a product's image slots have a
 * copy the image host serves, and the image-host URL each surface hands out for it.
 *
 * Every surface that shows a developer's image reads it here: the portal's presentation and
 * Discover (`services/identity/portal/library.ts`), the portal's `/media/<p>/*` 302
 * (`portal/media.ts`), the AltStore and SideStore sources (`services/distribution/feeds/art.ts`),
 * the download page's icon (`services/distribution/page/index.ts`) and the PR plane's screenshot
 * URLs (`services/distribution/prInputs.ts`). HA-12's discovery `core.presentation` reuses the same
 * reads and the same variant choice (`hostedImageUrl`).
 *
 * ── WHAT COUNTS AS A COPY ───────────────────────────────────────────────────────────────────
 *
 * Exactly what the image host would serve (`core/imgHost.ts` `original`): a `hosted_assets` row of
 * an IMAGE slot, every locale (`''`), with a stored `sha256` the product holds a `hosted-asset` ref
 * to under that slot, of a type on `IMG_HOST_TYPES`. A first pull still in flight has no copy. A
 * re-pull that is pending, failed or stale keeps the last good copy and its ref (`ingest` never
 * drops it), and the host keeps serving it, so a surface does too; `pulledRef` says which manifest
 * ref that copy was pulled for, for a caller that must match it (the feeds, `feeds/art.ts`).
 *
 * ── WHEN NOTHING IS SERVED FROM HERE ────────────────────────────────────────────────────────
 *
 * `hostedImageOrigin(env)` is `null`, and every read answers nothing, when the kill switch is off
 * (`core/assetHosting.ts`, HA-10's `assets.hosting.enabled`) or the deployment has no image host
 * (`IMG_ORIGIN` unset or unusable). Each surface then does what it did before HA-07.
 *
 * ── THE VARIANT CHOICE ──────────────────────────────────────────────────────────────────────
 *
 * HA-03 stores a fixed WebP width ladder per slot family (64…1024 px for icons, 640…1920 for the
 * header, 480…1920 for screenshots), never wider than the original. A surface asks for the width
 * it draws at (already multiplied for high-density screens) and gets the narrowest rung at least
 * that wide; when no rung is (a small original, or an empty ladder: no Images binding, quota
 * used up), it gets the original, which is then the widest image there is. A consumer that needs
 * exact pixels or the developer's own format (a store, an AltStore source) asks for no width and
 * gets the original.
 */

import type { Env } from "../env.js";
import type { Db } from "../db/types.js";
import { blobKey } from "./blobs.js";
import { HOSTED_ASSET_REF, parseVariants, slotClass } from "./hostedAssets.js";
import { IMG_ALIASES, IMG_HOST_TYPES } from "./imgHost.js";
import { imgOrigin, imgUrl } from "./imgHostname.js";
import { assetHostingEnabled } from "./assetHosting.js";

type HostedEnv = Pick<Env, "IMG_ORIGIN" | "BLOB_ORIGIN" | "PKG_ORIGIN">;

/** One slot's servable copy. */
export interface HostedImage {
  slot: string;
  sha256: string;
  /** `hosted_assets.origin`: `manifest`, `console` (a claim, HA-06) or `ci`. */
  origin: string;
  /** The manifest ref (canonical JSON, `wantedRefOf`) the copy was pulled for, or `null`. */
  pulledRef: string | null;
  width: number | null;
  height: number | null;
  /** The ladder widths the copy has, ascending (empty: the original serves alone). */
  widths: readonly number[];
}

/** The slots a product's icon is read from, first match wins: the image host's `/icon` alias. */
export const PRESENTATION_ICON_SLOTS: readonly string[] = IMG_ALIASES.icon;
/** The slot a product's header art is read from: the image host's `/header` alias. */
export const PRESENTATION_HEADER_SLOTS: readonly string[] = IMG_ALIASES.header;

/** `listing.screenshot:<n>` for n = 1…count (the listing's screenshot slots, 1-based). */
export function listingScreenshotSlots(count: number): string[] {
  const n = Math.max(0, Math.min(16, Math.floor(count)));
  return Array.from({ length: n }, (_, i) => `listing.screenshot:${i + 1}`);
}

/**
 * The image host's origin when hosted copies are served, else `null`: the kill switch is off, or
 * there is no image host. Every surface branches on this one answer.
 */
export function hostedImageOrigin(env: HostedEnv): string | null {
  if (!assetHostingEnabled(env)) return null;
  return imgOrigin(env);
}

/** `blobs/sha256/`: the ungated key prefix the image host reads (`blobKey`). */
const BLOB_PREFIX = blobKey("0".repeat(64)).slice(0, -64);
const SHA256_RE = /^[0-9a-f]{64}$/;

interface Row {
  slot: string;
  origin: string;
  sha256: string | null;
  content_type: string | null;
  width: number | null;
  height: number | null;
  variants_json: string | null;
  pulled_ref: string | null;
}

/**
 * The servable copies among `slots` of one product, by slot (one statement). Empty when
 * `hostedImageOrigin(env)` is `null`.
 */
export async function hostedImages(
  env: HostedEnv,
  db: Db,
  product: string,
  slots: readonly string[],
): Promise<Map<string, HostedImage>> {
  const out = new Map<string, HostedImage>();
  const wanted = [
    ...new Set(slots.filter((s) => slotClass(s)?.accept === "image")),
  ];
  if (hostedImageOrigin(env) === null || wanted.length === 0) return out;
  // The image host's tenancy check, in the query: the copy's hosted-asset ref must exist.
  const rows = await db.all<Row>(
    `SELECT h.slot AS slot, h.origin AS origin, h.sha256 AS sha256,
            h.content_type AS content_type, h.width AS width, h.height AS height,
            h.variants_json AS variants_json, h.pulled_ref AS pulled_ref
       FROM hosted_assets h
      WHERE h.product = ? AND h.locale = ''
        AND h.slot IN (${wanted.map(() => "?").join(", ")})
        AND h.sha256 IS NOT NULL
        AND EXISTS (SELECT 1 FROM blob_refs r
                     WHERE r.product = h.product AND r.ref_kind = ?
                       AND r.ref_id = h.slot || '@' || h.locale
                       AND r.storage_key = ? || h.sha256)`,
    product,
    ...wanted,
    HOSTED_ASSET_REF,
    BLOB_PREFIX,
  );
  for (const row of rows) {
    if (!row.sha256 || !SHA256_RE.test(row.sha256)) continue;
    if (row.content_type === null || !IMG_HOST_TYPES.has(row.content_type))
      continue;
    out.set(row.slot, {
      slot: row.slot,
      sha256: row.sha256,
      origin: row.origin,
      pulledRef: row.pulled_ref,
      width: row.width,
      height: row.height,
      widths: [...new Set(parseVariants(row.variants_json).map((v) => v.w))]
        .filter((w) => Number.isSafeInteger(w) && w > 0)
        .sort((a, b) => a - b),
    });
  }
  return out;
}

/** The first of `slots` that has a copy in `images`, or `null`. */
export function firstHostedImage(
  images: ReadonlyMap<string, HostedImage>,
  slots: readonly string[],
): HostedImage | null {
  for (const slot of slots) {
    const image = images.get(slot);
    if (image) return image;
  }
  return null;
}

/**
 * The ladder rung a surface drawing at `width` px gets: the narrowest at least that wide, or
 * `null` for the original (no rung is wide enough, or none exists). See the file comment.
 */
export function pickVariantWidth(
  widths: readonly number[],
  width: number,
): number | null {
  let best: number | null = null;
  for (const w of widths)
    if (w >= width && (best === null || w < best)) best = w;
  return best;
}

/**
 * The image-host URL of `image` for a surface drawing it at `width` px (the variant choice
 * above), or of the original when `width` is omitted. `null` when there is no image host or
 * hosting is off, so a caller never hands out a URL certain to 404.
 */
export function hostedImageUrl(
  env: HostedEnv,
  product: string,
  image: HostedImage,
  width?: number,
): string | null {
  if (hostedImageOrigin(env) === null) return null;
  const w = width === undefined ? null : pickVariantWidth(image.widths, width);
  return w === null
    ? imgUrl(env, product, image.sha256)
    : imgUrl(env, product, image.sha256, w);
}
