/**
 * Product presentation (HA-12; WIRE-CONTRACT-V4 §5.5, plans/HA-11.md §2.1, plans/HA-12.md §2.3):
 * discovery's unsigned `core.presentation`, and the text half the portal shares.
 *
 * Display data, never authority (S-20 owner decision 10): no gate, entitlement or trust decision
 * reads anything here, in the Worker or in an SDK.
 *
 * ── WHERE EACH FIELD COMES FROM ─────────────────────────────────────────────────────────────
 *
 *   name           the Distribution listing's `name`, else `products.name`;
 *   developerName  the listing's `developerName` (plans/HA-11.md Q2);
 *   accent         `.pkey/product` `presentation.accent` (`products.presentation_json`), else the
 *                  listing's `tintColor` (Q3), lower-cased;
 *   accentDark     `presentation.accentDark`, lower-cased;
 *   icon           the hosted copy the image host serves for its `/icon` alias: the
 *                  `presentation.icon` slot, else `listing.icon` (Q4), exactly as HA-07's
 *                  `hostedImages()` defines a copy, so discovery, the portal, the console card and
 *                  the alias always agree. `original` is its content-addressed URL, `url` the
 *                  WebP template, and `sizes` each ladder width with its own hash (Q1).
 *
 * The listing is read only through Core's `delivery` hook (rule 6), which answers `null` while
 * Distribution is off.
 *
 * ── WHAT IS NEVER EMITTED ───────────────────────────────────────────────────────────────────
 *
 * Only bytes an SDK can verify: a slot with no hosted copy (a product not resynced since HA-05, a
 * first pull in flight) has NO icon in discovery, and neither does a deployment with hosting off
 * or no image host (`hostedImageOrigin`). Never the manifest's icon ref (a developer URL or a repo
 * path), the portal's `/media` proxy, or the image host's `/icon` alias (a redirect an SDK refuses
 * to follow) (plans/HA-12.md Q3).
 *
 * ── THE FIXED POINT ─────────────────────────────────────────────────────────────────────────
 *
 * The candidate goes through client-core's `parsePresentation`, the reference every SDK ports, so
 * the Worker never emits a field an SDK would drop (a listing `developerName` the manifest allows
 * but §5.5's text rule does not, say), and what it emits re-parses to itself. The member is
 * emitted only when something beyond the name survives (Q8), so a product with nothing to show
 * keeps today's document byte for byte.
 */

import { parsePresentation } from "@polaris-key/client-core/presentation";
import {
  PRESENTATION_MAX_ICON_SIZES,
  type PresentationIcon,
  type PresentationIconType,
  type ProductPresentation,
} from "@polaris-key/protocol/core";
import type { Env } from "../env.js";
import type { Db } from "../db/types.js";
import type { ProductPublic } from "./products.js";
import type { ServiceHooks } from "./hooks.js";
import {
  PRESENTATION_ICON_SLOTS,
  firstHostedImage,
  hostedImageOrigin,
  hostedImages,
} from "./hostedImages.js";
import { imgUrl } from "./imgHostname.js";

/** The text half: what the portal shares with discovery (it draws its own art, HA-07). */
export interface PresentationText {
  name: string;
  developerName: string | null;
  /** `#rrggbb`, lower-case. */
  accent: string | null;
  /** `#rrggbb`, lower-case. */
  accentDark: string | null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** The product's name, developer and accents (see the file comment). Pure. */
export function presentationText(
  product: Pick<ProductPublic, "name" | "presentation">,
  listing: Readonly<Record<string, unknown>> | null,
): PresentationText {
  return {
    name: str(listing?.name) ?? product.name,
    developerName: str(listing?.developerName),
    accent:
      (
        str(product.presentation?.accent) ?? str(listing?.tintColor)
      )?.toLowerCase() ?? null,
    accentDark: str(product.presentation?.accentDark)?.toLowerCase() ?? null,
  };
}

/**
 * The icon as discovery names it, or `null`: hosting is off, there is no image host, or neither
 * icon slot has a hosted copy. One D1 statement, skipped while hosting is off.
 */
export async function presentationIcon(
  env: Env,
  db: Db,
  slug: string,
): Promise<PresentationIcon | null> {
  if (hostedImageOrigin(env) === null) return null;
  const image = firstHostedImage(
    await hostedImages(env, db, slug, PRESENTATION_ICON_SLOTS),
    PRESENTATION_ICON_SLOTS,
  );
  if (!image) return null;
  const original = imgUrl(env, slug, image.sha256);
  if (original === null) return null;
  const sizes = image.variants
    .slice(0, PRESENTATION_MAX_ICON_SIZES)
    .map((v) => ({ w: v.w, sha256: v.sha256 }));
  return {
    sha256: image.sha256,
    contentType: image.contentType as PresentationIconType,
    ...(image.width !== null ? { width: image.width } : {}),
    ...(image.height !== null ? { height: image.height } : {}),
    original,
    ...(sizes.length > 0 ? { url: `${original}/{w}.webp` } : {}),
    sizes,
  };
}

/** What `resolvePresentation` reads: discovery's context, or any request's equivalent. */
export interface PresentationContext {
  product: Pick<ProductPublic, "slug" | "name" | "presentation">;
  env: Env;
  db: Db;
  hooks: Pick<ServiceHooks, "delivery">;
}

/**
 * `core.presentation`, normalised, or `null` when nothing beyond the name resolves (the member is
 * then omitted). A failed read (the listing, the hosted copy) answers `null` too, with a warning in
 * the Worker's logs: presentation is display data and never fails discovery.
 */
export async function resolvePresentation(
  ctx: PresentationContext,
): Promise<ProductPresentation | null> {
  try {
    const delivery = ctx.hooks.delivery();
    const listing = delivery
      ? ((await delivery.listing()) as Readonly<Record<string, unknown>> | null)
      : null;
    const text = presentationText(ctx.product, listing);
    const icon = await presentationIcon(ctx.env, ctx.db, ctx.product.slug);
    const parsed = parsePresentation(
      {
        presentation: {
          name: text.name,
          developerName: text.developerName ?? undefined,
          accent: text.accent ?? undefined,
          accentDark: text.accentDark ?? undefined,
          icon: icon ?? undefined,
        },
      },
      { name: ctx.product.name, product: ctx.product.slug },
    );
    if (
      parsed === null ||
      (parsed.developerName === undefined &&
        parsed.accent === undefined &&
        parsed.accentDark === undefined &&
        parsed.icon === undefined)
    )
      return null;
    return parsed;
  } catch (err) {
    // Display data never fails discovery, but a swallowed failure is still logged (Workers Logs):
    // the product slug and the error only. No request, device or account fact is in scope here.
    console.warn(
      JSON.stringify({
        event: "core.presentation.resolve_failed",
        product: ctx.product.slug,
        error: err instanceof Error ? err.name : typeof err,
        message: err instanceof Error ? err.message.slice(0, 200) : undefined,
      }),
    );
    return null;
  }
}
