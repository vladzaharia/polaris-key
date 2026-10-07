/**
 * The AltStore and SideStore sources' art on Polaris Key's hosted copies (HA-07; notes/S-20 §4.2
 * L5, §6.8): `iconURL`, `headerURL` and `screenshots` name the image host instead of the
 * developer's host, so an end user's device never hotlinks a developer URL for them.
 *
 * Each field is resolved on its own, against the outlet's listing (the root `.pkey/distribution`
 * listing with the outlet's override merged over it), from the slots HA-05 pulls
 * (`listing.icon`, `listing.header`, `listing.screenshot:<n>`):
 *
 *   - the listing declares the field: its hosted copy is used only when that copy was pulled FOR
 *     this exact ref (`pulled_ref` equals the declared ref's canonical form, `wantedRefOf`), or when
 *     an operator claimed the slot in the console (`origin = 'console'`, HA-06), which wins over the
 *     manifest. So an outlet whose override names other art than the root listing, or a ref that
 *     changed and whose re-pull has not succeeded, keeps the URL it declares: today's behaviour;
 *   - the listing does not declare it: the hosted copy, if any. For the icon that is the listing
 *     icon's fallback to `.pkey/product` `presentation.icon` (`manifestAssetSlots`), so a source
 *     whose listing names no icon still gets the product's;
 *   - no usable copy: the declared https URL, as before HA-07 (a repo path has none, and is left
 *     out, as before).
 *
 * The URL is the ORIGINAL on the image host (`https://img…/<p>/a/<sha256>`), never a WebP
 * variant: the source keeps the developer's own pixels and format, as the stores do.
 *
 * With hosting off or no image host (`hostedImageOrigin`), `feedArt` answers `null` and the
 * renderer reads the listing exactly as before (HA-10's rollback).
 */

import { assetRefUrl, normalizeAssetRef } from "@polaris-key/manifest";
import type { Db, Env } from "../../../core/platform.js";
import {
  hostedImageOrigin,
  hostedImageUrl,
  hostedImages,
  listingScreenshotSlots,
  type HostedImage,
} from "../../../core/hostedImages.js";
import { wantedRefOf } from "../../../core/hostedAssetPulls.js";
import type { ListingArt, RenderListing } from "./render.js";

/** The canonical form (`wantedRefOf`) of a stored listing ref, or `null` when it is none. */
export function storedRefKey(v: unknown): string | null {
  if (typeof v === "string") {
    const ref = normalizeAssetRef(v);
    return ref ? wantedRefOf(ref) : null;
  }
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  if ((r.kind !== "url" && r.kind !== "repo") || typeof r.src !== "string")
    return null;
  return wantedRefOf({
    kind: r.kind,
    src: r.src,
    ...(typeof r.sha256 === "string" ? { sha256: r.sha256 } : {}),
  });
}

/** May `copy` stand in for the declared ref `declared` (`undefined`: nothing declared)? */
function stands(copy: HostedImage | undefined, declared: unknown): boolean {
  if (!copy) return false;
  if (declared === undefined || declared === null) return true;
  if (copy.origin === "console") return true;
  const key = storedRefKey(declared);
  return key !== null && copy.pulledRef === key;
}

/** The listing's art on hosted copies (see the file comment), or `null` = read the listing. */
export async function feedArt(
  env: Env,
  db: Db,
  product: string,
  listing: RenderListing | null,
): Promise<ListingArt | null> {
  if ((await hostedImageOrigin(env, db)) === null) return null;
  const l = (listing ?? {}) as Record<string, unknown>;
  const declaredShots = Array.isArray(l.screenshots) ? l.screenshots : [];
  const images = await hostedImages(env, db, product, [
    "listing.icon",
    "listing.header",
    ...listingScreenshotSlots(16),
  ]);
  const url = (copy: HostedImage) => hostedImageUrl(env, product, copy);

  const one = (slot: string, declared: unknown): string | undefined => {
    const copy = images.get(slot);
    if (copy && stands(copy, declared)) return url(copy) ?? undefined;
    return assetRefUrl(declared);
  };

  const screenshots: string[] = [];
  if (declaredShots.length > 0) {
    for (const [i, declared] of declaredShots.entries()) {
      const shot = one(`listing.screenshot:${i + 1}`, declared);
      if (shot !== undefined) screenshots.push(shot);
    }
  } else {
    // Nothing declared (or an outlet override that clears the list): only a console claim stands
    // in, in slot order. A manifest copy was pulled for the root listing's screenshots and must
    // not come back on an outlet that declares none.
    for (const slot of listingScreenshotSlots(16)) {
      const copy = images.get(slot);
      const shot = copy?.origin === "console" ? url(copy) : null;
      if (shot) screenshots.push(shot);
    }
  }

  const art: ListingArt = { screenshots };
  const icon = one("listing.icon", l.icon ?? l.iconUrl);
  const header = one("listing.header", l.header ?? l.headerUrl);
  if (icon !== undefined) art.icon = icon;
  if (header !== undefined) art.header = header;
  return art;
}

/**
 * The listing's screenshots as Polaris Key hosts them, and ONLY those: the image-host originals
 * `feedArt` resolves (each pulled for the listing's own ref, or claimed), in the listing's order,
 * never a developer URL. The PR plane's input for Flathub's MetaInfo `<screenshots>` (A-18i,
 * `prInputs.ts`; S-20 §4.2 L6). Empty while nothing is served from the image host.
 */
export async function hostedScreenshotUrls(
  env: Env,
  db: Db,
  product: string,
  listing: RenderListing | null,
): Promise<string[]> {
  const origin = await hostedImageOrigin(env, db);
  const art = await feedArt(env, db, product, listing);
  if (origin === null || art === null) return [];
  return art.screenshots.filter((u) => u.startsWith(`${origin}/`));
}

/**
 * The part of the feed cache's stamp (`cache.ts`) the hosted art follows: whether hosted copies
 * are served (the kill switch, the image host) and every listing slot's copy and the ref it was
 * pulled for. A copy becoming ready, a re-pull, a claim or a flip of the switch is a new key, so a
 * source names the new art on its next read rather than five minutes later. One D1 read, and none
 * at all while nothing is served from the image host.
 */
export async function hostedArtStamp(
  env: Env,
  db: Db,
  product: string,
): Promise<string> {
  const origin = await hostedImageOrigin(env, db);
  if (origin === null) return "-";
  const row = await db.first<{ s: string | null }>(
    `SELECT group_concat(slot || '=' || COALESCE(sha256, '') || '/' || origin || '/' ||
                         COALESCE(pulled_ref, ''), ',') AS s
       FROM (SELECT slot, sha256, origin, pulled_ref FROM hosted_assets
              WHERE product = ? AND locale = '' AND slot LIKE 'listing.%'
              ORDER BY slot)`,
    product,
  );
  const text = `${origin}|${row?.s ?? ""}`;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest).slice(0, 8)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
