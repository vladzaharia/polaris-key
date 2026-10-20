import type { PortalDiscoverOffer } from "../api.js";
import {
  formatDay,
  storeName,
  tierLabel,
  type LibraryProduct,
} from "./library.js";

/**
 * A tile's facts for the Library and Discover (portal.library, portal.discover): the tier, the
 * device count and one fact per line, from what the Worker sends today. The duration line
 * ("Updates until", "Then keeps the last version"), the add-ons and "Automatic grant" are not
 * here: they wait for LX-15, LX-38 and LX-41 (PX-28b).
 */
export interface TileFact {
  kind: "term" | "store" | "free" | "note" | "about";
  text: string;
}

export interface TileFacts {
  tier: string | null;
  devices: { text: string; atLimit: boolean } | null;
  lines: TileFact[];
}

/** "3/4 devices", "2 devices", "1 device". */
export function deviceCount(n: number, limit?: number | null): string {
  const word =
    (limit != null && limit > 0 ? limit : n) === 1 ? "device" : "devices";
  return limit != null && limit > 0 ? `${n}/${limit} ${word}` : `${n} ${word}`;
}

export function libraryTileFacts(p: LibraryProduct): TileFacts {
  if (p.kind === "entry")
    return {
      tier: null,
      devices: null,
      lines: [{ kind: "free", text: "Free to use" }],
    };
  const l = p.best;
  const tier =
    tierLabel(l.tier) ??
    (l.identityProvider === "oidc" && l.keyCount === 0 ? "Standard" : null);
  const seats = p.seats;
  const count = seats ? seats.inUse : p.deviceCount;
  const devices =
    seats || count > 0
      ? {
          text: deviceCount(count, seats?.limit),
          atLimit: Boolean(
            seats && seats.limit > 0 && seats.inUse >= seats.limit,
          ),
        }
      : null;
  const lines: TileFact[] = [];
  const kind = p.status.kind;
  if (kind === "suspended")
    lines.push({ kind: "note", text: "Suspended by the developer" });
  else if (l.expiresAt !== null) {
    const day = formatDay(l.expiresAt, kind !== "expiresSoon");
    lines.push({
      kind: "term",
      text:
        kind === "expired"
          ? `Ended ${day}`
          : kind === "expiresSoon"
            ? `Ends ${day}`
            : `Until ${day}`,
    });
  }
  if ((l.origin === "store" || l.origin === "store-key") && l.originStore)
    lines.push({
      kind: "store",
      text: `Bought on ${storeLabel(l.originStore)}`,
    });
  return { tier, devices, lines };
}

/** "the App Store", "Steam": a store as a sentence names it. */
function storeLabel(store: string): string {
  const name = storeName(store);
  return store === "app-store" ? `the ${name}` : name;
}

/**
 * A Discover tile's facts from the offer's terms: the tier, the device limit and how long it
 * lasts; an open product's or a link's one-line description instead of terms.
 */
export function discoverTileFacts(o: PortalDiscoverOffer): TileFacts {
  const terms = o.offer;
  if (!terms)
    return {
      tier: null,
      devices: null,
      lines: o.shortDescription
        ? [{ kind: "about", text: o.shortDescription }]
        : [],
    };
  const tier = terms.tierLabel ?? tierLabel(terms.tier);
  const lines: TileFact[] = [];
  if (terms.expiryDays !== null)
    lines.push({
      kind: "term",
      text: `${terms.expiryDays} ${terms.expiryDays === 1 ? "day" : "days"}`,
    });
  else if (terms.expiresAt !== null)
    lines.push({ kind: "term", text: `Until ${formatDay(terms.expiresAt)}` });
  else if (!tier || tier.toLowerCase() !== "lifetime")
    lines.push({ kind: "term", text: "Lifetime" });
  return {
    tier,
    devices:
      terms.deviceLimit > 0
        ? { text: deviceCount(terms.deviceLimit), atLimit: false }
        : null,
    lines,
  };
}
