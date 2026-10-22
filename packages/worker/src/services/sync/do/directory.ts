/**
 * The object's side of the D1 directory (U-05.9; plans/U-05-slices.md §3, L5, L7, L17).
 *
 * D1 holds what a list, a sort or a quota check must read without waking an object
 * (`sync_directory`, `sync_product_daily`). The object writes it, not the request: an accepted
 * write only marks the object dirty (`meta.directory_dirty`), snapshots what the directory shows
 * (quota, tier, the last platform) and counts the day's deltas, all in the write's own storage
 * transaction. An alarm then flushes in one D1 batch:
 *
 *   - the FIRST write ever schedules the alarm at once (L5), so the directory row, product
 *     deletion and the users count see a new person within seconds;
 *   - later writes coalesce: at most one flush per 15 minutes, however many writes land.
 *
 * Everything here is pure over a `SqlStore`'s meta, so it is driven the same in Node and workerd.
 */

import type { DbStatement } from "../../../db/types.js";
import type { StoreUsage } from "../engine/types.js";
import type { SqlStore } from "./sqlStore.js";

/** At most one flush per window after the first. */
export const FLUSH_WINDOW_MS = 15 * 60 * 1000;
/** A client binding idle this long expires; a tombstone older than this is collected. */
export const IDLE_RETENTION_SECONDS = 90 * 86_400;
/** Day marks kept for the tombstone clock (one per day, 90 days and a margin). */
const MARKS_KEPT = 100;

const DIRTY = "directory_dirty";
const SNAPSHOT = "dir_snapshot";
const DAILY = "dir_daily";
const FLUSHED_AT = "dir_flushed_at";
const MARKS = "seq_marks";

/** What the directory row shows beyond the object's own counters, from the last accepted write. */
export interface DirectorySnapshot {
  quotaBytes: number;
  tierId: string | null;
  platform: string | null;
  /** Epoch seconds of the last write. */
  activeAt: number;
}

/** UTC day -> [syncs, conflicts] not yet flushed. */
export type DailyDeltas = Record<string, [number, number]>;

export const dayOf = (ms: number): string =>
  new Date(ms).toISOString().slice(0, 10);

function readJson<T>(store: SqlStore, key: string): T | undefined {
  const raw = store.getMeta(key);
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

export const isDirty = (store: SqlStore): boolean =>
  store.getMeta(DIRTY) === "1";

/** Marks the directory stale (absorb, and any accepted write). Needs the schema. */
export const markDirty = (store: SqlStore): void => store.setMeta(DIRTY, "1");

/**
 * An accepted push: snapshot the directory's inputs, count the day's deltas, mark dirty. Runs
 * inside the push's storage transaction. `platform` keeps its previous value when the device
 * reported none (L7: the last platform seen).
 */
export function recordWrite(
  store: SqlStore,
  w: {
    nowMs: number;
    quotaBytes: number;
    tierId?: string | undefined;
    platform?: string | undefined;
    syncs: number;
    conflicts: number;
  },
): void {
  const prev = readJson<DirectorySnapshot>(store, SNAPSHOT);
  const snap: DirectorySnapshot = {
    quotaBytes: w.quotaBytes,
    tierId: w.tierId ?? prev?.tierId ?? null,
    platform: w.platform ?? prev?.platform ?? null,
    activeAt: Math.floor(w.nowMs / 1000),
  };
  store.setMeta(SNAPSHOT, JSON.stringify(snap));
  const daily = readJson<DailyDeltas>(store, DAILY) ?? {};
  const day = dayOf(w.nowMs);
  const cur = daily[day] ?? [0, 0];
  daily[day] = [cur[0] + w.syncs, cur[1] + w.conflicts];
  store.setMeta(DAILY, JSON.stringify(daily));
  markDirty(store);
}

/**
 * When the next flush should run, or `null` for none needed. The first flush ever is at once; the
 * rest wait out the window since the last one.
 */
export function flushDueAt(store: SqlStore, nowMs: number): number | null {
  if (!isDirty(store)) return null;
  const last = store.getMeta(FLUSHED_AT);
  if (last === undefined) return nowMs;
  return Math.max(nowMs, Number(last) + FLUSH_WINDOW_MS);
}

/**
 * The tombstone clock. A tombstone's HLC is client-supplied, so its age cannot be read from the
 * row. Instead the object notes (time, sequence) once a day at flush; every tombstone at or below
 * a mark's sequence was written before the mark's time. The returned sequence is the newest mark
 * at least `IDLE_RETENTION_SECONDS` old (0: none yet), and older marks are dropped.
 */
export function ageMarks(
  store: SqlStore,
  nowMs: number,
  seq: number,
): { throughSeq: number } {
  let marks = readJson<[number, number][]>(store, MARKS) ?? [];
  const last = marks[marks.length - 1];
  if (!last || dayOf(last[0]) !== dayOf(nowMs)) marks.push([nowMs, seq]);
  const cutoff = nowMs - IDLE_RETENTION_SECONDS * 1000;
  let through = -1;
  marks.forEach(([t], i) => {
    if (t <= cutoff) through = i;
  });
  const throughSeq = through >= 0 ? (marks[through]?.[1] ?? 0) : 0;
  if (through > 0) marks = marks.slice(through);
  if (marks.length > MARKS_KEPT) marks = marks.slice(-MARKS_KEPT);
  store.setMeta(MARKS, JSON.stringify(marks));
  return { throughSeq };
}

export interface Flush {
  statements: DbStatement[];
  /** Clears the dirty state once D1 has taken the batch. Synchronous, inside one transaction. */
  commit(nowMs: number): void;
}

/**
 * The D1 batch for a dirty object: one directory upsert and one daily upsert per pending day. The
 * counters are the object's own (`bytes`, `settings`); quota, tier, platform and activity are the
 * last write's snapshot, and an object that was only absorbed into (no write of its own) keeps
 * what the directory already has for them.
 */
export function buildFlush(
  store: SqlStore,
  pin: { product: string; subject: string },
  usage: StoreUsage,
  nowMs: number,
): Flush | null {
  if (!isDirty(store)) return null;
  const snap = readJson<DirectorySnapshot>(store, SNAPSHOT);
  const daily = readJson<DailyDeltas>(store, DAILY) ?? {};
  const now = Math.floor(nowMs / 1000);
  const statements: DbStatement[] = [];
  if (snap) {
    statements.push({
      sql: `INSERT INTO sync_directory
              (product, subject, bytes, settings, records, files, revision_bytes, quota_bytes,
               tier_id, platform, last_active_at, updated_at)
            VALUES (?, ?, ?, ?, 0, 0, 0, ?, ?, ?, ?, ?)
            ON CONFLICT (product, subject) DO UPDATE SET
              bytes = excluded.bytes, settings = excluded.settings,
              quota_bytes = excluded.quota_bytes, tier_id = excluded.tier_id,
              platform = excluded.platform,
              last_active_at = MAX(sync_directory.last_active_at, excluded.last_active_at),
              updated_at = excluded.updated_at`,
      params: [
        pin.product,
        pin.subject,
        usage.bytes,
        usage.settings,
        snap.quotaBytes,
        snap.tierId,
        snap.platform,
        snap.activeAt,
        now,
      ],
    });
  } else {
    statements.push({
      sql: `INSERT INTO sync_directory
              (product, subject, bytes, settings, records, files, revision_bytes, quota_bytes,
               tier_id, platform, last_active_at, updated_at)
            VALUES (?, ?, ?, ?, 0, 0, 0, 0, NULL, NULL, ?, ?)
            ON CONFLICT (product, subject) DO UPDATE SET
              bytes = excluded.bytes, settings = excluded.settings,
              updated_at = excluded.updated_at`,
      params: [pin.product, pin.subject, usage.bytes, usage.settings, now, now],
    });
  }
  for (const [day, [syncs, conflicts]] of Object.entries(daily)) {
    if (syncs === 0 && conflicts === 0) continue;
    statements.push({
      sql: `INSERT INTO sync_product_daily (product, day, syncs, conflicts)
            VALUES (?, ?, ?, ?)
            ON CONFLICT (product, day) DO UPDATE SET
              syncs = syncs + excluded.syncs, conflicts = conflicts + excluded.conflicts`,
      params: [pin.product, day, syncs, conflicts],
    });
  }
  return {
    statements,
    commit(at) {
      store.setMeta(DIRTY, "0");
      store.setMeta(DAILY, "{}");
      store.setMeta(FLUSHED_AT, String(at));
    },
  };
}
