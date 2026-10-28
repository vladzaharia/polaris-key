/**
 * What the grant writes and the invite writes (both in `./bindings.ts`) and the Members reads
 * (`./productMembers.ts`, `./access.ts`) share, so none of them imports another
 * (ST-31.6 follow-up: the old bindings <-> productMembers import cycle).
 */

import { ErrorCode } from "../../core/errors.js";
import { err } from "../../core/console/respond.js";
import { deliverEmail } from "../../core/notify/emailDelivery.js";
import { recipientHash } from "../../core/notify/emailLimits.js";
import type { NoticeMessage } from "../../core/notify/templates.js";
import { rowToGrant, listStoredSuperadmins } from "../../core/rbac/bindings.js";
import type { GrantScope, Role } from "../../core/rbac/can.js";
import { rateLimitOk } from "../../core/rateLimit.js";
import type { Db } from "../../db/types.js";
import type { Env } from "../../platform/env.js";
import { consoleRootHolders } from "../../services/identity/public.js";

/** Operator notices one address may receive per hour, whoever caused them. */
export const OPERATOR_NOTICE_PER_RECIPIENT_HOUR = 10;

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

/**
 * Send one operator notice (sender Polaris Key) to one address, within the per-recipient hourly
 * budget. Best effort: `false` for email off, an address that is suppressed or refused, a notice
 * over budget, a limiter outage (the budget fails closed) or any error. The address is hashed for
 * the budget; nothing is stored.
 *
 * `priority` skips the budget (ST-31.7 B1): the G5 notice of an L2 change (Superadmin, Platform
 * admin or `products:*`) must not be silenced by ten cheap invitations spending a Superadmin's
 * hour. Only Superadmin step-up writes, bounded by `adminGrantWrite`, set it.
 */
export async function sendOperatorNotice(
  env: Env,
  db: Db,
  to: string,
  message: NoticeMessage,
  now: number,
  priority = false,
): Promise<boolean> {
  try {
    if (!env.EMAIL) return false;
    const within =
      priority ||
      (await rateLimitOk(
        env,
        "_admin",
        {
          bucket: "emailOperatorNoticeHour",
          id: await recipientHash(env, to),
          limit: OPERATOR_NOTICE_PER_RECIPIENT_HOUR,
          windowSec: 3600,
        },
        now,
      ));
    if (!within) return false;
    const r = await deliverEmail(
      env,
      db,
      { sender: { kind: "platform", audience: "operator" }, to, ...message },
      now,
    );
    return r.ok;
  } catch {
    return false;
  }
}

/** The role names a notice and an audit summary use. */
export const ROLE_LABEL: Record<Role, string> = {
  superadmin: "Superadmin",
  platform_admin: "Platform admin",
  product_admin: "Product admin",
  console_access: "Console access",
};

/** A scope as a notice names it. */
export function scopeLabel(
  scope: GrantScope,
  productName: string | null,
): string {
  if (scope === "platform") return "the platform";
  if (scope === "products:*") return "all products";
  return productName ?? scope.slice("product:".length);
}

/** A 422 `bad_request` naming the offending fields (and, optionally, why). */
export const invalidRequest = (
  fields: string[],
  reason?: string,
  message?: string,
) =>
  err(422, ErrorCode.BadRequest, message ?? "invalid request", {
    fields,
    ...(reason ? { reason } : {}),
  });

/** Only these body fields are read; anything else is refused, not ignored. */
export function unknownFields(
  body: Record<string, unknown>,
  allowed: readonly string[],
): string[] {
  return Object.keys(body).filter((k) => !allowed.includes(k));
}
