/**
 * Cloud Sync's admin surface: `/manage/api/products/<slug>/sync/…` (U-05.19). The console's
 * RBAC area is `sync` (`test/fixtures/rbac-route-areas.json`). Read-only so far.
 */

import type { ServiceContext } from "../../../core/registry.js";
import type { AdminSession } from "../../../core/console/session.js";
import { handleUsage } from "./usage.js";

export type SyncAdminContext = ServiceContext & { session: AdminSession };

export async function handleSyncAdmin(
  ctx: SyncAdminContext,
): Promise<Response | null> {
  const [resource, ...rest] = ctx.rest;
  if (resource === "usage" && rest.length === 0 && ctx.req.method === "GET")
    return handleUsage(ctx);
  return null;
}
