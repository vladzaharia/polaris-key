/**
 * The sync slice of the console API (P0-32.22): Cloud Sync usage and one person's data summary.
 * Types and the `syncApi` methods live together; `api.ts` re-exports the types and spreads the methods.
 */
import { call, p } from "./transport.js";

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

export const syncApi = {
  // ── sync: Cloud Sync usage (U-05.19) ───────────────────────────────────────
  /** The Usage page's facts: the aggregate, today's UTC counters, tier labels and limits. */
  syncUsage: (slug: string) => call<SyncUsageResponse>(`${p(slug)}/sync/usage`),
  /** The Data tab's summary of one person (U-11a.1). Each load is audited. */
  syncSubject: (slug: string, subject: string) =>
    call<SyncSubjectResponse>(
      `${p(slug)}/sync/subjects/${encodeURIComponent(subject)}`,
    ),
};
