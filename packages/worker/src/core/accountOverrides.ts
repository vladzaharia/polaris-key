/**
 * The account override layer (U-03; notes/S-17 §5.12, plans/U-01.md §6.3): managed config for ONE
 * account on ONE product, and the rule that picks whose layer a device gets.
 *
 * ── WHY THIS IS CORE ─────────────────────────────────────────────────────────────────────────
 *
 * The table is Config's (`TABLE_OWNERS`), but the merge that reads it is Core's
 * (`core/payload.ts`: both signed documents are built from one walk), License's override route
 * must know when config and secrets stopped being licence data (the freeze), and Identity's
 * sign-in provisioning writes secrets here once the run has started. A service may not import
 * another (rule 6), so the reads and writes every one of them needs are answered here, once, the
 * way `accountSubjects.ts` answers the subject questions.
 *
 * ── WHOSE LAYER ──────────────────────────────────────────────────────────────────────────────
 *
 *     overrideSubject(device) = the subject signed in on the device     (the Cloud Sync principal)
 *                            ?? the licence owner's subject for the product  (Config's alone)
 *                            ?? none                                     (floating, or no licence)
 *
 * The first line is exactly the Cloud Sync principal (`resolveSyncPrincipal`), with every one of
 * its checks: an authorized device, a live or aliased subject (D21), never a floating licence
 * (S-24), never a licence the bound account removed from its library (S-24 D19, PX-23). The second
 * line is what keeps licence-key devices of owned licences whole after the migration (S-17 §5.12):
 * Cloud Sync has no such line (owner, final answers), and the registry guard's scan keeps it out
 * of Cloud Sync code. A device on a named-user seat (I-24, plans/I-24.md Q6) is signed in as the
 * seat user, so the first line already gives it the seat user's own layer.
 *
 * The owner line reads the subject without creating one (`existingSubjectFor`): every row here is
 * written for a subject that already exists (the editor answers only for a subject of the product,
 * and the migration creates the owner's subject before it writes), so an owner with no subject for
 * the product has no row, and a document GET never writes.
 */

import type { ManagedEntry } from "@polaris-key/protocol";
import type { Db, DbStatement } from "../db/types.js";
import type { Env } from "../env.js";
import { sealManagedValue } from "../admin/lib/managedSecrets.js";
import {
  existingSubjectFor,
  isFloatingLicense,
  resolveSyncPrincipal,
  subjectFor,
  type LicenseHolderFacts,
} from "./accountSubjects.js";

/** An account's layer: `config` and `secrets` only. Entitlements stay on the licence (decision 20). */
export interface AccountOverridePayload {
  config: Record<string, ManagedEntry>;
  secrets: Record<string, ManagedEntry>;
}

export interface AccountOverrideRow {
  product: string;
  subject: string;
  payload_json: string;
  updated_at: number;
  updated_by: string;
}

/** Who wrote a row besides an operator: the run, an account merge, the OIDC provisioning writer. */
export type AccountOverrideWriter = "migration" | "merge" | "signin";

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** Parse a stored layer. Anything unreadable is empty; an `entitlements` member is ignored. */
export function parseAccountOverridePayload(
  json: string | null | undefined,
): AccountOverridePayload {
  if (!json) return { config: {}, secrets: {} };
  try {
    const p: unknown = JSON.parse(json);
    if (!isRecord(p)) return { config: {}, secrets: {} };
    return {
      config: isRecord(p.config)
        ? (p.config as Record<string, ManagedEntry>)
        : {},
      secrets: isRecord(p.secrets)
        ? (p.secrets as Record<string, ManagedEntry>)
        : {},
    };
  } catch {
    return { config: {}, secrets: {} };
  }
}

export function isEmptyAccountOverridePayload(
  p: AccountOverridePayload,
): boolean {
  return (
    Object.keys(p.config).length === 0 && Object.keys(p.secrets).length === 0
  );
}

/** The stored row for (product, subject), or `null`. The caller passes a canonical subject. */
export async function getAccountOverrides(
  db: Db,
  product: string,
  subject: string,
): Promise<AccountOverrideRow | null> {
  return db.first<AccountOverrideRow>(
    `SELECT product, subject, payload_json, updated_at, updated_by
       FROM account_overrides WHERE product = ? AND subject = ?`,
    product,
    subject,
  );
}

/**
 * The write for one account's layer: an upsert, or a delete when the layer is empty (an account
 * with no overrides has no row, so a row count is a count of accounts that have one).
 */
export function stmtPutAccountOverrides(
  product: string,
  subject: string,
  payload: AccountOverridePayload,
  by: string,
  now: number,
): DbStatement {
  if (isEmptyAccountOverridePayload(payload))
    return stmtDeleteAccountOverrides(product, subject);
  return {
    sql: `INSERT INTO account_overrides (product, subject, payload_json, updated_at, updated_by)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (product, subject) DO UPDATE SET
            payload_json = excluded.payload_json,
            updated_at = excluded.updated_at,
            updated_by = excluded.updated_by`,
    params: [
      product,
      subject,
      JSON.stringify({ config: payload.config, secrets: payload.secrets }),
      now,
      by,
    ],
  };
}

export function stmtDeleteAccountOverrides(
  product: string,
  subject: string,
): DbStatement {
  return {
    sql: "DELETE FROM account_overrides WHERE product = ? AND subject = ?",
    params: [product, subject],
  };
}

export async function putAccountOverrides(
  db: Db,
  product: string,
  subject: string,
  payload: AccountOverridePayload,
  by: string,
  now: number,
): Promise<void> {
  const stmt = stmtPutAccountOverrides(product, subject, payload, by, now);
  await db.run(stmt.sql, ...stmt.params);
}

/**
 * A compare-and-set write: applies only while the stored `payload_json` is still `expected`
 * (`null` = no row). Answers false when another writer got there first, so a read-merge-write
 * never overwrites a concurrent edit (the OIDC provisioning writer and the editor share rows).
 */
export async function casAccountOverrides(
  db: Db,
  product: string,
  subject: string,
  expected: string | null,
  payload: AccountOverridePayload,
  by: string,
  now: number,
): Promise<boolean> {
  const empty = isEmptyAccountOverridePayload(payload);
  if (expected === null) {
    if (empty) return true;
    const changes = await db.runChanges(
      `INSERT OR IGNORE INTO account_overrides (product, subject, payload_json, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?)`,
      product,
      subject,
      JSON.stringify({ config: payload.config, secrets: payload.secrets }),
      now,
      by,
    );
    return changes > 0;
  }
  const changes = empty
    ? await db.runChanges(
        "DELETE FROM account_overrides WHERE product = ? AND subject = ? AND payload_json = ?",
        product,
        subject,
        expected,
      )
    : await db.runChanges(
        `UPDATE account_overrides SET payload_json = ?, updated_at = ?, updated_by = ?
          WHERE product = ? AND subject = ? AND payload_json = ?`,
        JSON.stringify({ config: payload.config, secrets: payload.secrets }),
        now,
        by,
        product,
        subject,
        expected,
      );
  return changes > 0;
}

// ── Whose layer ─────────────────────────────────────────────────────────────────────────────

/** The licence facts the owner line reads. */
export type OverrideLicenseFacts = LicenseHolderFacts & { id: string };

/** The device facts the signed-in line reads (the D1 row, never a KV record or the request). */
export interface OverrideDeviceFacts {
  product: string;
  status: string;
  license_id: string;
  subject?: string | null;
}

/**
 * The subject whose account layer a device gets on `product` (see the file header), or `null`.
 * `device` may be absent (a licence-level read: the owner line alone applies); `license` may be
 * absent (a licence-less device: the signed-in line alone applies).
 */
export async function overrideSubject(
  db: Db,
  product: string,
  license: OverrideLicenseFacts | null,
  device: OverrideDeviceFacts | null | undefined,
): Promise<string | null> {
  if (device) {
    const principal = await resolveSyncPrincipal(db, { ...device, product });
    if (principal) return principal.subject;
  }
  if (!license || isFloatingLicense(license)) return null;
  const accountId = license.account_id ?? null;
  return accountId ? existingSubjectFor(db, accountId, product) : null;
}

/**
 * The account layer as `mergePayloads` takes it (a stored payload JSON with empty
 * `entitlements`), or `null` when no subject applies or the subject has no row.
 */
export async function accountOverrideLayer(
  db: Db,
  product: string,
  license: OverrideLicenseFacts | null,
  device: OverrideDeviceFacts | null | undefined,
): Promise<string | null> {
  const subject = await overrideSubject(db, product, license, device);
  if (!subject) return null;
  const row = await getAccountOverrides(db, product, subject);
  if (!row) return null;
  const p = parseAccountOverridePayload(row.payload_json);
  return JSON.stringify({
    config: p.config,
    secrets: p.secrets,
    entitlements: {},
  });
}

// ── The OIDC provisioning writer (LX-02; S-19 §7.5, §8 U-03 row) ───────────────────────────

/** Max compare-and-set rounds {@link applyProvisionedAccountSecrets} makes before giving up. */
const PROVISION_ATTEMPTS = 3;

/**
 * Write an identity's provisioned SECRETS (e.g. `proxy.subscriptionUrl`) onto the licence owner's
 * account overrides, the surgical way LX-02 writes them on the licence: every key the product's
 * provisioning declares is removed, then set again only where the identity's claims provide it,
 * and every other key (an operator's) is kept. Used from the migration run's start (S-19: "U-03
 * moves secrets to the account override layer, which then becomes their target"); before it, the
 * licence column is still their target. Sealed under PLATFORM_KEK when `env` is given (every
 * caller passes it; without one the value is stored as the licence column stores it today, and
 * `openManagedValue` reads both). A read-merge-write under compare-and-set, so an operator's edit
 * in between is merged again, never lost.
 */
export async function applyProvisionedAccountSecrets(
  env: Env | undefined,
  db: Db,
  product: string,
  accountId: string,
  provisioned: Record<string, ManagedEntry>,
  declared: ReadonlySet<string>,
  now: number,
): Promise<void> {
  if (declared.size === 0) return;
  const subject = await subjectFor(db, accountId, product, now);
  const sealed: Record<string, ManagedEntry> = {};
  for (const [key, entry] of Object.entries(provisioned)) {
    if (!declared.has(key)) continue;
    sealed[key] = env
      ? {
          ...entry,
          value: (await sealManagedValue(
            env,
            product,
            key,
            entry.value,
          )) as ManagedEntry["value"],
        }
      : entry;
  }
  for (let attempt = 0; attempt < PROVISION_ATTEMPTS; attempt++) {
    const row = await getAccountOverrides(db, product, subject);
    const current = parseAccountOverridePayload(row?.payload_json ?? null);
    const secrets = { ...current.secrets };
    for (const key of declared) delete secrets[key];
    Object.assign(secrets, sealed);
    if (
      await casAccountOverrides(
        db,
        product,
        subject,
        row?.payload_json ?? null,
        { config: current.config, secrets },
        "signin",
        now,
      )
    )
      return;
  }
  throw new Error(
    "account overrides changed concurrently; provisioning not applied",
  );
}
