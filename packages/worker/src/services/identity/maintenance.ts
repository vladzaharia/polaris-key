/**
 * Identity's scheduled work, contributed on its descriptor (`contributes.maintenance`, P0-19) so
 * `scheduled.ts` iterates descriptors instead of importing these modules.
 *
 * The step names are the Operations page's and the tests' keys; they are unchanged from when
 * `scheduled.ts` ran them inline. Order inside a slot is the order the steps ran in then: the
 * erasure ledger is replayed BEFORE the legacy catch-up (I-11), so a restored account is
 * re-erased before the catch-up looks at it.
 */

import type {
  MaintenanceContribution,
  MaintenanceRecorder,
  PlatformMaintenanceContext,
} from "../../core/contributions.js";
import type { Env } from "../../platform/env.js";
import { prunePortalAudit } from "./portal/repo.js";
import { purgeDownloadTokens } from "../../core/assets/downloadTokens.js";
import { sweepAvatars } from "./card/avatars.js";
import { pruneStorefrontSeen } from "./portal/store/analytics.js";
import { pruneAccountMerges } from "./accounts/mergeUndo.js";
import { recheckConnectionDomains } from "./connections/domains.js";
import {
  replayErasures,
  stuckErasures,
  sweepErasures,
} from "./accounts/deletion.js";
import { sweepAccountDeletions } from "./accounts/lifecycle.js";
import { customerOrigin } from "../../core/hosts.js";
import type { Db } from "../../db/types.js";

/** The origin account mail links to: the customer site while `CUSTOMER_ORIGIN` is usable. */
const originOf = async (env: Env, db: Db): Promise<string> =>
  customerOrigin(env, env.CONSOLE_ORIGIN ?? "") ?? "";

/**
 * I-11: one bounded pass of the erasure ledger replay (`accounts/erasureLedger.ts`). The count is
 * what the pass repaired (tombstones recreated, restored accounts re-erased, erasure tombstones
 * copied into the ledger): 0 while D1 and the ledger agree. An account whose re-erasure or ledger
 * copy threw fails the step, naming the opaque account ids.
 */
async function erasureLedgerReplay(
  { db, now }: PlatformMaintenanceContext,
  env: Env,
  rec: MaintenanceRecorder,
): Promise<void> {
  await rec.step("erasureLedger", async () => {
    const r = await replayErasures({
      db,
      env,
      now,
      origin: await originOf(env, db),
    });
    if (r.failures.length > 0)
      throw new Error(
        `${r.failures.length} erasure ledger repair(s) failed: ` +
          r.failures
            .slice(0, 10)
            .map((f) => `${f.accountId} (${f.step}: ${f.message})`)
            .join(", ") +
          (r.failures.length > 10 ? ", …" : ""),
      );
    return r.tombstoned + r.reapplied + r.mirrored;
  });
}

/**
 * I-11: start hard erasure for account deletions whose fourteen-day grace period elapsed. The
 * lifecycle helper conditionally claims each request, so an account holder's cancellation and
 * this cron tick cannot both win.
 */
async function accountDeletionSweep(
  { db, now }: PlatformMaintenanceContext,
  env: Env,
  rec: MaintenanceRecorder,
): Promise<void> {
  await rec.step("accountDeletions", async () => {
    const r = await sweepAccountDeletions({
      db,
      env,
      now,
      origin: await originOf(env, db),
    });
    return r.started;
  });
}

/**
 * The account-erasure retry sweep (`accounts/deletion.ts`): resume every unfinished erasure whose
 * back-off elapsed. `reportStuck` (the nightly tick only) fails the `erasures` step while any
 * erasure has failed `ERASURE_STUCK_ATTEMPTS` times, naming the opaque account ids and the
 * failing step, so the Operations page shows a stuck erasure.
 */
async function erasureSweep(
  { db, now }: PlatformMaintenanceContext,
  env: Env,
  rec: MaintenanceRecorder,
  reportStuck: boolean,
): Promise<void> {
  await rec.step("erasures", async () => {
    const r = await sweepErasures({
      db,
      env,
      now,
      origin: await originOf(env, db),
    });
    if (reportStuck) {
      const stuck = await stuckErasures(db);
      if (stuck.length > 0)
        throw new Error(
          `${stuck.length} account erasure(s) stuck: ` +
            stuck
              .map(
                (s) =>
                  `${s.accountId} (${s.attempts} attempts, ${s.failedStep ?? "?"})`,
              )
              .join(", "),
        );
    }
    return r.completed;
  });
}

export const identityMaintenance: MaintenanceContribution = {
  async product({ db, product, now, cutoff }, rec) {
    await rec.drain(`portalAudit:${product}`, (limit) =>
      prunePortalAudit(db, product, cutoff, limit),
    );
    // Drained like its siblings: a single pass would remove at most PRUNE_BATCH_ROWS per night,
    // so a product minting download tokens faster than that would accumulate them for ever while
    // the report showed a healthy-looking count.
    await rec.drain(`downloadTokens:${product}`, (limit) =>
      purgeDownloadTokens(db, product, now, limit),
    );
    // PS-04: the storefront's impression dedupe keys older than yesterday (notes/S-21 §6.6:
    // nothing per person is kept past two days).
    await rec.drain(`storefrontSeen:${product}`, (limit) =>
      pruneStorefrontSeen(db, product, now, limit),
    );
  },

  async early(ctx, rec) {
    const { db, env } = ctx;
    // `portal_audit.product` is nullable (a magic-link sign-in belongs to no tenant), so without
    // this pass those rows would be the one part of the table that still grew forever.
    await rec.drain("portalAudit:_platform", (limit) =>
      prunePortalAudit(db, null, ctx.cutoff, limit),
    );
    if (env) await erasureLedgerReplay(ctx, env, rec);
    // I-11: due requests enter the resumable erasure state machine, then incomplete erasures
    // retry under their own back-off. Both runs are bounded and fault-isolated.
    if (env) {
      await accountDeletionSweep(ctx, env, rec);
      await erasureSweep(ctx, env, rec, true);
    }
  },

  async late(ctx, rec) {
    const { db, env, now } = ctx;
    // PX-W16: account pictures nothing has used for a day (a disconnected provider's copy, an
    // upload never saved, a merged account's leftovers, a write that died half way).
    if (env) await rec.step("avatars", () => sweepAvatars(env, db, now));
    // PX-W12: a join whose 72-hour undo window ended keeps no snapshot of the absorbed account.
    await rec.step("accountMerges", () => pruneAccountMerges(db, now));
    // I-30: every DNS-verified connection domain is asked again (plans/I-27.md §2.3 "Domains"). An
    // answer without the token unverifies it at once; resolver errors keep it for 72 h, then
    // unverify it, so a lapsed or taken-over domain stops routing, vouching and enforcing.
    await rec.step("connectionDomains", async () => {
      const r = await recheckConnectionDomains(db, now);
      return r.checked;
    });
  },

  /** Every connector-poll tick: erasures wait for no nightly. Failures wait for the nightly report. */
  async frequent(ctx, rec) {
    const { env } = ctx;
    if (!env) return;
    // The replay first: a restored account is closed before the sweeps below look at it.
    await erasureLedgerReplay(ctx, env, rec);
    await accountDeletionSweep(ctx, env, rec);
    await erasureSweep(ctx, env, rec, false);
  },
};
