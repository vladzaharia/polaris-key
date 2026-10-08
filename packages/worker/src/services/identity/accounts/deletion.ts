/**
 * Account deletion, per-product removal and disable (I-05; S-16 §5.1 and §5.5, D25, D27).
 *
 * Deletion and per-product removal call every registered store's `delete` (Cloud Sync, Config)
 * BEFORE the subject row goes, so each store can still resolve what it holds; then the device
 * binding is cleared and the developer hears `subject.deleted`, carrying the licence ids, through
 * the pull feed. Licences are the developer's commercial records: deletion DETACHES them (they
 * become floating) and leaves developer-set buyer columns to the developer (D27; the DPA wording
 * is pending a legal review, I-19).
 *
 * Per-product removal is NOT unlinkability while a licence of that product stays attached (D25):
 * the next contact mints a fresh subject that resolves to the same licence. `alsoDetachLicenses`
 * is the "also remove the licence from my Library" choice the removal screen offers.
 */

import { deleteAccountAvatars } from "../card/avatars.js";
import {
  accountLicenses,
  stmtDetachAccountLicenses,
} from "../../../core/accountSubjects.js";
import { stmtDeleteAccountAutoAttachBlocks } from "../../../core/licenseHolders.js";
import { randomId, type Db, type DbStatement } from "../../../core/platform.js";
import {
  forgetRegistryTokens,
  stmtRevokeAccountRegistryTokens,
} from "../../../core/registryTokens.js";
import {
  clearDeviceSubjects,
  onLicenseOwnershipEnded,
  runSubjectDelete,
  runSubjectDeleteIsolated,
} from "../../../core/subjectHooks.js";
import { portalAudit } from "../portal/repo.js";
import { stmtSubjectEvent } from "./events.js";
import { endLicenseLinks, moveLicenseOwnerEndingLinks } from "./legacy.js";
import type { AccountContext } from "./links.js";
import { getAccountRow } from "./repo.js";
import { stmtDeleteTermsAcceptances } from "./terms.js";
import { stmtDeleteAccountMerges } from "./mergeUndo.js";

/** Statements that end one (account, product) subject: its aliases, then the row itself. */
function stmtsEndSubject(
  accountId: string,
  product: string,
  subject: string,
): DbStatement[] {
  return [
    {
      sql: "DELETE FROM account_product_subject_aliases WHERE product = ? AND subject = ?",
      params: [product, subject],
    },
    {
      sql: "DELETE FROM account_product_subjects WHERE account_id = ? AND product = ?",
      params: [accountId, product],
    },
  ];
}

/**
 * "Remove my data from <Product>": end the account's pairwise subject for one product. Registered
 * stores delete first, devices signed in with it lose the binding, and the developer gets
 * `subject.deleted`. With `alsoDetachLicenses` the product's licences leave the Library too.
 */
export async function removeProductData(
  ctx: AccountContext,
  args: { accountId: string; product: string; alsoDetachLicenses: boolean },
): Promise<{ ok: boolean; detached: string[] }> {
  const { db, env, now } = ctx;
  const row = await db.first<{ subject: string }>(
    "SELECT subject FROM account_product_subjects WHERE account_id = ? AND product = ?",
    args.accountId,
    args.product,
  );
  const licenses = (
    await accountLicenses(db, args.accountId, args.product)
  ).map((l) => l.id);
  const detached: string[] = [];
  if (args.alsoDetachLicenses) {
    for (const licenseId of licenses) {
      // No portal link survives the detach (see endLicenseLinks): §8 Q1 losers settle here.
      await endLicenseLinks(ctx, args.product, licenseId, [args.accountId]);
      if (
        await moveLicenseOwnerEndingLinks(
          ctx,
          args.product,
          licenseId,
          args.accountId,
          null,
        )
      ) {
        detached.push(licenseId);
        await onLicenseOwnershipEnded(db, env, {
          product: args.product,
          licenseId,
          accountId: args.accountId,
          reason: "detached",
          now,
        });
      }
    }
  }
  if (!row) return { ok: detached.length > 0, detached };
  await runSubjectDelete(
    { db, env, now },
    { product: args.product, subject: row.subject },
  );
  await clearDeviceSubjects(
    db,
    env,
    { kind: "subject", product: args.product, subject: row.subject },
    "product_removed",
  );
  await db.batch([
    stmtSubjectEvent(
      {
        type: "subject.deleted",
        product: args.product,
        subject: row.subject,
        licenseIds: licenses,
        detached: args.alsoDetachLicenses,
      },
      now,
    ),
    ...stmtsEndSubject(args.accountId, args.product, row.subject),
  ]);
  await portalAudit(db, {
    accountId: args.accountId,
    action: "account.product.remove",
    product: args.product,
    targetKind: "product",
    targetId: args.product,
    summary: args.alsoDetachLicenses
      ? "Removed product data and its licenses from the library"
      : "Removed product data",
    now,
  });
  return { ok: true, detached };
}

/** How long one erasure attempt owns the account before another may take over (seconds). */
export const ERASURE_LEASE_SECONDS = 10 * 60;
/** Back-off between attempts by the number already made, capped at the last entry (seconds). */
export const ERASURE_BACKOFF_SECONDS = [
  15 * 60,
  60 * 60,
  4 * 60 * 60,
  12 * 60 * 60,
  24 * 60 * 60,
] as const;
/** From this many failed attempts an erasure counts as stuck and the nightly sweep reports it. */
export const ERASURE_STUCK_ATTEMPTS = 5;
/** Erasures one sweep resumes at most. */
export const ERASURE_SWEEP_MAX = 25;
/** Rounds of "re-read the subjects, delete the new ones' data" before the commit (SEC-PRV-19). */
const ERASURE_SUBJECT_ROUNDS = 5;

export interface ErasureResult {
  ok: boolean;
  /** Set when the account is closed to everyone but some of its data is still being erased: the
   *  retry sweeper completes it. Absent when the erasure finished. */
  erasing?: true;
}

interface ErasureFailure {
  step: string;
  text: string;
}

function failure(step: string, e: unknown): ErasureFailure {
  const name = e instanceof Error ? e.name : "Error";
  const msg = e instanceof Error ? e.message : String(e);
  return { step, text: `${step}: ${name}: ${msg}`.slice(0, 200) };
}

/**
 * Erase an account (right to erasure; S-16 §5.5) as a resumable, idempotent state machine
 * (SEC-PRV-1):
 *
 *   1. ERASING. One batch flips `accounts.status` to `deleted` (every reader refuses anything but
 *      `active`, so no session and no sign-in works), kills the sessions and writes the
 *      `account_erasures` progress row. The pairwise subjects, links and licences stay, because
 *      the hooks below need them to resolve what they hold.
 *   2. HOOKS, each fault-isolated: every registered store's `delete` per subject, the device
 *      bindings, the licence links and ownership hooks, the account pictures. All are idempotent.
 *      A failure is recorded on the progress row (`failed_step`, `last_error`, back-off) and the
 *      attempt ends with `{ ok: true, erasing: true }`; nothing was removed that a retry needs.
 *   3. ERASED. Only when every hook succeeded, one atomic batch removes every row naming the
 *      person: links, subjects (ALL of the account's, so a subject minted during the run is not
 *      orphaned, SEC-PRV-19) and aliases, grants, terms acceptances, passkeys, library entries,
 *      the account, and the pre-I-05 `portal_*` rows (so a Worker rollback cannot resurrect
 *      them), then the progress row. What remains is an id-only tombstone (a restore from backup
 *      can re-apply the deletion) and one `portal.account.delete` receipt with no email, name or
 *      product. `subject.deleted` goes to the developer of each product, carrying the licence ids.
 *
 * The retry sweeper ({@link sweepErasures}) resumes every unfinished erasure on the cron ticks.
 * Calling this again on an account already erasing resumes it, so a double invoke is harmless.
 */
export async function deleteAccount(
  ctx: AccountContext,
  accountId: string,
): Promise<ErasureResult> {
  const { db, now } = ctx;
  const row = await getAccountRow(db, accountId);
  if (!row) return { ok: false };
  await db.batch([
    {
      sql: `UPDATE accounts SET status = 'deleted', deleted_at = COALESCE(deleted_at, ?), modified_at = ?
             WHERE id = ?`,
      params: [now, now, accountId],
    },
    {
      sql: "DELETE FROM account_sessions WHERE account_id = ?",
      params: [accountId],
    },
    // The account's package-registry tokens stop authenticating now, not at the commit: the
    // lookup never reads the account. Idempotent; the commit batch repeats it.
    stmtRevokeAccountRegistryTokens(accountId, now),
    {
      sql: `INSERT OR IGNORE INTO account_erasures (account_id, requested_at, next_attempt_at)
            VALUES (?, ?, ?)`,
      params: [accountId, now, now],
    },
  ]);
  // This isolate's 30-second resolution cache; other isolates' entries expire within 30 s.
  forgetRegistryTokens();
  return runErasure(ctx, accountId);
}

/** Take the erasure's lease; false when another attempt holds it. */
async function claimErasure(
  ctx: AccountContext,
  accountId: string,
): Promise<boolean> {
  const { db, now } = ctx;
  return (
    (await db.runChanges(
      `UPDATE account_erasures SET lease_until = ?, last_attempt_at = ?, attempts = attempts + 1
        WHERE account_id = ? AND lease_until <= ?`,
      now + ERASURE_LEASE_SECONDS,
      now,
      accountId,
      now,
    )) === 1
  );
}

/** One attempt of steps 2 and 3. Never throws for a hook failure: it records it. */
async function runErasure(
  ctx: AccountContext,
  accountId: string,
): Promise<ErasureResult> {
  const { db, env, now } = ctx;
  if (!(await claimErasure(ctx, accountId))) {
    // Another attempt is running (or the progress row is gone: the erasure finished).
    const live = await db.first<{ account_id: string }>(
      "SELECT account_id FROM account_erasures WHERE account_id = ?",
      accountId,
    );
    return live ? { ok: true, erasing: true } : { ok: true };
  }
  const failures: ErasureFailure[] = [];
  const attempt = async (step: string, run: () => Promise<void>) => {
    try {
      await run();
    } catch (e) {
      failures.push(failure(step, e));
    }
  };
  type Subject = { product: string; subject: string };
  const done = new Set<string>();
  const readSubjects = () =>
    db.all<Subject>(
      "SELECT product, subject FROM account_product_subjects WHERE account_id = ? ORDER BY product",
      accountId,
    );
  const licenses = await accountLicenses(db, accountId);
  let subjects = await readSubjects();
  // The stores run first, per subject; a subject minted while this runs gets its own round
  // (SEC-PRV-19), then the final batch deletes every subject row of the account regardless.
  for (let round = 0; round < ERASURE_SUBJECT_ROUNDS; round++) {
    const fresh = subjects.filter(
      (s) => !done.has(`${s.product}\0${s.subject}`),
    );
    if (fresh.length === 0) break;
    for (const s of fresh) {
      const out = await runSubjectDeleteIsolated(
        { db, env, now },
        { product: s.product, subject: s.subject },
      );
      for (const f of out) failures.push(failure(`store:${f.store}`, f.error));
      if (out.length === 0) done.add(`${s.product}\0${s.subject}`);
    }
    if (failures.length > 0) break;
    subjects = await readSubjects();
  }
  await attempt("devices", async () => {
    await clearDeviceSubjects(
      db,
      env,
      { kind: "account", accountId },
      "account_deleted",
    );
  });
  for (const l of licenses) {
    await attempt("licenses", async () => {
      // Every portal link to a licence that is about to float ends first, other accounts' too
      // (§8 Q1 losers settled inline), so the scheduled catch-up cannot re-point it at one of them.
      await endLicenseLinks(ctx, l.product, l.id, [accountId]);
      await onLicenseOwnershipEnded(db, env, {
        product: l.product,
        licenseId: l.id,
        accountId,
        reason: "account_deleted",
        now,
      });
    });
  }
  // I-07, PX-W16: every picture the account owns or uses (provider copies, uploads, pending ones)
  // goes before the rows that name them (R2 objects have no foreign key; once the rows are gone
  // nothing could find them), and its `account_avatars` rows with them.
  await attempt("avatars", async () => {
    await deleteAccountAvatars(env, db, accountId);
  });
  if (failures.length === 0) {
    // One last read-and-hook pass (`subjectFor` now refuses to mint for an erasing account, so a
    // subject can only appear from a request that raced the closing batch).
    subjects = await readSubjects();
    for (const s of subjects) {
      if (done.has(`${s.product}\0${s.subject}`)) continue;
      const out = await runSubjectDeleteIsolated(
        { db, env, now },
        { product: s.product, subject: s.subject },
      );
      for (const f of out) failures.push(failure(`store:${f.store}`, f.error));
      if (out.length === 0) done.add(`${s.product}\0${s.subject}`);
    }
  }
  if (failures.length === 0) {
    try {
      await db.batch(commitStatements(accountId, subjects, licenses, now));
      return { ok: true };
    } catch (e) {
      failures.push(failure("commit", e));
    }
  }
  await recordErasureFailure(db, accountId, now, failures);
  return { ok: true, erasing: true };
}

async function recordErasureFailure(
  db: Db,
  accountId: string,
  now: number,
  failures: ErasureFailure[],
): Promise<void> {
  const row = await db.first<{ attempts: number }>(
    "SELECT attempts FROM account_erasures WHERE account_id = ?",
    accountId,
  );
  const n = Math.max(1, row?.attempts ?? 1);
  const wait =
    ERASURE_BACKOFF_SECONDS[
      Math.min(n - 1, ERASURE_BACKOFF_SECONDS.length - 1)
    ]!;
  const first = failures[0]?.step ?? "unknown";
  await db.run(
    `UPDATE account_erasures
        SET lease_until = 0, next_attempt_at = ?, failed_step = ?, last_error = ?
      WHERE account_id = ?`,
    now + wait,
    first,
    failures
      .map((f) => f.text)
      .join(" | ")
      .slice(0, 200),
    accountId,
  );
}

/** The atomic final batch (step 3). Every statement is keyed by the account id. */
function commitStatements(
  accountId: string,
  subjects: Array<{ product: string; subject: string }>,
  licenses: Array<{ product: string; id: string }>,
  now: number,
): DbStatement[] {
  const stmts: DbStatement[] = [];
  for (const s of subjects) {
    stmts.push(
      stmtSubjectEvent(
        {
          type: "subject.deleted",
          product: s.product,
          subject: s.subject,
          licenseIds: licenses
            .filter((l) => l.product === s.product)
            .map((l) => l.id),
          detached: true,
        },
        now,
      ),
    );
  }
  stmts.push(
    // SEC-PRV-19: every alias and every subject row of the account, including one minted since
    // the list above was read.
    {
      sql: `DELETE FROM account_product_subject_aliases
             WHERE EXISTS (SELECT 1 FROM account_product_subjects s
                            WHERE s.account_id = ? AND s.product = account_product_subject_aliases.product
                              AND s.subject = account_product_subject_aliases.subject)`,
      params: [accountId],
    },
    {
      sql: "DELETE FROM account_product_subjects WHERE account_id = ?",
      params: [accountId],
    },
    // Belt and braces for a link a pre-I-05 Worker wrote since the loop above: none survives.
    {
      sql: `DELETE FROM portal_license_links
             WHERE EXISTS (SELECT 1 FROM licenses x
                            WHERE x.account_id = ? AND x.product = portal_license_links.product
                              AND x.id = portal_license_links.license_id)`,
      params: [accountId],
    },
    stmtDetachAccountLicenses(accountId),
    {
      sql: "DELETE FROM account_links WHERE account_id = ?",
      params: [accountId],
    },
    {
      sql: "DELETE FROM account_product_grants WHERE account_id = ?",
      params: [accountId],
    },
    {
      sql: "DELETE FROM account_sessions WHERE account_id = ?",
      params: [accountId],
    },
    {
      sql: "DELETE FROM account_passkeys WHERE account_id = ?",
      params: [accountId],
    },
    // PX-W15: the record of which terms versions the person accepted goes with them.
    stmtDeleteTermsAcceptances(accountId),
    // I-12: the relink history keeps its pairwise subjects (the developer's record) and loses the
    // account id; undoing a relink away from this account then leaves the licence floating.
    {
      sql: "UPDATE license_relinks SET from_account_id = NULL WHERE from_account_id = ?",
      params: [accountId],
    },
    {
      sql: "UPDATE license_relinks SET to_account_id = NULL WHERE to_account_id = ?",
      params: [accountId],
    },
    // LX-26: the account's auto-attach blocks (its account id) go with it.
    stmtDeleteAccountAutoAttachBlocks(accountId),
    // PS-04: and its library entries (open products added from the storefront, S-21 §6.4).
    {
      sql: "DELETE FROM library_entries WHERE account_id = ?",
      params: [accountId],
    },
    // PX-W12: its join records, whose snapshots hold the absorbed accounts' details.
    stmtDeleteAccountMerges(accountId),
    { sql: "DELETE FROM accounts WHERE id = ?", params: [accountId] },
    // The erasure is finished: the progress row goes with the account, in the same batch.
    {
      sql: "DELETE FROM account_erasures WHERE account_id = ?",
      params: [accountId],
    },
    {
      sql: `INSERT OR REPLACE INTO account_tombstones (id, email_hash, merged_into, deleted_at)
            VALUES (?, NULL, NULL, ?)`,
      params: [accountId, now],
    },
    {
      sql: "DELETE FROM portal_account_emails WHERE account_id = ?",
      params: [accountId],
    },
    {
      sql: "DELETE FROM portal_account_identities WHERE account_id = ?",
      params: [accountId],
    },
    {
      sql: "DELETE FROM portal_license_links WHERE account_id = ?",
      params: [accountId],
    },
    {
      sql: "DELETE FROM portal_audit WHERE account_id = ?",
      params: [accountId],
    },
    { sql: "DELETE FROM portal_accounts WHERE id = ?", params: [accountId] },
    // F-21: every registry token this account minted, on every product, stops now.
    stmtRevokeAccountRegistryTokens(accountId, now),
    {
      sql: `INSERT INTO portal_audit
              (id, account_id, at, action, product, target_kind, target_id, summary)
            VALUES (?, ?, ?, 'portal.account.delete', NULL, 'account', ?, ?)`,
      params: [
        randomId("paud"),
        accountId,
        now,
        accountId,
        "Portal account erased at the account holder's request",
      ],
    },
  );
  return stmts;
}

/**
 * The retry sweeper (SEC-PRV-1), run by both cron ticks: adopt `status = 'deleted'` accounts that
 * have no progress row (an erasure a Worker before SEC-WP-04 left half done), then resume up to
 * {@link ERASURE_SWEEP_MAX} erasures whose back-off elapsed and whose lease is free. Returns how
 * many it completed; an erasure that fails again is re-scheduled, not thrown.
 */
export async function sweepErasures(
  ctx: AccountContext,
): Promise<{ completed: number; attempted: number }> {
  const { db, now } = ctx;
  await db.run(
    `INSERT OR IGNORE INTO account_erasures (account_id, requested_at, next_attempt_at)
     SELECT id, COALESCE(deleted_at, ?), ? FROM accounts WHERE status = 'deleted'`,
    now,
    now,
  );
  const due = await db.all<{ account_id: string }>(
    `SELECT account_id FROM account_erasures
      WHERE next_attempt_at <= ? AND lease_until <= ?
      ORDER BY next_attempt_at LIMIT ?`,
    now,
    now,
    ERASURE_SWEEP_MAX,
  );
  let completed = 0;
  for (const d of due) {
    if (!(await getAccountRow(db, d.account_id))) {
      // The commit landed but the row cleanup did not: nothing left to erase.
      await db.run(
        "DELETE FROM account_erasures WHERE account_id = ?",
        d.account_id,
      );
      completed++;
      continue;
    }
    const r = await runErasure(ctx, d.account_id);
    if (!r.erasing) completed++;
  }
  return { completed, attempted: due.length };
}

/** Erasures stuck for good (every retry failed {@link ERASURE_STUCK_ATTEMPTS} times) and the
 *  oldest request, for the nightly report. Ids only: they are opaque `acct_...` surrogates. */
export async function stuckErasures(db: Db): Promise<
  Array<{
    accountId: string;
    attempts: number;
    requestedAt: number;
    failedStep: string | null;
  }>
> {
  const rows = await db.all<{
    account_id: string;
    attempts: number;
    requested_at: number;
    failed_step: string | null;
  }>(
    `SELECT account_id, attempts, requested_at, failed_step FROM account_erasures
      WHERE attempts >= ? ORDER BY requested_at LIMIT 20`,
    ERASURE_STUCK_ATTEMPTS,
  );
  return rows.map((r) => ({
    accountId: r.account_id,
    attempts: r.attempts,
    requestedAt: r.requested_at,
    failedStep: r.failed_step,
  }));
}

/** Disable an account (operator or abuse action): it cannot sign in, and every binding clears. */
export async function disableAccount(
  ctx: AccountContext,
  accountId: string,
): Promise<{ ok: boolean }> {
  const { db, env, now } = ctx;
  const changes = await db.runChanges(
    "UPDATE accounts SET status = 'disabled', modified_at = ? WHERE id = ? AND status = 'active'",
    now,
    accountId,
  );
  if (changes === 0) return { ok: false };
  // Mirrored into the pre-I-05 table, so a Worker rollback does not re-enable the account.
  await db.run(
    "UPDATE portal_accounts SET status = 'disabled', modified_at = ? WHERE id = ?",
    now,
    accountId,
  );
  await clearDeviceSubjects(
    db,
    env,
    { kind: "account", accountId },
    "account_disabled",
  );
  await portalAudit(db, {
    accountId,
    action: "account.disable",
    targetKind: "account",
    targetId: accountId,
    summary: "Account disabled",
    now,
  });
  return { ok: true };
}
