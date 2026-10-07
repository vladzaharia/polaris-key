import type { LibraryProduct } from "./library.js";

/**
 * The library's URL-synced view (§3.3, §4.15): `?view=grid|list`, `?q=`, `?filter=attention`,
 * `?sort=recent|name`. Games / Apps & tools filters need a product category the API doesn't
 * carry yet (G1): with no count they are hidden, as the spec does for any zero-count chip.
 */
export type LibraryViewMode = "grid" | "list";
export type LibraryFilter = "all" | "attention";
export type LibrarySort = "recent" | "name";

export interface LibraryView {
  view: LibraryViewMode | null;
  q: string;
  filter: LibraryFilter;
  sort: LibrarySort;
}

export function readView(params: URLSearchParams): LibraryView {
  const view = params.get("view");
  return {
    view: view === "grid" || view === "list" ? view : null,
    q: params.get("q") ?? "",
    filter: params.get("filter") === "attention" ? "attention" : "all",
    sort: params.get("sort") === "name" ? "name" : "recent",
  };
}

/** Phones show the list by default above 6 products; a remembered choice wins (§4.15). */
export function effectiveMode(
  view: LibraryViewMode | null,
  remembered: LibraryViewMode | null,
  phone: boolean,
  count: number,
): LibraryViewMode {
  if (view) return view;
  if (remembered) return remembered;
  return phone && count > 6 ? "list" : "grid";
}

export function matches(p: LibraryProduct, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return [p.name, p.slug, p.presentation.developer ?? ""].some((s) =>
    s.toLowerCase().includes(needle),
  );
}

/** Newest first, a just-added product (PX-24) ahead of any other whatever its fallback date. */
function byRecent(a: LibraryProduct, b: LibraryProduct): number {
  return Number(b.justAdded) - Number(a.justAdded) || b.addedAt - a.addedAt;
}

/**
 * Search, filter and sort. Under the default sort (Recently added) a just-added product is first
 * (EXPERIENCE §0.6 P1 step 7); By name keeps it in its place.
 */
export function applyView(
  products: readonly LibraryProduct[],
  v: Pick<LibraryView, "q" | "filter" | "sort">,
): LibraryProduct[] {
  const out = products.filter(
    (p) => matches(p, v.q) && (v.filter === "all" || p.status.attention),
  );
  if (v.sort === "name")
    out.sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
    );
  else out.sort(byRecent);
  return out;
}

/**
 * The 2–7 grid, which has no sort (§4.14): the just-added products first, newest first, and the
 * rest in the Worker's order (PX-24; EXPERIENCE §0.6 P1 step 7: the new product is first in the
 * Library for its 24 hours).
 */
export function justAddedFirst(
  products: readonly LibraryProduct[],
): LibraryProduct[] {
  return [
    ...products.filter((p) => p.justAdded).sort(byRecent),
    ...products.filter((p) => !p.justAdded),
  ];
}

export const VIEW_STORAGE_KEY = "pk-portal-library-view";

export function readRememberedMode(): LibraryViewMode | null {
  try {
    const v = window.localStorage.getItem(VIEW_STORAGE_KEY);
    return v === "grid" || v === "list" ? v : null;
  } catch {
    return null;
  }
}

export function rememberMode(mode: LibraryViewMode): void {
  try {
    window.localStorage.setItem(VIEW_STORAGE_KEY, mode);
  } catch {
    // storage unavailable: the URL still carries the choice
  }
}

/** Products from which the scale features (toolbar, list, ⌘K) appear. */
export const SCALE_THRESHOLD = 8;
