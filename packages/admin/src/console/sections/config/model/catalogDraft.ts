/**
 * The catalog editor's draft (docs/design/ADMIN.md §6.6.2, CAT-6): one working copy shared by the
 * form and JSON modes, kept in `sessionStorage` per product so leaving the page, reloading or a
 * crash never silently loses it. The draft remembers the version it started from (`baseVersion`,
 * `0` before the first publish) and that version's entries, so the review diffs against what the
 * operator actually edited and the publish can send `expectedVersion` (A-6).
 */

import type { ConfigEntry, ProductCatalog } from "../../../../api.js";
import {
  cloudSyncEncryption,
  type CloudSyncEncryption,
} from "@polaris-key/catalog";
import { structuredDiff, type StructuredDiff } from "../../../../lib/diff.js";
import type { EntryConflict } from "./mergeDraft.js";

export interface CatalogDraft {
  baseVersion: number;
  baseEntries: ConfigEntry[];
  /** The Cloud Sync encryption of the catalog the draft started from, kept through a rebase. A
   *  publish carries the active catalog's block forward; the review compares the two. Absent in
   *  drafts saved before it existed. */
  baseEncryption?: CloudSyncEncryption;
  entries: ConfigEntry[];
  /** Edits the repository also made, until each is settled (`mergeDraft.ts`). Review waits. */
  conflicts?: EntryConflict[];
  /** The resync commit whose catalog the draft was last re-based onto. */
  rebasedOnto?: string | null;
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
    ...(catalog ? { baseEncryption: cloudSyncEncryption(catalog) } : {}),
    entries: entries.map((e) => structuredClone(e)),
  };
}

const isMinted = (e: ConfigEntry): boolean =>
  e.kind === "secret" && e.delivery === "edgeMint";

/** The entry's type as the console reads it; a change of it drops what no longer applies. */
const typeOf = (e: ConfigEntry): string => (isMinted(e) ? "minted" : e.kind);

/**
 * The entry as published. While a draft is open, changing an entry's Type keeps the fields the
 * new type does not use (so picking the earlier type again puts them back); they are dropped
 * here, and only for an entry whose type differs from its published one (or is new), so a
 * legacy entry that is not touched never shows a change it did not make.
 */
export function applicableEntry(
  entry: ConfigEntry,
  base: ConfigEntry | undefined,
): ConfigEntry {
  if (base !== undefined && typeOf(base) === typeOf(entry)) return entry;
  const next: Record<string, unknown> = { ...entry };
  const drop = (...fields: string[]): void => {
    for (const f of fields) delete next[f];
  };
  if (entry.kind === "secret")
    drop("default", "managementDefault", "user", "userGrant", "grantLabel");
  if (entry.kind === "flag") drop("managementDefault", "user");
  if (entry.kind === "config") drop("userGrant", "grantLabel");
  if (!isMinted(entry)) drop("delivery", "mint");
  else {
    next.schema = { type: "string" };
    drop("ui");
  }
  return next as unknown as ConfigEntry;
}

/** The draft's entries as published (see `applicableEntry`). */
export function draftEntries(draft: CatalogDraft): ConfigEntry[] {
  const base = new Map(draft.baseEntries.map((e) => [e.key, e]));
  return draft.entries.map((e) => applicableEntry(e, base.get(e.key)));
}

/** The draft as the document a publish sends. The server assigns the version. */
export function draftDocument(draft: CatalogDraft): ProductCatalog {
  return { schemaVersion: draft.baseVersion + 1, entries: draftEntries(draft) };
}

export function draftDiff(draft: CatalogDraft): StructuredDiff<ConfigEntry> {
  return structuredDiff(draft.baseEntries, draftEntries(draft), "key");
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

/** The draft's flag keys: what a minted token's Required entitlement may name. */
export const flagKeysOf = (entries: ConfigEntry[]): string[] =>
  entries.filter((e) => e.kind === "flag").map((e) => e.key);
