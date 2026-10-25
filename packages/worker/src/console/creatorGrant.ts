/**
 * G6, the creator rule (ST-31.9, ST-28 plan §5.1): a person who creates a product through the
 * console can manage it. After `POST /products` or `POST /products/link-repo` succeeds, the
 * creator's account gets `product_admin` on `product:<slug>` with source `creator`, unless a grant
 * they already hold covers every area of that product (a Superadmin, `products:*`, or an
 * unnarrowed `product:<slug>` grant), in which case nothing is written.
 *
 * Who it applies to. Only a v2 console session with an account (`session.aid`) and a member id.
 * A `pkeya_` token and a break-glass or v1 session carry no `aid`, so they get no binding: a
 * token is never turned into a person. The creator must be signed in as a console member who may
 * create at all (the route's own `new_products` check ran first), so the rule never lets a
 * stranger make themselves an admin: it only attaches the product just made to the person who
 * made it. The scope is the new slug alone, never `products:*`, never the system product, and
 * the role is `product_admin` with every area, nothing wider. An erased account (the erasure
 * ledger, fail closed) gets nothing.
 *
 * The binding and its two audit rows (`rbac.grant` on the platform trail and the product's) are
 * one batch. The product already exists by then, so a failure here leaves a product its creator
 * cannot yet see rather than a binding to nothing; a Superadmin can grant access, and the write
 * never throws into the create response.
 *
 * D-f notices: the grant is always audited. Superadmins are told by mail unless the creator is
 * one (then no grant is written). The creator is never mailed about their own action.
 */

import { erasureVerdict } from "../core/accounts/erasureFence.js";
import { auditStatementFor, platformAuditStatementFor } from "../core/audit.js";
import { isMemberId } from "../core/console/memberId.js";
import { accessChangedNotice } from "../core/notify/templates.js";
import {
  findAccountBinding,
  newBindingId,
  stmtInsertBinding,
} from "../core/rbac/bindings.js";
import { PRODUCT_AREAS } from "../core/rbac/areas.js";
import { can } from "../core/rbac/can.js";
import { SYSTEM_PRODUCT_SLUG } from "@polaris-key/manifest";
import type { Db } from "../db/types.js";
import type { Env } from "../platform/env.js";
import { consoleDirectory } from "../services/identity/public.js";
import type { AdminSession } from "../core/console/session.js";
import {
  ROLE_LABEL,
  sendOperatorNotice,
  superadminAccountIds,
} from "./handlers/accessShared.js";

/** The most addresses one creator notice goes to. */
const NOTICE_CAP = 25;

export type CreatorGrantResult = "granted" | "covered" | "skipped";

/**
 * Give the creator of `slug` (named by `product.name` for the notice) the creator binding.
 * Never throws. `granted` when a row was written, `covered` when an existing grant already
 * reaches every area, `skipped` for a session with no account, the system product, an erased
 * account, or a failed write.
 */
export async function grantCreator(
  env: Env,
  db: Db,
  session: AdminSession,
  slug: string,
  productName: string | null,
  now: number,
): Promise<CreatorGrantResult> {
  try {
    const accountId = session.aid;
    const memberId = session.principal?.memberId;
    if (!accountId || !memberId || !isMemberId(memberId)) return "skipped";
    if (slug === SYSTEM_PRODUCT_SLUG) return "skipped";
    const principal = session.principal;
    if (
      PRODUCT_AREAS.every((area) =>
        can(principal, { kind: "product", slug, system: false }, area, "edit"),
      )
    )
      return "covered";
    if ((await erasureVerdict(env, now, accountId)) !== "clear")
      return "skipped";
    // The unique index allows one `(account, role, scope)` row. An existing one is never widened
    // here (a narrowed grant on a brand-new slug can only be a remnant): the rule writes nothing.
    if (
      await findAccountBinding(
        db,
        accountId,
        "product_admin",
        `product:${slug}`,
      )
    )
      return "skipped";
    const id = newBindingId();
    const scope = `product:${slug}` as const;
    const after = {
      bindingId: id,
      memberId,
      role: "product_admin",
      scope,
      areas: null,
      source: "creator",
      grantedAt: now,
    };
    const target = { kind: "console_role_binding", id };
    const summary = `Gave the creator Product admin on ${scope}: ${memberId}`;
    await db.batch([
      stmtInsertBinding({
        id,
        accountId,
        emailNorm: null,
        role: "product_admin",
        scope,
        areas: null,
        source: "creator",
        grantedBy: memberId,
        grantedAt: now,
      }),
      platformAuditStatementFor(session, now, "rbac.grant", target, summary, {
        after,
      }),
      auditStatementFor(slug, session, now, "rbac.grant", target, summary),
    ]);
    await tellSuperadmins(env, db, session, accountId, slug, productName, now);
    return "granted";
  } catch {
    return "skipped";
  }
}

/** Every active Superadmin with an address, best effort, after the commit. */
async function tellSuperadmins(
  env: Env,
  db: Db,
  session: AdminSession,
  creatorAccountId: string,
  slug: string,
  productName: string | null,
  now: number,
): Promise<void> {
  try {
    const supers = await superadminAccountIds(env, db, now);
    const ids = supers.map((s) => s.id).filter((id) => id !== creatorAccountId);
    if (ids.length === 0) return;
    const dir = await consoleDirectory(
      env,
      db,
      [creatorAccountId, ...ids],
      now,
    );
    const creator = dir.get(creatorAccountId);
    const message = accessChangedNotice({
      change: "granted",
      member: creator?.name || creator?.email || session.name || session.email,
      actor: creator?.name || creator?.email || session.name || session.email,
      roleLabel: ROLE_LABEL.product_admin,
      scopeLabel: productName ?? slug,
      areas: null,
      origin: env.CONSOLE_ORIGIN,
    });
    const seen = new Set<string>();
    const to: string[] = [];
    for (const id of ids) {
      const e = dir.get(id);
      const addr = e?.email.trim();
      if (!e || e.disabled || !addr) continue;
      if (seen.has(addr.toLowerCase())) continue;
      seen.add(addr.toLowerCase());
      to.push(addr);
    }
    await Promise.all(
      to
        .slice(0, NOTICE_CAP)
        .map((addr) => sendOperatorNotice(env, db, addr, message, now)),
    );
  } catch {
    // The binding is committed; a mail that fails changes nothing.
  }
}
