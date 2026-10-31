/**
 * What the console's summary reads beyond the settings, split out of `sqlStore.ts` to keep that
 * file under its size budget.
 */
import type { InspectedCollection } from "./protocol.js";

type All = <T extends Record<string, unknown>>(q: string) => T[];

export interface InspectTables {
  collections: InspectedCollection[];
  uploadsOpen: number;
}

/**
 * What the console's summary reads beyond the settings (U-11a.1): per-collection counters from
 * the `records` and `files` tables and the count of open uploads. Defensive on purpose: the
 * tables arrive with later schema versions (U-09, U-10), so each query runs only when every
 * column it names exists, and an object without them answers nothing. Counts and sizes only; a
 * value, a record id and a file name are never selected.
 */
export function inspectTables(all: All, hasSchema: boolean): InspectTables {
  /** The columns of a table, or none when the table does not exist (the schema grows lazily). */
  const columnsOf = (table: string): Set<string> => {
    if (!hasSchema) return new Set();
    return new Set(
      all<{ name: string }>(`PRAGMA table_info("${table}")`).map((c) => c.name),
    );
  };
  const byName = new Map<string, InspectedCollection>();
  const entry = (name: string): InspectedCollection => {
    let c = byName.get(name);
    if (!c) {
      c = {
        name,
        records: 0,
        bytes: 0,
        files: 0,
        fileBytes: 0,
        revisionBytes: 0,
        lastWriteAt: null,
      };
      byName.set(name, c);
    }
    return c;
  };
  const has = (table: string, ...cols: string[]): boolean => {
    const have = columnsOf(table);
    return cols.every((c) => have.has(c));
  };
  if (has("records", "collection", "id", "value_json", "deleted", "hlc")) {
    for (const r of all<{
      collection: string;
      n: number;
      b: number;
      h: string | null;
    }>(
      `SELECT collection,
                SUM(CASE WHEN deleted = 0 THEN 1 ELSE 0 END) AS n,
                SUM(CASE WHEN deleted = 0
                         THEN length(CAST(id AS BLOB)) + length(CAST(value_json AS BLOB))
                         ELSE 0 END) AS b,
                MAX(hlc) AS h
           FROM records GROUP BY collection`,
    )) {
      const c = entry(r.collection);
      c.records = Number(r.n ?? 0);
      c.bytes = Number(r.b ?? 0);
      const ms =
        typeof r.h === "string" ? Number.parseInt(r.h.slice(0, 12), 16) : NaN;
      c.lastWriteAt = Number.isFinite(ms) ? ms : null;
    }
  }
  if (has("files", "collection", "size", "status")) {
    for (const r of all<{
      collection: string;
      n: number;
      b: number;
      rb: number;
    }>(
      `SELECT collection,
                SUM(CASE WHEN status = 'live' THEN 1 ELSE 0 END) AS n,
                SUM(CASE WHEN status = 'live' THEN size ELSE 0 END) AS b,
                SUM(CASE WHEN status = 'revision' THEN size ELSE 0 END) AS rb
           FROM files GROUP BY collection`,
    )) {
      const c = entry(r.collection);
      c.files = Number(r.n ?? 0);
      c.fileBytes = Number(r.b ?? 0);
      c.revisionBytes = Number(r.rb ?? 0);
    }
  }
  let uploadsOpen = 0;
  if (has("uploads", "state"))
    uploadsOpen = Number(
      all<{ n: number }>(
        `SELECT COUNT(*) AS n FROM uploads WHERE state = 'open'`,
      )[0]?.n ?? 0,
    );
  return {
    collections: [...byName.values()].sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    ),
    uploadsOpen,
  };
}
