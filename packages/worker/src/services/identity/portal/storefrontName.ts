/**
 * `GET /api/storefront/<product>` (LK-12d): the product's name and icon for the signed-out
 * sign-in card, so "Sign in to add <name>" names a product the visitor could really add.
 *
 * ── WHAT AN ANONYMOUS CALLER LEARNS ─────────────────────────────────────────────────────────
 *
 * Exactly what the public download page and Discover already say to a stranger, and only for a
 * product Discover offers a brand-new account an Add action (`discoverVisibility`, LK-12b:
 * the storefront engine's own persona preview, so this cannot drift from Discover). For every
 * other input (a slug nobody holds, an unlisted product, purchase-only, operator-issued, the
 * storefront or the portal off, Identity off) the answer is one uniform 404: the same body and
 * headers, and no cookie, session read or account row on any path. A caller cannot tell
 * "no such product" from "exists, not offered". The icon is the URL the download page draws
 * (the image host's copy at the page's width), never anything else; `null` without one.
 *
 * Charged to a per-network bucket before any lookup; the bucket has no FAIL_MODE row, so it
 * fails closed (the card then shows its generic copy).
 */

import type { Db } from "../../../db/types.js";
import type { Env } from "../../../platform/env.js";
import { loadProductPublic } from "../../../core/products.js";
import { clientNetwork, rateLimitOk } from "../../../core/rateLimit.js";
import {
  PRESENTATION_ICON_SLOTS,
  firstHostedImage,
  hostedImageOrigin,
  hostedImageUrl,
  hostedImages,
  PRESENTATION_HEADER_SLOTS,
} from "../../../core/assets/hostedImages.js";
import { err, notFound, portalJson, type PortalHooksFor } from "./api.js";

export const STOREFRONT_NAME_BUCKET = "portalStorefrontName";
export const STOREFRONT_NAME_LIMIT_PER_MINUTE = 60;
/** The icon's width: the download page's (`PAGE_ICON_WIDTH`, 64 px at 2x), so the URL is the same. */
const ICON_WIDTH = 128;
const SLUG = /^[a-z0-9-]{1,64}$/;

export async function handleStorefrontName(
  req: Request,
  env: Env,
  db: Db,
  product: string,
  now: number,
  hooksFor: PortalHooksFor | undefined,
): Promise<Response> {
  if (req.method !== "GET" && req.method !== "HEAD")
    return err(405, "method_not_allowed");
  const allowed = await rateLimitOk(
    env,
    "_portal",
    {
      bucket: STOREFRONT_NAME_BUCKET,
      id: clientNetwork(req),
      limit: STOREFRONT_NAME_LIMIT_PER_MINUTE,
      windowSec: 60,
    },
    now,
  );
  if (!allowed) return err(429, "rate_limited", "too many requests");
  const shown = await storefrontView(env, db, product, now, hooksFor);
  if (!shown) return notFound();
  return portalJson({ name: shown.name, iconUrl: shown.iconUrl }, 200, {
    "cache-control": "public, max-age=300",
  });
}

/** The art's width: the passport's (16:10 at 280 px, drawn at 2x), as `appForPage` draws it. */
const ART_WIDTH = 640;

/**
 * What an anonymous caller may learn about a product: its name, icon and header art, only for a
 * product Discover offers a brand-new account (the file comment). `null` for every other input,
 * so a caller cannot tell "no such product" from "exists, not offered". Shared by this route and
 * `GET /api/capabilities?product=` (the sign-in card's product header).
 */
export async function storefrontView(
  env: Env,
  db: Db,
  product: string,
  now: number,
  hooksFor: PortalHooksFor | undefined,
): Promise<{
  slug: string;
  name: string;
  iconUrl: string | null;
  artUrl: string | null;
} | null> {
  if (!hooksFor || !SLUG.test(product)) return null;
  const loaded = await loadProductPublic(db, product);
  if (!loaded) return null;
  if ((await hooksFor(loaded, now).discoverVisibility()) !== true) return null;
  let iconUrl: string | null = null;
  let artUrl: string | null = null;
  if ((await hostedImageOrigin(env, db)) !== null) {
    const images = (slots: readonly string[]) =>
      hostedImages(env, db, product, slots);
    const icon = firstHostedImage(
      await images(PRESENTATION_ICON_SLOTS),
      PRESENTATION_ICON_SLOTS,
    );
    iconUrl = icon ? hostedImageUrl(env, product, icon, ICON_WIDTH) : null;
    const header = firstHostedImage(
      await images(PRESENTATION_HEADER_SLOTS),
      PRESENTATION_HEADER_SLOTS,
    );
    artUrl = header ? hostedImageUrl(env, product, header, ART_WIDTH) : null;
  }
  return { slug: loaded.slug, name: loaded.name, iconUrl, artUrl };
}
