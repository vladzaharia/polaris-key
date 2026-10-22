/**
 * The Platform Members read API (ST-31.4; ST-28 plan §2.6, §5.2):
 *
 *   GET /members            the root rule's group, every member (an account with a binding, or a
 *                           current root holder) with roles and sources, and the pending invites
 *   GET /members/<memberId> one member
 *
 * Platform scope, area `members` (`./routes.ts`). Session only: the rows name no `tokenScope`.
 *
 * Privacy. A body names a person by their member id (`mbr_…`), display name and address, and by
 * nothing else: the account id stays inside this file's joins and is never serialised. The id in
 * the path is never decoded (it is one-way); the handler computes the id of each candidate and
 * compares, so a forged or stale id is a 404 that says nothing. The directory is asked only about
 * accounts that hold a binding or the root rule, so a non-member is never read or named. A binding
 * granted by someone who is no longer a member shows `grantedBy: { name: null }`.
 *
 * Caps. The list answers 500 members and 500 invites from at most 2000 bindings and says
 * `truncated: true` when any cap cut it. `/members/<id>` reads up to 20000 bindings so a real member
 * past the list's cap is still found.
 */

import { adminJson, notFound } from "../../core/console/respond.js";
import { isMemberId } from "../../core/console/memberId.js";
import {
  listAccountBindings,
  listAllInvites,
  rowToGrant,
  type BindingRow,
} from "../../core/rbac/bindings.js";
import {
  consoleDirectory,
  consoleRootHolders,
  type ConsoleDirectoryEntry,
} from "../../services/identity/public.js";
import type { AdminCtx } from "../routes.js";

/** At most this many members and invites are answered (the page is a roster, not a log). */
const LIMIT = 500;
/** The most bindings read to build the roster. */
const BINDING_LIMIT = 2000;
/** `GET /members/<id>` reads far wider so a real member past the list's cap is still found. */
const ONE_LIMIT = 20000;

interface RoleView {
  role: string;
  scope: string;
  /** `null` = every area (a product admin only). */
  areas: string[] | null;
  /** `root` (computed, cannot be revoked), `grant`, `invite` or `creator`. */
  source: string;
  /** The binding to revoke; `null` for the root rule. */
  bindingId: string | null;
  /** `null` = the system / the root rule; `{ name: null }` = someone who is no longer a member. */
  grantedBy: { name: string | null } | null;
  grantedAt: number | null;
}

interface MemberView extends ConsoleDirectoryEntry {
  you: boolean;
  roles: RoleView[];
}

const ROOT_ROLE: RoleView = {
  role: "superadmin",
  scope: "platform",
  areas: null,
  source: "root",
  bindingId: null,
  grantedBy: null,
  grantedAt: null,
};

interface Built {
  members: MemberView[];
  /** memberId -> display name, for `grantedBy` and `invitedBy`. */
  names: Map<string, string>;
  bindings: BindingRow[];
  /** A cap cut the bindings or the members. */
  truncated: boolean;
}

async function build(c: AdminCtx, one = false): Promise<Built> {
  const bindingCap = one ? ONE_LIMIT : BINDING_LIMIT;
  const memberCap = one ? ONE_LIMIT : LIMIT;
  const fetched = await listAccountBindings(c.db, bindingCap);
  let truncated = fetched.length > bindingCap;
  const bound = fetched.slice(0, bindingCap);
  const roots = await consoleRootHolders(c.env, c.db, c.now);
  const ids = [...new Set([...bound.map((b) => b.account_id!), ...roots])];
  const dir = await consoleDirectory(c.env, c.db, ids, c.now);
  const names = new Map<string, string>();
  for (const e of dir.values()) names.set(e.memberId, e.name || e.email);

  const byAccount = new Map<string, RoleView[]>();
  for (const id of roots) byAccount.set(id, [{ ...ROOT_ROLE }]);
  for (const row of bound) {
    const grant = rowToGrant(row);
    if (!grant) continue; // unreadable rows grant nothing, so they are not shown as a role
    const list = byAccount.get(row.account_id!) ?? [];
    list.push({
      role: grant.role,
      scope: grant.scope,
      areas: grant.areas ? [...grant.areas] : null,
      source: grant.source,
      bindingId: row.id,
      grantedBy: row.granted_by
        ? { name: names.get(row.granted_by) ?? null }
        : null,
      grantedAt: row.granted_at,
    });
    byAccount.set(row.account_id!, list);
  }
  const members: MemberView[] = [];
  for (const [accountId, roles] of byAccount) {
    const entry = dir.get(accountId);
    if (!entry) continue;
    members.push({
      ...entry,
      you:
        (c.session.aid !== undefined && c.session.aid === accountId) ||
        c.session.sub === entry.memberId,
      roles,
    });
  }
  members.sort(
    (a, b) =>
      (a.name || a.email).localeCompare(b.name || b.email) ||
      a.memberId.localeCompare(b.memberId),
  );
  if (members.length > memberCap) {
    members.length = memberCap;
    truncated = true;
  }
  return { members, names, bindings: bound, truncated };
}

/** `GET /members`. */
export async function handleMembersList(c: AdminCtx): Promise<Response> {
  const built = await build(c);
  const { members, names } = built;
  const fetchedInvites = await listAllInvites(c.db, c.now, LIMIT);
  const invites = fetchedInvites.slice(0, LIMIT);
  return adminJson({
    rootRule: { group: c.env.PLATFORM_ADMIN_GROUP ?? null },
    truncated: built.truncated || fetchedInvites.length > LIMIT,
    members,
    invites: invites.flatMap((row) => {
      const grant = rowToGrant(row);
      if (!grant) return [];
      return [
        {
          bindingId: row.id,
          email: row.email_norm,
          role: grant.role,
          scope: grant.scope,
          areas: grant.areas ? [...grant.areas] : null,
          invitedBy: row.granted_by
            ? { name: names.get(row.granted_by) ?? null }
            : null,
          sentAt: row.granted_at,
          expiresAt: row.expires_at,
        },
      ];
    }),
  });
}

/** `GET /members/<memberId>`: found by computing each candidate's id, never by decoding. */
export async function handleMemberGet(c: AdminCtx): Promise<Response> {
  const id = c.params.memberId ?? "";
  if (!isMemberId(id)) return notFound();
  const { members } = await build(c, true);
  const member = members.find((m) => m.memberId === id);
  return member ? adminJson({ member }) : notFound();
}
