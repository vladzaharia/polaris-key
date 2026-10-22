/**
 * The stored role bindings (ST-28 plan §5.1, built by ST-31 slice 1).
 *
 * `console_role_bindings` holds an operator's grants: a row names a member (`account_id`) or, for
 * an invite, an address (`email_norm`). This file is Core's only store for it. Slice 1 adds the
 * store and nothing reads grants through it yet; the principal's reader is slice 2.
 *
 * Fail closed. A row the reader cannot understand (an unknown area, a malformed `areas_json`, a
 * role or scope outside the vocabulary) yields no grant rather than a wider one.
 */

import { PRODUCT_SLUG_RE, SYSTEM_PRODUCT_SLUG } from "@polaris-key/manifest";
import type { Db, DbStatement } from "../../db/types.js";
import { randomToken } from "../../platform/random.js";
import { AREA_IDS, PRODUCT_AREAS, isAreaId, type AreaId } from "./areas.js";
import { ROLES, type Grant, type GrantScope, type Role } from "./can.js";

/** How a binding came to be. Stored; `rowToGrant` passes it to `Grant.source`. */
export type BindingSource = "grant" | "invite" | "creator";

/** One `console_role_bindings` row, as stored. */
export interface BindingRow {
  id: string;
  account_id: string | null;
  email_norm: string | null;
  role: string;
  scope: string;
  areas_json: string | null;
  source: string;
  granted_by: string | null;
  granted_at: number;
  expires_at: number | null;
}

/** What a caller supplies to insert a binding (the id is minted by `newBindingId`). */
export interface NewBinding {
  id: string;
  accountId: string | null;
  emailNorm: string | null;
  role: Role;
  scope: GrantScope;
  /** `null` = every area. Already normalised (`normalizeAreas`). */
  areas: readonly AreaId[] | null;
  source: BindingSource;
  grantedBy: string | null;
  grantedAt: number;
  expiresAt?: number | null;
}

const SOURCES: readonly string[] = ["grant", "invite", "creator"];

/** `crb_` plus 22 base64url characters (16 random bytes). */
export function newBindingId(): string {
  return `crb_${randomToken(16)}`;
}

/**
 * A product admin's area list as stored: deduplicated, in `AREAS` order. Throws on an empty list
 * (NULL means every area, so "no areas" must never be spelled `[]`) and on an id that is not a
 * product area, so a typo cannot silently narrow or widen a grant.
 */
export function normalizeAreas(areas: readonly string[]): AreaId[] {
  if (areas.length === 0) throw new Error("areas must not be empty");
  const wanted = new Set<string>();
  for (const a of areas) {
    if (!isAreaId(a) || !PRODUCT_AREAS.includes(a)) {
      throw new Error(`not a product area: ${String(a)}`);
    }
    wanted.add(a);
  }
  return AREA_IDS.filter((id) => wanted.has(id));
}

/** The union of two area lists in `AREAS` order; NULL (every area) wins. */
export function mergeAreas(
  a: readonly AreaId[] | null,
  b: readonly AreaId[] | null,
): AreaId[] | null {
  if (a === null || b === null) return null;
  const all = new Set<string>([...a, ...b]);
  return AREA_IDS.filter((id) => all.has(id));
}

/**
 * `product:<slug>`, lower case, the one product slug rule (P0-14). The system product is a
 * platform resource and takes no product scope, so `product:<system>` is no scope here (the
 * writer refuses it and the reader drops it, as `validateGrant` does).
 */
function validScope(scope: string): scope is GrantScope {
  return (
    scope === "platform" ||
    scope === "products:*" ||
    (scope.startsWith("product:") &&
      PRODUCT_SLUG_RE.test(scope.slice("product:".length)) &&
      scope !== `product:${SYSTEM_PRODUCT_SLUG}`)
  );
}

/** Role and scope agree: a product admin is scoped to products, every other role to the platform. */
function roleScopeAgree(role: string, scope: string): boolean {
  return role === "product_admin" ? scope !== "platform" : scope === "platform";
}

/**
 * A row as a grant, or `null` when it cannot be read safely: an unknown area (so a narrowed
 * grant never widens), an empty or malformed list, or a role, scope or source outside the
 * vocabulary.
 */
export function rowToGrant(row: BindingRow): Grant | null {
  if (
    !(ROLES as readonly string[]).includes(row.role) ||
    !SOURCES.includes(row.source)
  )
    return null;
  if (!validScope(row.scope) || !roleScopeAgree(row.role, row.scope))
    return null;
  let areas: AreaId[] | null = null;
  if (row.areas_json !== null) {
    // Areas narrow a product admin and nothing else.
    if (row.role !== "product_admin") return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.areas_json);
    } catch {
      return null;
    }
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    if (!parsed.every((a) => isAreaId(a) && PRODUCT_AREAS.includes(a)))
      return null;
    areas = AREA_IDS.filter((id) => (parsed as string[]).includes(id));
  }
  return {
    role: row.role as Role,
    scope: row.scope,
    areas,
    source: row.source as BindingSource,
  };
}

/** The grants stored for an account. Email rows (invites) never count. */
export async function listAccountGrants(
  db: Db,
  accountId: string,
): Promise<Grant[]> {
  let rows: BindingRow[];
  try {
    rows = await db.all<BindingRow>(
      "SELECT * FROM console_role_bindings WHERE account_id = ? ORDER BY granted_at, id",
      accountId,
    );
  } catch (e) {
    // Deploy order: the code may run before the migration. Stored grants only ever narrow what a
    // root operator holds, so a missing table means "no stored grants", not a locked-out operator.
    if (/no such table/i.test(String((e as Error)?.message ?? e))) return [];
    throw e;
  }
  const grants: Grant[] = [];
  for (const row of rows) {
    const g = rowToGrant(row);
    if (g) grants.push(g);
  }
  return grants;
}

/** The unexpired invites for a normalised address. */
export async function listPendingInvites(
  db: Db,
  emailNorm: string,
  now: number,
): Promise<BindingRow[]> {
  return db.all<BindingRow>(
    "SELECT * FROM console_role_bindings WHERE email_norm = ? AND expires_at IS NOT NULL AND expires_at > ? ORDER BY granted_at, id",
    emailNorm,
    now,
  );
}

export function stmtInsertBinding(b: NewBinding): DbStatement {
  // A second line of defence behind the callers' own validation: refuse what `rowToGrant` would
  // read as no grant, so a bad row is never written.
  if (!validScope(b.scope))
    throw new Error(`invalid binding scope: ${b.scope}`);
  if (!roleScopeAgree(b.role, b.scope))
    throw new Error(`role ${b.role} does not fit scope ${b.scope}`);
  if (b.areas !== null && b.role !== "product_admin")
    throw new Error("areas apply to a product_admin binding only");
  const areas = b.areas === null ? null : normalizeAreas(b.areas);
  if (
    b.accountId === null &&
    (b.expiresAt === undefined || b.expiresAt === null)
  )
    throw new Error("an email binding needs an expiry");
  return {
    sql: `INSERT INTO console_role_bindings
            (id, account_id, email_norm, role, scope, areas_json, source, granted_by, granted_at, expires_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    params: [
      b.id,
      b.accountId,
      b.emailNorm,
      b.role,
      b.scope,
      areas === null ? null : JSON.stringify(areas),
      b.source,
      b.grantedBy,
      b.grantedAt,
      b.expiresAt ?? null,
    ],
  };
}

/** One binding by id (an account row or an invite), or `null`. */
export async function getBinding(
  db: Db,
  id: string,
): Promise<BindingRow | null> {
  return db.first<BindingRow>(
    "SELECT * FROM console_role_bindings WHERE id = ?",
    id,
  );
}

/** The account's binding for one `(role, scope)`, which the unique index allows at most once. */
export async function findAccountBinding(
  db: Db,
  accountId: string,
  role: string,
  scope: string,
): Promise<BindingRow | null> {
  return db.first<BindingRow>(
    `SELECT * FROM console_role_bindings
      WHERE account_id = ? AND role = ? AND scope = ?`,
    accountId,
    role,
    scope,
  );
}

/**
 * The distinct accounts that hold a binding, for resolving a member id by computing each
 * candidate's id (the id is one-way). `limit + 1` rows are asked for so a caller can tell a cap
 * cut the list.
 */
export async function listBoundAccountIds(
  db: Db,
  limit: number,
): Promise<string[]> {
  const rows = await db.all<{ account_id: string }>(
    `SELECT DISTINCT account_id FROM console_role_bindings
      WHERE account_id IS NOT NULL ORDER BY account_id LIMIT ?`,
    limit + 1,
  );
  return rows.map((r) => r.account_id);
}

/**
 * ST-31.6: the guard a write carries so it applies only while the binding is still as the caller
 * read it. `areasJson` is the stored `areas_json` the caller authorised against (`null` = every
 * area). Used as the tail of the audit rows and in the statements below.
 */
export function bindingUnchangedSql(
  id: string,
  areasJson: string | null,
): { sql: string; params: (string | null)[] } {
  return {
    sql: "EXISTS (SELECT 1 FROM console_role_bindings WHERE id = ? AND areas_json IS ?)",
    params: [id, areasJson],
  };
}

/** Narrow or widen one binding's areas, only while it still holds `expectedAreasJson`. */
export function stmtUpdateBindingAreas(
  id: string,
  areas: readonly AreaId[] | null,
  expectedAreasJson: string | null,
): DbStatement {
  const next = areas === null ? null : normalizeAreas(areas);
  return {
    sql: "UPDATE console_role_bindings SET areas_json = ? WHERE id = ? AND areas_json IS ?",
    params: [
      next === null ? null : JSON.stringify(next),
      id,
      expectedAreasJson,
    ],
  };
}

/** Delete one binding, only while it still holds `expectedAreasJson`. */
export function stmtDeleteBindingIfUnchanged(
  id: string,
  expectedAreasJson: string | null,
): DbStatement {
  return {
    sql: "DELETE FROM console_role_bindings WHERE id = ? AND areas_json IS ?",
    params: [id, expectedAreasJson],
  };
}

export function stmtDeleteBinding(id: string): DbStatement {
  return {
    sql: "DELETE FROM console_role_bindings WHERE id = ?",
    params: [id],
  };
}

/** ST-28 G8: a deleted product takes its `product:<slug>` bindings with it, and only those. */
export function stmtDeleteProductBindings(slug: string): DbStatement {
  return {
    sql: "DELETE FROM console_role_bindings WHERE scope = 'product:' || ?",
    params: [slug],
  };
}

/**
 * The read side the Members pages use (ST-31.4/31.5). Each asks for `limit + 1` rows so a caller
 * can tell that a cap cut the list (`truncated`) and slice back to `limit`.
 */

/** Every binding that names an account, oldest first. */
export async function listAccountBindings(
  db: Db,
  limit: number,
): Promise<BindingRow[]> {
  return db.all<BindingRow>(
    `SELECT * FROM console_role_bindings WHERE account_id IS NOT NULL
      ORDER BY granted_at, id LIMIT ?`,
    limit + 1,
  );
}

/** The unexpired invites (address rows), newest first; one scope when `scope` is given. */
export async function listAllInvites(
  db: Db,
  now: number,
  limit: number,
  scope?: string,
): Promise<BindingRow[]> {
  return db.all<BindingRow>(
    `SELECT * FROM console_role_bindings
      WHERE email_norm IS NOT NULL AND expires_at IS NOT NULL AND expires_at > ?
        ${scope === undefined ? "" : "AND scope = ?"}
      ORDER BY granted_at DESC, id LIMIT ?`,
    ...(scope === undefined ? [now, limit + 1] : [now, scope, limit + 1]),
  );
}

/** Bindings on one scope held by ACTIVE accounts. */
export async function listScopeBindings(
  db: Db,
  scope: string,
  limit: number,
): Promise<BindingRow[]> {
  return db.all<BindingRow>(
    `SELECT b.* FROM console_role_bindings b JOIN accounts a ON a.id = b.account_id
      WHERE b.scope = ? AND a.status = 'active'
      ORDER BY b.granted_at, b.id LIMIT ?`,
    scope,
    limit + 1,
  );
}

/** `products:*` Product admin bindings of active accounts. */
export async function listWideProductAdmins(
  db: Db,
  limit: number,
): Promise<BindingRow[]> {
  return db.all<BindingRow>(
    `SELECT b.* FROM console_role_bindings b JOIN accounts a ON a.id = b.account_id
      WHERE b.scope = 'products:*' AND b.role = 'product_admin' AND a.status = 'active'
      ORDER BY b.granted_at, b.id LIMIT ?`,
    limit + 1,
  );
}

/** `product_admin` bindings on exactly one scope, held by ACTIVE accounts, oldest first. */
export async function listProductAdminBindings(
  db: Db,
  scope: string,
  limit: number,
): Promise<BindingRow[]> {
  return db.all<BindingRow>(
    `SELECT b.* FROM console_role_bindings b JOIN accounts a ON a.id = b.account_id
      WHERE b.role = 'product_admin' AND b.scope = ? AND a.status = 'active'
      ORDER BY b.granted_at, b.id LIMIT ?`,
    scope,
    limit,
  );
}

/** Stored platform-scope Superadmin bindings of active accounts. */
export async function listStoredSuperadmins(db: Db): Promise<BindingRow[]> {
  return db.all<BindingRow>(
    `SELECT b.* FROM console_role_bindings b JOIN accounts a ON a.id = b.account_id
      WHERE b.role = 'superadmin' AND b.scope = 'platform' AND a.status = 'active'
      ORDER BY b.granted_at, b.id LIMIT 200`,
  );
}

/**
 * ST-31.7: invites. An invite is an address row (`email_norm`, no account) that expires after
 * {@link INVITE_TTL_SECONDS}. It grants nothing until sign-in converts it (ST-31.8); the principal
 * reads account rows only. The unique index `(email_norm, role, scope)` makes a second invite for
 * the same grant a refresh.
 */
export const INVITE_TTL_SECONDS = 7 * 86_400;
/** The nightly job deletes an invite this long after it expired. */
export const INVITE_PURGE_GRACE_SECONDS = 7 * 86_400;

/** The invite (live or expired but not yet purged) for one address, role and scope. */
export async function findInvite(
  db: Db,
  emailNorm: string,
  role: string,
  scope: string,
): Promise<BindingRow | null> {
  return db.first<BindingRow>(
    `SELECT * FROM console_role_bindings
      WHERE email_norm = ? AND role = ? AND scope = ?`,
    emailNorm,
    role,
    scope,
  );
}

/**
 * Create the invite, or refresh the one that exists: a later expiry, the new areas, the new
 * inviter and time. The row keeps its id.
 */
export function stmtUpsertInvite(b: {
  id: string;
  emailNorm: string;
  role: Role;
  scope: GrantScope;
  areas: readonly AreaId[] | null;
  grantedBy: string;
  grantedAt: number;
}): DbStatement {
  const insert = stmtInsertBinding({
    id: b.id,
    accountId: null,
    emailNorm: b.emailNorm,
    role: b.role,
    scope: b.scope,
    areas: b.areas,
    source: "invite",
    grantedBy: b.grantedBy,
    grantedAt: b.grantedAt,
    expiresAt: b.grantedAt + INVITE_TTL_SECONDS,
  });
  return {
    sql: `${insert.sql}
          ON CONFLICT (email_norm, role, scope) WHERE email_norm IS NOT NULL
          DO UPDATE SET areas_json = excluded.areas_json, granted_by = excluded.granted_by,
                        granted_at = excluded.granted_at, expires_at = excluded.expires_at`,
    params: insert.params,
  };
}

/** Whether the account holds any stored binding (it is a console member besides the root rule). */
export async function hasAccountBinding(
  db: Db,
  accountId: string,
): Promise<boolean> {
  return (
    (await db.first<{ n: number }>(
      "SELECT 1 AS n FROM console_role_bindings WHERE account_id = ? LIMIT 1",
      accountId,
    )) !== null
  );
}

/**
 * The nightly sweep: invites that expired more than {@link INVITE_PURGE_GRACE_SECONDS} ago.
 * Bounded per pass; returns how many went.
 */
export async function purgeExpiredInvites(
  db: Db,
  now: number,
  limit = 500,
): Promise<number> {
  return db.runChanges(
    `DELETE FROM console_role_bindings
      WHERE id IN (SELECT id FROM console_role_bindings
                    WHERE email_norm IS NOT NULL AND expires_at IS NOT NULL AND expires_at < ?
                    LIMIT ?)`,
    now - INVITE_PURGE_GRACE_SECONDS,
    limit,
  );
}
