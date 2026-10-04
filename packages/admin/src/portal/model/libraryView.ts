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
  else out.sort((a, b) => b.addedAt - a.addedAt);
  return out;
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
