/**
 * Absorb: the survivor of an account merge takes in the absorbed subject's settings (U-05.8;
 * plans/U-05-slices.md §3, L8, S-16 §5.1 "never silently overwrite").
 *
 * The absorbed person's store is read as an export (rows, tombstones, member cells with their
 * stamps, client bindings) and JOINED into the survivor's, row by row:
 *
 *   scalar rows   the higher stamp (HLC, then clientId) wins, as `lastWrite` does; for a key the
 *                 caller names `max` or `min` (`policies`) two live numbers keep the better value.
 *   merged rows   member cells union, each name keeping its higher stamp; the floor (the latest
 *                 `clear`) is the higher of the two and drops every cell stamped below it. A
 *                 scalar row meeting a merged one is lifted to a merged one first, as a push does.
 *   tombstones    a row is never lost: a deletion newer than the survivor's value wins, a value
 *                 newer than the deletion wins, as in a push.
 *   clients       a clientId the survivor does not know is adopted with its binding; one it knows
 *                 keeps its device and the higher last mutation id, so a device that re-keyed onto
 *                 the survivor does not replay mutations the absorbed store already processed.
 *
 * Records (U-09.8) join in `absorbRecords.ts`: the same rules by stamps, cells and tags, with a
 * colliding `revision` record parked, not overwritten (D3).
 *
 * The join is commutative, associative and idempotent on stamps, which is what makes the merge
 * retry-safe: absorbing the same export again (a retry after a crash), or a fresher export of the
 * same source, converges on the same rows and writes nothing for a row that does not change (no
 * sequence bump, so a pull is not told of it twice). Nothing is refused or deleted for budget or
 * quota (L8): usage simply moves with the rows, and the ordinary admission then refuses later
 * growth while the survivor is over.
 */

import type { SyncJson } from "@polaris-key/protocol/sync";
import { compareStamps } from "./hlc.js";
import {
  absorbRecords,
  isSealedRecord,
  type RecordJoin,
} from "./absorbRecords.js";
import { asMerged, newer, pruneRemoved } from "./settings.js";
import { liveMembers } from "./store.js";
import { account } from "./usage.js";
import type {
  ClientRecord,
  MemberCell,
  ParkedRecord,
  SettingPolicy,
  Stamp,
  StoredRecord,
  StoredSetting,
  SyncStore,
} from "./types.js";

export interface AbsorbInput {
  /** The absorbed person's rows (live and tombstones). Their `version`s are ignored. */
  settings: readonly StoredSetting[];
  clients: readonly ClientRecord[];
  /** A catalog policy per key, where the caller knows it. Absent keys join as `lastWrite`. */
  policies?: ReadonlyMap<string, SettingPolicy>;
  /** The absorbed person's records (live and tombstones). Their `version`s are ignored. */
  records?: readonly StoredRecord[];
  /** The absorbed store's `encryptionSince`, if it has one: a setting at or above it is sealed. */
  encryptionSince?: number;
  /** Copies an earlier merge parked on the absorbed side; they travel to the survivor. */
  parked?: readonly ParkedRecord[];
  /** The absorbed subject: the owner of a record copy this absorb parks. */
  fromSubject?: string;
  /** The declaration of a concrete record collection, where the caller knows it. */
  recordPolicies?: ReadonlyMap<string, RecordJoin>;
  /** Epoch seconds, stamped on a copy this absorb parks. Default: now. */
  now?: number;
}

export interface AbsorbOutcome {
  /** Rows written (a row that already held the joined value is not counted). */
  rows: number;
  /** Client bindings adopted or advanced. */
  clients: number;
  /** Record copies parked or carried over (counted in `rows`). */
  parked: number;
  /** Settings left out because they would mix sealed and plaintext values (§13.10.7); not in `rows`. */
  skipped: number;
}

const copyCell = (c: MemberCell): MemberCell => ({
  value: structuredClone(c.value) as SyncJson,
  removed: c.removed,
  stamp: { ...c.stamp },
  ...(c.kid !== undefined ? { kid: c.kid } : {}),
});

const copyRow = (r: StoredSetting): StoredSetting => ({
  ...r,
  stamp: { ...r.stamp },
  value: structuredClone(r.value) as SyncJson,
  ...(r.floor ? { floor: { ...r.floor } } : {}),
  ...(r.members
    ? {
        members: new Map(
          [...r.members].map(([k, c]) => [k, copyCell(c)] as const),
        ),
      }
    : {}),
});

const stampsEqual = (a: Stamp | undefined, b: Stamp | undefined): boolean =>
  a === undefined || b === undefined ? a === b : compareStamps(a, b) === 0;

const cellsEqual = (a: MemberCell, b: MemberCell): boolean =>
  a.removed === b.removed &&
  a.kid === b.kid &&
  stampsEqual(a.stamp, b.stamp) &&
  JSON.stringify(a.value) === JSON.stringify(b.value);

/** Whether two rows hold the same state (member order aside; the version is not state). */
function sameRow(a: StoredSetting, b: StoredSetting): boolean {
  if (
    a.deleted !== b.deleted ||
    a.kid !== b.kid ||
    !stampsEqual(a.stamp, b.stamp) ||
    !stampsEqual(a.floor, b.floor) ||
    JSON.stringify(a.value) !== JSON.stringify(b.value) ||
    Boolean(a.members) !== Boolean(b.members)
  )
    return false;
  if (!a.members || !b.members) return true;
  if (a.members.size !== b.members.size) return false;
  for (const [name, cell] of a.members) {
    const other = b.members.get(name);
    if (!other || !cellsEqual(cell, other)) return false;
  }
  return true;
}

function joinMerged(a: StoredSetting, b: StoredSetting): StoredSetting {
  const left = copyRow(a);
  // A merged row has no key id of its own: its members carry theirs.
  delete left.kid;
  const members = left.members as Map<string, MemberCell>;
  for (const [name, cell] of b.members ?? new Map<string, MemberCell>()) {
    const have = members.get(name);
    if (!have || compareStamps(cell.stamp, have.stamp) > 0)
      members.set(name, copyCell(cell));
  }
  let floor: Stamp | undefined = left.floor;
  if (b.floor && (!floor || compareStamps(b.floor, floor) > 0))
    floor = { ...b.floor };
  if (floor) {
    left.floor = floor;
    // The floor is the latest clear: nothing stamped below it can come back.
    for (const [name, cell] of members)
      if (compareStamps(cell.stamp, floor) < 0) members.delete(name);
  }
  pruneRemoved(members);
  left.stamp = { ...newer(a.stamp, b.stamp) };
  left.deleted = liveMembers(left) === null;
  left.value = null;
  return left;
}

/** The joined row for one key. `a` is the survivor's, `b` the absorbed one's. */
export function joinRows(
  a: StoredSetting,
  b: StoredSetting,
  policy?: SettingPolicy,
): StoredSetting {
  if (a.members || b.members || policy === "merge")
    return joinMerged(asMerged(a), asMerged(b));
  const better =
    (policy === "max" || policy === "min") &&
    !a.deleted &&
    !b.deleted &&
    typeof a.value === "number" &&
    typeof b.value === "number" &&
    a.value !== b.value
      ? policy === "max"
        ? b.value > a.value
        : b.value < a.value
      : compareStamps(b.stamp, a.stamp) > 0;
  return copyRow(better ? b : a);
}

const keyOf = (r: StoredSetting): [string, "user" | "platform", string] => [
  r.key,
  r.scope,
  r.scope === "platform" ? (r.family ?? "") : "",
];

/** Whether an absorbed live row holds sealed values (§13.10.7): a key id anywhere, or a version at or above the absorbed store's `encryptionSince`. */
function incomingSealed(r: StoredSetting, since: number | undefined): boolean {
  if (r.deleted) return false;
  if (r.kid !== undefined) return true;
  for (const c of r.members?.values() ?? [])
    if (c.kid !== undefined) return true;
  return since !== undefined && r.version >= since;
}

/**
 * The rows of one phase joined into the survivor. A live plaintext row never enters a store that
 * has `encryptionSince` (it would be served as sealed), and a sealed row never joins a live
 * legacy-plaintext row (the join would mix them): those are `skipped`, and counted. A tombstone
 * has no content and joins as ever.
 */
function joinSettings(
  store: SyncStore,
  settings: readonly StoredSetting[],
  input: AbsorbInput,
): { rows: number; skipped: number } {
  let rows = 0;
  let skipped = 0;
  for (const incoming of settings) {
    const [key, scope, family] = keyOf(incoming);
    const since = store.getEncryptionSince();
    const sealed = incomingSealed(incoming, input.encryptionSince);
    if (!incoming.deleted && !sealed && since !== undefined) {
      skipped++;
      continue;
    }
    const prev = store.getSetting(key, scope, family);
    const policy = input.policies?.get(key);
    const legacy =
      since !== undefined && prev && !prev.deleted && prev.version < since;
    const next = prev ? joinRows(prev, incoming, policy) : copyRow(incoming);
    if (prev && sameRow(prev, next)) continue;
    // A write that would give a legacy row's content a sealed row's version.
    if (legacy && !next.deleted) {
      skipped++;
      continue;
    }
    next.version = store.nextSeq();
    store.putSetting(next);
    account(store, prev, next);
    rows++;
  }
  return { rows, skipped };
}

/**
 * Joins `input` into `store`. Call inside the store's transaction: a failure part way must leave
 * nothing behind. Deterministic in the input's order, which is the export's version order.
 *
 * Sealed rows (§13.10.7) go in last: the plaintext rows and tombstones are joined first, then, if
 * any sealed row comes and the survivor has no `encryptionSince`, it is fixed at the next
 * sequence, and the sealed rows are written at or above it.
 */
export function absorbSettings(
  store: SyncStore,
  input: AbsorbInput,
): AbsorbOutcome {
  const sealedSettings = input.settings.filter((r) =>
    incomingSealed(r, input.encryptionSince),
  );
  const plainSettings = input.settings.filter(
    (r) => !incomingSealed(r, input.encryptionSince),
  );
  const records = input.records ?? [];
  const sealedRecords = records.filter(isSealedRecord);
  const plainRecords = records.filter((r) => !isSealedRecord(r));
  const recordInput = {
    fromSubject: input.fromSubject ?? "",
    now: input.now ?? Math.floor(Date.now() / 1000),
    ...(input.recordPolicies ? { recordPolicies: input.recordPolicies } : {}),
  };

  const first = joinSettings(store, plainSettings, input);
  let rows = first.rows;
  let skipped = first.skipped;
  let clients = 0;
  for (const c of input.clients) {
    const have = store.getClient(c.clientId);
    if (!have) {
      store.putClient({ ...c });
      clients++;
    } else if (c.lastMutationId > have.lastMutationId) {
      store.putClient({ ...have, lastMutationId: c.lastMutationId });
      clients++;
    }
  }
  const recs = absorbRecords(store, {
    ...recordInput,
    records: plainRecords,
    parked: input.parked ?? [],
  });
  rows += recs.rows;
  let parked = recs.parked;

  if (
    (sealedSettings.length > 0 || sealedRecords.length > 0) &&
    store.getEncryptionSince() === undefined
  )
    store.setEncryptionSince(store.currentSeq() + 1);
  const last = joinSettings(store, sealedSettings, input);
  const sealedRecs = absorbRecords(store, {
    ...recordInput,
    records: sealedRecords,
    parked: [],
  });
  rows += last.rows + sealedRecs.rows;
  skipped += last.skipped;
  parked += sealedRecs.parked;
  return { rows, clients, parked, skipped };
}
