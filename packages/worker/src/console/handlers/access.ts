/**
 * `GET /api/access/admins?scope=&area=` (ST-29; ST-28 plan §5.2; ST-31.5): who can give the caller
 * access to an area in a scope. NoAccessPage and every disabled write control's reason name these
 * people.
 *
 * Up to three people, narrowest first: the product's admins who hold the area and `members`, then
 * Superadmins, who can give any role. Each is a name, a role and an address to copy; never an
 * account id or a subject (`accountIdBoundary.test.ts`).
 *
 * What a member may learn here (PRIVACY.md, "What an admin can see"):
 *   - Platform admins are never listed: they cannot give a product role to someone else, and
 *     naming the products they hold would reveal product names. `products:*` admins are not listed
 *     either: this answer is about the one scope asked.
 *   - A product's own admins are listed only to a caller who already holds an area of that
 *     product. Anyone else gets the Superadmins alone, the same answer for a product that does not
 *     exist, so the route is no oracle for product slugs. The product is never looked up.
 *   - Narrowest first: an admin narrowed to fewer areas comes before one narrowed to more, and an
 *     admin of every area comes last among them; ties go to the earlier grant.
 *
 * The Superadmins are the root rule's current holders (`consoleRootHolders`) and the stored
 * Superadmin bindings of active accounts. The caller is never on their own list.
 */

import { adminJson, err } from "../../core/console/respond.js";
import { PRODUCT_AREAS, type AreaId } from "../../core/rbac/areas.js";
import {
  mergeAreas,
  rowToGrant,
  type BindingRow,
} from "../../core/rbac/bindings.js";
import { can } from "../../core/rbac/can.js";
import { consoleDirectory } from "../../services/identity/public.js";
import { isAreaId } from "../authz.js";
import type { AdminCtx } from "../routes.js";
import { byPerson, superadminAccountIds } from "./productMembers.js";

/** One person who can help. */
export interface AccessAdmin {
  name: string;
  email: string;
  /** The role that lets them give the access. */
  role: "superadmin" | "product_admin";
}

/** At most this many are named. */
export const ACCESS_ADMINS_LIMIT = 3;

const SCOPE_RE = /^(platform|product:[a-z0-9][a-z0-9-]{0,62})$/;

/** Does the caller hold any area of this product? Only then are its admins named. */
function holdsAreaOf(c: AdminCtx, slug: string): boolean {
  const p = c.session.principal;
  return PRODUCT_AREAS.some((a) =>
    can(p, { kind: "product", slug, system: false }, a, "view"),
  );
}

export async function handleAccessAdmins(c: AdminCtx): Promise<Response> {
  const url = new URL(c.req.url);
  const scope = url.searchParams.get("scope") ?? "platform";
  const area = url.searchParams.get("area") ?? "console";
  const fields: string[] = [];
  if (!SCOPE_RE.test(scope)) fields.push("scope");
  if (!isAreaId(area)) fields.push("area");
  if (fields.length)
    return err(400, "bad_request", "invalid scope or area", { fields });

  const isSelf = (accountId: string, memberId: string) =>
    (c.session.aid !== undefined && c.session.aid === accountId) ||
    c.session.sub === memberId;

  // Product admins: bindings on exactly this product that hold `area` and `members`.
  const candidates: { accountId: string; rank: number; at: number }[] = [];
  if (
    scope.startsWith("product:") &&
    (PRODUCT_AREAS as readonly string[]).includes(area) &&
    holdsAreaOf(c, scope.slice("product:".length))
  ) {
    const rows = await c.db.all<BindingRow>(
      `SELECT b.* FROM console_role_bindings b JOIN accounts a ON a.id = b.account_id
        WHERE b.role = 'product_admin' AND b.scope = ? AND a.status = 'active'
        ORDER BY b.granted_at, b.id LIMIT 200`,
      scope,
    );
    // One person's bindings on this product add up: their areas are the union (NULL = every area).
    const union = new Map<string, { areas: AreaId[] | null; at: number }>();
    for (const row of rows) {
      const g = rowToGrant(row);
      if (!g) continue;
      const have = union.get(row.account_id!);
      union.set(row.account_id!, {
        areas: have ? mergeAreas(have.areas, g.areas) : g.areas && [...g.areas],
        at: have ? Math.min(have.at, row.granted_at) : row.granted_at,
      });
    }
    for (const [accountId, v] of union) {
      const holds = (a: string) =>
        v.areas === null || (v.areas as readonly string[]).includes(a);
      if (holds(area) && holds("members"))
        candidates.push({
          accountId,
          rank: v.areas === null ? 99 : v.areas.length,
          at: v.at,
        });
    }
    candidates.sort(
      (a, b) =>
        a.rank - b.rank ||
        a.at - b.at ||
        a.accountId.localeCompare(b.accountId),
    );
  }

  const supers = await superadminAccountIds(c.env, c.db, c.now);
  const dir = await consoleDirectory(
    c.env,
    c.db,
    [...candidates.map((x) => x.accountId), ...supers.map((s) => s.id)],
    c.now,
  );
  const admins: AccessAdmin[] = [];
  const seen = new Set<string>();
  const push = (accountId: string, role: AccessAdmin["role"]) => {
    const e = dir.get(accountId);
    if (!e || !e.email || seen.has(accountId) || isSelf(accountId, e.memberId))
      return;
    seen.add(accountId);
    admins.push({ name: e.name || e.email, email: e.email, role });
  };
  for (const x of candidates) push(x.accountId, "product_admin");
  // A Superadmin who also holds the product is named once, as the narrower role.
  const people = supers
    .map((s) => ({ id: s.id, e: dir.get(s.id) }))
    .filter((p) => p.e)
    .sort((a, b) => byPerson(a.e!, b.e!));
  for (const p of people) push(p.id, "superadmin");
  return adminJson({
    scope,
    area,
    admins: admins.slice(0, ACCESS_ADMINS_LIMIT),
  });
}
