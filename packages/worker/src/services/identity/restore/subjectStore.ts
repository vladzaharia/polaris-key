/**
 * The silent-restore keys as a store of account × product data (I-49.4; plans/I-49-slices.md
 * D-3), registered with Core's subject-store registry (`core/accounts/subjectHooks.ts`) so an
 * account merge, a deletion and an export reach it, and so removing the app from Connected apps
 * revokes it (`removeProductData` runs every store's `delete`). It claims `identity_restore_keys`
 * and `identity_restore_origins`.
 *
 *   merge   the absorbed subject's keys are deleted (its devices enrol again as the survivor);
 *           its origin marks move to the survivor, so removing such a device still reaches the
 *           survivor's rows. Idempotent.
 *   delete  every key and origin mark of the subject for the product. Never gated.
 *   export  the dates of each row, `createdAt` and `checkedAt`. The id and the hash are never
 *           exported.
 *   size    0: a row is a few hundred bytes of bookkeeping.
 */

import type { SubjectStore } from "../../../core/accounts/subjectHooks.js";
import { revokeSubjectRestore } from "./store.js";

/** The registry name (stable: the export document is keyed by it). */
export const IDENTITY_RESTORE_STORE = "identity.restore";

export const identityRestoreStore: SubjectStore = {
  tables: ["identity_restore_keys", "identity_restore_origins"],

  async merge({ db }, { product, from, to }) {
    if (from === to) return;
    await db.batch([
      {
        sql: "DELETE FROM identity_restore_keys WHERE product = ? AND subject = ?",
        params: [product, from],
      },
      {
        sql: "UPDATE identity_restore_origins SET subject = ? WHERE product = ? AND subject = ?",
        params: [to, product, from],
      },
    ]);
  },

  async delete({ db }, { product, subject }) {
    await revokeSubjectRestore(db, product, subject);
  },

  async export({ db }, { product, subject }) {
    const rows = await db.all<{ created_at: number; checked_at: number }>(
      `SELECT created_at, checked_at FROM identity_restore_keys
        WHERE product = ? AND subject = ? ORDER BY created_at, rowid`,
      product,
      subject,
    );
    return rows.length === 0
      ? null
      : rows.map((r) => ({ createdAt: r.created_at, checkedAt: r.checked_at }));
  },

  async size() {
    return 0;
  },
};
