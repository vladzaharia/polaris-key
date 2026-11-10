/**
 * Registered clients and their secrets (I-21.2; V5 §12.13.2; threats IS-1, IS-12).
 *
 * `identity_clients` and `identity_client_secrets` are Identity's tables. Every read and write is
 * scoped by `product`, so a `client_id` of another product is `null` and never changed. The cap of
 * 20 clients per product and of 2 live secrets per client is checked INSIDE the insert, so two
 * concurrent writers cannot both pass it. A secret is shown once, by `addClientSecret`, and only
 * `hashKey("client-secret:" + secret, KEY_HASH_PEPPER)` is stored. Validation of a client's
 * members (redirect classes, display names) is the caller's: I-21.4 and I-21.14.
 */

import {
  MAX_CLIENT_SECRETS,
  MAX_ISSUER_CLIENTS,
  type IssuerClaim,
  type IssuerScope,
  type RegisteredClient,
  type RegisteredClientType,
} from "@polaris-key/protocol/identity";
import type { Db, DbStatement } from "../../../db/types.js";
import { batchCounts } from "../../../db/batch.js";
import type { Env } from "../../../platform/env.js";
import { constantTimeEqual } from "../../../platform/compare.js";
import { hashKey, randomId } from "../../../platform/crypto.js";
import { randomToken } from "../../../platform/random.js";

export type ClientOrigin = "console" | "manifest";

/** A client as stored: the wire members plus who owns them and the card's icon. */
export interface ClientRecord extends RegisteredClient {
  product: string;
  origin: ClientOrigin;
  iconUrl: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface NewClient {
  product: string;
  key: string;
  origin: ClientOrigin;
  name: string;
  developerName: string | null;
  type: RegisteredClientType;
  redirectUris: string[];
  postLogoutRedirectUris: string[];
  scopes: IssuerScope[];
  claimsRequired: IssuerClaim[];
  iconUrl: string | null;
}

interface Row {
  client_id: string;
  product: string;
  key: string;
  origin: ClientOrigin;
  name: string;
  developer_name: string | null;
  type: RegisteredClientType;
  redirect_uris_json: string;
  post_logout_redirect_uris_json: string;
  scopes_json: string;
  claims_required_json: string;
  icon_url: string | null;
  status: "active" | "disabled";
  created_at: number;
  updated_at: number;
}

const COLUMNS = `client_id, product, key, origin, name, developer_name, type, redirect_uris_json,
  post_logout_redirect_uris_json, scopes_json, claims_required_json, icon_url, status,
  created_at, updated_at`;

const toRecord = (r: Row): ClientRecord => ({
  clientId: r.client_id,
  product: r.product,
  key: r.key,
  origin: r.origin,
  name: r.name,
  developerName: r.developer_name,
  type: r.type,
  redirectUris: JSON.parse(r.redirect_uris_json) as string[],
  postLogoutRedirectUris: JSON.parse(
    r.post_logout_redirect_uris_json,
  ) as string[],
  scopes: JSON.parse(r.scopes_json) as IssuerScope[],
  claims: { required: JSON.parse(r.claims_required_json) as IssuerClaim[] },
  iconUrl: r.icon_url,
  status: r.status,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** `cl_` + 22 base64url characters (16 random bytes). */
export const mintClientId = (): string => `cl_${randomToken(16)}`;

export type CreateClientResult =
  | { ok: true; client: ClientRecord }
  | { ok: false; reason: "limit" | "key_exists" | "invalid" };

/** Create a client with a fresh id. Fails closed on the product's cap and on a duplicate key. */
export async function createClient(
  db: Db,
  input: NewClient,
  now: number,
): Promise<CreateClientResult> {
  // Checked here so a CHECK failure is never reported as the product's cap.
  if (
    !["web", "spa", "native"].includes(input.type) ||
    !["console", "manifest"].includes(input.origin)
  )
    return { ok: false, reason: "invalid" };
  const clientId = mintClientId();
  const changed = await db.runChanges(
    `INSERT OR IGNORE INTO identity_clients
       (client_id, product, key, origin, name, developer_name, type, redirect_uris_json,
        post_logout_redirect_uris_json, scopes_json, claims_required_json, icon_url, status,
        created_at, updated_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?
     WHERE (SELECT COUNT(*) FROM identity_clients WHERE product = ?) < ?`,
    clientId,
    input.product,
    input.key,
    input.origin,
    input.name,
    input.developerName,
    input.type,
    JSON.stringify(input.redirectUris),
    JSON.stringify(input.postLogoutRedirectUris),
    JSON.stringify(input.scopes),
    JSON.stringify(input.claimsRequired),
    input.iconUrl,
    now,
    now,
    input.product,
    MAX_ISSUER_CLIENTS,
  );
  if (changed === 1) {
    const client = await getClient(db, input.product, clientId);
    if (client) return { ok: true, client };
  }
  const dup = await getClientByKey(db, input.product, input.key);
  return { ok: false, reason: dup ? "key_exists" : "limit" };
}

export async function getClient(
  db: Db,
  product: string,
  clientId: string,
): Promise<ClientRecord | null> {
  const r = await db.first<Row>(
    `SELECT ${COLUMNS} FROM identity_clients WHERE product = ? AND client_id = ?`,
    product,
    clientId,
  );
  return r ? toRecord(r) : null;
}

export async function getClientByKey(
  db: Db,
  product: string,
  key: string,
): Promise<ClientRecord | null> {
  const r = await db.first<Row>(
    `SELECT ${COLUMNS} FROM identity_clients WHERE product = ? AND key = ?`,
    product,
    key,
  );
  return r ? toRecord(r) : null;
}

/** The client the issuer routes serve: `null` unless it is active. */
export async function getActiveClient(
  db: Db,
  product: string,
  clientId: string,
): Promise<ClientRecord | null> {
  const c = await getClient(db, product, clientId);
  return c && c.status === "active" ? c : null;
}

export async function listClients(
  db: Db,
  product: string,
): Promise<ClientRecord[]> {
  const rows = await db.all<Row>(
    `SELECT ${COLUMNS} FROM identity_clients WHERE product = ? ORDER BY created_at, client_id`,
    product,
  );
  return rows.map(toRecord);
}

export type ClientPatch = Partial<
  Pick<
    NewClient,
    | "name"
    | "developerName"
    | "type"
    | "redirectUris"
    | "postLogoutRedirectUris"
    | "scopes"
    | "claimsRequired"
    | "iconUrl"
  >
>;

/** Update a client's declared members. `false` for an unknown client. */
export async function updateClient(
  db: Db,
  product: string,
  clientId: string,
  patch: ClientPatch,
  now: number,
): Promise<boolean> {
  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  const set = (col: string, v: string | number | null) => {
    sets.push(`${col} = ?`);
    params.push(v);
  };
  if (patch.name !== undefined) set("name", patch.name);
  if (patch.developerName !== undefined)
    set("developer_name", patch.developerName);
  if (patch.type !== undefined) set("type", patch.type);
  if (patch.redirectUris !== undefined)
    set("redirect_uris_json", JSON.stringify(patch.redirectUris));
  if (patch.postLogoutRedirectUris !== undefined)
    set(
      "post_logout_redirect_uris_json",
      JSON.stringify(patch.postLogoutRedirectUris),
    );
  if (patch.scopes !== undefined)
    set("scopes_json", JSON.stringify(patch.scopes));
  if (patch.claimsRequired !== undefined)
    set("claims_required_json", JSON.stringify(patch.claimsRequired));
  if (patch.iconUrl !== undefined) set("icon_url", patch.iconUrl);
  if (sets.length === 0)
    return (await getClient(db, product, clientId)) !== null;
  set("updated_at", now);
  return (
    (await db.runChanges(
      `UPDATE identity_clients SET ${sets.join(", ")} WHERE product = ? AND client_id = ?`,
      ...params,
      product,
      clientId,
    )) === 1
  );
}

/**
 * Disable or re-enable a client. Disabling also revokes its refresh families, in one batch, so a
 * disabled client leaves no live token behind (V5 §12.13.7).
 */
export async function setClientStatus(
  db: Db,
  product: string,
  clientId: string,
  status: "active" | "disabled",
  now: number,
): Promise<boolean> {
  const stmts: DbStatement[] = [
    {
      sql: `UPDATE identity_clients SET status = ?, disabled_by = ?, updated_at = ?
            WHERE product = ? AND client_id = ?`,
      params: [
        status,
        status === "disabled" ? "operator" : null,
        now,
        product,
        clientId,
      ],
    },
  ];
  if (status === "disabled")
    stmts.push({
      sql: `UPDATE identity_refresh_tokens SET revoked_at = ?
            WHERE product = ? AND client_id = ? AND revoked_at IS NULL`,
      params: [now, product, clientId],
    });
  const counts = await batchCounts(db, stmts);
  return counts[0] === 1;
}

/** The statements that delete a client with its secrets, grants and refresh tokens. */
export function deleteClientStatements(
  product: string,
  clientId: string,
): DbStatement[] {
  return [
    "identity_client_secrets",
    "identity_client_grants",
    "identity_refresh_tokens",
    "identity_clients",
  ].map((table) => ({
    sql: `DELETE FROM ${table} WHERE product = ? AND client_id = ?`,
    params: [product, clientId],
  }));
}

/** Delete a client and everything it holds, atomically. `false` for an unknown client. */
export async function deleteClient(
  db: Db,
  product: string,
  clientId: string,
): Promise<boolean> {
  const counts = await batchCounts(
    db,
    deleteClientStatements(product, clientId),
  );
  return (counts[3] ?? 0) === 1;
}

// ── secrets ─────────────────────────────────────────────────────────────────────────────────

export interface ClientSecretInfo {
  id: string;
  last4: string;
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

/** Domain separation: a client-secret hash is never the hash of another credential. */
const SECRET_DOMAIN = "client-secret:";

/** Fails closed: without the pepper a hash would be unkeyed and guessable from a leaked row. */
export const hashClientSecret = (env: Env, secret: string): Promise<string> => {
  if (!env.KEY_HASH_PEPPER)
    throw new Error("KEY_HASH_PEPPER is not configured");
  return hashKey(SECRET_DOMAIN + secret, env.KEY_HASH_PEPPER);
};

/**
 * Mint a secret for a live `web` client of the product. The plaintext is in the return value and
 * nowhere else. `null` when the client is unknown, disabled, not `web`, or already holds 2 live
 * secrets (the limit is part of the insert).
 */
export async function addClientSecret(
  env: Env,
  db: Db,
  product: string,
  clientId: string,
  now: number,
): Promise<{ id: string; secret: string; last4: string } | null> {
  const secret = `pkeycs_${randomToken(32)}`;
  const id = randomId("cs");
  const last4 = secret.slice(-4);
  const changed = await db.runChanges(
    `INSERT INTO identity_client_secrets (id, client_id, product, secret_hash, last4, created_at)
     SELECT ?, ?, ?, ?, ?, ?
     WHERE EXISTS (SELECT 1 FROM identity_clients
                    WHERE product = ? AND client_id = ? AND type = 'web' AND status = 'active')
       AND (SELECT COUNT(*) FROM identity_client_secrets
            WHERE client_id = ? AND revoked_at IS NULL) < ?`,
    id,
    clientId,
    product,
    await hashClientSecret(env, secret),
    last4,
    now,
    product,
    clientId,
    clientId,
    MAX_CLIENT_SECRETS,
  );
  return changed === 1 ? { id, secret, last4 } : null;
}

export async function listClientSecrets(
  db: Db,
  product: string,
  clientId: string,
): Promise<ClientSecretInfo[]> {
  const rows = await db.all<{
    id: string;
    last4: string;
    created_at: number;
    last_used_at: number | null;
    revoked_at: number | null;
  }>(
    `SELECT id, last4, created_at, last_used_at, revoked_at FROM identity_client_secrets
     WHERE product = ? AND client_id = ? ORDER BY created_at, id`,
    product,
    clientId,
  );
  return rows.map((r) => ({
    id: r.id,
    last4: r.last4,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
    revokedAt: r.revoked_at,
  }));
}

export async function revokeClientSecret(
  db: Db,
  product: string,
  clientId: string,
  secretId: string,
  now: number,
): Promise<boolean> {
  return (
    (await db.runChanges(
      `UPDATE identity_client_secrets SET revoked_at = ?
       WHERE product = ? AND client_id = ? AND id = ? AND revoked_at IS NULL`,
      now,
      product,
      clientId,
      secretId,
    )) === 1
  );
}

/**
 * Does `secret` match a live secret of an ACTIVE `web` client of the product? The hash is
 * computed first and every live hash is compared (constant time, no early exit), so an unknown
 * client, a client with no secret and a wrong secret cost the same. A match stamps `last_used_at`.
 */
export async function verifyClientSecret(
  env: Env,
  db: Db,
  product: string,
  clientId: string,
  secret: string,
  now: number,
): Promise<boolean> {
  const presented = await hashClientSecret(env, secret);
  const rows = await db.all<{ id: string; secret_hash: string }>(
    `SELECT s.id, s.secret_hash FROM identity_client_secrets s
       JOIN identity_clients c ON c.client_id = s.client_id AND c.product = s.product
      WHERE s.product = ? AND s.client_id = ? AND s.revoked_at IS NULL
        AND c.status = 'active' AND c.type = 'web'`,
    product,
    clientId,
  );
  let matched: string | null = null;
  for (const r of rows)
    if (constantTimeEqual(r.secret_hash, presented)) matched = r.id;
  if (matched === null) return false;
  await db.run(
    `UPDATE identity_client_secrets SET last_used_at = ? WHERE product = ? AND id = ?`,
    now,
    product,
    matched,
  );
  return true;
}
