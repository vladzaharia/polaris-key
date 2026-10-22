/**
 * The P0-49 job `core.provisioned-secrets-to-account` (U-27.6; plans/U-27-P2-12-slices.md §A2,
 * L-U3, L-U4), over the pure planner in `./provisionedSecrets.ts`. Its units are product slugs.
 *
 *   plan    reads only: the planner's answer as counts and capped licence ids (`summarizePlan`).
 *   apply   re-plans from the live rows (the dry run's report is a preview, never an instruction),
 *           then per move: CAS-add the sealed entry to the owner's account row exactly as stored,
 *           CAS-remove the key from the licence column (guarded on the column AND on the account
 *           row, `modified_at` untouched), and keep one ledger row. A sign-in between the read and
 *           a write fails a CAS and that move is skipped; the next dry run shows it.
 *   down    puts every entry back from the ledger and the account row (see {@link downProduct}).
 *
 * SEALED VALUES. An entry is read from `licenses.overrides_json` and written to
 * `account_overrides.payload_json` byte for byte (parsed and re-stringified, never opened, never
 * re-sealed: every managed secret shares one AAD, `pkey:v2:<product>:managed-secret:<key>`, so it is
 * valid where it lands). It is never logged, never in a report, and never in the ledger, which
 * holds `entry_sha256` only. An error thrown here names no value.
 */

import type { ManagedEntry } from "@polaris-key/protocol";
import type { Db } from "../../db/types.js";
import { randomId } from "../../platform/crypto.js";
import { sha256Hex } from "../../platform/hash.js";
import {
  casAccountOverrides,
  getAccountOverrides,
  overrideSubjectVia,
  parseAccountOverridePayload,
} from "../accounts/accountOverrides.js";
import { existingSubjectsFor } from "../accounts/accountSubjects.js";
import type { SubjectStore } from "../accounts/subjectHooks.js";
import { NO_LICENSE_ID } from "../devices.js";
import {
  getProvisioning,
  provisioningDeclaredKeys,
} from "../licensing/provisioning.js";
import { casLicenseOverrides } from "../licensing/store.js";
import type { MigrationContext, MigrationJob, UnitPlan } from "./job.js";
import {
  canonicalJson,
  planProvisionedSecretMoves,
  summarizePlan,
  type PlanDevice,
  type PlanInput,
  type PlanLicence,
  type ProvisionedSecretPlan,
} from "./provisionedSecrets.js";

export const PROVISIONED_SECRETS_JOB_ID = "core.provisioned-secrets-to-account";

const PAGE = 200;
const WRITER = "migration";
/** Compare-and-set rounds `down` makes per account row or column before leaving a ledger row. */
const CAS_ATTEMPTS = 3;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

const sha = (entry: unknown): Promise<string> =>
  sha256Hex(canonicalJson(entry));

// ── Reading the world the planner needs ──────────────────────────────────────────────────────

/** Products whose provisioning declares a secret key: the only ones with anything to move. */
async function productsWithSecretHooks(db: Db): Promise<string[]> {
  const rows = await db.all<{ product: string }>(
    `SELECT DISTINCT p.product AS product
       FROM provisioning_config p JOIN products pr ON pr.slug = p.product
      WHERE p.secret_key IS NOT NULL AND p.secret_key <> '' AND pr.status <> 'deleted'
      ORDER BY p.product`,
  );
  return rows.map((r) => r.product);
}

interface LicenceFacts {
  id: string;
  account_id: string | null;
  email: string | null;
}

/** The planner's input from the live rows. Reads only. */
async function gather(
  ctx: MigrationContext,
  product: string,
): Promise<PlanInput> {
  const { db } = ctx;
  const declared = provisioningDeclaredKeys(
    await getProvisioning(db, product),
  ).secrets;
  const licences: PlanLicence[] = [];
  const accountRows = new Map<string, string | null>();
  const devicesBySubject = new Map<string | null, PlanDevice[]>();
  const input: PlanInput = {
    product,
    declared,
    licences,
    accountRows,
    devicesBySubject,
  };
  if (declared.size === 0) return input;

  // Licences holding a declared key in the column (a cheap text prefilter; the planner parses).
  const keys = [...declared];
  const anyKey = keys.map(() => "instr(overrides_json, ?) > 0").join(" OR ");
  const accountIds = new Set<string>();
  const held: { id: string; account_id: string | null; json: string }[] = [];
  for (let after = ""; ; ) {
    const page = await db.all<{
      id: string;
      account_id: string | null;
      overrides_json: string;
    }>(
      `SELECT id, account_id, overrides_json FROM licenses
        WHERE product = ? AND id > ? AND overrides_json IS NOT NULL AND (${anyKey})
        ORDER BY id LIMIT ${PAGE}`,
      product,
      after,
      ...keys,
    );
    for (const r of page) {
      held.push({
        id: r.id,
        account_id: r.account_id,
        json: r.overrides_json,
      });
      if (r.account_id) accountIds.add(r.account_id);
    }
    if (page.length < PAGE) break;
    after = page[page.length - 1]!.id;
  }
  const subjects = await existingSubjectsFor(db, [...accountIds], product);
  for (const l of held) {
    // An owner with no subject yet counts as unowned (the column stays).
    const owner = l.account_id ? (subjects.get(l.account_id) ?? null) : null;
    const licence: PlanLicence = {
      id: l.id,
      ownerSubject: owner,
      overridesJson: l.json,
    };
    licences.push(licence);
  }

  // Every active device, by the subject whose account layer it gets.
  const facts = new Map<string, LicenceFacts | null>();
  for (let after = ""; ; ) {
    const page = await db.all<{
      device_id: string;
      license_id: string;
      status: string;
      subject: string | null;
    }>(
      `SELECT device_id, license_id, status, subject FROM devices
        WHERE product = ? AND status = 'authorized' AND device_id > ?
        ORDER BY device_id LIMIT ${PAGE}`,
      product,
      after,
    );
    for (const d of page) {
      let licence: LicenceFacts | null = null;
      if (d.license_id !== NO_LICENSE_ID) {
        if (!facts.has(d.license_id))
          facts.set(
            d.license_id,
            await db.first<LicenceFacts>(
              "SELECT id, account_id, email FROM licenses WHERE product = ? AND id = ?",
              product,
              d.license_id,
            ),
          );
        licence = facts.get(d.license_id) ?? null;
      }
      const answer = await overrideSubjectVia(db, product, licence, {
        product,
        status: d.status,
        license_id: d.license_id,
        subject: d.subject,
      });
      const key = answer?.subject ?? null;
      const list = devicesBySubject.get(key) ?? [];
      list.push({
        licenseId: d.license_id,
        signedIn: answer?.via === "signedIn",
      });
      devicesBySubject.set(key, list);
    }
    if (page.length < PAGE) break;
    after = page[page.length - 1]!.device_id;
  }

  // The owner rows the planner compares against.
  const owners = new Set(
    licences.flatMap((l) => (l.ownerSubject ? [l.ownerSubject] : [])),
  );
  for (const subject of owners)
    accountRows.set(
      subject,
      (await getAccountOverrides(db, product, subject))?.payload_json ?? null,
    );
  return input;
}

/** The plan for one product, from the live rows. Reads only. */
export async function planProduct(
  ctx: MigrationContext,
  product: string,
): Promise<ProvisionedSecretPlan> {
  return planProvisionedSecretMoves(await gather(ctx, product));
}

/** What an apply did, as counts (never an entry). */
export interface ApplyResult {
  /** Copies removed from a licence column (moved, or shadowed). */
  removed: number;
  /** Entries added to an account row. */
  added: number;
  /** Planned moves skipped because a CAS failed or a row changed after the plan. */
  skipped: number;
}

// ── Apply ────────────────────────────────────────────────────────────────────────────────────

interface Column {
  json: string;
  parsed: Record<string, unknown>;
  secrets: Record<string, unknown>;
}

async function readColumn(
  db: Db,
  product: string,
  licenseId: string,
): Promise<Column | null> {
  const row = await db.first<{ overrides_json: string | null }>(
    "SELECT overrides_json FROM licenses WHERE product = ? AND id = ?",
    product,
    licenseId,
  );
  if (!row?.overrides_json) return null;
  try {
    const parsed: unknown = JSON.parse(row.overrides_json);
    if (!isRecord(parsed) || !isRecord(parsed.secrets)) return null;
    return { json: row.overrides_json, parsed, secrets: parsed.secrets };
  } catch {
    return null;
  }
}

const accountJson = (
  config: Record<string, ManagedEntry>,
  secrets: Record<string, ManagedEntry>,
): string => JSON.stringify({ config, secrets });

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Perform a plan under compare-and-set. Exported so a test can apply a plan it computed earlier
 * and prove that a change in between skips the move. Idempotent: a re-run finds nothing to do.
 */
export async function applyProductPlan(
  ctx: MigrationContext,
  product: string,
  plan: ProvisionedSecretPlan,
  runId: string = randomId("psm"),
): Promise<ApplyResult> {
  const { db, now } = ctx;
  const result: ApplyResult = { removed: 0, added: 0, skipped: 0 };
  /** licence id -> the order its secrets had before this pass removed anything. */
  const original = new Map<string, string[]>();

  interface Action {
    licenseId: string;
    key: string;
    subject: string;
    /** null = a shadowed copy (the account row decides). */
    entry: ManagedEntry | null;
    addToAccount: boolean;
  }
  const actions: Action[] = [
    ...plan.moves.map((m) => ({ ...m })),
    ...plan.shadowed.map((s) => ({
      licenseId: s.licenseId,
      key: s.key,
      subject: s.subject,
      entry: null,
      addToAccount: false,
    })),
  ].sort((a, b) => byText(a.licenseId, b.licenseId) || byText(a.key, b.key));

  for (const a of actions) {
    const column = await readColumn(db, product, a.licenseId);
    const current = column?.secrets[a.key];
    if (!column || !isRecord(current)) {
      result.skipped++;
      continue;
    }
    const currentText = canonicalJson(current);
    if (a.entry !== null && currentText !== canonicalJson(a.entry)) {
      result.skipped++; // the column changed after the plan
      continue;
    }
    if (!original.has(a.licenseId))
      original.set(a.licenseId, Object.keys(column.secrets));
    const position = original.get(a.licenseId)!.indexOf(a.key);

    // The owner's row as it is now.
    const rowJson =
      (await getAccountOverrides(db, product, a.subject))?.payload_json ?? null;
    const row = parseAccountOverridePayload(rowJson);
    const onRow = row.secrets[a.key];
    let added = false;
    let nextRowJson = rowJson;
    if (a.entry === null) {
      if (onRow === undefined) {
        result.skipped++; // a shadow needs the row's entry to still be there
        continue;
      }
    } else if (onRow === undefined) {
      if (!a.addToAccount) {
        result.skipped++; // the move that adds it did not happen
        continue;
      }
      added = true;
      nextRowJson = accountJson(row.config, {
        ...row.secrets,
        [a.key]: a.entry,
      });
    } else if (canonicalJson(onRow) !== currentText) {
      result.skipped++; // a sign-in wrote a different entry after the plan
      continue;
    }

    // The ledger row first: a crash after the account write still has its record.
    await db.run(
      `INSERT OR IGNORE INTO provisioned_secret_moves
         (product, license_id, key, subject, entry_sha256, added_to_account, shadowed, position, run_id, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      product,
      a.licenseId,
      a.key,
      a.subject,
      await sha(current),
      added ? 1 : 0,
      a.entry === null ? 1 : 0,
      position < 0 ? 0 : position,
      runId,
      now,
    );
    const undoLedger = async (): Promise<void> => {
      if (!added)
        await db.run(
          `DELETE FROM provisioned_secret_moves
            WHERE product = ? AND license_id = ? AND key = ? AND run_id = ?`,
          product,
          a.licenseId,
          a.key,
          runId,
        );
    };

    if (added) {
      const ok = await casAccountOverrides(
        db,
        product,
        a.subject,
        rowJson,
        { config: row.config, secrets: { ...row.secrets, [a.key]: a.entry! } },
        WRITER,
        now,
      );
      if (!ok) {
        await undoLedger();
        result.skipped++;
        continue;
      }
      result.added++;
    }

    const { [a.key]: _gone, ...rest } = column.secrets;
    void _gone;
    const removed = await casLicenseOverrides(
      db,
      product,
      a.licenseId,
      column.json,
      JSON.stringify({ ...column.parsed, secrets: rest }),
      { subject: a.subject, payloadJson: nextRowJson },
    );
    if (!removed) {
      await undoLedger();
      result.skipped++;
      continue;
    }
    result.removed++;
  }
  return result;
}

// ── Down ─────────────────────────────────────────────────────────────────────────────────────

interface LedgerRow {
  license_id: string;
  key: string;
  subject: string;
  entry_sha256: string;
  added_to_account: number;
  shadowed: number;
  position: number;
}

/**
 * Undo one product from its ledger. For each ledger row whose account entry still hashes to
 * `entry_sha256`: put the entry back on the licence column at its old position (when the column
 * lacks the key), then remove it from the account row when this job added it. An account entry
 * that was edited since (a different hash) stays, and so does the column as it is. A shadowed
 * copy (its value was never stored, and it changed no document) is not restored. Finished
 * ledger rows are deleted, so a second `down` changes nothing; a row whose CAS kept failing
 * stays for the next call.
 */
export async function downProduct(
  ctx: MigrationContext,
  product: string,
): Promise<number> {
  const { db, now } = ctx;
  const rows = await db.all<LedgerRow>(
    `SELECT license_id, key, subject, entry_sha256, added_to_account, shadowed, position
       FROM provisioned_secret_moves WHERE product = ?
      ORDER BY license_id, position, key`,
    product,
  );
  let changes = 0;
  let incomplete = 0;
  /** `subject|key` -> every restorable row of the group got its column back (or had it). */
  const groupOk = new Map<string, boolean>();
  const groupAdded = new Map<string, LedgerRow>();
  const done: LedgerRow[] = [];
  const groupId = (r: LedgerRow): string => canonicalJson([r.subject, r.key]);

  for (const r of rows) {
    if (r.shadowed === 1) {
      done.push(r);
      continue;
    }
    const accountRow = await getAccountOverrides(db, product, r.subject);
    const entry = parseAccountOverridePayload(accountRow?.payload_json ?? null)
      .secrets[r.key];
    if (entry === undefined || (await sha(entry)) !== r.entry_sha256) {
      done.push(r); // edited or gone since: it stays as it is
      continue;
    }
    const id = groupId(r);
    if (r.added_to_account === 1) groupAdded.set(id, r);
    let restored = false;
    for (let attempt = 0; attempt < CAS_ATTEMPTS && !restored; attempt++) {
      const row = await db.first<{ overrides_json: string | null }>(
        "SELECT overrides_json FROM licenses WHERE product = ? AND id = ?",
        product,
        r.license_id,
      );
      if (!row) {
        restored = true; // the licence is gone
        break;
      }
      let parsed: Record<string, unknown> = { config: {}, secrets: {} };
      try {
        const p: unknown = row.overrides_json
          ? JSON.parse(row.overrides_json)
          : null;
        if (isRecord(p)) parsed = p;
      } catch {
        // an unreadable column is replaced by one holding the entry
      }
      const secrets = isRecord(parsed.secrets) ? parsed.secrets : {};
      if (Object.hasOwn(secrets, r.key)) {
        restored = true; // already back (or put there by an operator)
        break;
      }
      const list = Object.entries(secrets);
      list.splice(Math.min(r.position, list.length), 0, [r.key, entry]);
      const ok = await casLicenseOverrides(
        db,
        product,
        r.license_id,
        row.overrides_json,
        JSON.stringify({ ...parsed, secrets: Object.fromEntries(list) }),
      );
      if (ok) {
        restored = true;
        changes++;
      }
    }
    groupOk.set(id, (groupOk.get(id) ?? true) && restored);
    if (restored) done.push(r);
    else incomplete++;
  }

  // The account row loses an entry this job added only once every licence has its copy back.
  for (const [id, r] of groupAdded) {
    if (groupOk.get(id) !== true) continue;
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
      const accountRow = await getAccountOverrides(db, product, r.subject);
      const payload = parseAccountOverridePayload(
        accountRow?.payload_json ?? null,
      );
      const entry = payload.secrets[r.key];
      if (entry === undefined || (await sha(entry)) !== r.entry_sha256) break;
      const { [r.key]: _gone, ...secrets } = payload.secrets;
      void _gone;
      if (
        await casAccountOverrides(
          db,
          product,
          r.subject,
          accountRow?.payload_json ?? null,
          { config: payload.config, secrets },
          WRITER,
          now,
        )
      ) {
        changes++;
        break;
      }
    }
  }

  for (const r of done)
    await db.run(
      "DELETE FROM provisioned_secret_moves WHERE product = ? AND license_id = ? AND key = ?",
      product,
      r.license_id,
      r.key,
    );
  if (incomplete > 0)
    throw new Error("provisioned_secret_moves_down_incomplete");
  return changes;
}

// ── The job ──────────────────────────────────────────────────────────────────────────────────

export const provisionedSecretsToAccountJob: MigrationJob = {
  id: PROVISIONED_SECRETS_JOB_ID,
  summary:
    "Move provisioned secrets from owned licences to the owner's account overrides row (exact down)",
  units: ({ db }) => productsWithSecretHooks(db),
  async plan(ctx, product): Promise<UnitPlan> {
    const plan = await planProduct(ctx, product);
    return {
      // Column copies the apply removes; conflicts and skips are reported, not changes.
      changes: plan.moves.length + plan.shadowed.length,
      detail: summarizePlan(plan),
    };
  },
  async apply(ctx, product) {
    const plan = await planProduct(ctx, product);
    return (await applyProductPlan(ctx, product, plan)).removed;
  },
  down: downProduct,
};

// ── Erasure: the ledger holds a subject ──────────────────────────────────────────────────────

export const PROVISIONED_SECRET_MOVES_STORE = "core.provisionedSecretMoves";

/**
 * The ledger is account × product data (a pairwise subject), so an account merge re-keys it and
 * an erasure deletes it. It holds no value, so the export carries ids only.
 */
export const provisionedSecretMovesStore: SubjectStore = {
  tables: ["provisioned_secret_moves"],

  async merge({ db }, { product, from, to }) {
    await db.run(
      "UPDATE provisioned_secret_moves SET subject = ? WHERE product = ? AND subject = ?",
      to,
      product,
      from,
    );
  },

  async delete({ db }, { product, subject }) {
    await db.run(
      "DELETE FROM provisioned_secret_moves WHERE product = ? AND subject = ?",
      product,
      subject,
    );
  },

  async export({ db }, { product, subject }) {
    const rows = await db.all<{ license_id: string; key: string; at: number }>(
      `SELECT license_id, key, at FROM provisioned_secret_moves
        WHERE product = ? AND subject = ? ORDER BY license_id, key`,
      product,
      subject,
    );
    return rows.map((r) => ({ licenseId: r.license_id, key: r.key, at: r.at }));
  },
};
