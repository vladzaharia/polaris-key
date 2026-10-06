import * as React from "react";
import { History } from "lucide-react";
import { pageOf } from "../../nav.js";
import {
  globalPage,
  parseLocation,
  productPage,
  type Route,
} from "../../routes.js";
import { PREF_KEYS, readPref, stringArray, writePref } from "../../storage.js";
import type { ProductLike } from "../bits.js";
import type { PaletteItem } from "./types.js";

/** How many recents the palette keeps (EXPERIENCE.md §0.3 J-1: the last 5). */
export const RECENT_MAX = 5;

/** The prefix of a recent that names a record the operator opened, not a palette row. */
const RECORD = "record:";

/**
 * The recents list, newest first: palette row ids (`nav:djdl:settings`, `action:create-license`)
 * and records opened anywhere in the console (`record:#/p/djdl/license/licenses/lic_1`). One list
 * in one preference, so "the last 5" means the last five things, whichever way they were reached.
 */
export function readRecents(): string[] {
  return readPref(PREF_KEYS.recentCommands, stringArray, []);
}

/** Put `id` first, keeping the list unique and at most `RECENT_MAX` long. */
export function pushRecent(id: string, list = readRecents()): string[] {
  const next = [id, ...list.filter((x) => x !== id)].slice(0, RECENT_MAX);
  writePref(PREF_KEYS.recentCommands, next);
  return next;
}

/**
 * The recents id of the record a route shows, or `null` when it shows no record. A tab or a query
 * does not make a different record: the license is the same on its Keys tab.
 */
export function recordRecentId(route: Route): string | null {
  if (route.kind === "not-found" || route.id === undefined) return null;
  const child = route.child ? { ids: route.child.ids } : undefined;
  const href =
    route.kind === "product"
      ? productPage(route.slug, route.page, { id: route.id, child })
      : globalPage(route.page, undefined, { id: route.id, child });
  return `${RECORD}${href}`;
}

/**
 * A recorded record as a palette row: "License lic_1 · Licenses · DJDL". `null` when it no longer
 * resolves (a product the session lost, a page that moved). Names instead of ids arrive with the
 * entity source (UX-06b), which can enrich the same id.
 */
export function recordItem(
  id: string,
  products: ProductLike[],
): PaletteItem | null {
  if (!id.startsWith(RECORD)) return null;
  const href = id.slice(RECORD.length);
  const { route, redirect } = parseLocation(href);
  if (redirect || route.kind === "not-found" || route.id === undefined)
    return null;
  const page = pageOf(route.page);
  const record = page.record;
  if (!record) return null;
  const childNoun = route.child && record.child ? record.child.noun : null;
  const name = route.child
    ? `${childNoun ?? record.noun} ${route.child.ids.join("/")}`
    : `${record.noun} ${route.id}`;
  let where = page.label;
  if (route.kind === "product") {
    const product = products.find((p) => p.slug === route.slug);
    if (!product) return null;
    where = `${page.label} · ${product.name}`;
  }
  return {
    id,
    group: "Recent",
    label: name,
    detail: where,
    keywords: `${route.id} ${route.kind === "product" ? route.slug : ""}`,
    icon: <History aria-hidden className="size-4" />,
    href,
  };
}

/** Resolve the stored recents against the rows on offer now; anything that no longer exists drops. */
export function resolveRecents(
  ids: string[],
  items: PaletteItem[],
  products: ProductLike[],
): PaletteItem[] {
  const out: PaletteItem[] = [];
  for (const id of ids) {
    const item = id.startsWith(RECORD)
      ? recordItem(id, products)
      : items.find((i) => i.id === id);
    if (item) out.push(item);
  }
  return out;
}

/**
 * Remember every record the operator opens, however they reached it (a table row, a link, the
 * palette). The palette is mounted for the life of the console, so it is the one place that sees
 * every route change.
 */
export function useRecordRecents(route: Route, known: boolean): void {
  const id = known ? recordRecentId(route) : null;
  React.useEffect(() => {
    if (id) pushRecent(id);
  }, [id]);
}
