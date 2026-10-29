/**
 * The store contract's re-export point and the one helper every implementation shares. The
 * contract itself (`SyncStore`) is in `types.ts`; `memoryStore.ts` is the reference
 * implementation and U-05.6's SQLite store is the other.
 */

import type { SyncJson } from "@polaris-key/protocol/sync";
import type { StoredRecord, StoredSetting } from "./types.js";

export type { SyncStore } from "./types.js";

/**
 * A row's identity as one map key: `user` rows are (scope, key), `platform` rows add the family.
 * `\u0000` cannot occur in a key (SYNC_KEY_PATTERN).
 */
export const settingId = (
  key: string,
  scope: string,
  family?: string,
): string =>
  scope === "platform"
    ? `${scope}\u0000${family ?? ""}\u0000${key}`
    : `${scope}\u0000${key}`;

/** The live members of a merged row as a JSON object (a prototype-free object: a member may be
 *  called `__proto__`). `null` when none is live. */
export function liveMembers(row: StoredSetting): SyncJson {
  const out: Record<string, SyncJson> = Object.create(null) as Record<
    string,
    SyncJson
  >;
  let any = false;
  for (const [name, cell] of row.members ?? []) {
    if (cell.removed) continue;
    out[name] = cell.value;
    any = true;
  }
  return any ? out : null;
}

/**
 * A comparable dump of records for the stores' test `snapshot()`: keyed by (collection, id), the
 * cells and elements as arrays. `undefined` when there are none, so a settings-only store dumps
 * as before.
 */
export function recordsDump(rows: readonly StoredRecord[]): unknown {
  if (rows.length === 0) return undefined;
  return rows
    .map((r) => [`${r.collection}\u0000${r.id}`, r] as const)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, r]) => [
      k,
      {
        ...r,
        fields: r.fields ? [...r.fields] : undefined,
        elements: r.elements ? [...r.elements] : undefined,
      },
    ]);
}
