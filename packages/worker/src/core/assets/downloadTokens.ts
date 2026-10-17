/**
 * Single-use download tokens (`release_download_tokens`): the credential the customer portal
 * hands a signed-in person for one file, redeemed at `/download/<token>`.
 *
 * Core owns the table (P0-23). The portal (Identity) used to write it and read Release's
 * `release_metadata` / `release_artifacts` next to it; the token is generic substrate (a hash, a
 * product, a release and file id, an expiry), so it lives here and every service reaches it
 * through this module. What a token MEANS for a file (its bytes, its access) is still read from
 * Release and Distribution through their hooks at redemption.
 */

import { hashKey, mintOpaqueToken } from "../../platform/crypto.js";
import type { Db } from "../../db/types.js";
import type { Env } from "../../platform/env.js";

export interface DownloadTokenRow {
  product: string;
  token_hash: string;
  release_id: string;
  artifact_id: string | null;
  scope_json: string | null;
  expires_at: number;
  used_at: number | null;
  created_at: number;
}

/** How long a minted token lives, in seconds. */
const DOWNLOAD_TOKEN_TTL_SECONDS = 300;

/** Mint a token for one file; `scope` is stored as JSON (the portal records its account). */
export async function mintDownloadToken(
  env: Env,
  db: Db,
  input: {
    product: string;
    releaseId: string;
    artifactId: string;
    scope: Record<string, unknown>;
    now: number;
  },
): Promise<string> {
  const token = mintOpaqueToken();
  const tokenHash = await hashKey(token, env.KEY_HASH_PEPPER);
  await db.run(
    // R11-13: `customer_id` went with the dead `customers` table (0016_drop_dead_pii) — it was
    // always written as a literal NULL and read nowhere.
    `INSERT INTO release_download_tokens
       (product, token_hash, release_id, artifact_id, device_id,
        scope_json, expires_at, used_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    input.product,
    tokenHash,
    input.releaseId,
    input.artifactId,
    null,
    JSON.stringify(input.scope),
    input.now + DOWNLOAD_TOKEN_TTL_SECONDS,
    null,
    input.now,
  );
  return token;
}

/**
 * Resolve a `/download/<token>` bearer to its row.
 *
 * R5-10 / R11-12: the PRIMARY KEY is `(product, token_hash)`, so a bare `token_hash` predicate
 * was neither unique — two products could hold the same hash and `db.first` picked one
 * arbitrarily, which then became the authorization SCOPE for every downstream check — nor
 * indexed: R11-05 measured `SCAN release_download_tokens` on an unauthenticated, unrate-limited
 * endpoint backed by a table that only ever grew. This route has no product in its URL, so the
 * predicate cannot be product-scoped; `idx_release_download_tokens_hash` (0015) instead makes
 * the hash GLOBALLY unique, which is the real invariant (it is a 256-bit secret) and turns the
 * lookup into a single-row index SEARCH. The unexpired/unused predicates are pushed into SQL
 * so an expired or spent token is never even returned to the caller.
 */
export async function readDownloadToken(
  env: Env,
  db: Db,
  token: string,
  now: number,
): Promise<DownloadTokenRow | null> {
  const tokenHash = await hashKey(token, env.KEY_HASH_PEPPER);
  return db.first<DownloadTokenRow>(
    `SELECT * FROM release_download_tokens
      WHERE token_hash = ? AND expires_at > ? AND used_at IS NULL`,
    tokenHash,
    now,
  );
}

/**
 * Spend a single-use download token. Returns false when it was already spent.
 *
 * R9-05b / R11-05: the read and this UPDATE sat ~6 awaits apart with no `used_at IS NULL`
 * predicate, so two concurrent redemptions of the same token both read `used_at = null`, both
 * passed, and both got the redirect — "single-use" was advisory. The predicate moves the
 * decision into the statement: exactly one caller sees `changes === 1`.
 */
export async function spendDownloadToken(
  db: Db,
  product: string,
  tokenHash: string,
  now: number,
): Promise<boolean> {
  const changes = await db.runChanges(
    `UPDATE release_download_tokens
        SET used_at = ?
      WHERE product = ? AND token_hash = ? AND used_at IS NULL`,
    now,
    product,
    tokenHash,
  );
  return changes > 0;
}

/**
 * Product-scoped retention, run by the nightly sweep (Identity's maintenance contribution, once
 * per product, in a `drain` loop). Returns how many rows were removed.
 *
 * Nothing else deletes from this table, and nothing on a request path may: the portal download
 * route is unauthenticated, and a delete issued from it would be a stranger-triggered write that
 * names no product. Every statement here names one.
 *
 * Two statements, not one `OR`, because they want different indexes. The expiry pass rides
 * `idx_release_download_tokens_expiry(product, expires_at)`; the spent pass is a short scan of
 * what the first pass left behind, which by construction is only this product's still-live
 * tokens (a 300-second TTL). Both are bounded by `limit`, so neither can turn into an unbounded
 * delete inside a single cron invocation.
 *
 * The returned count is the sum of the two, so up to `2 * limit`. A caller that loops until a
 * pass comes back short of `limit` (`drain`) stops correctly on that sum: a sum below `limit`
 * means both passes were short, and a sum at or above it costs at most one confirming pass.
 *
 * A spent token is deleted before it expires on purpose: `spendDownloadToken` is the
 * single-use gate, so a row with `used_at` set can never authorize another download — retaining
 * it buys nothing and keeps a row naming an account, a product and an artifact.
 */
export async function purgeDownloadTokens(
  db: Db,
  product: string,
  now: number,
  limit = 500,
): Promise<number> {
  const expired = await db.runChanges(
    `DELETE FROM release_download_tokens
      WHERE rowid IN (
        SELECT rowid FROM release_download_tokens
         WHERE product = ? AND expires_at < ? LIMIT ?
      )`,
    product,
    now,
    limit,
  );
  const spent = await db.runChanges(
    `DELETE FROM release_download_tokens
      WHERE rowid IN (
        SELECT rowid FROM release_download_tokens
         WHERE product = ? AND used_at IS NOT NULL LIMIT ?
      )`,
    product,
    limit,
  );
  return expired + spent;
}
