/**
 * The store contract's re-export point and the one helper every implementation shares. The
 * contract itself (`SyncStore`) is in `types.ts`; `memoryStore.ts` is the reference
 * implementation and U-05.6's SQLite store is the other.
 */

import type { SyncJson } from "@polaris-key/protocol/sync";
import type { StoredSetting } from "./types.js";

export type { SyncStore } from "./types.js";

/** `key` and `scope` joined into one map key. `\u0000` cannot occur in a key (SYNC_KEY_PATTERN). */
export const settingId = (key: string, scope: string): string =>
  `${scope}\u0000${key}`;

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
