/**
 * Cloud Connect's admin surface: `/manage/api/products/<slug>/connect/…` (CC-16.W). The console's
 * RBAC area is `connect` (`test/fixtures/rbac-route-areas.json`). Read-only: the people with linked
 * devices and the relay's usage. The routes are narrative-only in the OpenAPI spec, as every admin
 * route is (rule 10 covers the router's routes).
 */

import type { ServiceContext } from "../../../core/registry.js";
import type { AdminSession } from "../../../core/console/session.js";
import { handlePeople } from "./people.js";
import { handleRelayUsage } from "./usage.js";

export type ConnectAdminContext = ServiceContext & { session: AdminSession };

export async function handleConnectAdmin(
  ctx: ConnectAdminContext,
): Promise<Response | null> {
  const [resource, ...rest] = ctx.rest;
  if (ctx.req.method !== "GET" || rest.length > 0) return null;
  if (resource === "people") return handlePeople(ctx);
  if (resource === "usage") return handleRelayUsage(ctx);
  return null;
}
