/**
 * Rebasing a console draft onto a catalog that moved underneath it (docs/design/mockups
 * config.entry-draft-stale; admin-2-21). A three-way merge by entry key and then by field, with the
 * draft's own base as the common ancestor:
 *
 * - a field only the repository changed is taken without asking;
 * - a field only the person changed stays;
 * - a field both changed to different values is a conflict: the draft keeps its side until the
 *   person picks (Keep mine / Take the repo's), and the other side is held on the conflict so
 *   nothing is lost.
 */

import type { ConfigEntry, ProductCatalog } from "../../../../api.js";
import type { CatalogDraft } from "./catalogDraft.js";

/** `*` stands for the entry as a whole: one side removed it while the other edited it. */
export const WHOLE_ENTRY = "*";

export interface FieldConflict {
  field: string;
  /** The draft's value (`undefined`: the person cleared it). */
  mine: unknown;
  /** The repository's value. */
  theirs: unknown;
}

export interface EntryConflict {
  key: string;
  fields: FieldConflict[];
}

type Json = Record<string, unknown>;

const canon = (v: unknown): string =>
  JSON.stringify(v, (_k, x: unknown) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(
          Object.entries(x as Json).sort(([a], [b]) => a.localeCompare(b)),
        )
      : x,
  ) ?? "undefined";

export const same = (a: unknown, b: unknown): boolean => canon(a) === canon(b);

/** The draft re-based onto `server`, and what could not be merged. */
export function mergeDraft(
  draft: CatalogDraft,
  server: ProductCatalog,
): CatalogDraft & { conflicts: EntryConflict[] } {
  const base = new Map(draft.baseEntries.map((e) => [e.key, e]));
  const mine = new Map(draft.entries.map((e) => [e.key, e]));
  const theirs = new Map(server.entries.map((e) => [e.key, e]));
  const conflicts: EntryConflict[] = [];
  const merged = new Map<string, ConfigEntry>();

  const keys = [
    ...new Set([...server.entries, ...draft.entries].map((e) => e.key)),
  ];
  for (const key of keys) {
    const b = base.get(key);
    const m = mine.get(key);
    const t = theirs.get(key);
    if (same(m, t)) {
      if (m) merged.set(key, m);
    } else if (same(b, t)) {
      if (m) merged.set(key, m);
    } else if (same(b, m)) {
      if (t) merged.set(key, t);
    } else if (!m || !t || !b) {
      // Removed on one side and edited (or added differently) on the other.
      if (m) merged.set(key, m);
      conflicts.push({
        key,
        fields: [{ field: WHOLE_ENTRY, mine: m ?? null, theirs: t ?? null }],
      });
    } else {
      const out: Json = {};
      const fields: FieldConflict[] = [];
      const names = new Set([
        ...Object.keys(b),
        ...Object.keys(m),
        ...Object.keys(t),
      ]);
      for (const f of names) {
        const bv = (b as unknown as Json)[f];
        const mv = (m as unknown as Json)[f];
        const tv = (t as unknown as Json)[f];
        let pick = mv;
        if (same(mv, tv) || same(bv, tv)) pick = mv;
        else if (same(bv, mv)) pick = tv;
        else fields.push({ field: f, mine: mv, theirs: tv });
        if (pick !== undefined) out[f] = pick;
      }
      merged.set(key, out as unknown as ConfigEntry);
      if (fields.length) conflicts.push({ key, fields });
    }
  }

  // The repository's order first, then what the person added.
  const entries = keys.flatMap((k) => (merged.has(k) ? [merged.get(k)!] : []));
  return {
    baseVersion: server.schemaVersion,
    baseEntries: server.entries,
    // Kept: the review compares the encryption the person started from with the active one.
    ...(draft.baseEncryption ? { baseEncryption: draft.baseEncryption } : {}),
    entries,
    conflicts,
  };
}

/** The draft after one field of one conflict is settled; `take` picks the repository's side. */
export function settle(
  draft: CatalogDraft,
  key: string,
  field: string,
  take: boolean,
): CatalogDraft {
  const conflicts = draft.conflicts ?? [];
  const found = conflicts
    .find((c) => c.key === key)
    ?.fields.find((f) => f.field === field);
  if (!found) return draft;
  let entries = draft.entries;
  if (take) {
    if (field === WHOLE_ENTRY) {
      const next = found.theirs as ConfigEntry | null;
      entries = entries.some((e) => e.key === key)
        ? entries.flatMap((e) => (e.key !== key ? [e] : next ? [next] : []))
        : next
          ? [...entries, next]
          : entries;
    } else {
      entries = entries.map((e) => {
        if (e.key !== key) return e;
        const copy = { ...(e as unknown as Json) };
        if (found.theirs === undefined) delete copy[field];
        else copy[field] = found.theirs;
        return copy as unknown as ConfigEntry;
      });
    }
  }
  const left = conflicts
    .map((c) =>
      c.key === key
        ? { ...c, fields: c.fields.filter((f) => f.field !== field) }
        : c,
    )
    .filter((c) => c.fields.length > 0);
  const next: CatalogDraft = { ...draft, entries };
  if (left.length) next.conflicts = left;
  else delete next.conflicts;
  return next;
}
