import { discoverCountFrom } from "./owned.js";

/**
 * Discover's count in the nav, the phone bar and the library (PORTAL.md §4.16, FLOWS.md P-13).
 *
 * The rule (EXPERIENCE.md P6, no dead ends): a count is shown only when the Discover page can
 * show the items it counts. The Worker already sends `discoverCount` (PX-W10), but until the
 * page lists `GET /api/discover` (PX-16) it shows "Nothing to add right now", so a count of 4 in
 * the nav would promise four things the page cannot show. Every surface that shows the count
 * reads it through `useLibrary()`, which reads it through `navDiscoverCount`: one place decides.
 *
 * PX-16 sets `DISCOVER_LISTS_OFFERS` to `true` in the change that makes the page list offers.
 */
export const DISCOVER_LISTS_OFFERS: boolean = false;

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
