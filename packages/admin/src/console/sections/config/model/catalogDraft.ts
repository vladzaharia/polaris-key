/**
 * The catalog editor's draft (docs/design/ADMIN.md §6.6.2, CAT-6): one working copy shared by the
 * form and JSON modes, kept in `sessionStorage` per product so leaving the page, reloading or a
 * crash never silently loses it. The draft remembers the version it started from (`baseVersion`,
 * `0` before the first publish) and that version's entries, so the review diffs against what the
 * operator actually edited and the publish can send `expectedVersion` (A-6).
 */

import type { ConfigEntry, ProductCatalog } from "../../../../api.js";
import { structuredDiff, type StructuredDiff } from "../../../../lib/diff.js";

export interface CatalogDraft {
  baseVersion: number;
  baseEntries: ConfigEntry[];
  entries: ConfigEntry[];
}

const storageKey = (slug: string): string => `pk-catalog-draft:${slug}`;

const isEntryList = (v: unknown): v is ConfigEntry[] =>
  Array.isArray(v) && v.every((e) => typeof e === "object" && e !== null);

/** The draft saved for this product in this tab, if any. */
export function loadDraft(slug: string): CatalogDraft | null {
  try {
    const raw = window.sessionStorage.getItem(storageKey(slug));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CatalogDraft>;
    if (
      typeof parsed.baseVersion !== "number" ||
      !isEntryList(parsed.baseEntries) ||
      !isEntryList(parsed.entries)
    )
      return null;
    return parsed as CatalogDraft;
  } catch {
    return null;
  }
}

export function saveDraft(slug: string, draft: CatalogDraft): void {
  try {
    window.sessionStorage.setItem(storageKey(slug), JSON.stringify(draft));
  } catch {
    // Storage full or blocked: the draft lasts as long as the page.
  }
}

export function clearDraft(slug: string): void {
  try {
    window.sessionStorage.removeItem(storageKey(slug));
  } catch {
    // nothing stored
  }
}

/** A fresh draft from the active catalog, or the first-publish seed when there is none (CAT-1). */
export function draftFrom(catalog: ProductCatalog | null): CatalogDraft {
  const entries = catalog?.entries ?? [];
  return {
    baseVersion: catalog?.schemaVersion ?? 0,
    baseEntries: entries,
    entries: entries.map((e) => structuredClone(e)),
  };
}

/** The draft as the document a publish sends. The server assigns the version. */
export function draftDocument(draft: CatalogDraft): ProductCatalog {
  return { schemaVersion: draft.baseVersion + 1, entries: draft.entries };
}

export function draftDiff(draft: CatalogDraft): StructuredDiff<ConfigEntry> {
  return structuredDiff(draft.baseEntries, draft.entries, "key");
}

/** A key not yet in the draft: `new.key`, `new.key.2`, … */
export function freshKey(entries: ConfigEntry[], base = "new.key"): string {
  const taken = new Set(entries.map((e) => e.key));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}.${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** A new entry with the fields the publish route requires. */
export function newEntry(
  entries: ConfigEntry[],
  category: string,
): ConfigEntry {
  return {
    key: freshKey(entries),
    kind: "config",
    category,
    label: "New key",
    description: "",
    schema: { type: "string" },
  };
}
