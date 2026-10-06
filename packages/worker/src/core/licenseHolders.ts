/**
 * Licence holders (LX-26; notes/S-24 §5, §6.1, §7, decisions D1–D4 and D19): whether a licence is
 * floating or assigned, the auto-attach blocks that keep a removed licence out of an account, and
 * the account-email hook through which an assigned licence joins the account that verified its
 * email.
 *
 * ── TWO STATES, DERIVED (D1) ────────────────────────────────────────────────────────────────
 *
 * A licence is **floating** (no account and no email: whoever holds the key uses it) or
 * **assigned** (it has an account, or an email that becomes one the first time an account verifies
 * it; "waiting" is assigned without an account yet). Nothing is stored: `licenseHolder` reads
 * `licenses.account_id` and `licenses.email` through the one rule in `accountSubjects.ts`
 * (`isFloatingLicense`), so a read, a list filter and Cloud Sync's principal never disagree. The
 * `email` a holder carries is the licence's own, which the developer wrote; never the account's
 * (S-24 D6, §7.3).
 *
 * ── THE AUTO-ATTACH BLOCK (D19) ─────────────────────────────────────────────────────────────
 *
 * Association by email is automatic, so a person who removes an email-bearing licence from their
 * library would get it back on the next sweep (S-24 H5). `license_auto_attach_blocks` (Core's
 * table, migrations `0092_license_auto_attach_blocks.sql`) records "never attach this licence to
 * this account automatically again". Every AUTOMATIC attach skips a blocked pair: the portal's
 * link sweep (both its email and its OIDC-subject halves), the email hook below and the
 * association at creation. An explicit act still works: the person adding the key, or a developer
 * moving the licence back (a reassignment's undo); either clears the block. Another account that
 * verifies the email is not blocked.
 *
 * ── THE HOOK ────────────────────────────────────────────────────────────────────────────────
 *
 * `onAccountEmailVerified(db, accountId, email, now)` is the one entry point for "this account has
 * just verified this address": it attaches every licence waiting on that address (unattached, on
 * a product whose auto-link resolves on, not blocked for the account). `associateLicenseHolder`
 * is the other direction, for a licence that has just been given an email (created with one, or
 * assigned by PATCH): it joins the account that verified that address, if one did.
 *
 * Both are implemented by Identity, which owns the account tables, the auto-link setting
 * (R5-01) and `portal_audit`, and which registers them once at module load
 * (`services/identity/accounts/holders.ts`), the way a subject store registers in
 * `subjectHooks.ts`. Core holds only the contract, so License (the creation path) and any later
 * caller reach them without importing Identity (AGENTS.md rule 6). With nothing registered both
 * answer "nothing attached": the licence simply waits, which is safe (it fails towards no
 * association, never towards a wrong one).
 */

import type { Db, DbStatement } from "../db/types.js";
import type { Env } from "../env.js";
import {
  floatingLicenseSql,
  isFloatingLicense,
  licenseEmail,
  type LicenseHolderFacts,
} from "./accountSubjects.js";

// ── Floating or assigned ─────────────────────────────────────────────────────────────────────

/**
 * A licence's holder as every licence read reports it (S-24 §6.1). `inAccount` says whether the
 * licence has joined an account; `email`, when present, is the licence's own.
 */
export type LicenseHolder =
  | { kind: "floating" }
  | { kind: "assigned"; inAccount: boolean; email?: string };

/** The derived holder of a licence row (D1: no column). */
export function licenseHolder(licence: LicenseHolderFacts): LicenseHolder {
  if (isFloatingLicense(licence)) return { kind: "floating" };
  const email = licenseEmail(licence);
  return {
    kind: "assigned",
    inAccount: (licence.account_id ?? null) !== null,
    ...(email !== null ? { email } : {}),
  };
}

/** One line for an audit summary: `floating`, `assigned, waiting` or `assigned, in an account`. */
export function describeHolder(holder: LicenseHolder): string {
  if (holder.kind === "floating") return "floating";
  return holder.inAccount ? "assigned, in an account" : "assigned, waiting";
}

/**
 * The licence list's `holder` filter (`GET …/license/licenses?holder=`): `floating`, `assigned`
 * (in an account or waiting), `waiting` (assigned, no account yet) and `inAccount` (the console's
 * "In an account", LX-30).
 */
export const HOLDER_FILTERS = [
  "floating",
  "assigned",
  "waiting",
  "inAccount",
] as const;
export type HolderFilter = (typeof HOLDER_FILTERS)[number];

export function isHolderFilter(value: string): value is HolderFilter {
  return (HOLDER_FILTERS as readonly string[]).includes(value);
}

/** The filter as a SQL predicate over the `licenses` row aliased `alias`. */
export function holderFilterSql(filter: HolderFilter, alias: string): string {
  const floating = floatingLicenseSql(alias);
  switch (filter) {
    case "floating":
      return floating;
    case "assigned":
      return `NOT ${floating}`;
    case "waiting":
      return `(${alias}.account_id IS NULL AND NOT ${floating})`;
    case "inAccount":
      return `${alias}.account_id IS NOT NULL`;
  }
}

// ── The auto-attach blocks (D19) ─────────────────────────────────────────────────────────────

/**
 * "This licence is not blocked for the account bound to the next `?`", as a SQL predicate over the
 * `licenses` row aliased `alias`. The caller binds ONE parameter, the account id, where the
 * fragment sits.
 */
export function notAutoAttachBlockedSql(alias: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(alias)) {
    throw new Error("notAutoAttachBlockedSql: bad table alias");
  }
  return `NOT EXISTS (SELECT 1 FROM license_auto_attach_blocks b
     WHERE b.product = ${alias}.product AND b.license_id = ${alias}.id AND b.account_id = ?)`;
}

/** Is automatic attach of this licence to this account blocked? */
export async function autoAttachBlocked(
  db: Db,
  product: string,
  licenseId: string,
  accountId: string,
): Promise<boolean> {
  const row = await db.first<{ one: number }>(
    `SELECT 1 AS one FROM license_auto_attach_blocks
      WHERE product = ? AND license_id = ? AND account_id = ?`,
    product,
    licenseId,
    accountId,
  );
  return row !== null;
}

/** Block automatic attach of the licence to the account (idempotent; the newest time wins). */
export function stmtBlockAutoAttach(
  product: string,
  licenseId: string,
  accountId: string,
  now: number,
): DbStatement {
  return {
    sql: `INSERT OR REPLACE INTO license_auto_attach_blocks
            (product, license_id, account_id, created_at)
          VALUES (?, ?, ?, ?)`,
    params: [product, licenseId, accountId, now],
  };
}

/** Lift the block: the licence moved back into that account by an explicit act. */
export function stmtUnblockAutoAttach(
  product: string,
  licenseId: string,
  accountId: string,
): DbStatement {
  return {
    sql: `DELETE FROM license_auto_attach_blocks
           WHERE product = ? AND license_id = ? AND account_id = ?`,
    params: [product, licenseId, accountId],
  };
}

/** Run one statement (the block writes outside a batch). */
export async function runBlockStatement(
  db: Db,
  stmt: DbStatement,
): Promise<number> {
  return db.runChanges(stmt.sql, ...stmt.params);
}

/**
 * A merge: the absorbed account's blocks become the survivor's, in the merge batch. A pair the
 * survivor already blocks keeps the survivor's row.
 */
export function stmtsMoveAccountAutoAttachBlocks(
  from: string,
  to: string,
): DbStatement[] {
  return [
    {
      sql: `INSERT OR IGNORE INTO license_auto_attach_blocks
              (product, license_id, account_id, created_at)
            SELECT product, license_id, ?, created_at
              FROM license_auto_attach_blocks WHERE account_id = ?`,
      params: [to, from],
    },
    {
      sql: "DELETE FROM license_auto_attach_blocks WHERE account_id = ?",
      params: [from],
    },
  ];
}

/** An account deletion: its blocks go with it, in the deletion batch. */
export function stmtDeleteAccountAutoAttachBlocks(
  accountId: string,
): DbStatement {
  return {
    sql: "DELETE FROM license_auto_attach_blocks WHERE account_id = ?",
    params: [accountId],
  };
}

// ── The hook ─────────────────────────────────────────────────────────────────────────────────

/** What the creation-time association needs: the notice path of an attach reads `env`. */
export interface LicenseHolderContext {
  db: Db;
  env: Env;
  now: number;
  /** The portal origin a notice links to. */
  origin: string;
}

/** Identity's implementation of the two association directions. */
export interface LicenseHolderHooks {
  /**
   * The account has verified `email` (it is one of `verifiedAccountEmails`): attach every licence
   * waiting on it that may join this account. Answers how many joined. An address the account has
   * not verified attaches nothing.
   */
  accountEmailVerified(
    db: Db,
    args: { accountId: string; email: string; now: number },
  ): Promise<number>;
  /**
   * The licence has just been given an email: if an account verified that address, the licence
   * is not in an account, the product's auto-link resolves on and the pair is not blocked, attach
   * it (`via: "email"`). The account lookup runs whenever the licence has an email, whatever the
   * outcome, so the answer's timing does not tell an operator whether the address has an account
   * (D4). Answers whether it attached.
   */
  licenseEmailAssigned(
    ctx: LicenseHolderContext,
    args: { product: string; licenseId: string },
  ): Promise<boolean>;
}

let HOOKS: LicenseHolderHooks | null = null;

/** Identity registers once, at module load. A second registration is a programming error. */
export function registerLicenseHolderHooks(hooks: LicenseHolderHooks): void {
  if (HOOKS) throw new Error("licence holder hooks are already registered");
  HOOKS = hooks;
}

/** Whether Identity's implementation is registered (the guard test asserts it is, at the root). */
export function licenseHolderHooksRegistered(): boolean {
  return HOOKS !== null;
}

/**
 * THE account-email hook (S-24 §5.4): call it wherever an address becomes verified on an
 * account. It runs the email half of the portal's link sweep for that one address. Answers how
 * many licences joined (0 when nothing is registered).
 */
export async function onAccountEmailVerified(
  db: Db,
  accountId: string,
  email: string,
  now: number,
): Promise<number> {
  return HOOKS ? HOOKS.accountEmailVerified(db, { accountId, email, now }) : 0;
}

/**
 * Association at creation or assignment (S-24 D3): the licence joins the account that verified its
 * email, when one did. Answers whether it attached (false when nothing is registered). The caller
 * answers the same `holder` shape either way (D4).
 */
export async function associateLicenseHolder(
  ctx: LicenseHolderContext,
  product: string,
  licenseId: string,
): Promise<boolean> {
  return HOOKS
    ? HOOKS.licenseEmailAssigned(ctx, { product, licenseId })
    : false;
}
