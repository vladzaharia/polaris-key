/// <reference types="@cloudflare/workers-types" />

/**
 * License's `applyStoreGrant` (P6-01, `core/storeGrants.ts`): the one writer of
 * `license_store_grants`. From LX-08 each write also re-projects the purchase's licence-held grant
 * (`core/grants.ts`, Core's tables) in the same batch: the dual-write of S-19 §7.14 step 3.
 *
 * Distribution has already verified the purchase with its store and bound it to this licence;
 * this only records the effect. One row per (store, purchase key hash, flag):
 *
 *   - `grant`  — the row becomes `active` (granted now). A grant of a row already active changes
 *     nothing (a replayed notification, a second claim of the same purchase).
 *   - `revoke` — an active row becomes `revoked` (refund, revocation, a voided Play purchase, a
 *     Steam non-owner). A revoke of a row that is not active changes nothing.
 *
 * A REFUND_REVERSED re-grants through `grant`. Every change is one audit row as
 * `system:commerce`, naming the flag and the store — never a purchase token, never PII. The
 * licence must exist in this product (`no_license` otherwise); its status is not consulted: a
 * disabled licence keeps the grant it paid for, and `licenseUsable` already keeps a disabled
 * licence from receiving a document.
 */

import type {
  StoreGrantChange,
  StoreGrantContext,
  StoreGrantOutcome,
} from "../../core/storeGrants.js";
import type { LicenseMergeChange } from "../../core/licenseMerge.js";
import type { DbStatement } from "../../core/platform.js";
import { appendAudit, getLicense } from "../../core/data.js";
import { randomId } from "../../core/platform.js";
import {
  grantMergeStatements,
  storeGrantProjection,
} from "../../core/grants.js";

/** The audit actor of a store-grant change. */
export const STORE_GRANT_ACTOR = "system:commerce";

export async function applyStoreGrant(
  ctx: StoreGrantContext,
  change: StoreGrantChange,
): Promise<StoreGrantOutcome> {
  const { db, now } = ctx;
  const product = ctx.product.slug;
  const license = await getLicense(db, product, change.licenseId);
  if (!license) return { ok: false, reason: "no_license" };

  const write =
    change.action === "grant"
      ? {
          sql: `INSERT INTO license_store_grants
                  (product, license_id, flag, store, purchase_key_hash, state, granted_at, revoked_at)
                VALUES (?, ?, ?, ?, ?, 'active', ?, NULL)
                ON CONFLICT (product, store, purchase_key_hash, flag) DO UPDATE SET
                  state = 'active', granted_at = excluded.granted_at, revoked_at = NULL
                WHERE license_store_grants.state <> 'active'
                  AND license_store_grants.license_id = excluded.license_id`,
          params: [
            product,
            change.licenseId,
            change.flag,
            change.store,
            change.purchaseKeyHash,
            now,
          ],
        }
      : {
          sql: `UPDATE license_store_grants SET state = 'revoked', revoked_at = ?
                 WHERE product = ? AND store = ? AND purchase_key_hash = ? AND flag = ?
                   AND license_id = ? AND state = 'active'`,
          params: [
            now,
            product,
            change.store,
            change.purchaseKeyHash,
            change.flag,
            change.licenseId,
          ],
        };
  // LX-08 (S-19 §7.14 step 3): the licensing model's grant for this purchase is re-projected from
  // the rows just written, in the SAME batch, so the two can never disagree. Reads stay on
  // `license_store_grants` until LX-09.
  const projection = storeGrantProjection(
    product,
    { store: change.store, purchaseKeyHash: change.purchaseKeyHash },
    "commerce",
  );
  let changed: number;
  if (db.batchChanges) {
    changed = (await db.batchChanges([write, ...projection]))[0] ?? 0;
  } else {
    changed = await db.runChanges(write.sql, ...write.params);
    await db.batch(projection);
  }
  if (changed > 0)
    await appendAudit(db, {
      product,
      id: randomId("aud"),
      at: now,
      actor_sub: STORE_GRANT_ACTOR,
      actor_name: "Commerce bridge",
      actor_email: null,
      action:
        change.action === "grant"
          ? "license.store_grant.grant"
          : "license.store_grant.revoke",
      target_kind: "license",
      target_id: change.licenseId,
      parent_id: null,
      summary: change.summary.slice(0, 500),
    });
  return { ok: true, changed: changed > 0 };
}

/**
 * LX-03: License's share of a licence merge (`core/licenseMerge.ts`) — every store grant of the
 * retired licence, active or revoked, moves to the survivor, so the flags it paid for ride the
 * survivor's document and a later refund, revocation or REFUND_REVERSED (which match the grant on
 * its licence) still finds it. The grant's key is (product, store, purchase key hash, flag), not
 * the licence, so the re-key cannot collide. The audit row is the merge's own (`license.merge`).
 */
export function storeGrantMergeStatements(
  change: LicenseMergeChange,
): DbStatement[] {
  return [
    {
      sql: `UPDATE license_store_grants SET license_id = ?
             WHERE product = ? AND license_id = ?`,
      params: [change.toLicenseId, change.product, change.fromLicenseId],
    },
    // LX-08: the store grants' projection moves with them (`core/grants.ts`).
    ...grantMergeStatements(change),
  ];
}
