/**
 * The sync slice of the console API (P0-32.22): Cloud Sync usage and one person's data summary.
 * Types and the `syncApi` methods live together; `api.ts` re-exports the types and spreads the methods.
 */
import { call, enc, p, send } from "./transport.js";

/** `GET …/sync/usage` (U-05.19): counts and bytes only, no person, subject or device. */
export type SyncUsageResponse =
  | { enabled: false }
  | {
      enabled: true;
      usage: {
        bytes: number;
        people: number;
        settingsBytes: number;
        recordBytes: number;
        fileBytes: number;
        revisionBytes: number;
        computedAt: number;
        breakdown: {
          byTier: {
            tierId: string | null;
            people: number;
            bytes: number;
            medianBytes: number;
            over80: number;
          }[];
          byKind: {
            settings: number;
            records: number;
            files: number;
            revisions: number;
          };
          byPlatform: {
            platform: string | null;
            peopleThisWeek: number;
            lastSyncAt: number;
          }[];
        };
      };
      today: { day: string; syncs: number; conflicts: number };
      tiers: { id: string; label: string; bytes: number | null }[];
      defaultBytes: number;
      /** The platform pause (U-05.21): `null` while writes run; `reason` only for Platform. */
      paused?: {
        since: number | null;
        by: string | null;
        reason: string | null;
      } | null;
    };

/** One declared synced setting that a person has stored: its name, size and age, never its value. */
export interface SyncSubjectSetting {
  key: string;
  bytes: number;
  /** Epoch seconds of the newest write. */
  updatedAt: number;
  /** The platform family of a per-platform setting, else `null`. */
  platform: string | null;
}

export interface SyncSubjectCollection {
  name: string;
  label: string;
  records: number;
  bytes: number;
  files: number;
  fileBytes: number;
  revisionBytes: number;
  /** Epoch seconds of the newest record write, or `null`. */
  lastWriteAt: number | null;
}

/** The person's key ring: which key, when made, and the labels of the devices that open it. */
export interface SyncSubjectRing {
  kid: string;
  createdAt: number;
  recoverySet: boolean;
  devices: string[];
  /** Epoch seconds until which the replaced ring still opens. */
  previousUntil?: number;
}

/**
 * `GET …/sync/subjects/<subject>` (U-11a.1): what Cloud Sync holds for one person of this
 * product. Sizes and names only; a value, a record id and a file name never arrive.
 */
export type SyncSubjectResponse =
  | { enabled: false }
  | {
      enabled: true;
      empty: boolean;
      encryption: "e2e" | "server";
      encryptionSince: number | null;
      quota: {
        /** The entitlement at the person's last write, or `null` before the first. */
        bytes: number | null;
        defaultBytes: number;
        tierId: string | null;
        tierLabel: string | null;
      };
      usage: { bytes: number; settings: number; settingsBytes: number };
      settings: {
        declared: SyncSubjectSetting[];
        open: { count: number; bytes: number };
      };
      collections: SyncSubjectCollection[];
      uploadsOpen: number;
      ring: SyncSubjectRing | null;
    };

/** A JSON value as the person's device stored it. */
export type SyncJsonValue =
  | null
  | boolean
  | number
  | string
  | SyncJsonValue[]
  | { [k: string]: SyncJsonValue };

/** The pointer to a record's live file (`file` on a record). */
export interface SyncSubjectFile {
  version: number;
  size: number;
  sha256: string;
  format: string;
}

export interface SyncValueSetting {
  key: string;
  /** Whether the catalog declares it. */
  declared: boolean;
  platform: string | null;
  bytes: number;
  /** Epoch seconds. */
  updatedAt: number;
  /** `null` when `sealed`. */
  value: SyncJsonValue | null;
  sealed: boolean;
}

export interface SyncValueRecord {
  id: string;
  version: number;
  updatedAt: number;
  bytes: number;
  value: SyncJsonValue | null;
  sealed: boolean;
  file?: SyncSubjectFile;
}

/** `GET …/sync/subjects/<subject>/values` (U-11a.2): server mode, after a step-up, audited. */
export interface SyncValuesResponse {
  /** Present on the read with no collection. */
  settings: SyncValueSetting[] | null;
  records: SyncValueRecord[];
  /** The `cursor` for the next page, or `null` on the last. */
  next: string | null;
}

export interface SyncFileRevision {
  version: number;
  size: number;
  sha256: string;
  format: string;
  /** Epoch seconds. */
  createdAt: number;
}

export const syncApi = {
  // ── sync: Cloud Sync usage (U-05.19) ───────────────────────────────────────
  /** The Usage page's facts: the aggregate, today's UTC counters, tier labels and limits. */
  syncUsage: (slug: string) => call<SyncUsageResponse>(`${p(slug)}/sync/usage`),
  /** The Data tab's summary of one person (U-11a.1). Each load is audited. */
  syncSubject: (slug: string, subject: string) =>
    call<SyncSubjectResponse>(
      `${p(slug)}/sync/subjects/${encodeURIComponent(subject)}`,
    ),
  /** Setting values, or (with `collection`) one page of its records. Needs a recent sign-in. */
  syncValues: (
    slug: string,
    subject: string,
    q: { collection?: string; cursor?: string } = {},
  ) => {
    const params = new URLSearchParams();
    if (q.collection !== undefined) params.set("collection", q.collection);
    if (q.cursor !== undefined) params.set("cursor", q.cursor);
    const qs = params.toString();
    return call<SyncValuesResponse>(
      `${p(slug)}/sync/subjects/${enc(subject)}/values${qs ? `?${qs}` : ""}`,
    );
  },
  /** The kept older versions of a record's file, newest first. Needs a recent sign-in. */
  syncFileRevisions: (
    slug: string,
    subject: string,
    collection: string,
    id: string,
  ) =>
    call<{ revisions: SyncFileRevision[] }>(
      `${p(slug)}/sync/subjects/${enc(subject)}/files/${enc(collection)}/${enc(id)}/revisions`,
    ),
  /**
   * A record's file (the live one, or `version`) as bytes. Needs a recent sign-in. `onProgress`
   * hears the bytes read so far and the total (0 when the response does not say).
   */
  syncFileDownload: async (
    slug: string,
    subject: string,
    collection: string,
    id: string,
    version?: number,
    onProgress?: (loaded: number, total: number) => void,
  ): Promise<Blob> => {
    const res = await send(
      `${p(slug)}/sync/subjects/${enc(subject)}/files/${enc(collection)}/${enc(id)}${
        version === undefined ? "" : `?version=${version}`
      }`,
    );
    if (!onProgress || !res.body) return res.blob();
    const total = Number(res.headers.get("content-length")) || 0;
    const reader = res.body.getReader();
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    let loaded = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value as Uint8Array<ArrayBuffer>);
      loaded += value.byteLength;
      onProgress(loaded, total);
    }
    return new Blob(chunks, { type: "application/octet-stream" });
  },
  /** Erases the person's Cloud Sync data and key ring. Needs a recent sign-in. */
  syncDeleteData: (slug: string, subject: string) =>
    call<{ deleted: true }>(`${p(slug)}/sync/subjects/${enc(subject)}/delete`, {
      method: "POST",
      body: JSON.stringify({ confirm: true }),
    }),
};
