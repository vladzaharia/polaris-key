/**
 * The setting policies (§13.3's operation table and §13.6's vocabulary) as pure functions over a
 * `SyncStore`. One mutation in, one `MutationResult` out. A write allocates the store sequence and
 * becomes the row's `version`; a conflict or a rejection writes nothing.
 *
 *   lastWrite     `set`, `clear`: the higher stamp (HLC, then clientId) wins; a loser is a
 *                 `conflict` carrying the server copy.
 *   max, min      `set` keeps the larger or smaller value, a tie falls back to lastWrite; `clear`
 *                 is a reset at its clock, after which an older `set` is ignored (a `conflict`).
 *   merge         `setMember`, `removeMember`, `clear`: each member is its own lastWrite cell;
 *                 `clear` sets a floor that drops every member at or below it.
 *
 * "Wins" is `>=` on the stamp: an equal stamp is the same client writing again (a later
 * mutation id), and the later write is the one to keep.
 */

import type {
  MutationResult,
  SyncJson,
  SyncMutation,
  SyncOp,
  SyncServerCopy,
} from "@polaris-key/protocol/sync";
import { compareStamps } from "./hlc.js";
import { liveMembers } from "./store.js";
import type {
  Classification,
  MemberCell,
  SettingPolicy,
  Stamp,
  StoredSetting,
  SyncStore,
} from "./types.js";

/** The operation-versus-policy table. Any other operation is `op_invalid_for_policy`. */
export const POLICY_OPS: Readonly<Record<SettingPolicy, ReadonlySet<SyncOp>>> =
  {
    lastWrite: new Set<SyncOp>(["set", "clear"]),
    max: new Set<SyncOp>(["set", "clear"]),
    min: new Set<SyncOp>(["set", "clear"]),
    merge: new Set<SyncOp>(["setMember", "removeMember", "clear"]),
  };

type Accept = Extract<Classification, { verdict: "accept" }>;

/** The server's copy of a row, as a `conflict` carries it. A cleared key answers `value: null`. */
export function serverCopy(row: StoredSetting): SyncServerCopy {
  return {
    value: row.members ? liveMembers(row) : row.deleted ? null : row.value,
    version: row.version,
    editedHlc: row.stamp.hlc,
  };
}

const newer = (a: Stamp, b: Stamp): Stamp => (compareStamps(a, b) >= 0 ? a : b);

const isPlainObject = (v: SyncJson): v is { [k: string]: SyncJson } =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Lifts a scalar row to a merged one: an object's entries become members at the row's stamp. */
function asMerged(row: StoredSetting): StoredSetting {
  if (row.members) return row;
  const members = new Map<string, MemberCell>();
  if (!row.deleted && isPlainObject(row.value)) {
    for (const [name, value] of Object.entries(row.value))
      members.set(name, { value, removed: false, stamp: row.stamp });
  }
  const floor = row.stamp.hlc === "" ? undefined : row.stamp;
  return { ...row, members, ...(floor ? { floor } : {}), value: null };
}

/** Collapses a merged row to a scalar one holding its live members. */
function asScalar(row: StoredSetting): StoredSetting {
  if (!row.members) return row;
  const value = liveMembers(row);
  const { members: _members, floor: _floor, ...rest } = row;
  void _members;
  void _floor;
  return { ...rest, value, deleted: value === null };
}

function commit(store: SyncStore, row: StoredSetting): number {
  row.version = store.nextSeq();
  store.putSetting(row);
  return row.version;
}

const ok = (m: SyncMutation, version: number): MutationResult => ({
  mutationId: m.mutationId,
  status: "ok",
  version,
});

const conflict = (m: SyncMutation, row: StoredSetting): MutationResult => ({
  mutationId: m.mutationId,
  status: "conflict",
  server: serverCopy(row),
});

const empty = (
  m: SyncMutation,
  scope: StoredSetting["scope"],
): StoredSetting => ({
  key: (m.target as { setting: string }).setting,
  scope,
  version: 0,
  stamp: { hlc: "", clientId: "" },
  deleted: true,
  value: null,
});

/**
 * Applies one setting mutation. `stamp` carries the clamped `editedHlc` and the pushing clientId.
 * Operation and value checks come first and write nothing.
 */
export function applySettingMutation(
  store: SyncStore,
  m: SyncMutation,
  route: Accept,
  stamp: Stamp,
): MutationResult {
  const target = m.target as { setting: string; scope: "user" | "platform" };
  if (target.scope !== route.scope)
    return {
      mutationId: m.mutationId,
      status: "rejected",
      code: "setting_not_synced",
    };
  if (!POLICY_OPS[route.policy].has(m.op))
    return {
      mutationId: m.mutationId,
      status: "rejected",
      code: "op_invalid_for_policy",
    };
  // A max or min set is a number comparison; anything else cannot be compared.
  const numberless =
    m.op === "set" &&
    (route.policy === "max" || route.policy === "min") &&
    (typeof m.value !== "number" || !Number.isFinite(m.value));
  if (route.valueInvalid || numberless)
    return {
      mutationId: m.mutationId,
      status: "rejected",
      code: "value_invalid",
    };

  const stored = store.getSetting(target.setting, target.scope);
  const base = stored ?? empty(m, target.scope);
  const fresh = stored === undefined;

  if (route.policy === "merge") return applyMerge(store, m, base, stamp);

  const row = asScalar(base);
  const stale = !fresh && compareStamps(stamp, row.stamp) < 0;

  if (m.op === "clear") {
    // A reset at its clock: an older clear loses to a newer write, a newer one clears it.
    if (stale) return conflict(m, row);
    return ok(m, commit(store, { ...row, deleted: true, value: null, stamp }));
  }

  const value = m.value as SyncJson;
  const compared =
    (route.policy === "max" || route.policy === "min") &&
    !fresh &&
    !row.deleted &&
    typeof row.value === "number" &&
    typeof value === "number" &&
    value !== row.value;
  if (compared) {
    // The better value wins whatever its clock; the worse loses whatever its clock.
    const beats =
      route.policy === "max"
        ? value > (row.value as number)
        : value < (row.value as number);
    if (!beats) return conflict(m, row);
  } else if (stale) {
    // lastWrite, a max/min tie, or a write older than the clear that reset the key.
    return conflict(m, row);
  }
  return ok(m, commit(store, { ...row, deleted: false, value, stamp }));
}

function applyMerge(
  store: SyncStore,
  m: SyncMutation,
  base: StoredSetting,
  stamp: Stamp,
): MutationResult {
  const row = asMerged(base);
  const members = row.members as Map<string, MemberCell>;
  // The floor is the latest clear: nothing at or below it can come back.
  if (row.floor && compareStamps(stamp, row.floor) < 0) return conflict(m, row);

  if (m.op === "clear") {
    for (const [name, cell] of members)
      if (compareStamps(cell.stamp, stamp) <= 0) members.delete(name);
    row.floor = stamp;
  } else {
    const name = m.member as string;
    const cell = members.get(name);
    if (cell && compareStamps(stamp, cell.stamp) < 0) return conflict(m, row);
    members.set(
      name,
      m.op === "setMember"
        ? { value: m.value as SyncJson, removed: false, stamp }
        : { value: null, removed: true, stamp },
    );
  }
  row.stamp = newer(stamp, row.stamp);
  row.deleted = liveMembers(row) === null;
  row.value = null;
  return ok(m, commit(store, row));
}
