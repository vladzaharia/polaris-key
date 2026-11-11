/**
 * The issuer's services-write listener (I-21.15; `core/contributions.ts` `onServicesChange`; V5
 * §12.13.7). A write of a product's service set that leaves Identity off revokes every refresh
 * family of the product: the issuer answers `404` while Identity is off, so a family must not
 * outlive that window. Grants stay, so turning Identity back on asks nobody again.
 *
 * Writers call it on every write, so it runs whether or not the set changed and is idempotent: a
 * second call revokes nothing and writes no audit row. One `identity.issuer.refresh_revoked` row
 * says it happened, and only when it did.
 */

import type { ServicesChangeListener } from "../../../core/contributions.js";
import { appendAudit } from "../../../core/audit.js";
import { randomId } from "../../../platform/crypto.js";
import { revokeProductRefresh } from "./refreshRepo.js";

export const IDENTITY_ISSUER_SERVICES_LISTENER = "identity.issuer";

export const issuerServicesListener: ServicesChangeListener = async (
  { db, now },
  { product, after, actor },
) => {
  if (after.identity?.enabled === true) return;
  const revoked = await revokeProductRefresh(db, product, now);
  if (revoked === 0) return;
  await appendAudit(db, {
    product,
    id: randomId("aud"),
    at: now,
    actor_sub: actor.sub,
    actor_name: actor.name,
    actor_email: actor.email,
    action: "identity.issuer.refresh_revoked",
    target_kind: "product",
    target_id: product,
    parent_id: null,
    summary: `Identity is off for ${product}: ended ${revoked} client sign-in${revoked === 1 ? "" : "s"}`,
  });
};
