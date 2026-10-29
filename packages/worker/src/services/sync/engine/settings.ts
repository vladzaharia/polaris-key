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
 * A write that would grow the store past the budget, the quota or the ceiling is `rejected` with
 * `quota_exceeded` (budget.ts); nothing is written and nothing is ever deleted. A merge holds at
 * most `SYNC_MAX_MERGE_MEMBERS` live members (a further new one is `value_invalid`), and a member
 * name is at most `SYNC_MAX_UNION_ELEMENT_BYTES` of UTF-8 (a longer one is `value_invalid`).
 *
 * "Wins" is `>=` on the stamp: an equal stamp is the same client writing again (a later
 * mutation id), and the later write is the one to keep.
 */

import {
  SYNC_MAX_MERGE_MEMBERS,
  SYNC_MAX_UNION_ELEMENT_BYTES,
  type MutationResult,
  type SyncJson,
  type SyncMutation,
  type SyncOp,
  type SyncSealedMember,
  type SyncServerCopy,
} from "@polaris-key/protocol/sync";
import { admission } from "./budget.js";
import { compareStamps } from "./hlc.js";
import { envelopeKid } from "./sealed.js";
import { liveMembers } from "./store.js";
import { account } from "./usage.js";
import type {
  Classification,
  MemberCell,
  PushLimits,
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

/** The live members of a sealed `merge` row, as the wire carries them (§13.4). */
export function sealedMembers(row: StoredSetting): SyncSealedMember[] {
  const out: SyncSealedMember[] = [];
  for (const [member, cell] of row.members ?? [])
    if (!cell.removed && typeof cell.value === "string")
      out.push({ member, ct: cell.value, editedHlc: cell.stamp.hlc });
  return out;
}

/**
 * The server's copy of a row, as a `conflict` carries it. A cleared key answers `value: null`. A
 * sealed row answers `ct` (or, for a merge, its sealed `members`) in place of `value` (§13.10).
 */
export function serverCopy(row: StoredSetting): SyncServerCopy {
  if (row.sealed && !row.deleted) {
    const base = { version: row.version, editedHlc: row.stamp.hlc };
    if (row.members) return { ...base, members: sealedMembers(row) };
    if (typeof row.value === "string") return { ct: row.value, ...base };
  }
  return {
    value: row.members ? liveMembers(row) : row.deleted ? null : row.value,
    version: row.version,
    editedHlc: row.stamp.hlc,
  };
}

export const newer = (a: Stamp, b: Stamp): Stamp =>
  compareStamps(a, b) >= 0 ? a : b;

const isPlainObject = (v: SyncJson): v is { [k: string]: SyncJson } =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Lifts a scalar row to a merged one: an object's entries become members at the row's stamp. */
export function asMerged(row: StoredSetting): StoredSetting {
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

/** What a mutation needs beyond the route: the device's family and the Worker's limits. */
export interface ApplyContext {
  family: string;
  limits?: PushLimits;
  /** End-to-end mode: the row this write produces holds sealed values. Set from the route. */
  sealed?: boolean;
}

/**
 * Admits, then writes: `prev` is the stored row before (if any), `next` the row after. A write
 * that shrinks (`clear`, `removeMember`) is never refused. Allocates the sequence and moves the
 * usage only on a write.
 */
function commit(
  store: SyncStore,
  ctx: ApplyContext,
  m: SyncMutation,
  prev: StoredSetting | undefined,
  next: StoredSetting,
): MutationResult {
  const shrinking = m.op === "clear" || m.op === "removeMember";
  next.sealed = ctx.sealed === true;
  stampKid(next, ctx.sealed === true);
  const refused = admission(
    store.getUsage(),
    prev,
    next,
    shrinking,
    ctx.limits,
  );
  if (refused)
    return {
      mutationId: m.mutationId,
      status: "rejected",
      code: "quota_exceeded",
      scope: refused,
    };
  next.version = store.nextSeq();
  next.sealed = ctx.sealed === true;
  store.putSetting(next);
  account(store, prev, next);
  return { mutationId: m.mutationId, status: "ok", version: next.version };
}

/**
 * Records the key id of the sealed value a row holds (U-09.5; C14). A merged row has none of its
 * own (its members carry theirs), a plaintext row has none, and a tombstone keeps the id of the
 * value it replaced.
 */
function stampKid(row: StoredSetting, sealed: boolean): void {
  if (row.members) delete row.kid;
  else if (row.deleted) return;
  else if (sealed && typeof row.value === "string") {
    const kid = envelopeKid(row.value);
    if (kid !== undefined) row.kid = kid;
    else delete row.kid;
  } else delete row.kid;
}

const conflict = (m: SyncMutation, row: StoredSetting): MutationResult => ({
  mutationId: m.mutationId,
  status: "conflict",
  server: serverCopy(row),
});

const empty = (
  m: SyncMutation,
  scope: StoredSetting["scope"],
  family: string,
): StoredSetting => ({
  key: (m.target as { setting: string }).setting,
  scope,
  ...(scope === "platform" ? { family } : {}),
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
  baseCtx: ApplyContext = { family: "" },
): MutationResult {
  const ctx: ApplyContext = { ...baseCtx, sealed: route.sealed === true };
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
    !route.sealed &&
    (route.policy === "max" || route.policy === "min") &&
    (typeof m.value !== "number" || !Number.isFinite(m.value));
  // A member name is client text kept as a cell key; removals are never refused for quota, so the
  // name is bounded (SR-1 B1) or a quota-0 device could park unlimited uncounted bytes.
  const memberTooLong =
    (m.op === "setMember" || m.op === "removeMember") &&
    typeof m.member === "string" &&
    new TextEncoder().encode(m.member).length > SYNC_MAX_UNION_ELEMENT_BYTES;
  // A sealed write carries `ct` as a string (the Worker checked its shape); anything else is
  // not a value. A sealed max/min `baseVersion` is a number or `"*"` (§13.3).
  const sealedBad =
    route.sealed === true &&
    (((m.op === "set" || m.op === "setMember") && typeof m.ct !== "string") ||
      (m.baseVersion !== undefined &&
        m.baseVersion !== "*" &&
        !(Number.isSafeInteger(m.baseVersion) && m.baseVersion >= 0)));
  if (route.valueInvalid || numberless || memberTooLong || sealedBad)
    return {
      mutationId: m.mutationId,
      status: "rejected",
      code: "value_invalid",
    };

  const loaded = store.getSetting(target.setting, target.scope, ctx.family);
  // A row at or above `encryptionSince` holds sealed values (§13.10.7).
  const since = store.getEncryptionSince();
  const stored: StoredSetting | undefined =
    loaded && since !== undefined && loaded.version >= since
      ? { ...loaded, sealed: true }
      : loaded;
  const base = stored ?? empty(m, target.scope, ctx.family);
  const fresh = stored === undefined;

  // Clearing an open key the store has never seen changes nothing and writes no row: a tombstone
  // costs no quota, so a free one per invented name would be unbounded storage. (A declared key
  // is bounded by the catalog and keeps its tombstone: a later older write must still lose.)
  if (m.op === "clear" && fresh && route.open)
    return {
      mutationId: m.mutationId,
      status: "ok",
      version: store.currentSeq(),
    };

  if (route.policy === "merge")
    return applyMerge(store, ctx, m, stored, base, stamp);

  const row = asScalar(base);
  const stale = !fresh && compareStamps(stamp, row.stamp) < 0;

  if (m.op === "clear") {
    // A reset at its clock: an older clear loses to a newer write, a newer one clears it.
    if (stale) return conflict(m, row);
    return commit(store, ctx, m, stored, {
      ...row,
      deleted: true,
      value: null,
      stamp,
    });
  }

  const value = (route.sealed ? m.ct : m.value) as SyncJson;
  // E2E max/min: the server holds a compare-and-swap register and cannot compare values; the
  // client decides the better one and re-pushes on the server's `version` (§13.10.5).
  if (route.sealed && (route.policy === "max" || route.policy === "min")) {
    const bv = m.baseVersion;
    const live = !fresh && !row.deleted;
    if (
      bv === "*"
        ? live
        : typeof bv === "number" && (fresh || row.version !== bv)
    )
      return conflict(m, row);
    if (bv !== undefined)
      return commit(store, ctx, m, stored, {
        ...row,
        deleted: false,
        value,
        stamp: newer(stamp, row.stamp),
      });
  }
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
  return commit(store, ctx, m, stored, {
    ...row,
    deleted: false,
    value,
    stamp,
  });
}

function applyMerge(
  store: SyncStore,
  ctx: ApplyContext,
  m: SyncMutation,
  stored: StoredSetting | undefined,
  base: StoredSetting,
  stamp: Stamp,
): MutationResult {
  // A copy: `stored` stays what it was, because admission compares the row before with after.
  const lifted = asMerged(base);
  const row: StoredSetting = {
    ...lifted,
    members: new Map(lifted.members as Map<string, MemberCell>),
  };
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
    // The cap is on live members; a member already live (or a removal) never adds one.
    if (m.op === "setMember" && (!cell || cell.removed)) {
      let live = 0;
      for (const c of members.values()) if (!c.removed) live++;
      if (live >= SYNC_MAX_MERGE_MEMBERS)
        return {
          mutationId: m.mutationId,
          status: "rejected",
          code: "value_invalid",
        };
    }
    const kid =
      ctx.sealed && m.op === "setMember"
        ? envelopeKid(m.ct as string)
        : undefined;
    members.set(
      name,
      m.op === "setMember"
        ? {
            value: (ctx.sealed ? m.ct : m.value) as SyncJson,
            removed: false,
            stamp,
            ...(kid !== undefined ? { kid } : {}),
          }
        : { value: null, removed: true, stamp },
    );
  }
  pruneRemoved(members);
  row.stamp = newer(stamp, row.stamp);
  row.deleted = liveMembers(row) === null;
  row.value = null;
  return commit(store, ctx, m, stored, row);
}

/**
 * Member tombstones keep a removed name from coming back from an older write. Bound them: past
 * twice the member cap the oldest are forgotten (they cost no budget, so nothing else limits them).
 */
export function pruneRemoved(members: Map<string, MemberCell>): void {
  const limit = 2 * SYNC_MAX_MERGE_MEMBERS;
  if (members.size <= limit) return;
  const removed = [...members]
    .filter(([, c]) => c.removed)
    .sort(([, a], [, b]) => compareStamps(a.stamp, b.stamp));
  for (const [name] of removed) {
    if (members.size <= limit) break;
    members.delete(name);
  }
}
