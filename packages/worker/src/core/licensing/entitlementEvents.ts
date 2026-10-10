/**
 * The `entitlements.changed` feed's subject store (LX-08; plans/LX-01.md §6.1 and §8 Q4).
 *
 * `entitlement_events` (migrations/0105_a) names the product's pairwise subject a change concerns.
 * LX-13 writes it and serves its pull cursor; LX-08 creates the table empty and registers it here,
 * so from its first row an account merge re-keys it and an account deletion or per-product removal
 * removes it, through Core's subject-store registry (`core/accounts/subjectHooks.ts`; the registry guard,
 * `test/subjectStores.test.ts`, refuses a subject-keyed table nobody claims). The feed is history
 * of the subject's entitlements, so a merge moves the absorbed subject's events to the survivor
 * (no collision is possible: event ids are unique) and a deletion drops them.
 */

import {
  registerSubjectStore,
  type SubjectStore,
} from "../accounts/subjectHooks.js";

/** The registry name (stable: the export document is keyed by it). */
export const ENTITLEMENT_EVENT_STORE = "core.entitlementEvents";

export const entitlementEventStore: SubjectStore = {
  tables: ["entitlement_events"],

  async merge({ db }, { product, from, to }) {
    await db.run(
      "UPDATE entitlement_events SET subject = ? WHERE product = ? AND subject = ?",
      to,
      product,
      from,
    );
  },

  async delete({ db }, { product, subject }) {
    await db.run(
      "DELETE FROM entitlement_events WHERE product = ? AND subject = ?",
      product,
      subject,
    );
  },

  async export({ db }, { product, subject }) {
    const rows = await db.all<{
      id: string;
      keys_json: string;
      created_at: number;
    }>(
      `SELECT id, keys_json, created_at FROM entitlement_events
        WHERE product = ? AND subject = ? ORDER BY created_at, id`,
      product,
      subject,
    );
    return rows.map((r) => {
      let keys: unknown = [];
      try {
        keys = JSON.parse(r.keys_json);
      } catch {
        // A row LX-13 wrote unparseable is exported without its keys rather than failing the export.
      }
      return { id: r.id, keys, createdAt: r.created_at };
    });
  },
};

registerSubjectStore(ENTITLEMENT_EVENT_STORE, entitlementEventStore);
