/**
 * The pull (§13.4) and the tombstone horizon, as pure functions over a `SyncStore`.
 *
 *   - Changes since a cursor, oldest first, in pages of `SYNC_PULL_PAGE_CHANGES` (settings, records
 *     and tombstones together, one cursor order). `more` while rows remain; the answer's `cursor`
 *     is the page's last row while `more`, else the store's sequence. The page is the merge of two
 *     paged reads (settings, records), each at most one page and one row long: never a full load.
 *   - Which rows (L9): every `user` row, and the `platform` rows of the asking device's own
 *     family; every record (records belong to the person, not a platform family). Rows of another family stay stored, dormant and exported; a scope or policy change
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
  type SyncSealedChange,
  type SyncTombstone,
  type SyncUsage,
} from "@polaris-key/protocol/sync";
import { liveRecordValue, sealedElements, sealedFields } from "./recordSets.js";
import { sealedMembers } from "./settings.js";
import { liveMembers } from "./store.js";
import type { StoredRecord, StoredSetting, SyncStore } from "./types.js";

/** A change as the wire carries it: a setting or a record, plaintext or sealed. */
export type PullChange = SyncChange | SyncSealedChange;

export interface PullInput {
  /** 0 or absent: a snapshot. */
  cursor?: number;
  /** The authenticated device (a clientId bound to another device answers lastMutationId 0). */
  deviceId: string;
  clientId?: string;
  /** The device row's platform family. */
  family: string;
  /**
   * End-to-end mode (§13.4, §13.10.7): rows at or above `encryptionSince` leave as `ct` (or, for
   * a merge setting, sealed `members`), and the outcome names `encryptionSince`. Absent: the
   * plaintext pull, unchanged.
   */
  e2e?: boolean;
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
      changes: PullChange[];
      tombstones: SyncTombstone[];
      usage: SyncUsage;
      etag: string;
      /** End-to-end pulls only. */
      encryptionSince?: number;
    }
  | { ok: false; error: "cursor_expired" };

export const pullEtag = (seq: number, lastMutationId: number): string =>
  `"${seq}.${lastMutationId}"`;

function toChange(row: StoredSetting, sealed: boolean): PullChange {
  if (sealed) {
    const base = {
      setting: row.key,
      scope: row.scope,
      version: row.version,
      editedHlc: row.stamp.hlc,
      updatedBy: row.stamp.clientId,
    };
    if (row.members) return { ...base, members: sealedMembers(row) };
    if (typeof row.value === "string") return { ...base, ct: row.value };
  }
  return {
    setting: row.key,
    scope: row.scope,
    value: row.members ? liveMembers(row) : row.value,
    version: row.version,
    editedHlc: row.stamp.hlc,
    updatedBy: row.stamp.clientId,
  };
}

/**
 * A record change (§13.4). In server mode `value` is the record's live content: its value, a
 * `merge` record's object, a `union` record's array in the order of each element's first
 * surviving add tag. A sealed record carries `ct` (one value), `fields` (a `merge` record's whole
 * live content) or `elements` (a `union` record's), and no `value`; a list replaces the client's
 * copy.
 */
function toRecordChange(row: StoredRecord, sealed: boolean): PullChange {
  const record: [string, string] = [row.collection, row.id];
  if (sealed) {
    if (row.kind === "value" && typeof row.value === "string")
      return {
        record,
        ct: row.value,
        version: row.version,
        editedHlc: row.stamp.hlc,
      };
    if (row.kind === "fields")
      return {
        record,
        fields: sealedFields(row),
        version: row.version,
        editedHlc: row.stamp.hlc,
      };
    if (row.kind === "set")
      return { record, elements: sealedElements(row), version: row.version };
  }
  return {
    record,
    value: liveRecordValue(row),
    version: row.version,
    editedHlc: row.stamp.hlc,
  };
}

/** One row of the merged page: a setting or a record, ordered by the store sequence it was written at. */
type PageRow =
  | { version: number; setting: StoredSetting }
  | { version: number; record: StoredRecord };

export function applyPull(store: SyncStore, input: PullInput): PullOutcome {
  const cursor = input.cursor ?? 0;
  const seq = store.currentSeq();
  if (cursor !== 0 && (cursor < store.getWatermark() || cursor > seq))
    return { ok: false, error: "cursor_expired" };

  const size = input.pageSize ?? SYNC_PULL_PAGE_CHANGES;
  // One row past the page says whether more remain; the store pages in storage (SR-1 N12). Each
  // table is read for one page and one row, and the two are merged in version order (versions are
  // store sequences, one per write, so they never tie).
  const rows: PageRow[] = [
    ...store
      .settingsPageAfter(cursor, input.family, size + 1)
      .map((setting) => ({ version: setting.version, setting })),
    ...store
      .recordsPageAfter(cursor, size + 1)
      .map((record) => ({ version: record.version, record })),
  ]
    .sort((a, b) => a.version - b.version)
    .slice(0, size + 1);
  const page = rows.slice(0, size);
  const more = rows.length > size;
  const last = page[page.length - 1];

  // A store with no end-to-end write yet answers the sequence its first one will take.
  const since = input.e2e ? (store.getEncryptionSince() ?? seq + 1) : undefined;
  const changes: PullChange[] = [];
  const tombstones: SyncTombstone[] = [];
  for (const item of page) {
    const sealed = since !== undefined && item.version >= since;
    if ("setting" in item) {
      const row = item.setting;
      if (row.deleted)
        tombstones.push({ setting: row.key, editedHlc: row.stamp.hlc });
      else changes.push(toChange(row, sealed));
    } else {
      const row = item.record;
      if (row.deleted)
        tombstones.push({
          record: [row.collection, row.id],
          editedHlc: row.stamp.hlc,
        });
      else changes.push(toRecordChange(row, sealed));
    }
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
    usage: {
      bytes: u.bytes,
      settings: u.settings,
      records: u.records,
      files: 0,
    },
    etag: pullEtag(seq, lastMutationId),
    ...(since !== undefined ? { encryptionSince: since } : {}),
  };
}

/**
 * Forgets tombstones last written at or before `throughSeq` (setting and record rows, and the
 * removed-member and removed-field cells of merged rows), and raises the watermark to it, so an
 * older cursor is `cursor_expired` instead of silently missing a delete. Returns how many tombstone
 * rows went. The watermark never falls. Neither costs quota, so usage does not move.
 */
export function collectTombstones(
  store: SyncStore,
  throughSeq: number,
): number {
  let removed = 0;
  store.transaction(() => {
    // Paged by version: removing or rewriting a row never moves the cursor, and no more than a
    // page is in memory (tombstones on open keys are not bounded by the settings budget).
    let after = 0;
    for (;;) {
      const page = store.settingsPageThrough(after, throughSeq, COLLECT_PAGE);
      for (const row of page) {
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
      if (page.length < COLLECT_PAGE) break;
      after = page[page.length - 1]?.version ?? throughSeq;
    }
    // Records likewise (U-09.9): a tombstone goes, a live `merge` record sheds its removed cells.
    // A cell's own clock is client-supplied, so the record's `version` (a store sequence) is the age.
    after = 0;
    for (;;) {
      const page = store.recordsPageThrough(after, throughSeq, COLLECT_PAGE);
      for (const row of page) {
        if (row.deleted) {
          store.deleteRecordRow(row.collection, row.id);
          removed++;
        } else if (row.fields) {
          const fields = new Map(
            [...row.fields].filter(([, cell]) => !cell.removed),
          );
          if (fields.size !== row.fields.size)
            store.putRecord({ ...row, fields });
        }
      }
      if (page.length < COLLECT_PAGE) break;
      after = page[page.length - 1]?.version ?? throughSeq;
    }
    store.setWatermark(Math.max(store.getWatermark(), throughSeq));
  });
  return removed;
}

/** Rows read per page by the tombstone collector. */
const COLLECT_PAGE = 100;
