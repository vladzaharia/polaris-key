/**
 * Help on the customer host (LK-09, plans/LK-00.md D7). One docs build serves two hosts: Help is
 * the customer's, at polaris.locker/docs/help/, and every other door stays on key.plrs.im.
 *
 * Canonical decision: a Help page's canonical URL and `og:url` are the polaris.locker address,
 * because that is the URL a customer is sent to (key.plrs.im/docs/help/* answers a 301 to it).
 */
import { doorOf, type DoorId } from "./doors";

/** The customer site's production origin (LK-00 §0). */
export const CUSTOMER_SITE = "https://polaris.locker";

/** True for the id of a Help page (`help`, `help/activate`). */
export const helpRoute = (id: string): boolean =>
  id === "help" || id.startsWith("help/");

interface SidebarEntry {
  type: "link" | "group";
  href?: string;
  entries?: SidebarEntry[];
}

/** The door of a sidebar link (`/docs/help/activate/`), null when no door owns it. */
function doorOfHref(href: string): DoorId | null {
  const id = href
    .replace(/^\/docs\//, "")
    .replace(/[?#].*$/, "")
    .replace(/\/$/, "");
  return doorOf(id || "index")?.door ?? null;
}

/** The sidebar entries that hold a link into `door`; a group keeps only those links. */
export function scopeSidebar<T extends SidebarEntry>(
  entries: readonly T[],
  door: DoorId,
): T[] {
  const out: T[] = [];
  for (const entry of entries) {
    if (entry.type === "link") {
      if (entry.href && doorOfHref(entry.href) === door) out.push(entry);
    } else {
      const inner = scopeSidebar(entry.entries ?? [], door);
      if (inner.length > 0) out.push({ ...entry, entries: inner });
    }
  }
  return out;
}

/**
 * The Locker icon for a Key icon href (`/docs/branding/key/favicon.svg`): same file name, except
 * the touch icon, which the Locker kit calls `apple-touch-icon.png`.
 */
export function lockerIcon(href: string): string {
  return href
    .replace(
      "/branding/key/app-icon-dark-180.png",
      "/branding/locker/apple-touch-icon.png",
    )
    .replace("/branding/key/", "/branding/locker/");
}
