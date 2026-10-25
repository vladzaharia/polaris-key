/**
 * `GET /products/<slug>/members` (ST-31.5; ST-28 plan §5.2): who holds access to one product.
 *
 * Product scope, area `members` (`./routes.ts`): the dispatcher has already loaded the product (404)
 * and checked the caller holds `members` on it, so a caller who cannot manage this product's members
 * never reaches the handler. Session only.
 *
 * The body has three parts:
 *   - `members`: accounts with a binding on `product:<slug>`, each with its roles and areas;
 *   - `invites`: the unexpired invites for this product, by address;
 *   - `platformRoles`: read-only, who reaches this product from above. Superadmins (the root rule's
 *     holders and stored Superadmin bindings) and `products:*` admins, each with a source. Platform
 *     admins are not listed: they hold no product area, and naming them here would add nothing.
 *
 * Privacy. A person is named by member id, display name and address, and by nothing else: the
 * account id stays inside this file's joins (`accountIdBoundary.test.ts`). An account that is
 * not active is not named. `truncated: true` says a cap of 500 cut a list; `incomplete: true` says the erasure
 * ledger could not be read for some account, so it was left out. No last sign-in is returned: a
 * Product admin learns who holds the product, not when each co-admin was last active.
 */

import { adminJson, err, readBody } from "../../core/console/respond.js";
import { ErrorCode } from "../../core/errors.js";
import {
  listAllInvites,
  listScopeBindings,
  listWideProductAdmins,
  rowToGrant,
} from "../../core/rbac/bindings.js";
import {
  consoleDirectoryPeople,
  type ConsoleDirectoryPerson,
} from "../../services/identity/public.js";
import type { AdminCtx } from "../routes.js";
import { createBinding, editBinding, revokeBinding } from "./bindings.js";
import { superadminAccountIds } from "./accessShared.js";

const LIMIT = 500;

type PersonKey = Pick<ConsoleDirectoryPerson, "memberId" | "name" | "email">;

/** Sorted for a stable page: name, then address, then member id. */
export function byPerson(a: PersonKey, b: PersonKey) {
  return (
    (a.name || a.email).localeCompare(b.name || b.email) ||
    a.email.localeCompare(b.email) ||
    a.memberId.localeCompare(b.memberId)
  );
}

export async function handleProductMembers(c: AdminCtx): Promise<Response> {
  const slug = c.product!.slug;
  const scope = `product:${slug}`;
  const boundAll = await listScopeBindings(c.db, scope, LIMIT);
  const wideAll = await listWideProductAdmins(c.db, LIMIT);
  const bound = boundAll.slice(0, LIMIT);
  const wide = wideAll.slice(0, LIMIT);
  const supers = await superadminAccountIds(c.env, c.db, c.now);
  const ids = [
    ...new Set([
      ...bound.map((b) => b.account_id!),
      ...wide.map((b) => b.account_id!),
      ...supers.map((s) => s.id),
    ]),
  ];
  const { people: dir, incomplete } = await consoleDirectoryPeople(
    c.env,
    c.db,
    ids,
    c.now,
  );
  const names = new Map<string, string>();
  for (const e of dir.values()) names.set(e.memberId, e.name || e.email);

  const isYou = (accountId: string, e: ConsoleDirectoryPerson) =>
    (c.session.aid !== undefined && c.session.aid === accountId) ||
    c.session.sub === e.memberId;

  const roles = new Map<string, unknown[]>();
  for (const row of bound) {
    const grant = rowToGrant(row);
    const e = dir.get(row.account_id!);
    if (!grant || !e) continue;
    const list = roles.get(row.account_id!) ?? [];
    list.push({
      role: grant.role,
      areas: grant.areas ? [...grant.areas] : null,
      source: grant.source,
      bindingId: row.id,
      grantedBy: row.granted_by
        ? { name: names.get(row.granted_by) ?? null }
        : null,
      grantedAt: row.granted_at,
    });
    roles.set(row.account_id!, list);
  }
  const members = [...roles]
    .map(([accountId, list]) => {
      const e = dir.get(accountId)!;
      return {
        memberId: e.memberId,
        name: e.name,
        email: e.email,
        you: isYou(accountId, e),
        roles: list,
      };
    })
    .sort(byPerson);

  const platformRoles: unknown[] = [];
  const seen = new Set<string>();
  for (const s of supers) {
    const e = dir.get(s.id);
    if (!e) continue;
    seen.add(`${s.id}:superadmin`);
    platformRoles.push({
      memberId: e.memberId,
      name: e.name,
      email: e.email,
      role: "superadmin",
      scope: "platform",
      areas: null,
      source: s.source,
    });
  }
  for (const row of wide) {
    const grant = rowToGrant(row);
    const e = dir.get(row.account_id!);
    if (!grant || !e) continue;
    platformRoles.push({
      memberId: e.memberId,
      name: e.name,
      email: e.email,
      role: "product_admin",
      scope: "products:*",
      areas: grant.areas ? [...grant.areas] : null,
      source: grant.source,
    });
  }
  platformRoles.sort((a, b) => byPerson(a as PersonKey, b as PersonKey));

  const invitesAll = await listAllInvites(c.db, c.now, LIMIT, scope);
  const invites = invitesAll.slice(0, LIMIT);
  return adminJson({
    product: slug,
    truncated:
      boundAll.length > LIMIT ||
      wideAll.length > LIMIT ||
      invitesAll.length > LIMIT,
    incomplete,
    members,
    invites: invites.flatMap((row) => {
      const grant = rowToGrant(row);
      if (!grant) return [];
      return [
        {
          bindingId: row.id,
          email: row.email_norm,
          role: grant.role,
          areas: grant.areas ? [...grant.areas] : null,
          invitedBy: row.granted_by
            ? { name: names.get(row.granted_by) ?? null }
            : null,
          sentAt: row.granted_at,
          expiresAt: row.expires_at,
        },
      ];
    }),
    platformRoles,
  });
}

// ── ST-31.6: the writes (D-d) ────────────────────────────────────────────────────────────────
//
// The product-scope twins of `POST /bindings` and `PATCH|DELETE /bindings/<id>`, for a Product admin
// who holds `members` on this product and so cannot reach the platform rows. The role is fixed: a
// Product admin on this product, or Console access (G3, platform scope: inviting someone to a
// product brings the console with it). The checks and the audit are `./bindings.ts`'s.

/** `POST /products/<slug>/members`: `{member, role?, areas?, confirm?}`. */
export async function handleProductMemberCreate(
  c: AdminCtx,
): Promise<Response> {
  const slug = c.product!.slug;
  const body = await readBody(c.req);
  const extra = Object.keys(body).filter(
    (k) => !["member", "emails", "role", "areas", "confirm"].includes(k),
  );
  if (extra.length)
    return err(422, ErrorCode.BadRequest, "invalid request", {
      fields: extra,
      reason: "unknown_field",
    });
  const role = body.role === undefined ? "product_admin" : body.role;
  if (role !== "product_admin" && role !== "console_access")
    return err(422, ErrorCode.BadRequest, "invalid request", {
      fields: ["role"],
      reason: "role",
    });
  return createBinding(c, { slug }, body, {
    member: body.member,
    role,
    scope: role === "product_admin" ? `product:${slug}` : "platform",
    areas:
      role === "console_access" && body.areas === undefined ? null : body.areas,
  });
}

/** `PATCH /products/<slug>/members/<bindingId>`: `{areas, confirm?}`. */
export const handleProductMemberEdit = (c: AdminCtx) =>
  editBinding(c, { slug: c.product!.slug });

/** `DELETE /products/<slug>/members/<bindingId>`. */
export const handleProductMemberRevoke = (c: AdminCtx) =>
  revokeBinding(c, { slug: c.product!.slug });
