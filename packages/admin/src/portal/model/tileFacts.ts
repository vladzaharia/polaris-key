import { t } from "../../lib/copy.js";
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
 * ("Updates until", "Then keeps the last version"), the add-ons and "Sign-in" are not
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
  return limit != null && limit > 0
    ? t("locker.devices.ratio", { used: n, limit })
    : t("devices.count", { count: n });
}

export function libraryTileFacts(p: LibraryProduct): TileFacts {
  if (p.kind === "entry")
    return {
      tier: null,
      devices: null,
      lines: [{ kind: "free", text: t("locker.offer.reasonOpen") }],
    };
  const l = p.best;
  // A license with no tier is "Standard", as on the product page (model/product.ts).
  const tier = tierLabel(l.tier) ?? t("locker.tier.standard");
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
    lines.push({ kind: "note", text: t("locker.status.suspendedTile") });
  else if (l.expiresAt !== null) {
    const day = formatDay(l.expiresAt, kind !== "expiresSoon");
    lines.push({
      kind: "term",
      text:
        kind === "updatesEnded"
          ? t("locker.status.keepsWorking")
          : kind === "expired"
            ? t("locker.status.ended", { date: day })
            : kind === "expiresSoon"
              ? t("locker.status.ends", { date: day })
              : t("locker.status.until", { date: day }),
    });
  }
  if ((l.origin === "store" || l.origin === "store-key") && l.originStore)
    lines.push({
      kind: "store",
      text: boughtOn(l.originStore),
    });
  return { tier, devices, lines };
}

/** "Bought on the App Store", "Bought on Steam". */
function boughtOn(store: string): string {
  return store === "app-store"
    ? t("locker.status.boughtOnAppStore")
    : t("locker.status.boughtOn", { store: storeName(store) });
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
  const tier =
    terms.tierLabel ?? tierLabel(terms.tier) ?? t("locker.tier.standard");
  const lines: TileFact[] = [];
  if (terms.expiryDays !== null)
    lines.push({
      kind: "term",
      text: t("locker.packages.days", { count: terms.expiryDays }),
    });
  else if (terms.expiresAt !== null)
    lines.push({
      kind: "term",
      text: t("locker.status.until", { date: formatDay(terms.expiresAt) }),
    });
  else if (!tier || tier.toLowerCase() !== "lifetime")
    lines.push({ kind: "term", text: t("signin.term.lifetime") });
  return {
    tier,
    devices:
      terms.deviceLimit > 0
        ? { text: deviceCount(terms.deviceLimit), atLimit: false }
        : null,
    lines,
  };
}
