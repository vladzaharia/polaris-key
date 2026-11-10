/**
 * Issuer refresh tokens (I-21.2; V5 §12.13.7; threat IS-5).
 *
 * A token is `pkeyo_` + 43 base64url characters, returned once and stored only as
 * `hashKey("refresh:" + token, KEY_HASH_PEPPER)` in `identity_refresh_tokens`. Tokens form
 * families: a code redemption opens one (`issueRefreshFamily`), every use rotates it
 * (`rotateRefreshToken`) and a spent token presented again revokes the whole family with no
 * grace. A token ends 30 days after its last use and a family 90 days after it opened. At most
 * 10 families stay live per (account, client); an eleventh revokes the oldest.
 *
 * Rotation is one conditional batch: the presented row is spent only while unspent and unrevoked,
 * and the new row is written only when that spend (carrying this call's `replaced_by`) happened. A
 * lost race therefore changes nothing and is treated as reuse. The caller (I-21.10) re-checks the
 * client, grant, toggles and account on every use and audits `identity.refresh.reuse`.
 */

import {
  ISSUER_REFRESH_IDLE_SECONDS,
  ISSUER_REFRESH_MAX_SECONDS,
  MAX_REFRESH_FAMILIES,
} from "@polaris-key/protocol/identity";
import type { Db, DbStatement } from "../../../db/types.js";
import { batchCounts } from "../../../db/batch.js";
import type { Env } from "../../../platform/env.js";
import { hashKey, randomId } from "../../../platform/crypto.js";
import { randomToken } from "../../../platform/random.js";

const HASH_DOMAIN = "refresh:";
/** Refresh rows are deleted this long after their family ended (30 days). */
export const REFRESH_PURGE_SECONDS = 30 * 86_400;

export const mintRefreshToken = (): string => `pkeyo_${randomToken(32)}`;

export const hashRefreshToken = (env: Env, token: string): Promise<string> =>
  hashKey(HASH_DOMAIN + token, env.KEY_HASH_PEPPER);

export interface RefreshGrantFields {
  product: string;
  clientId: string;
  accountId: string;
  scope: string;
  claims: string[];
  authTime: number;
}

export interface RefreshRow extends RefreshGrantFields {
  tokenHash: string;
  familyId: string;
  familyStartedAt: number;
  createdAt: number;
  lastUsedAt: number;
  spentAt: number | null;
  replacedBy: string | null;
  revokedAt: number | null;
}

interface Row {
  token_hash: string;
  family_id: string;
  product: string;
  client_id: string;
  account_id: string;
  scope: string;
  claims_json: string;
  auth_time: number;
  family_started_at: number;
  created_at: number;
  last_used_at: number;
  spent_at: number | null;
  replaced_by: string | null;
  revoked_at: number | null;
}

const toRow = (r: Row): RefreshRow => ({
  tokenHash: r.token_hash,
  familyId: r.family_id,
  product: r.product,
  clientId: r.client_id,
  accountId: r.account_id,
  scope: r.scope,
  claims: JSON.parse(r.claims_json) as string[],
  authTime: r.auth_time,
  familyStartedAt: r.family_started_at,
  createdAt: r.created_at,
  lastUsedAt: r.last_used_at,
  spentAt: r.spent_at,
  replacedBy: r.replaced_by,
  revokedAt: r.revoked_at,
});

/** Has the token (or its family) run out by idle time or by the absolute cap? */
export function refreshEnded(r: RefreshRow, now: number): boolean {
  return (
    now >= r.lastUsedAt + ISSUER_REFRESH_IDLE_SECONDS ||
    now >= r.familyStartedAt + ISSUER_REFRESH_MAX_SECONDS
  );
}

function insertStatement(
  h: string,
  family: string,
  f: RefreshGrantFields,
  familyStartedAt: number,
  now: number,
): DbStatement {
  return {
    sql: `INSERT INTO identity_refresh_tokens
            (token_hash, family_id, product, client_id, account_id, scope, claims_json, auth_time,
             family_started_at, created_at, last_used_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    params: [
      h,
      family,
      f.product,
      f.clientId,
      f.accountId,
      f.scope,
      JSON.stringify(f.claims),
      f.authTime,
      familyStartedAt,
      now,
      now,
    ],
  };
}

/** Open a family at code redemption. Returns the token, shown once. Trims past 10 live families. */
export async function issueRefreshFamily(
  env: Env,
  db: Db,
  f: RefreshGrantFields,
  now: number,
): Promise<{ token: string; familyId: string }> {
  const token = mintRefreshToken();
  const familyId = randomId("rf");
  const stmt = insertStatement(
    await hashRefreshToken(env, token),
    familyId,
    f,
    now,
    now,
  );
  await db.run(stmt.sql, ...stmt.params);
  // The oldest live families beyond the cap are revoked (a live family has an unspent, unrevoked,
  // unended token).
  const live = await db.all<{ family_id: string }>(
    `SELECT family_id FROM identity_refresh_tokens
      WHERE product = ? AND account_id = ? AND client_id = ?
        AND spent_at IS NULL AND revoked_at IS NULL
        AND last_used_at + ? > ? AND family_started_at + ? > ?
      ORDER BY family_started_at DESC, family_id`,
    f.product,
    f.accountId,
    f.clientId,
    ISSUER_REFRESH_IDLE_SECONDS,
    now,
    ISSUER_REFRESH_MAX_SECONDS,
    now,
  );
  for (const old of live.slice(MAX_REFRESH_FAMILIES))
    await revokeRefreshFamily(db, f.product, old.family_id, now);
  return { token, familyId };
}

/** The row of a presented token of this product, or `null`. Reads only; never spends it. */
export async function findRefreshToken(
  env: Env,
  db: Db,
  product: string,
  token: string,
): Promise<RefreshRow | null> {
  const r = await db.first<Row>(
    `SELECT * FROM identity_refresh_tokens WHERE token_hash = ? AND product = ?`,
    await hashRefreshToken(env, token),
    product,
  );
  return r ? toRow(r) : null;
}

export type RotateResult =
  | {
      ok: true;
      /** The new token, shown once. */
      token: string;
      /** What the family was issued for; `scope` is the new (possibly narrowed) one. */
      row: RefreshRow;
    }
  | {
      ok: false;
      reason: "invalid" | "wrong_client" | "expired" | "reuse";
      /** For `reuse`: the family that was just revoked, for the audit row. */
      familyId?: string;
      accountId?: string;
    };

/**
 * Spend `token` and issue its successor. `invalid`: unknown, another product's, or revoked.
 * `wrong_client`: another client's token (nothing changes). `expired`: past the idle or absolute
 * cap (nothing changes). `reuse`: already spent, or a race lost: the family is revoked.
 * `scope` may narrow the family's scope; the caller checks it is a subset.
 */
export async function rotateRefreshToken(
  env: Env,
  db: Db,
  input: { product: string; clientId: string; token: string; scope?: string },
  now: number,
): Promise<RotateResult> {
  const row = await findRefreshToken(env, db, input.product, input.token);
  if (!row || row.revokedAt !== null) return { ok: false, reason: "invalid" };
  if (row.clientId !== input.clientId)
    return { ok: false, reason: "wrong_client" };
  const reuse = async (): Promise<RotateResult> => {
    await revokeRefreshFamily(db, row.product, row.familyId, now);
    return {
      ok: false,
      reason: "reuse",
      familyId: row.familyId,
      accountId: row.accountId,
    };
  };
  if (row.spentAt !== null) return reuse();
  if (refreshEnded(row, now)) return { ok: false, reason: "expired" };

  const token = mintRefreshToken();
  const next = await hashRefreshToken(env, token);
  const scope = input.scope ?? row.scope;
  const counts = await batchCounts(db, [
    {
      sql: `UPDATE identity_refresh_tokens SET spent_at = ?, replaced_by = ?
            WHERE token_hash = ? AND spent_at IS NULL AND revoked_at IS NULL`,
      params: [now, next, row.tokenHash],
    },
    {
      sql: `INSERT INTO identity_refresh_tokens
              (token_hash, family_id, product, client_id, account_id, scope, claims_json,
               auth_time, family_started_at, created_at, last_used_at)
            SELECT ?, family_id, product, client_id, account_id, ?, claims_json, auth_time,
                   family_started_at, ?, ?
              FROM identity_refresh_tokens
             WHERE token_hash = ? AND spent_at = ? AND replaced_by = ?`,
      params: [next, scope, now, now, row.tokenHash, now, next],
    },
  ]);
  if (counts[0] !== 1 || counts[1] !== 1) return reuse();
  return {
    ok: true,
    token,
    row: { ...row, tokenHash: next, scope, createdAt: now, lastUsedAt: now },
  };
}

export async function revokeRefreshFamily(
  db: Db,
  product: string,
  familyId: string,
  now: number,
): Promise<number> {
  return db.runChanges(
    `UPDATE identity_refresh_tokens SET revoked_at = ?
     WHERE product = ? AND family_id = ? AND revoked_at IS NULL`,
    now,
    product,
    familyId,
  );
}

/** Revoke every family of a client (disable, delete). */
export function revokeClientRefresh(
  db: Db,
  product: string,
  clientId: string,
  now: number,
): Promise<number> {
  return db.runChanges(
    `UPDATE identity_refresh_tokens SET revoked_at = ?
     WHERE product = ? AND client_id = ? AND revoked_at IS NULL`,
    now,
    product,
    clientId,
  );
}

/** Revoke every family of the product (Identity or the issuer turned off). */
export function revokeProductRefresh(
  db: Db,
  product: string,
  now: number,
): Promise<number> {
  return db.runChanges(
    `UPDATE identity_refresh_tokens SET revoked_at = ? WHERE product = ? AND revoked_at IS NULL`,
    now,
    product,
  );
}

/**
 * One bounded pass: rows whose family ended 30 days ago (revoked, past the 90-day cap, or an
 * unspent token idle for 30 days). Returns the number deleted, for `rec.drain`.
 */
export function purgeRefreshTokens(
  db: Db,
  product: string,
  now: number,
  limit = 500,
): Promise<number> {
  const cutoff = now - REFRESH_PURGE_SECONDS;
  return db.runChanges(
    `DELETE FROM identity_refresh_tokens WHERE rowid IN (
       SELECT rowid FROM identity_refresh_tokens
        WHERE product = ?
          AND (revoked_at <= ?
               OR family_started_at + ? <= ?
               OR (spent_at IS NULL AND last_used_at + ? <= ?))
        LIMIT ?)`,
    product,
    cutoff,
    ISSUER_REFRESH_MAX_SECONDS,
    cutoff,
    ISSUER_REFRESH_IDLE_SECONDS,
    cutoff,
    limit,
  );
}
