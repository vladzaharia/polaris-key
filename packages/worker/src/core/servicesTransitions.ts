/**
 * What a write of `products.services_json` sets in motion (PX-W17; plans/PX-W17.md §6).
 *
 * Every writer of the enablement set calls `applyServiceTransitions` after its write: the console
 * (`PATCH …/services` and `…/services/revert` in `servicesAdmin.ts`) and the manifest resync
 * (`services/release/resync.ts`). ST-05's generic settings write must call it too. It reads the
 * set it is handed, not a diff, and every consequence is idempotent, so it runs on EVERY such
 * write: a straggler (a binding written by a racing sign-in) heals at the next write or resync.
 *
 * Today there is one consequence, and it carries S-19's holder rule ("on a product without
 * Identity no device is ever signed in"):
 *
 *   Identity off ⇒ every device binding (`devices.subject`) of the product is cleared, with its KV
 *   mirror, through Core's clearing hook (`clearDeviceSubjects`, reason `identity_disabled`). No
 *   seat is released and no device is deauthorized: installs keep their anchor licence, token and
 *   documents, and only the sign-in goes. `account_product_grants` rows are kept, so turning
 *   Identity back on asks nobody for consent again; nobody is re-bound until they sign in again.
 *
 * Then every mounted service's `onServicesChange` listener hears the write (`contributions.ts`):
 * Identity's silent-restore keys are purged while Identity is off and when it comes back on, because
 * `DELETE restore` answers 404 while Identity is off and a key must not outlive that window.
 *
 * Together with the bind guard (`setDeviceSubject`, `bindDevice`, `registerDeviceBinding` refuse
 * while Identity is off), this is what lets LX-09's resolver trust `devices.subject` without
 * reading the toggle.
 */

import type { Db } from "../db/types.js";
import type { Env } from "../platform/env.js";
import { appendAudit } from "./audit.js";
import { randomId } from "../platform/crypto.js";
import type { ServicesMap } from "./services.js";
import { seedImplicitTierStatement } from "./licensing/store.js";
import { clearDeviceSubjects } from "./accounts/subjectHooks.js";
import { contributedServicesChangeListeners } from "./contributions.js";

/** Who made the write, for the audit row: the verified admin session, or the resync. */
export interface ServicesActor {
  sub: string;
  name: string | null;
  email: string | null;
}

/** The actor a manifest resync writes as. */
export const MANIFEST_RESYNC_ACTOR: ServicesActor = {
  sub: "manifest",
  name: "Manifest resync",
  email: null,
};

export interface ServiceTransitionResult {
  /** Device bindings cleared because Identity is off (0 when it is on, or none were left). */
  signedInDevicesCleared: number;
}

/**
 * How many devices of the product are signed in right now: the count the console shows in its
 * confirmation before Identity is turned off (`PATCH …/services?dryRun=1`).
 */
export async function countSignedInDevices(
  db: Db,
  product: string,
): Promise<number> {
  const row = await db.first<{ n: number }>(
    `SELECT COUNT(*) AS n FROM devices
      WHERE product = ? AND subject IS NOT NULL AND status = 'authorized'`,
    product,
  );
  return row?.n ?? 0;
}

/**
 * Apply the consequences of the enablement set `after`, just written for `product`. Writes the
 * audit row `services.identity_disabled` only when a binding was actually cleared, so a resync of
 * an Identity-off product with nothing to heal leaves no trace.
 */
export async function applyServiceTransitions(
  env: Env,
  db: Db,
  product: string,
  after: ServicesMap,
  actor: ServicesActor,
  now: number,
  /** `seedDefaultTier: false`: a manifest resync never touches the Default tier (LX-33.7). */
  opts: {
    seedDefaultTier?: boolean;
    /** The set the write replaced, when the writer saw it (the console's PATCH). */
    before?: ServicesMap;
  } = {},
): Promise<ServiceTransitionResult> {
  // LX-33.7: License on ⇒ the product has its Default tier (a no-op when it does, so an enable
  // and a re-enable both land here).
  if (after.license?.enabled && opts.seedDefaultTier !== false) {
    const seed = await seedImplicitTierStatement(db, product, now);
    if (seed) await db.run(seed.sql, ...seed.params);
  }
  const result = after.identity?.enabled
    ? { signedInDevicesCleared: 0 }
    : await signOutIdentityOff(env, db, product, actor, now);
  for (const listener of contributedServicesChangeListeners())
    await listener(
      { db, env, now },
      { product, before: opts.before ?? null, after, actor },
    );
  return result;
}

/** Identity is off: clear every device binding, with the audit row when any was left. */
async function signOutIdentityOff(
  env: Env,
  db: Db,
  product: string,
  actor: ServicesActor,
  now: number,
): Promise<ServiceTransitionResult> {
  const { cleared } = await clearDeviceSubjects(
    db,
    env,
    { kind: "product", product },
    "identity_disabled",
  );
  if (cleared > 0) {
    await appendAudit(db, {
      product,
      id: randomId("aud"),
      at: now,
      actor_sub: actor.sub,
      actor_name: actor.name,
      actor_email: actor.email,
      action: "services.identity_disabled",
      target_kind: "product",
      target_id: product,
      parent_id: null,
      summary: `Identity is off for ${product}: signed out ${cleared} device${cleared === 1 ? "" : "s"}; installs and licences keep working`,
    });
  }
  return { signedInDevicesCleared: cleared };
}
