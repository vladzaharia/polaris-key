import { PRODUCT_SLUG_RE } from "@polaris-key/manifest";
import type {
  PortalDiscoverOffer,
  PortalDiscoverTerms,
  PortalLibraryItem,
  PortalObtainPath,
  PortalStorefrontStore,
} from "../api.js";
import { PLATFORM_ORDER, type PlatformKey } from "../components/Glyphs.js";
import {
  formatDay,
  normalisePlatform,
  storeName,
  tierLabel,
} from "./library.js";
import { discoverCountFrom } from "./owned.js";

/**
 * Discover's words and shapes (PORTAL.md §4.16), kept in one module: what an offer gives
 * ("Lifetime · 5 devices"), why the account can add it (Q-6: always shown), and the tile a
 * just-added product keeps. How licences map to what a product grants is the Worker's (S-19 may
 * change it): this module only words the terms the Worker sends and never derives them.
 */

export type ReasonKind =
  | "account"
  | "trial"
  | "group"
  | "idp"
  | "domain"
  | "store"
  | "open"
  | "added"
  | "other";

export interface ReasonCopy {
  kind: ReasonKind;
  text: string;
}

const GENERIC: ReasonCopy = {
  kind: "other",
  text: "Offered to your account by its developer",
};

/** The reason line for a Worker reason code. Unknown codes get honest generic copy. */
export function reasonCopy(reason: string): ReasonCopy {
  if (reason === ADDED_REASON)
    return { kind: "added", text: "Added from Discover, at no cost" };
  if (reason === "free_with_account")
    return { kind: "account", text: "Free with a Polaris Key account" };
  if (reason === "open") return { kind: "open", text: "Free to use" };
  if (reason.startsWith("group:")) {
    const group = reason.slice("group:".length).trim();
    if (group) return { kind: "group", text: `For members of ${group}` };
  }
  return GENERIC;
}

/**
 * Why the account can add the product by this path (notes/S-21 §6.5's table; owner decision Q-6:
 * every offer says why). A path this build doesn't know reads by its reason code, generically.
 *
 * - `auto_issue`: "Free with a Polaris Key account", or "Free trial · 14 days" when the tier
 *   expires;
 * - `group`: "Included with <label>" when the operator labelled the group, else "For members of
 *   <group>";
 * - `product_idp`: "Included with your <IdP> account"; `email_domain`: "For everyone with a
 *   <domain> email"; `store_owned`: "You own it on Steam";
 * - `open`: "Free to use".
 */
export function pathCopy(path: PortalObtainPath): ReasonCopy {
  const detail = path.detail?.trim() || null;
  switch (path.kind) {
    case "auto_issue": {
      const t = path.terms;
      if (t?.expiryDays != null)
        return {
          kind: "trial",
          text: `Free trial · ${t.expiryDays} ${t.expiryDays === 1 ? "day" : "days"}`,
        };
      if (t?.expiresAt != null)
        return {
          kind: "trial",
          text: `Free trial · until ${formatDay(t.expiresAt)}`,
        };
      return { kind: "account", text: "Free with a Polaris Key account" };
    }
    case "group": {
      const label = path.label?.trim();
      if (label) return { kind: "group", text: `Included with ${label}` };
      if (detail) return { kind: "group", text: `For members of ${detail}` };
      return reasonCopy(path.reason);
    }
    case "product_idp":
      return detail
        ? { kind: "idp", text: `Included with your ${detail} account` }
        : GENERIC;
    case "email_domain":
      return detail
        ? { kind: "domain", text: `For everyone with a ${detail} email` }
        : GENERIC;
    case "store_owned":
      return {
        kind: "store",
        text: detail
          ? `You own it on ${storeName(detail)}`
          : "You own it in a store",
      };
    case "open":
      return { kind: "open", text: "Free to use" };
    default:
      return reasonCopy(path.reason);
  }
}

/** The tile's reason line: the first path's, or `null` for a link (S-21 §6.5: no reason line). */
export function offerReason(offer: PortalDiscoverOffer): ReasonCopy | null {
  if (offer.reason === ADDED_REASON) return reasonCopy(ADDED_REASON);
  const first = offer.paths[0];
  return first ? pathCopy(first) : null;
}

/** "+1 more way", "+2 more ways": the paths beyond the tile's first, or `null`. */
export function moreWaysText(offer: PortalDiscoverOffer): string | null {
  const more = offer.paths.length - 1;
  if (more < 1) return null;
  return `+${more} more ${more === 1 ? "way" : "ways"}`;
}

/** What a path gives, for the product page: its licence terms, or what an open product means. */
export function pathTermsLine(path: PortalObtainPath): string {
  return path.terms ? termsLine(path.terms) : "No license needed";
}

/** "Get it on Steam", "Get it on the App Store": a link-only offer's action for one store page. */
export function storeLinkLabel(store: PortalStorefrontStore): string {
  if (store.kind === "app-store") return "Get it on the App Store";
  if (store.kind === "play") return "Get it on Google Play";
  return `Get it on ${store.label}`;
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

/** How many just-added products `?added=` remembers for a reload: the most recent ones. */
export const ADDED_PARAM_MAX = 12;

/**
 * The just-added products a Discover URL names (`#/discover?added=<p>&added=<q>`): each once,
 * oldest first, at most {@link ADDED_PARAM_MAX} (the most recent). A value that is not a product
 * slug is dropped, so a crafted link's junk is not carried forward on later adds.
 */
export function addedParam(params: URLSearchParams): string[] {
  const out: string[] = [];
  for (const slug of params.getAll("added")) {
    if (!PRODUCT_SLUG_RE.test(slug)) continue;
    const at = out.indexOf(slug);
    if (at >= 0) out.splice(at, 1);
    out.push(slug);
  }
  return out.slice(-ADDED_PARAM_MAX);
}

/** `?added=` once `slug` is added too: the earlier ones kept, `slug` the most recent. */
export function withAdded(current: readonly string[], slug: string): string[] {
  return [...current.filter((s) => s !== slug), slug].slice(-ADDED_PARAM_MAX);
}

/**
 * A just-added product's tile after a reload (`#/discover?added=<p>`): the offer is gone from
 * `GET /api/discover` (the account holds it now), so the tile is rebuilt from the library item:
 * the licence's terms, or none for an open product's entry. Its reason line says what happened
 * instead of why it was offered.
 */
export function addedOfferFromLibrary(
  item: PortalLibraryItem,
): PortalDiscoverOffer {
  const {
    developerName,
    tintColor,
    website,
    iconUrl,
    headerUrl,
    support,
    name,
    product,
  } = item;
  const terms: PortalDiscoverTerms | null = item.license
    ? {
        tier: item.license.tier,
        tierLabel: null,
        deviceLimit: item.license.deviceLimit,
        expiresAt: item.license.expiresAt,
        expiryDays: null,
      }
    : null;
  return {
    name,
    developerName,
    tintColor,
    website,
    iconUrl,
    headerUrl,
    support,
    product,
    platforms: [],
    shortDescription: null,
    cta: "add",
    paths: [],
    offer: terms,
    reason: ADDED_REASON,
    stores: [],
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

/**
 * Discover's count in the nav, the phone bar and the library (PORTAL.md §4.16, FLOWS.md P-13).
 *
 * The rule (EXPERIENCE.md P6, no dead ends): a count is shown only when the Discover page can
 * show the items it counts. The Worker already sends `discoverCount` (PX-W10), but until the
 * page lists `GET /api/discover` (PX-16) it shows "Nothing to add right now", so a count of 4 in
 * the nav would promise four things the page cannot show. Every surface that shows the count
 * reads it through `useLibrary()`, which reads it through `navDiscoverCount`: one place decides.
 *
 * PX-16 makes the page list offers, so `DISCOVER_LISTS_OFFERS` is `true`.
 */
export const DISCOVER_LISTS_OFFERS: boolean = true;

/**
 * The count the portal may show, or `null` to keep Discover out of the nav (and the library's
 * "in Discover" lines out of the page): `null` while the page cannot list offers, else the
 * Worker's count when it is a whole, non-negative number (`0` keeps Discover in the nav with no
 * count).
 */
export function navDiscoverCount(
  raw: unknown,
  pageListsOffers: boolean = DISCOVER_LISTS_OFFERS,
): number | null {
  return pageListsOffers ? discoverCountFrom(raw) : null;
}
