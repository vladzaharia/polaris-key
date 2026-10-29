/**
 * Silent restore's services-write listener (I-49.8; `core/contributions.ts` `onServicesChange`).
 *
 * `DELETE /<p>/identity/restore` answers 404 while Identity is off, like every identity route, so a
 * device that signs out in that window cannot revoke its key. Turning Identity off therefore ends
 * every restore key of the product, and so does turning it back on (V5 §12.11.8, Revocation):
 *
 *   - Identity is off in the set just written: purge. Every services write calls the listener, so a
 *     straggler is healed by the next write or resync;
 *   - Identity was off in the set the write replaced and is on now: purge. Only a writer that saw the
 *     set before (the console's PATCH) can say so; a resync reads the stored set after its batch.
 *
 * Keys, origin marks and nothing else; people sign in again and enrol again. One audit row names the
 * reason, and none is written when there was nothing to remove. It runs whatever the launch gate or
 * the `identity.restore` setting say, like every revocation.
 */

import type { ServicesChangeListener } from "../../../core/contributions.js";
import { purgeProductRestore } from "./store.js";

export const IDENTITY_RESTORE_SERVICES_LISTENER = "identity.restore";

export const restoreServicesListener: ServicesChangeListener = async (
  { db, now },
  { product, before, after, actor },
) => {
  const off = after.identity?.enabled !== true;
  const backOn = !off && before !== null && before.identity?.enabled === false;
  if (!off && !backOn) return;
  await purgeProductRestore(db, product, {
    actor,
    now,
    reason: backOn
      ? "Identity was turned back on"
      : "Identity is off, so a key cannot be revoked",
    skipEmpty: true,
  });
};
