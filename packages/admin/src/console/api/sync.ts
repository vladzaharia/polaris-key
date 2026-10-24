/**
 * The sync slice of the console API (P0-32.22): Cloud Sync usage.
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

export const syncApi = {
  // ── sync: Cloud Sync usage (U-05.19) ───────────────────────────────────────
  /** The Usage page's facts: the aggregate, today's UTC counters, tier labels and limits. */
  syncUsage: (slug: string) => call<SyncUsageResponse>(`${p(slug)}/sync/usage`),
};
