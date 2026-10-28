/**
 * The roster epoch and discovery key as a store of account × product data (CC-06.1;
 * plans/CC-01-cloud-connect.md §2.9), registered with Core's subject-store registry
 * (`core/accounts/subjectHooks.ts`) so an account merge, a deletion and an export reach it without
 * Connect importing Identity (rule 6). It claims `connect_rings`.
 *
 *   merge   the absorbed subject's row is deleted. The survivor's row is bumped at once (forced, so a new K_disc is drawn even when the member set is
 *           unchanged); the read-time check is the backstop. A repeat deletes nothing but still
 *           bumps once more.
 *   delete  the subject's row.
 *   export  the epoch and when it last changed. The discovery key is a secret of the devices'
 *           discovery, not data about the person, and is never exported.
 *   size    0: the row is a few hundred bytes of bookkeeping.
 */

import type { SubjectStore } from "../../core/accounts/subjectHooks.js";
import { bumpRingNow } from "./ringListener.js";

/** The registry name (stable: the export document is keyed by it). */
export const CONNECT_RINGS_STORE = "connect.rings";

export const connectRingsStore: SubjectStore = {
  tables: ["connect_rings"],

  async merge({ db, now }, { product, from, to }) {
    if (from === to) return;
    await db.run(
      "DELETE FROM connect_rings WHERE product = ? AND subject = ?",
      product,
      from,
    );
    // The survivor's roster moves now, forced: the merged devices must not keep the old key.
    try {
      await bumpRingNow(db, product, to, now, "merge", { force: true });
    } catch {
      // Bookkeeping: the next read compares the members and catches up.
    }
  },

  async delete({ db }, { product, subject }) {
    await db.run(
      "DELETE FROM connect_rings WHERE product = ? AND subject = ?",
      product,
      subject,
    );
  },

  async export({ db }, { product, subject }) {
    const row = await db.first<{ epoch: number; bumped_at: number }>(
      "SELECT epoch, bumped_at FROM connect_rings WHERE product = ? AND subject = ?",
      product,
      subject,
    );
    return row ? { epoch: row.epoch, bumpedAt: row.bumped_at } : null;
  },

  async size() {
    return 0;
  },
};
