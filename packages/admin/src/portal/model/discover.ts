import type {
  PortalDiscoverOffer,
  PortalDiscoverTerms,
  PortalLibraryItem,
} from "../api.js";
import { PLATFORM_ORDER, type PlatformKey } from "../components/Glyphs.js";
import { formatDay, normalisePlatform, tierLabel } from "./library.js";

/**
 * Discover's words and shapes (PORTAL.md §4.16), kept in one module: what an offer gives
 * ("Lifetime · 5 devices"), why the account can add it (Q-6: always shown), and the tile a
 * just-added product keeps. How licences map to what a product grants is the Worker's (S-19 may
 * change it): this module only words the terms the Worker sends and never derives them.
 */

export type ReasonKind = "account" | "group" | "added" | "other";

export interface ReasonCopy {
  kind: ReasonKind;
  text: string;
}

/** The reason line for a Worker reason code. Unknown codes get honest generic copy. */
export function reasonCopy(reason: string): ReasonCopy {
  if (reason === ADDED_REASON)
    return { kind: "added", text: "Added from Discover, at no cost" };
  if (reason === "free_with_account")
    return { kind: "account", text: "Free with a Polaris Key account" };
  if (reason.startsWith("group:")) {
    const group = reason.slice("group:".length).trim();
    if (group) return { kind: "group", text: `For members of ${group}` };
  }
  return { kind: "other", text: "Offered to your account by its developer" };
}

/** "Lifetime · 5 devices", "Beta · 90 days · 2 devices": the tier and its terms. */
export function termsLine(terms: PortalDiscoverTerms): string {
  const tier = terms.tierLabel ?? tierLabel(terms.tier);
  const parts: string[] = [];
  if (tier) parts.push(tier);
  if (terms.expiryDays !== null)
    parts.push(
      `${terms.expiryDays} ${terms.expiryDays === 1 ? "day" : "days"}`,
    );
  else if (terms.expiresAt !== null)
    parts.push(`Until ${formatDay(terms.expiresAt)}`);
  else if (!tier || tier.toLowerCase() !== "lifetime") parts.push("Lifetime");
  if (terms.deviceLimit > 0)
    parts.push(
      `${terms.deviceLimit} ${terms.deviceLimit === 1 ? "device" : "devices"}`,
    );
  return parts.join(" · ");
}

/** The Worker's platform names as glyph keys, in the site's platform order. */
export function offerPlatforms(platforms: readonly string[]): PlatformKey[] {
  const keys = new Set(platforms.map(normalisePlatform));
  return PLATFORM_ORDER.filter((k) => keys.has(k));
}

/**
 * A just-added product's tile after a reload (`#/discover?added=<p>`): the offer is gone from
 * `GET /api/discover` (the account holds it now), so the tile is rebuilt from the library item.
 * Its reason line says what happened instead of why it was offered.
 */
export function addedOfferFromLibrary(
  item: PortalLibraryItem,
): PortalDiscoverOffer {
  const {
    product,
    license,
    status: _s,
    licenseCount: _c,
    addedAt: _a,
    ...pres
  } = item;
  return {
    ...pres,
    product,
    platforms: [],
    offer: {
      tier: license.tier,
      tierLabel: null,
      deviceLimit: license.deviceLimit,
      expiresAt: license.expiresAt,
      expiryDays: null,
    },
    reason: ADDED_REASON,
  };
}

/** The reason code of a tile rebuilt from the library (never sent by the Worker). */
export const ADDED_REASON = "pk:added";

/** Offers by name, the just-added ones kept in place among them. */
export function mergeAdded(
  offers: readonly PortalDiscoverOffer[],
  added: readonly PortalDiscoverOffer[],
): PortalDiscoverOffer[] {
  const out = new Map<string, PortalDiscoverOffer>();
  for (const o of offers) out.set(o.product, o);
  for (const a of added) if (!out.has(a.product)) out.set(a.product, a);
  return [...out.values()].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
  );
}
