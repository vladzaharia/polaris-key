/**
 * Personal tokens (F-33, plans/I-27.md §2.5): the `pkeyp_` credential a PERSON holds.
 *
 * WHY CORE, AND WHY NOT `registry_tokens`. One token installs every package the account may read,
 * across products. `registry_tokens` is keyed by the product that owns the feed; a person-wide
 * credential is none of a product's. The table is `account_tokens` (migration 0120), Core's:
 * the portal mints and lists from Identity, the console's account menu from the admin API, and
 * the registry host (Distribution) resolves, and none of those may import another.
 *
 * THE TOKEN. `pkeyp_` + 256 random bits. Only `hashKey(token, KEY_HASH_PEPPER)` is stored (a global
 * unique index), the same treatment as `pkeya_` and `pkeyr_`; the plaintext is returned once by
 * the mint and never logged, echoed or stored. `hint` keeps the last four characters so a person
 * can tell two tokens apart in a list, as a registry token's does.
 *
 * ONE SCOPE PER TOKEN. `scope` is a column, not a list: exclusivity is the shape. The
 * vocabulary is `packages:read` and `admin`. An `admin` token (ST-34) lives 7 days by default and
 * 30 at most, is accepted by the admin API alone (ST-34.3), is minted only through a
 * console-approved `pkey login` (ST-34.5/34.6; the portal refuses the scope), and is REVOKED, not
 * moved, by an account merge (below). A scope is refused at mint and again at use when it is not in
 * {@link PERSONAL_TOKEN_SCOPES}, so a row an older Worker wrote with a scope this one does not
 * know resolves to nothing rather than to something broader. {@link resolvePersonalToken} takes
 * the scope the CALLER accepts: the registry host asks for `packages:read` and so can never be
 * handed an `admin` token, whatever the row says.
 *
 * LIFECYCLE. Every token expires (default 90 days, at most 365 for `packages:read`). It is
 * revoked by the person, by a Superadmin (`revokeAllAccountTokens`), and by the account's erasure
 * (`stmtRevokeAccountTokens` first, then `stmtDeleteAccountTokens` in the closing batch), and dies with a restored backup's
 * erased account through the erasure fence (below). A merge moves the absorbed account's
 * `packages:read` tokens to the surviving account (`stmtMoveAccountTokens`), and its undo moves
 * the same rows back; its `admin` tokens are revoked (`stmtRevokeAccountAdminTokens`, reason
 * `access_removed`) and stay on the absorbed account, because an admin token resolves to the
 * roles of the account that holds it and must never silently take on the survivor's.
 *
 * THE ERASURE FENCE (I-11). A D1 restore can bring an erased account's unrevoked tokens back, so
 * {@link resolvePersonalToken} asks the erasure ledger before it resolves one or writes
 * `last_used_at`: an erased account's token resolves to nothing, and a ledger that cannot be
 * read resolves to nothing for that request.
 *
 * AUDIT. The mint and the revoke are audited by the caller through the account audit
 * (`portal_audit`, the portal) or the platform audit (`core/audit.ts`, the console); this module
 * writes no audit row (the audit row also records who created the token: the row itself keeps no creator). A token USE is not audited per request (a package install is dozens of
 * requests); `last_used_at` is the signal, written at most once an hour.
 */

import type { Env } from "../../platform/env.js";
import { secret } from "../../platform/env.js";
import type { Db, DbStatement } from "../../db/types.js";
import {
  hashKey,
  isPersonalToken,
  mintPersonalToken,
  randomId,
} from "../../platform/crypto.js";
import { erasureVerdict } from "./erasureFence.js";

// ── Vocabulary ───────────────────────────────────────────────────────────────────────────────

/** The one scope the registry host reads. */
export const PACKAGES_READ_SCOPE = "packages:read";

/** The admin API's scope (ST-34): never accepted by the registry host, never minted by the portal. */
export const ADMIN_SCOPE = "admin";

/** Every scope a personal token may hold. */
export const PERSONAL_TOKEN_SCOPES = [
  PACKAGES_READ_SCOPE,
  ADMIN_SCOPE,
] as const;
export type PersonalTokenScope = (typeof PERSONAL_TOKEN_SCOPES)[number];

export function isPersonalTokenScope(v: unknown): v is PersonalTokenScope {
  return (
    typeof v === "string" &&
    (PERSONAL_TOKEN_SCOPES as readonly string[]).includes(v)
  );
}

/** Lifetime, in days, per scope: the default and the ceiling (the floor is one day for all). */
export const PERSONAL_TOKEN_DAYS: Readonly<
  Record<PersonalTokenScope, { readonly default: number; readonly max: number }>
> = {
  "packages:read": { default: 90, max: 365 },
  admin: { default: 7, max: 30 },
};
export const PERSONAL_TOKEN_MIN_DAYS = 1;

/** The longest label. */
export const PERSONAL_TOKEN_LABEL_MAX = 64;

/** Live tokens one account may hold: a bound, so a minting loop is visible rather than unbounded. */
export const MAX_LIVE_PERSONAL_TOKENS = 25;

/** Rows are purged this long after they expired or were revoked. */
export const PERSONAL_TOKEN_RETENTION_SECONDS = 90 * 86_400;

/** `last_used_at` is written at most this often per token (seconds). */
const LAST_USED_GRANULARITY = 3_600;

export type PersonalTokenRevokeReason =
  | "manual"
  | "admin"
  | "account_deleted"
  | "access_removed";

// ── Rows and views ───────────────────────────────────────────────────────────────────────────

interface PersonalTokenRow {
  id: string;
  account_id: string;
  token_hash: string;
  hint: string;
  label: string;
  scope: string;
  created_at: number;
  expires_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
  revoked_by: string | null;
  revoke_reason: string | null;
}

/** One token as the portal and the console list it. Never the plaintext or the hash. */
export interface PersonalTokenView {
  readonly id: string;
  readonly label: string;
  /** The plaintext's last four characters. */
  readonly hint: string;
  readonly scope: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly lastUsedAt: number | null;
  readonly revokedAt: number | null;
  readonly revokedBy: string | null;
  readonly revokeReason: string | null;
  readonly status: "active" | "expired" | "revoked";
}

function viewOf(row: PersonalTokenRow, now: number): PersonalTokenView {
  return {
    id: row.id,
    label: row.label,
    hint: row.hint,
    scope: row.scope,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
    revokedBy: row.revoked_by,
    revokeReason: row.revoke_reason,
    status:
      row.revoked_at !== null
        ? "revoked"
        : row.expires_at <= now
          ? "expired"
          : "active",
  };
}

/** The stored hash of a presented token. */
export function hashPersonalToken(env: Env, token: string): Promise<string> {
  return hashKey(token, secret(env, "KEY_HASH_PEPPER"));
}

// ── Mint ─────────────────────────────────────────────────────────────────────────────────────

export interface MintPersonalTokenInput {
  readonly accountId: string;
  readonly label: string;
  /** Exactly one scope. */
  readonly scope: string;
  readonly expiresInDays?: number;
  /** `portal:<accountId>`, `admin:<sub>` or `console:<memberId>`. Informational: the token row keeps
   *  no `created_by` column, so the caller's audit row is the provenance record. */
  readonly createdBy: string;
}

export type MintPersonalTokenResult =
  | {
      readonly ok: true;
      /** The plaintext: shown once, never stored. */
      readonly token: string;
      readonly view: PersonalTokenView;
    }
  | {
      readonly ok: false;
      readonly status: 409 | 422;
      readonly reason: "invalid_token" | "token_limit";
      readonly message: string;
      readonly fields?: readonly string[];
    };

/**
 * Validate and mint one token: a non-empty label of at most 64 characters, one known scope, a
 * lifetime inside that scope's bounds, and at most {@link MAX_LIVE_PERSONAL_TOKENS} live tokens
 * for the account. Returns the plaintext once.
 */
export async function mintAccountToken(
  env: Env,
  db: Db,
  input: MintPersonalTokenInput,
  now: number,
): Promise<MintPersonalTokenResult> {
  const fields: string[] = [];
  const label = typeof input.label === "string" ? input.label.trim() : "";
  if (label === "" || label.length > PERSONAL_TOKEN_LABEL_MAX)
    fields.push("label");
  const scope = input.scope;
  if (!isPersonalTokenScope(scope)) fields.push("scope");
  const bounds = isPersonalTokenScope(scope)
    ? PERSONAL_TOKEN_DAYS[scope]
    : PERSONAL_TOKEN_DAYS[PACKAGES_READ_SCOPE];
  const days = input.expiresInDays ?? bounds.default;
  if (
    !Number.isSafeInteger(days) ||
    days < PERSONAL_TOKEN_MIN_DAYS ||
    days > bounds.max
  )
    fields.push("expiresInDays");
  if (fields.length || !isPersonalTokenScope(scope))
    return {
      ok: false,
      status: 422,
      reason: "invalid_token",
      message: "invalid personal token",
      fields,
    };
  const live = await db.first<{ n: number }>(
    `SELECT COUNT(*) AS n FROM account_tokens
      WHERE account_id = ? AND revoked_at IS NULL AND expires_at > ?`,
    input.accountId,
    now,
  );
  if ((live?.n ?? 0) >= MAX_LIVE_PERSONAL_TOKENS)
    return {
      ok: false,
      status: 409,
      reason: "token_limit",
      message: `at most ${MAX_LIVE_PERSONAL_TOKENS} live personal tokens per account; revoke one first`,
    };
  const token = mintPersonalToken();
  const row: PersonalTokenRow = {
    id: randomId("ptok"),
    account_id: input.accountId,
    token_hash: await hashPersonalToken(env, token),
    hint: token.slice(-4),
    label,
    scope,
    created_at: now,
    expires_at: now + days * 86_400,
    last_used_at: null,
    revoked_at: null,
    revoked_by: null,
    revoke_reason: null,
  };
  await db.run(
    `INSERT INTO account_tokens
       (id, account_id, token_hash, hint, label, scope, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    row.id,
    row.account_id,
    row.token_hash,
    row.hint,
    row.label,
    row.scope,
    row.created_at,
    row.expires_at,
  );
  return { ok: true, token, view: viewOf(row, now) };
}

// ── List and revoke ──────────────────────────────────────────────────────────────────────────

/** The account's tokens, live first and then newest, revoked and expired ones included until purged. */
export async function listAccountTokens(
  db: Db,
  accountId: string,
  now: number,
): Promise<PersonalTokenView[]> {
  const rows = await db.all<PersonalTokenRow>(
    `SELECT * FROM account_tokens WHERE account_id = ?
      ORDER BY (revoked_at IS NULL AND expires_at > ?) DESC, created_at DESC, id DESC
      LIMIT 1000`,
    accountId,
    now,
  );
  return rows.map((r) => viewOf(r, now));
}

/** One token of the account, or `null` (absent, or another account's). */
export async function getAccountToken(
  db: Db,
  accountId: string,
  id: string,
  now: number,
): Promise<PersonalTokenView | null> {
  const row = await db.first<PersonalTokenRow>(
    "SELECT * FROM account_tokens WHERE account_id = ? AND id = ?",
    accountId,
    id,
  );
  return row ? viewOf(row, now) : null;
}

/**
 * Revoke one token of `accountId`. Answers the token as it now stands (already revoked included),
 * or `null` when the account holds no such token: another account's id is a 404, not a 403.
 */
export async function revokeAccountToken(
  db: Db,
  accountId: string,
  id: string,
  by: string,
  reason: PersonalTokenRevokeReason,
  now: number,
): Promise<PersonalTokenView | null> {
  return (await revokeAccountTokenCounted(db, accountId, id, by, reason, now))
    .view;
}

/**
 * {@link revokeAccountToken}, also saying whether THIS call ended the token: of two concurrent
 * revokes of one token exactly one has `changed` true, so only that one audits.
 */
export async function revokeAccountTokenCounted(
  db: Db,
  accountId: string,
  id: string,
  by: string,
  reason: PersonalTokenRevokeReason,
  now: number,
): Promise<{ view: PersonalTokenView | null; changed: boolean }> {
  const changes = await db.runChanges(
    `UPDATE account_tokens SET revoked_at = ?, revoked_by = ?, revoke_reason = ?
      WHERE account_id = ? AND id = ? AND revoked_at IS NULL`,
    now,
    by.slice(0, 320),
    reason,
    accountId,
    id,
  );
  return {
    view: await getAccountToken(db, accountId, id, now),
    changed: changes === 1,
  };
}

/**
 * The provenance mark of a token minted for `pkey` by a Locker approval: the tail of the
 * `portal.personal_token.create` audit row's summary. The token row keeps no created_by column, so
 * this row is how a CLI-minted token is told from one the person made by hand under the same label.
 */
export const CLI_PACKAGES_TOKEN_MARK = "by pkey approved in Polaris Locker";

/**
 * F-37.1b: a new CLI `packages:read` mint replaces the account's earlier one for the same label
 * (as `pkey login` replaces its sign-in). Revokes ONLY live tokens that are all of: this
 * `accountId`'s, scope `packages:read`, exactly this `label`, not `exceptId`, and recorded by a
 * Locker CLI approval (the audit mark above) for the same account. A token the person made by
 * hand with the same label, another label, another scope or another account is never touched.
 * Answers the revoked tokens' hints.
 */
export async function revokeReplacedCliPackagesTokens(
  db: Db,
  accountId: string,
  label: string,
  exceptId: string,
  now: number,
): Promise<string[]> {
  const rows = await db.all<{ id: string; hint: string }>(
    `SELECT t.id AS id, t.hint AS hint FROM account_tokens t
      WHERE t.account_id = ? AND t.scope = ? AND t.label = ? AND t.id <> ?
        AND t.revoked_at IS NULL AND t.expires_at > ?
        AND EXISTS (
          SELECT 1 FROM portal_audit a
           WHERE a.account_id = t.account_id AND a.target_id = t.id
             AND a.action = 'portal.personal_token.create'
             AND a.target_kind = 'account_token'
             AND a.summary LIKE ?
        )`,
    accountId,
    PACKAGES_READ_SCOPE,
    label,
    exceptId,
    now,
    `%${CLI_PACKAGES_TOKEN_MARK}`,
  );
  const hints: string[] = [];
  for (const r of rows) {
    const out = await revokeAccountTokenCounted(
      db,
      accountId,
      r.id,
      `portal:${accountId}`,
      "manual",
      now,
    );
    if (out.changed) hints.push(r.hint);
  }
  return hints;
}

/** A token as a Superadmin lists it: the view plus the account's email (never its id). Never the plaintext or the hash. */
export interface PersonalTokenAdminView extends Omit<
  PersonalTokenView,
  "revokedBy"
> {
  /** The account's primary email, `null` once it is erased or has none. */
  readonly email: string | null;
}

/** The admin's view drops `revokedBy` (it names the revoking account); `revokeReason` says who. */
function adminViewOf(
  row: PersonalTokenRow & { email: string | null },
  now: number,
): PersonalTokenAdminView {
  const { revokedBy: _by, ...rest } = viewOf(row, now);
  return { ...rest, email: row.email };
}

/** The most rows the Superadmin roster returns. */
export const ADMIN_TOKEN_LIST_LIMIT = 500;

/** Every account's tokens, live first then newest, for the platform roster (F-33). */
export async function listAllAccountTokens(
  db: Db,
  now: number,
): Promise<PersonalTokenAdminView[]> {
  const rows = await db.all<PersonalTokenRow & { email: string | null }>(
    `SELECT t.*, a.primary_email AS email
       FROM account_tokens t LEFT JOIN accounts a ON a.id = t.account_id
      ORDER BY (t.revoked_at IS NULL AND t.expires_at > ?) DESC, t.created_at DESC, t.id DESC
      LIMIT ${ADMIN_TOKEN_LIST_LIMIT}`,
    now,
  );
  return rows.map((r) => adminViewOf(r, now));
}

/**
 * A Superadmin revokes one token of any account (reason `admin`). Answers the token as it now
 * stands, or `null` when no such token exists. Revoking a revoked token answers it as it stands.
 */
export async function revokeAccountTokenAsAdmin(
  db: Db,
  id: string,
  by: string,
  now: number,
): Promise<PersonalTokenAdminView | null> {
  await db.run(
    `UPDATE account_tokens SET revoked_at = ?, revoked_by = ?, revoke_reason = 'admin'
      WHERE id = ? AND revoked_at IS NULL`,
    now,
    by.slice(0, 320),
    id,
  );
  const row = await db.first<PersonalTokenRow & { email: string | null }>(
    `SELECT t.*, a.primary_email AS email
       FROM account_tokens t LEFT JOIN accounts a ON a.id = t.account_id WHERE t.id = ?`,
    id,
  );
  return row ? adminViewOf(row, now) : null;
}

/**
 * Revoke every live token of the account; answers how many. With `scope`, only the tokens of that
 * scope end (ST-34.12: sign-out ends the `admin` tokens and leaves the `packages` ones).
 */
export async function revokeAllAccountTokens(
  db: Db,
  accountId: string,
  by: string,
  reason: PersonalTokenRevokeReason,
  now: number,
  scope?: PersonalTokenScope,
): Promise<number> {
  return db.runChanges(
    `UPDATE account_tokens SET revoked_at = ?, revoked_by = ?, revoke_reason = ?
      WHERE account_id = ? AND revoked_at IS NULL AND (? IS NULL OR scope = ?)`,
    now,
    by.slice(0, 320),
    reason,
    accountId,
    scope ?? null,
    scope ?? null,
  );
}

/**
 * The first step of an erasure: the account's tokens stop authenticating now, not at the commit.
 * A statement, so the erasure batch stays atomic; the closing batch then deletes them
 * ({@link stmtDeleteAccountTokens}).
 */
export function stmtRevokeAccountTokens(
  accountId: string,
  now: number,
): DbStatement {
  return {
    sql: `UPDATE account_tokens
             SET revoked_at = ?, revoked_by = ?, revoke_reason = 'account_deleted'
           WHERE account_id = ? AND revoked_at IS NULL`,
    params: [now, `portal:${accountId}`, accountId],
  };
}

/**
 * The erasure's closing batch: the account's tokens are DELETED, not left revoked. A label is
 * text the person chose and may name them, and nothing needs it once the account is gone.
 */
export function stmtDeleteAccountTokens(accountId: string): DbStatement {
  return {
    sql: "DELETE FROM account_tokens WHERE account_id = ?",
    params: [accountId],
  };
}

/**
 * The merge: the absorbed account's non-admin tokens become the survivor's. An `admin` row never
 * moves ({@link stmtRevokeAccountAdminTokens} runs first in the same batch).
 */
export function stmtMoveAccountTokens(
  fromAccountId: string,
  toAccountId: string,
): DbStatement {
  return {
    sql: `UPDATE account_tokens SET account_id = ?
           WHERE account_id = ? AND scope <> '${ADMIN_SCOPE}'`,
    params: [toAccountId, fromAccountId],
  };
}

/**
 * The merge: the absorbed account's live `admin` tokens stop authenticating (reason
 * `access_removed`) and stay on that account (ST-34 D-12). A statement, so the merge batch stays
 * atomic.
 */
export function stmtRevokeAccountAdminTokens(
  accountId: string,
  now: number,
  by: string,
): DbStatement {
  return {
    sql: `UPDATE account_tokens
             SET revoked_at = ?, revoked_by = ?, revoke_reason = 'access_removed'
           WHERE account_id = ? AND scope = '${ADMIN_SCOPE}' AND revoked_at IS NULL`,
    params: [now, by.slice(0, 320), accountId],
  };
}

/** The ids of the account's tokens that a merge moves (never `admin`), so its undo moves exactly these back. */
export async function accountTokenIds(
  db: Db,
  accountId: string,
): Promise<string[]> {
  const rows = await db.all<{ id: string }>(
    `SELECT id FROM account_tokens WHERE account_id = ? AND scope <> '${ADMIN_SCOPE}'`,
    accountId,
  );
  return rows.map((r) => r.id);
}

/** The merge's undo: put the snapshotted tokens back, only those still on the survivor. */
export function stmtRestoreAccountTokens(
  ids: readonly string[],
  fromAccountId: string,
  toAccountId: string,
): DbStatement {
  return {
    sql: `UPDATE account_tokens SET account_id = ?
           WHERE account_id = ? AND id IN (SELECT value FROM json_each(?))`,
    params: [toAccountId, fromAccountId, JSON.stringify(ids)],
  };
}

/** Retention (the nightly cron): rows 90 days past their expiry or revocation go. */
export async function purgeAccountTokens(db: Db, now: number): Promise<number> {
  const cutoff = now - PERSONAL_TOKEN_RETENTION_SECONDS;
  try {
    return await db.runChanges(
      `DELETE FROM account_tokens
        WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)`,
      cutoff,
      cutoff,
    );
  } catch (err) {
    if (err instanceof Error && /no such table/i.test(err.message)) return 0;
    throw err;
  }
}

// ── Resolution ───────────────────────────────────────────────────────────────────────────────

/** Options of the resolvers. */
export interface PersonalResolveOpts {
  waitUntil?: (p: Promise<unknown>) => void;
  /**
   * `false`: do not write `last_used_at`. The admin API passes it and calls
   * {@link touchPersonalToken} once the request has cleared every gate, so a refused request
   * (wrong route, no reach) leaves no mark.
   */
  touch?: boolean;
}

function stmtTouch(db: Db, id: string, now: number): Promise<unknown> {
  return db
    .run(
      `UPDATE account_tokens SET last_used_at = ?
        WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)`,
      now,
      id,
      now - LAST_USED_GRANULARITY,
    )
    .catch(() => undefined);
}

/**
 * Record a use (at most hourly per token). For a caller that resolved with `touch: false`.
 * `lastUsedAt` is the token view's: when it is already fresh there is no write at all.
 */
export async function touchPersonalToken(
  db: Db,
  id: string,
  now: number,
  lastUsedAt?: number | null,
): Promise<void> {
  if (
    typeof lastUsedAt === "number" &&
    lastUsedAt >= now - LAST_USED_GRANULARITY
  )
    return;
  await stmtTouch(db, id, now);
}

/** Who a presented personal token is. */
export interface ResolvedPersonalToken {
  readonly accountId: string;
  readonly tokenId: string;
  readonly scope: PersonalTokenScope;
}

/**
 * Resolve a presented `pkeyp_` token, accepting ONLY the scope the caller names: a token of any
 * other scope, a malformed, unknown, expired or revoked one, and one whose account is on the
 * erasure ledger (or whose ledger cannot be read) resolve to `null`. The caller sees no reason,
 * so the refusal reveals nothing about which check failed.
 *
 * Shape first (cheap, and what makes "a foreign credential is refused" a property of the code),
 * then hash and lookup, then the lifecycle and the fence. `last_used_at` is written only once
 * every check has passed, and at most hourly per token.
 */
export async function resolvePersonalToken(
  env: Env,
  db: Db,
  presented: string,
  accepts: PersonalTokenScope,
  now: number,
  opts: PersonalResolveOpts = {},
): Promise<ResolvedPersonalToken | null> {
  if (!isPersonalToken(presented)) return null;
  const hash = await hashPersonalToken(env, presented);
  return resolveRow(env, db, "token_hash = ?", hash, accepts, now, opts);
}

/**
 * Re-resolve a token by its id (an OCI pull token's subject): the same checks as
 * {@link resolvePersonalToken}, for a caller that holds the id and not the plaintext.
 */
export function resolvePersonalTokenById(
  env: Env,
  db: Db,
  id: string,
  accepts: PersonalTokenScope,
  now: number,
  opts: PersonalResolveOpts = {},
): Promise<ResolvedPersonalToken | null> {
  return resolveRow(env, db, "id = ?", id, accepts, now, opts);
}

async function resolveRow(
  env: Env,
  db: Db,
  where: "token_hash = ?" | "id = ?",
  key: string,
  accepts: PersonalTokenScope,
  now: number,
  opts: PersonalResolveOpts,
): Promise<ResolvedPersonalToken | null> {
  let row: PersonalTokenRow | null;
  try {
    row = await db.first<PersonalTokenRow>(
      `SELECT * FROM account_tokens
        WHERE ${where} AND revoked_at IS NULL AND expires_at > ?`,
      key,
      now,
    );
  } catch (err) {
    if (err instanceof Error && /no such table/i.test(err.message)) return null;
    throw err;
  }
  if (!row) return null;
  if (!isPersonalTokenScope(row.scope) || row.scope !== accepts) return null;
  if ((await erasureVerdict(env, now, row.account_id)) !== "clear") return null;
  if (
    opts.touch !== false &&
    (row.last_used_at === null ||
      row.last_used_at < now - LAST_USED_GRANULARITY)
  ) {
    const write = stmtTouch(db, row.id, now);
    if (opts.waitUntil) opts.waitUntil(write);
    else await write;
  }
  return { accountId: row.account_id, tokenId: row.id, scope: row.scope };
}
