/**
 * The pull (§13.4) and the tombstone horizon, as pure functions over a `SyncStore`.
 *
 *   - Changes since a cursor, oldest first, in pages of `SYNC_PULL_PAGE_CHANGES` (changes and
 *     tombstones together, one cursor order). `more` while rows remain; the answer's `cursor` is
 *     the page's last row while `more`, else the store's sequence.
 *   - Which rows (L9): every `user` row, and the `platform` rows of the asking device's own
 *     family. Rows of another family stay stored, dormant and exported; a scope or policy change
 *     rewrites nothing (R4 rule 6), so a row under a scope the catalog no longer routes is simply
 *     still there.
 *   - `empty: true` only on a cursor-0 answer for a principal with nothing stored.
 *   - `cursor_expired` (410) for a cursor the store cannot serve: below the tombstone watermark
 *     (the tombstones it would need are gone), or past the store's sequence (the store is not the
 *     one the cursor came from). A cursor of 0 is a snapshot and is always served.
 *   - The ETag is `"<seq>.<lastMutationId>"`, strong.
 *
 * Collecting tombstones is split with U-05.9: `collectTombstones` is the pure rule (it removes the
 * rows and moves the watermark); the alarm that picks the 90-day sequence is U-05.9's.
 */

import {
  SYNC_PULL_PAGE_CHANGES,
  type SyncChange,
  type SyncTombstone,
  type SyncUsage,
} from "@polaris-key/protocol/sync";
import { liveMembers } from "./store.js";
import type { StoredSetting, SyncStore } from "./types.js";

/** The setting members of the wire unions: what this engine can produce until U-09. */
export type SettingChange = Extract<SyncChange, { setting: string }>;
export type SettingTombstone = Extract<SyncTombstone, { setting: string }>;

export interface PullInput {
  /** 0 or absent: a snapshot. */
  cursor?: number;
  /** The authenticated device (a clientId bound to another device answers lastMutationId 0). */
  deviceId: string;
  clientId?: string;
  /** The device row's platform family. */
  family: string;
  /** For tests; the wire page size is `SYNC_PULL_PAGE_CHANGES`. */
  pageSize?: number;
}

export type PullOutcome =
  | {
      ok: true;
      cursor: number;
      more: boolean;
      lastMutationId: number;
      empty?: true;
      changes: SettingChange[];
      tombstones: SettingTombstone[];
      usage: SyncUsage;
      etag: string;
    }
  | { ok: false; error: "cursor_expired" };

export const pullEtag = (seq: number, lastMutationId: number): string =>
  `"${seq}.${lastMutationId}"`;

const visible = (row: StoredSetting, family: string): boolean =>
  row.scope === "user" || row.family === family;

function toChange(row: StoredSetting): SettingChange {
  return {
    setting: row.key,
    scope: row.scope,
    value: row.members ? liveMembers(row) : row.value,
    version: row.version,
    editedHlc: row.stamp.hlc,
    updatedBy: row.stamp.clientId,
  };
}

export function applyPull(store: SyncStore, input: PullInput): PullOutcome {
  const cursor = input.cursor ?? 0;
  const seq = store.currentSeq();
  if (cursor !== 0 && (cursor < store.getWatermark() || cursor > seq))
    return { ok: false, error: "cursor_expired" };

  const rows = store
    .settingsAfter(cursor)
    .filter((r) => visible(r, input.family));
  const size = input.pageSize ?? SYNC_PULL_PAGE_CHANGES;
  const page = rows.slice(0, size);
  const more = rows.length > size;
  const last = page[page.length - 1];

  const changes: SettingChange[] = [];
  const tombstones: SettingTombstone[] = [];
  for (const row of page) {
    if (row.deleted)
      tombstones.push({ setting: row.key, editedHlc: row.stamp.hlc });
    else changes.push(toChange(row));
  }

  const bound = input.clientId ? store.getClient(input.clientId) : undefined;
  const lastMutationId =
    bound && bound.deviceId === input.deviceId ? bound.lastMutationId : 0;
  const u = store.getUsage();
  const answerCursor = more && last ? last.version : seq;
  return {
    ok: true,
    cursor: answerCursor,
    more,
    lastMutationId,
    ...(cursor === 0 && store.isEmpty() ? { empty: true as const } : {}),
    changes,
    tombstones,
    usage: { bytes: u.bytes, settings: u.settings, records: 0, files: 0 },
    etag: pullEtag(seq, lastMutationId),
  };
}

/**
 * Forgets tombstones last written at or before `throughSeq` (rows, and the removed-member cells
 * of merged rows), and raises the watermark to it, so an older cursor is `cursor_expired` instead
 * of silently missing a delete. Returns how many tombstone rows went. The watermark never falls.
 */
export function collectTombstones(
  store: SyncStore,
  throughSeq: number,
): number {
  let removed = 0;
  store.transaction(() => {
    for (const row of store.settingsAfter(0)) {
      if (row.version > throughSeq) continue;
      if (row.deleted) {
        store.deleteSetting(row.key, row.scope, row.family);
        removed++;
      } else if (row.members) {
        const members = new Map(
          [...row.members].filter(([, cell]) => !cell.removed),
        );
        if (members.size !== row.members.size)
          store.putSetting({ ...row, members });
      }
    }
    store.setWatermark(Math.max(store.getWatermark(), throughSeq));
  });
  return removed;
}
