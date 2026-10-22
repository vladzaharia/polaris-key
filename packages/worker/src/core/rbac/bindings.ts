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

/** `product:<slug>`, lower case, a slug of letters, digits and hyphens (never empty). */
const PRODUCT_SCOPE = /^product:[a-z0-9][a-z0-9-]*$/;

function validScope(scope: string): scope is GrantScope {
  return (
    scope === "platform" || scope === "products:*" || PRODUCT_SCOPE.test(scope)
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
    // root operator holds, so a missing table means "no stored grants", not a locked-out console.
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
