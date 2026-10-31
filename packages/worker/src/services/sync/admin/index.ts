/**
 * Cloud Sync's admin surface: `/manage/api/products/<slug>/sync/…` (U-05.19). The console's
 * RBAC area is `sync` (`test/fixtures/rbac-route-areas.json`). Read-only so far:
 *
 *   GET usage                  the product's Usage page (U-05.19)
 *   GET subjects/<subject>     one person's Data tab summary (U-11a.1)
 */

import type { ServiceContext } from "../../../core/registry.js";
import type { AdminSession } from "../../../core/console/session.js";
import { handleSubject } from "./subject.js";
import { handleUsage } from "./usage.js";

export type SyncAdminContext = ServiceContext & { session: AdminSession };

export async function handleSyncAdmin(
  ctx: SyncAdminContext,
): Promise<Response | null> {
  const [resource, ...rest] = ctx.rest;
  if (resource === "usage" && rest.length === 0 && ctx.req.method === "GET")
    return handleUsage(ctx);
  if (resource === "subjects" && rest.length === 1 && ctx.req.method === "GET")
    return handleSubject(ctx, rest[0] as string);
  return null;
}
