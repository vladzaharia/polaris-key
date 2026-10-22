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

import { adminJson } from "../../core/console/respond.js";
import {
  listAllInvites,
  listScopeBindings,
  listStoredSuperadmins,
  listWideProductAdmins,
  rowToGrant,
} from "../../core/rbac/bindings.js";
import {
  consoleDirectoryPeople,
  consoleRootHolders,
  type ConsoleDirectoryPerson,
} from "../../services/identity/public.js";
import type { Db } from "../../db/types.js";
import type { Env } from "../../platform/env.js";
import type { AdminCtx } from "../routes.js";

const LIMIT = 500;

/** Every current Superadmin account: the root rule's holders plus stored bindings. */
export async function superadminAccountIds(
  env: Env,
  db: Db,
  now: number,
): Promise<{ id: string; source: "root" | "grant" }[]> {
  const out = new Map<string, "root" | "grant">();
  for (const id of await consoleRootHolders(env, db, now)) out.set(id, "root");
  for (const row of await listStoredSuperadmins(db)) {
    // A row the reader cannot understand grants nothing, so it is not listed either.
    if (rowToGrant(row) && !out.has(row.account_id!))
      out.set(row.account_id!, "grant");
  }
  return [...out].map(([id, source]) => ({ id, source }));
}

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
