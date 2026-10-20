/**
 * "Get a badge" (LK-10; plans/LK-00.md A3 §14.6): which Polaris Locker badge labels a product
 * backs. A badge is a claim on someone else's page, so a label shows only when the product does
 * what it says. "Powered by" is always true.
 */

import type { LockerBadgeOptions } from "@polaris-key/brand/svg";
import type {
  PolarisKeyStatusResponse,
  ProductDetail,
} from "../../../../api.js";

type LockerBadgeKind = LockerBadgeOptions["kind"];

export interface OfferedBadge {
  kind: LockerBadgeKind;
  /** Why the product may carry it, in the product's terms. */
  because: string;
}

const on = (p: ProductDetail | undefined, slug: string): boolean =>
  (p?.services as Record<string, { enabled: boolean }> | undefined)?.[slug]
    ?.enabled === true;

export function offeredBadges(
  status: PolarisKeyStatusResponse,
  product: ProductDetail | undefined,
): OfferedBadge[] {
  const listed =
    status.enabled &&
    status.portalEnabled &&
    (status.listing.listed === "listed" ||
      (status.listing.listed === "auto" &&
        status.readiness.find((c) => c.id === "listing")?.state === "pass"));
  const out: OfferedBadge[] = [];
  const add = (label: string, because: string): void => {
    out.push({ kind: `locker-${label}` as LockerBadgeKind, because });
  };
  if (listed) {
    add("open-in", "Listed on Polaris Locker");
    add("available-on", "Listed on Polaris Locker");
  }
  if (on(product, "identity")) add("sign-in-with", "Sign-in is on");
  if (on(product, "distribution")) add("download-from", "Downloads are on");
  if (on(product, "commerce")) {
    add("buy-on", "Purchases are on");
    add("purchase-with", "Purchases are on");
  }
  if (on(product, "update")) add("update-with", "Updates are on");
  if (on(product, "sync")) add("sync-with", "Sync is on");
  add("powered-by", "Always");
  return out;
}

/** The product's page on Polaris Locker, or `null` while there is no customer site. */
export function lockerUrl(
  customerOrigin: string | null | undefined,
  slug: string,
): string | null {
  return customerOrigin
    ? `${customerOrigin}/#/discover/${encodeURIComponent(slug)}`
    : null;
}

/** The HTML to paste: the art as a link to `url`. */
export function badgeHtml(svg: string, url: string, alt: string): string {
  const safe = url.replace(/"/g, "&quot;");
  return `<a href="${safe}" aria-label="${alt.replace(/"/g, "&quot;")}">${svg}</a>`;
}
