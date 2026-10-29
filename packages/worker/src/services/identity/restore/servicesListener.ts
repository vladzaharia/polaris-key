/**
 * Silent restore's services-write listener (I-49.8; `core/contributions.ts` `onServicesChange`).
 *
 * `DELETE /<p>/identity/restore` answers 404 while Identity is off, like every identity route, so a
 * device that signs out in that window cannot revoke its key. Turning Identity back on therefore
 * ends every restore key of the product (V5 §12.11.8, Revocation): its keys and origin marks, and
 * nothing else; people sign in again and enrol again. One audit row names the reason, and none is
 * written when there was nothing to remove.
 *
 * The transition is seen where the writer knows the set it replaced: the console's PATCH and a
 * manifest resync (`before` is the product row as it stood before the apply). A write that does not
 * go from off to on is not this listener's business. It runs whatever the launch gate or the
 * `identity.restore` setting say, like every revocation.
 */

import type { ServicesChangeListener } from "../../../core/contributions.js";
import { purgeProductRestore } from "./store.js";

export const IDENTITY_RESTORE_SERVICES_LISTENER = "identity.restore";

export const restoreServicesListener: ServicesChangeListener = async (
  { db, now },
  { product, before, after, actor },
) => {
  if (before?.identity?.enabled !== false || after.identity?.enabled !== true)
    return;
  await purgeProductRestore(db, product, {
    actor,
    now,
    reason: "Identity was turned back on",
    skipEmpty: true,
  });
};
