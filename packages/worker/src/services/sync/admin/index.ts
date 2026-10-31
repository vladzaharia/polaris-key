/**
 * Cloud Sync's admin surface: `/manage/api/products/<slug>/sync/…` (U-05.19). The console's
 * RBAC area is `sync` (`test/fixtures/rbac-route-areas.json`). Read-only so far:
 *
 *   GET usage                  the product's Usage page (U-05.19)
 *   GET subjects/<subject>     one person's Data tab summary (U-11a.1)
 *   GET subjects/<subject>/values                    server mode: setting values (U-11a.2)
 *   GET subjects/<subject>/values?collection=&cursor= server mode: one page of records
 *   GET subjects/<subject>/files/<collection>/<id>[/revisions][?version=]
 *   POST subjects/<subject>/delete                   erase the person's Cloud Sync data
 *
 * The values, files and delete routes need a step-up (`403 step_up_required`), refuse an
 * end-to-end product (`404`: the server holds no value to show) and write one audit row each.
 */

import type { ServiceContext } from "../../../core/registry.js";
import type { AdminSession } from "../../../core/console/session.js";
import { handleSubject } from "./subject.js";
import { handleUsage } from "./usage.js";
import { handleDelete, handleFile, handleValues } from "./values.js";

export type SyncAdminContext = ServiceContext & { session: AdminSession };

export async function handleSyncAdmin(
  ctx: SyncAdminContext,
): Promise<Response | null> {
  const [resource, ...rest] = ctx.rest;
  if (resource === "usage" && rest.length === 0 && ctx.req.method === "GET")
    return handleUsage(ctx);
  if (resource === "subjects" && rest.length === 1 && ctx.req.method === "GET")
    return handleSubject(ctx, rest[0] as string);
  if (resource === "subjects" && rest.length >= 2) {
    const [subject = "", action, ...tail] = rest;
    const method = ctx.req.method;
    if (action === "values" && tail.length === 0 && method === "GET")
      return handleValues(ctx, subject);
    if (action === "delete" && tail.length === 0 && method === "POST")
      return handleDelete(ctx, subject);
    if (action === "files" && method === "GET" && tail.length >= 2) {
      const [collection = "", id = "", more, ...extra] = tail;
      if (extra.length === 0 && (more === undefined || more === "revisions"))
        return handleFile(ctx, subject, {
          collection,
          id,
          revisions: more === "revisions",
        });
    }
  }
  return null;
}
