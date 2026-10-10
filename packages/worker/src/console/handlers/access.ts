/**
 * `GET /api/access/admins?scope=&area=` (ST-29; ST-28 plan §5.2): who can give the caller access
 * to an area in a scope. NoAccessPage and every disabled write control's reason name these people.
 *
 * Up to three people, narrowest first: the product's admins who hold the area (ST-31 adds them),
 * then Superadmins, who can give any role. Each is a name, a role and an address to copy; never an
 * account id or a subject (`accountIdBoundary.test.ts`).
 *
 * What a member may learn here (PRIVACY.md, "What an admin can see"):
 *   - Platform admins are never listed: they cannot give a product role to someone else, and
 *     naming the products they hold would reveal product names.
 *   - A product's own admins are listed only to a caller who already holds an area of that
 *     product. Anyone else gets the Superadmins alone, the same answer for a product that does not
 *     exist, so the route is no oracle for product slugs.
 *
 * Today's Superadmins are the root rule's holders: the platform admin group at the console IdP.
 * Nothing stores that list, so it is read from the sign-ins that proved it, the `admin.signin`
 * rows of the last session lifetime (8 h, the same freshness ST-30 gives the root rule), each
 * named by that operator's latest audited action. ST-30 and ST-31 replace the source with
 * accounts and bindings; the response keeps its shape.
 */

import type { Db } from "../../db/types.js";
import { ADMIN_SESSION_TTL_SECONDS } from "../../core/console/session.js";
import { adminJson, err } from "../../core/console/respond.js";
import { isAreaId } from "../authz.js";
import type { AdminCtx } from "../routes.js";

/** One person who can help. */
export interface AccessAdmin {
  name: string;
  email: string;
  /** The role that lets them give the access: `superadmin` today; `product_admin` with ST-31. */
  role: "superadmin" | "product_admin";
}

/** At most this many are named. */
export const ACCESS_ADMINS_LIMIT = 3;

/** How far back a signed-in operator's name is looked for in the audit trail. */
const NAME_LOOKBACK_SECONDS = 90 * 24 * 60 * 60;

const SCOPE_RE = /^(platform|product:[a-z0-9][a-z0-9-]{0,62})$/;

/**
 * The Superadmins who signed in within the root rule's freshness window, latest first, named as
 * their own audited actions name them. A sign-in row carries no name or address (security events
 * never do), so a member who signed in but has acted on nothing yet is not listed.
 */
async function recentSuperadmins(
  db: Db,
  excludeSub: string,
  now: number,
): Promise<AccessAdmin[]> {
  const signedIn = await db.all<{ actor_sub: string }>(
    `SELECT actor_sub, MAX(at) AS last_at FROM platform_audit
      WHERE action = 'admin.signin' AND at > ? AND actor_sub IS NOT NULL AND actor_sub != ?
      GROUP BY actor_sub
      ORDER BY last_at DESC
      LIMIT 20`,
    now - ADMIN_SESSION_TTL_SECONDS,
    excludeSub,
  );
  if (signedIn.length === 0) return [];
  const subs = signedIn.map((r) => r.actor_sub);
  const marks = subs.map(() => "?").join(", ");
  const named = await db.all<{
    actor_sub: string;
    actor_name: string | null;
    actor_email: string;
  }>(
    `SELECT actor_sub, actor_name, actor_email, at FROM (
       SELECT actor_sub, actor_name, actor_email, at FROM platform_audit
        WHERE at > ? AND actor_sub IN (${marks}) AND actor_email IS NOT NULL AND actor_email != ''
       UNION ALL
       SELECT actor_sub, actor_name, actor_email, at FROM audit
        WHERE at > ? AND actor_sub IN (${marks}) AND actor_email IS NOT NULL AND actor_email != ''
     )
     ORDER BY at DESC`,
    now - NAME_LOOKBACK_SECONDS,
    ...subs,
    now - NAME_LOOKBACK_SECONDS,
    ...subs,
  );
  const latest = new Map<string, { name: string; email: string }>();
  for (const r of named)
    if (!latest.has(r.actor_sub))
      latest.set(r.actor_sub, {
        name: r.actor_name || r.actor_email,
        email: r.actor_email,
      });
  const out: AccessAdmin[] = [];
  const emails = new Set<string>();
  for (const sub of subs) {
    const who = latest.get(sub);
    if (!who || emails.has(who.email)) continue;
    emails.add(who.email);
    out.push({ ...who, role: "superadmin" });
    if (out.length === ACCESS_ADMINS_LIMIT) break;
  }
  return out;
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

  // ST-31: the product's own admins who hold `area` come first, for a caller who holds an area of
  // that product. No product-scope bindings exist before it, so only Superadmins are named.
  const admins = await recentSuperadmins(c.db, c.session.sub, c.now);
  return adminJson({ scope, area, admins });
}
