/**
 * Invite conversion (ST-31.8; ST-28 plan §2.3, §2.5): a person signs in to the console and the
 * invites addressed to their verified primary email become their own bindings.
 *
 * An invite is a promise, not a credential. It names an address and a grant, and it turns into
 * access only when ALL of this holds at the sign-in (a failed check leaves the invite where it
 * is, converts nothing, and says nothing about why):
 *
 *   1. D-g: the inviter is not the converting person (`granted_by` is not their member id).
 *   2. The inviter's authority is re-checked NOW: the inviter resolves to an active, un-erased
 *      account that still holds a console grant and `mayGrant`s what the invite grants. An
 *      invite outlives the inviter's authority otherwise.
 *   3. The invite's address is the account's VERIFIED primary email (read through Identity's
 *      public API) and the console IdP vouched for that same address at this sign-in.
 *   4. That address is verified on exactly one active account: this one. Two claimants convert
 *      for neither.
 *   5. Via the operator connection (the console IdP sign-in) any valid invite converts; via a
 *      passkey (ST-31b) only the SM-6 eligible ones (`inviteBootstrapAllowed`): Superadmin,
 *      Platform admin and `products:*` never bootstrap without the operator IdP (SM-7).
 *   6. The account is active and `erasureVerdict` is `clear` (an unreadable ledger refuses).
 *   7. The row re-validates: `rowToGrant` reads it, a product scope names a real product that
 *      is not the system product, and `expires_at` is still in the future.
 *   8. The change is ONE batch: the member's binding (inserted, or unioned into the one they
 *      already hold, NULL winning), the `rbac.grant` audit rows (source invite) and the deletion
 *      of the invite, each carrying the invite's guard, so a concurrent edit, a racing sign-in
 *      or an expiry makes the whole conversion a no-op.
 *   9. A repeat sign-in finds no invite and converts nothing.
 *
 * Mail goes out after the commit, best effort: the inviter and every Superadmin are told, on the
 * priority path (no per-recipient hourly budget) when the grant is L2.
 */

import { erasureVerdict } from "../core/accounts/erasureFence.js";
import { platformAuditStatementFor, auditStatementFor } from "../core/audit.js";
import { memberIdFor } from "../core/console/memberId.js";
import type { AdminSession } from "../core/console/session.js";
import { accessInviteAcceptedNotice } from "../core/notify/templates.js";
import {
  findAccountBinding,
  listPendingInvites,
  newBindingId,
  rowToGrant,
  stmtsConvertInvite,
} from "../core/rbac/bindings.js";
import {
  can,
  type Grant,
  type GrantScope,
  type Principal,
} from "../core/rbac/can.js";
import {
  confirmLevel,
  inviteBootstrapAllowed,
  mayGrant,
  productSlugOf,
  type GrantSpec,
} from "../core/rbac/grantRules.js";
import { resolvePrincipal } from "../core/rbac/principal.js";
import { getProduct } from "../core/products/store.js";
import type { Db, DbStatement } from "../db/types.js";
import type { Env } from "../platform/env.js";
import {
  accountsWithVerifiedPrimaryEmail,
  consoleAccountForMember,
  consoleDirectoryRead,
  consoleRootHolders,
  consoleVerifiedPrimaryEmail,
  type ConsoleDirectoryEntry,
} from "../services/identity/public.js";
import {
  ROLE_LABEL,
  scopeLabel,
  sendOperatorNotice,
  superadminAccountIds,
} from "./handlers/accessShared.js";
import { PLATFORM } from "./authz.js";
import { SYSTEM_PRODUCT_SLUG } from "@polaris-key/manifest";

/** How the person signed in: the console IdP (operator connection), or a passkey (ST-31b). */
export type ConvertVia = "operator" | "passkey";

/** The most invites one sign-in converts, and the most operator mails it sends. */
const MAX_CONVERT = 20;
const MAIL_CAP = 50;

export interface ConvertArgs {
  accountId: string;
  /** The address the console IdP vouched for at THIS sign-in (`consoleAssertedEmail`), or `null`. */
  assertedEmail: string | null;
  via: ConvertVia;
}

export interface ConvertResult {
  /** How many invites became bindings. */
  converted: number;
}

const NONE: ConvertResult = { converted: 0 };

/** The `sub`, name and address an audit row names the converting person by. */
function actorOf(
  memberId: string,
  entry: ConsoleDirectoryEntry,
): Pick<AdminSession, "sub" | "name" | "email"> {
  return { sub: memberId, name: entry.name, email: entry.email };
}

/**
 * The inviter as they stand today: their principal, or `null` when they cannot be resolved, are
 * disabled, erased, or no longer hold any console grant. Cached per inviter for one sign-in.
 */
function inviterResolver(env: Env, db: Db, now: number) {
  const cache = new Map<
    string,
    Promise<{ principal: Principal; entry: ConsoleDirectoryEntry } | null>
  >();
  let roots: Promise<Set<string>> | null = null;
  const resolve = async (memberId: string) => {
    const accountId = await consoleAccountForMember(env, db, memberId);
    if (!accountId) return null;
    const read = await consoleDirectoryRead(env, db, [accountId], now, {
      lastSignIn: false,
    });
    const entry = read.entries.get(accountId);
    // Absent = erased or unknown; `incomplete` = the erasure ledger could not be read (fail closed).
    if (!entry || entry.disabled || read.incomplete) return null;
    roots ??= consoleRootHolders(env, db, now).then((ids) => new Set(ids));
    const principal = await resolvePrincipal(
      env,
      db,
      {
        sub: memberId,
        groups: [],
        root: (await roots).has(accountId),
        accountId,
      },
      now,
    );
    if (!can(principal, PLATFORM, "console", "view")) return null;
    return { principal, entry };
  };
  return (memberId: string) => {
    let hit = cache.get(memberId);
    if (!hit) {
      hit = resolve(memberId).catch(() => null);
      cache.set(memberId, hit);
    }
    return hit;
  };
}

/** The product a `product:<slug>` scope names, when it exists and is not the system product. */
async function productStillValid(
  db: Db,
  scope: GrantScope,
): Promise<{ ok: boolean; name: string | null }> {
  if (scope === "platform" || scope === "products:*")
    return { ok: true, name: null };
  const slug = productSlugOf(scope);
  if (!slug || slug === SYSTEM_PRODUCT_SLUG) return { ok: false, name: null };
  const product = await getProduct(db, slug);
  if (!product || product.system === 1) return { ok: false, name: null };
  return { ok: true, name: product.name ?? null };
}

/** The ten checks (module header) that do not need a particular invite. */
async function convertible(
  env: Env,
  db: Db,
  now: number,
  a: ConvertArgs,
): Promise<{ memberId: string; entry: ConsoleDirectoryEntry } | null> {
  if (!a.assertedEmail) return null;
  // 6. active, and not on the erasure ledger (read fails closed).
  if ((await erasureVerdict(env, now, a.accountId)) !== "clear") return null;
  const read = await consoleDirectoryRead(env, db, [a.accountId], now, {
    lastSignIn: false,
  });
  const entry = read.entries.get(a.accountId);
  if (!entry || entry.disabled || read.incomplete) return null;
  // 3. the verified primary email IS the asserted one.
  if ((await consoleVerifiedPrimaryEmail(db, a.accountId)) !== a.assertedEmail)
    return null;
  // 4. verified on this account alone.
  const claimants = await accountsWithVerifiedPrimaryEmail(db, a.assertedEmail);
  if (claimants.length !== 1 || claimants[0] !== a.accountId) return null;
  return { memberId: await memberIdFor(env, a.accountId), entry };
}

/**
 * Convert the invites addressed to this account's verified primary email. Never throws: a
 * failure converts nothing (the caller's post-gate then refuses a session with no grant).
 */
export async function convertInvites(
  env: Env,
  db: Db,
  now: number,
  args: ConvertArgs,
): Promise<ConvertResult> {
  try {
    return await convert(env, db, now, args);
  } catch {
    return NONE;
  }
}

async function convert(
  env: Env,
  db: Db,
  now: number,
  args: ConvertArgs,
): Promise<ConvertResult> {
  // The cheap read first: most sign-ins have no invite, and then nothing else is read.
  if (!args.assertedEmail) return NONE;
  const invites = (await listPendingInvites(db, args.assertedEmail, now)).slice(
    0,
    MAX_CONVERT,
  );
  if (invites.length === 0) return NONE;
  const me = await convertible(env, db, now, args);
  if (!me) return NONE;

  const inviterOf = inviterResolver(env, db, now);
  const done: {
    spec: GrantSpec;
    inviter: ConsoleDirectoryEntry;
    productName: string | null;
    product: string | null;
  }[] = [];

  for (const invite of invites) {
    // 7. the row reads, and its product is real.
    const grant: Grant | null = rowToGrant(invite);
    if (!grant || invite.email_norm !== args.assertedEmail) continue;
    const spec: GrantSpec = {
      role: grant.role,
      scope: grant.scope,
      areas: grant.areas,
    };
    // 1. D-g again, at conversion: nobody converts their own invitation.
    if (!invite.granted_by || invite.granted_by === me.memberId) continue;
    // 5. SM-6/SM-7: a passkey never bootstraps a platform role or `products:*`.
    if (args.via === "passkey" && !inviteBootstrapAllowed(spec)) continue;
    const valid = await productStillValid(db, grant.scope);
    if (!valid.ok) continue;
    // 2. the inviter, today.
    const inviter = await inviterOf(invite.granted_by);
    if (!inviter || !mayGrant(inviter.principal, spec)) continue;

    const existing = await findAccountBinding(
      db,
      args.accountId,
      invite.role,
      invite.scope,
    );
    const plan = stmtsConvertInvite({
      invite,
      accountId: args.accountId,
      existing,
      newId: newBindingId(),
      now,
    });
    if (!plan) continue;

    const product = productSlugOf(grant.scope);
    const actor = actorOf(me.memberId, me.entry);
    const summary = `${existing ? "Merged" : "Granted"} ${ROLE_LABEL[spec.role]} on ${spec.scope}${
      spec.areas ? ` (${spec.areas.join(", ")})` : ""
    } to ${me.memberId} from an invitation by ${invite.granted_by}`;
    const target = { kind: "console_role_binding", id: plan.bindingId };
    const change = {
      after: {
        bindingId: plan.bindingId,
        memberId: me.memberId,
        role: spec.role,
        scope: spec.scope,
        areas: plan.areas ? [...plan.areas] : null,
        source: "invite",
        grantedBy: invite.granted_by,
        via: args.via,
        merged: existing !== null,
      },
      ...(existing
        ? {
            before: {
              bindingId: existing.id,
              areas: rowToGrant(existing)?.areas ?? null,
            },
          }
        : {}),
    };
    const statements: DbStatement[] = [
      ...plan.write,
      platformAuditStatementFor(
        actor as AdminSession,
        now,
        "rbac.grant",
        target,
        summary,
        change,
        plan.when,
      ),
      ...(product
        ? [
            auditStatementFor(
              product,
              actor as AdminSession,
              now,
              "rbac.grant",
              target,
              summary,
              plan.when,
            ),
          ]
        : []),
      plan.remove,
    ];
    // 8. one batch; the last statement (the delete) says whether it applied.
    let applied: boolean;
    if (db.batchChanges) {
      const changes = await db.batchChanges(statements);
      applied = (changes[changes.length - 1] ?? 0) > 0;
    } else {
      await db.batch(statements);
      applied = !(await db.first(
        "SELECT 1 AS n FROM console_role_bindings WHERE id = ?",
        invite.id,
      ));
    }
    if (!applied) continue;
    done.push({
      spec,
      inviter: inviter.entry,
      productName: valid.name,
      product,
    });
  }
  if (done.length === 0) return NONE;
  await tell(env, db, now, me.entry, done);
  return { converted: done.length };
}

/** After the commit: the inviter and every Superadmin, best effort, priority for an L2 grant. */
async function tell(
  env: Env,
  db: Db,
  now: number,
  member: ConsoleDirectoryEntry,
  done: {
    spec: GrantSpec;
    inviter: ConsoleDirectoryEntry;
    productName: string | null;
  }[],
): Promise<void> {
  try {
    const supers = await superadminAccountIds(env, db, now);
    const dir = await consoleDirectoryRead(
      env,
      db,
      supers.map((s) => s.id),
      now,
      { lastSignIn: false },
    );
    const superAddresses = [...dir.entries.values()]
      .filter((e) => !e.disabled && e.email.trim())
      .map((e) => e.email.trim());
    let left = MAIL_CAP;
    for (const d of done) {
      const message = accessInviteAcceptedNotice({
        member: member.name || member.email,
        inviter: d.inviter.name || d.inviter.email,
        roleLabel: ROLE_LABEL[d.spec.role],
        scopeLabel: scopeLabel(d.spec.scope, d.productName),
        areas: d.spec.areas,
        origin: env.CONSOLE_ORIGIN,
      });
      const seen = new Set<string>();
      const to: string[] = [];
      for (const addr of [
        ...(d.inviter.disabled ? [] : [d.inviter.email.trim()]),
        ...superAddresses,
      ]) {
        const key = addr.toLowerCase();
        if (!addr || seen.has(key)) continue;
        seen.add(key);
        to.push(addr);
      }
      const recipients = to.slice(0, Math.max(0, left));
      left -= recipients.length;
      const priority = confirmLevel(d.spec) === "L2";
      await Promise.all(
        recipients.map((addr) =>
          sendOperatorNotice(env, db, addr, message, now, priority),
        ),
      );
    }
  } catch {
    // The conversion is committed; a mail that fails changes nothing.
  }
}
