/**
 * Diff models for `DiffViewer` (components.md §6.8).
 *
 * - `structuredDiff` compares two lists of keyed entries (catalog entries by `key`, outlets by
 *   `id`, …) and returns added, removed and changed entries, each change with its field-level
 *   before → after. Fields compare by JSON value, so nested objects (a schema fragment) count as
 *   one field.
 * - `lineDiff` is a unified line diff (jsdiff) as rows with old/new line numbers.
 */

import { diffLines } from "diff";

export interface FieldChange {
  field: string;
  before: unknown;
  after: unknown;
}

export type EntryChange<T> =
  | { kind: "added"; key: string; after: T }
  | { kind: "removed"; key: string; before: T }
  | {
      kind: "changed";
      key: string;
      before: T;
      after: T;
      fields: FieldChange[];
    };

export interface StructuredDiff<T> {
  added: Extract<EntryChange<T>, { kind: "added" }>[];
  removed: Extract<EntryChange<T>, { kind: "removed" }>[];
  changed: Extract<EntryChange<T>, { kind: "changed" }>[];
  /** Every change, in the after-list order then removals (stable for display). */
  all: EntryChange<T>[];
}

const same = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

/** The field-level differences between two records (top-level keys, sorted). */
export function fieldChanges(before: object, after: object): FieldChange[] {
  const b = before as Record<string, unknown>;
  const a = after as Record<string, unknown>;
  const fields = [...new Set([...Object.keys(b), ...Object.keys(a)])].sort();
  return fields
    .filter((f) => !same(b[f], a[f]))
    .map((f) => ({ field: f, before: b[f], after: a[f] }));
}

/** Compare two keyed entry lists. `key` names the identity field (or computes it). */
export function structuredDiff<T extends object>(
  before: readonly T[],
  after: readonly T[],
  key: keyof T | ((entry: T) => string),
): StructuredDiff<T> {
  const keyOf = (e: T): string =>
    typeof key === "function" ? key(e) : String(e[key]);
  const old = new Map(before.map((e) => [keyOf(e), e]));
  const next = new Map(after.map((e) => [keyOf(e), e]));
  const out: StructuredDiff<T> = {
    added: [],
    removed: [],
    changed: [],
    all: [],
  };
  for (const [k, a] of next) {
    const b = old.get(k);
    if (b === undefined) {
      const c = { kind: "added" as const, key: k, after: a };
      out.added.push(c);
      out.all.push(c);
    } else {
      const fields = fieldChanges(b, a);
      if (fields.length) {
        const c = {
          kind: "changed" as const,
          key: k,
          before: b,
          after: a,
          fields,
        };
        out.changed.push(c);
        out.all.push(c);
      }
    }
  }
  for (const [k, b] of old) {
    if (!next.has(k)) {
      const c = { kind: "removed" as const, key: k, before: b };
      out.removed.push(c);
      out.all.push(c);
    }
  }
  return out;
}

/** "+2 keys · −1 key · 3 changed" (`noun` pluralised with an s). */
export function diffSummary(
  d: { added: unknown[]; removed: unknown[]; changed: unknown[] },
  noun = "key",
): string {
  const n = (count: number) => `${count} ${count === 1 ? noun : `${noun}s`}`;
  const parts: string[] = [];
  if (d.added.length) parts.push(`+${n(d.added.length)}`);
  if (d.removed.length) parts.push(`−${n(d.removed.length)}`);
  if (d.changed.length) parts.push(`${d.changed.length} changed`);
  return parts.length ? parts.join(" · ") : "No changes";
}

export interface LineRow {
  kind: "added" | "removed" | "context";
  text: string;
  /** Line number in the old text (removed and context rows). */
  oldLine?: number;
  /** Line number in the new text (added and context rows). */
  newLine?: number;
}

/** A unified line diff as rows. */
export function lineDiff(before: string, after: string): LineRow[] {
  const rows: LineRow[] = [];
  let o = 1;
  let n = 1;
  for (const part of diffLines(before, after)) {
    const lines = part.value.replace(/\n$/, "").split("\n");
    for (const text of lines) {
      if (part.added) rows.push({ kind: "added", text, newLine: n++ });
      else if (part.removed) rows.push({ kind: "removed", text, oldLine: o++ });
      else rows.push({ kind: "context", text, oldLine: o++, newLine: n++ });
    }
  }
  return rows;
}
