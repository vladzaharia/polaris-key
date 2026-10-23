/**
 * Catalog migrations (rule 6): the catalog's `cloudSync.migrations` say a key was renamed
 * (`renamedTo`) or dropped. An old build keeps pushing the old name, and the server answers for it
 * rather than refusing: a rename is written to the new key and answers `ok` with `renamedTo`; a
 * drop answers `ok` with `dropped: true` and writes nothing. Dropped wins over renamed.
 */

import type { CatalogMigrations } from "./types.js";

export type KeyResolution =
  | { kind: "same" }
  | { kind: "renamed"; to: string }
  | { kind: "dropped" };

/** Follows renames to the current name; a cycle, or a rename to itself, is no rename. */
export function resolveKey(
  key: string,
  migrations: CatalogMigrations | undefined,
): KeyResolution {
  if (!migrations) return { kind: "same" };
  if (migrations.dropped.has(key)) return { kind: "dropped" };
  const seen = new Set<string>([key]);
  let current = key;
  for (;;) {
    const next = migrations.renamedTo.get(current);
    if (next === undefined) break;
    if (seen.has(next)) return { kind: "same" };
    seen.add(next);
    current = next;
    if (migrations.dropped.has(current)) return { kind: "dropped" };
  }
  return current === key ? { kind: "same" } : { kind: "renamed", to: current };
}
