/**
 * Client grants (I-21.2; V5 §12.13.3, §12.13.7): one person's decision for one registered client,
 * keyed `(account_id, client_id)` in `identity_client_grants`. Identity's table. Whether a grant
 * COVERS a request is I-21.8's rule (`scopeHash`); this file stores and reads the decision, and
 * ends it on Disconnect together with the client's refresh families for that account.
 *
 * `putClientGrant` does not check the client: I-21.8 looks it up with
 * `getActiveClient(product, …)` first.
 */

import type { IssuerClaim } from "@polaris-key/protocol/identity";
import type { Db, DbStatement } from "../../../db/types.js";
import { batchCounts } from "../../../db/batch.js";

export interface ClientGrant {
  accountId: string;
  clientId: string;
  product: string;
  /** Optional claims the person granted. */
  claimsGranted: IssuerClaim[];
  /** Optional claims the person declined: not asked again. */
  claimsDeclined: IssuerClaim[];
  /** The `pkey:*` and `offline_access` scopes the grant holds. */
  scopes: string[];
  scopeHash: string;
  grantedAt: number;
  changedAt: number;
  lastUsedAt: number | null;
}

interface Row {
  account_id: string;
  client_id: string;
  product: string;
  claims_granted_json: string;
  claims_declined_json: string;
  scopes_json: string;
  scope_hash: string;
  granted_at: number;
  changed_at: number;
  last_used_at: number | null;
}

const toGrant = (r: Row): ClientGrant => ({
  accountId: r.account_id,
  clientId: r.client_id,
  product: r.product,
  claimsGranted: JSON.parse(r.claims_granted_json) as IssuerClaim[],
  claimsDeclined: JSON.parse(r.claims_declined_json) as IssuerClaim[],
  scopes: JSON.parse(r.scopes_json) as string[],
  scopeHash: r.scope_hash,
  grantedAt: r.granted_at,
  changedAt: r.changed_at,
  lastUsedAt: r.last_used_at,
});

export async function getClientGrant(
  db: Db,
  product: string,
  accountId: string,
  clientId: string,
): Promise<ClientGrant | null> {
  const r = await db.first<Row>(
    `SELECT * FROM identity_client_grants WHERE product = ? AND account_id = ? AND client_id = ?`,
    product,
    accountId,
    clientId,
  );
  return r ? toGrant(r) : null;
}

/** An account's grants for the product, newest first (Connected apps). */
export async function listAccountGrants(
  db: Db,
  product: string,
  accountId: string,
): Promise<ClientGrant[]> {
  const rows = await db.all<Row>(
    `SELECT * FROM identity_client_grants WHERE product = ? AND account_id = ?
     ORDER BY granted_at DESC, client_id`,
    product,
    accountId,
  );
  return rows.map(toGrant);
}

/** The upsert of a decision, as a statement for a batch. `granted_at` is kept across a change. */
export function clientGrantStatement(
  g: Omit<ClientGrant, "grantedAt" | "changedAt" | "lastUsedAt">,
  now: number,
): DbStatement {
  return {
    sql: `INSERT INTO identity_client_grants
       (account_id, client_id, product, claims_granted_json, claims_declined_json, scopes_json,
        scope_hash, granted_at, changed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (product, account_id, client_id) DO UPDATE SET
       claims_granted_json = excluded.claims_granted_json,
       claims_declined_json = excluded.claims_declined_json,
       scopes_json = excluded.scopes_json,
       scope_hash = excluded.scope_hash,
       changed_at = excluded.changed_at`,
    params: [
      g.accountId,
      g.clientId,
      g.product,
      JSON.stringify(g.claimsGranted),
      JSON.stringify(g.claimsDeclined),
      JSON.stringify(g.scopes),
      g.scopeHash,
      now,
      now,
    ],
  };
}

/** Write the decision. `granted_at` is kept across a change; `changed_at` moves. */
export async function putClientGrant(
  db: Db,
  g: Omit<ClientGrant, "grantedAt" | "changedAt" | "lastUsedAt">,
  now: number,
): Promise<void> {
  const s = clientGrantStatement(g, now);
  await db.run(s.sql, ...s.params);
}

export async function touchClientGrant(
  db: Db,
  product: string,
  accountId: string,
  clientId: string,
  now: number,
): Promise<void> {
  await db.run(
    `UPDATE identity_client_grants SET last_used_at = ?
     WHERE product = ? AND account_id = ? AND client_id = ?`,
    now,
    product,
    accountId,
    clientId,
  );
}

/** Disconnect: the grant and that account's refresh families for the client, in one batch. */
export function disconnectStatements(
  product: string,
  accountId: string,
  clientId: string,
  now: number,
): DbStatement[] {
  return [
    {
      sql: `UPDATE identity_refresh_tokens SET revoked_at = ?
            WHERE product = ? AND account_id = ? AND client_id = ? AND revoked_at IS NULL`,
      params: [now, product, accountId, clientId],
    },
    {
      sql: `DELETE FROM identity_client_grants WHERE product = ? AND account_id = ? AND client_id = ?`,
      params: [product, accountId, clientId],
    },
  ];
}

/** Returns whether a grant existed. */
export async function disconnectClient(
  db: Db,
  product: string,
  accountId: string,
  clientId: string,
  now: number,
): Promise<boolean> {
  const stmts = disconnectStatements(product, accountId, clientId, now);
  const counts = await batchCounts(db, stmts);
  return (counts[1] ?? 0) === 1;
}
