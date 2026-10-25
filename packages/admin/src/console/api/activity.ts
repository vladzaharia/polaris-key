/**
 * The activity slice of the console API (P0-32.22): the activity log.
 * Types and the `activityApi` methods live together; `api.ts` re-exports the types and spreads the methods.
 */
import { call, p } from "./transport.js";

/** The activity feed's server-side filters (A-2). */
export interface ActivityFilters {
  /** A prefix: `license.` matches every license action. */
  action?: string;
  /** A subject or email; `system` for rows the runtime wrote. */
  actor?: string;
  targetKind?: string;
  targetId?: string;
  /** Epoch seconds, inclusive. */
  since?: number;
  until?: number;
}

// ── activity ──────────────────────────────────────────────────────────────────
export interface ActivityItem {
  id: string;
  at: number;
  actor: { sub: string; name: string; email: string };
  action: string;
  target: { kind: string; id: string } | null;
  summary: string;
}
export interface ActivityCursor {
  beforeAt: number;
  beforeId: string;
}
export interface ActivityPage {
  items: ActivityItem[];
  nextCursor: ActivityCursor | null;
}

export const activityApi = {
  // ── activity (keyset) ─────────────────────────────────────────────────────────
  activity: (
    slug: string,
    cursor?: ActivityCursor | null,
    limit = 50,
    filters: ActivityFilters = {},
  ) => {
    const search = new URLSearchParams({ limit: String(limit) });
    if (cursor) {
      search.set("beforeAt", String(cursor.beforeAt));
      search.set("beforeId", cursor.beforeId);
    }
    for (const [k, v] of Object.entries(filters)) {
      if (v !== undefined && v !== null && v !== "") search.set(k, String(v));
    }
    return call<ActivityPage>(`${p(slug)}/activity?${search.toString()}`);
  },
};
