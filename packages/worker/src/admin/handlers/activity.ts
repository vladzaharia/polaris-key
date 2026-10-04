/**
 * Per-product audit activity feed (`/api/products/<slug>/activity`): a keyset-paginated
 * list of audit rows, newest first, with a `nextCursor` when more remain.
 *
 * A-2 (docs/design/ADMIN.md §7.3): the feed filters on the server, so the console's Activity
 * page and the per-record History tabs page through matching rows instead of filtering what one
 * page happened to load:
 *
 *   action      a prefix: `license.` matches every license action
 *   actor       a subject or an email, exactly; `system` for rows the runtime wrote
 *   targetKind  exact (`license`, `profile`, `key`…)
 *   targetId    exact
 *   since       epoch seconds, inclusive
 *   until       epoch seconds, inclusive
 *
 * The cursor carries no filter: the caller sends the same filters with every page.
 */

import type { Db } from "../../db/types.js";
import { ErrorCode } from "../../core/errors.js";
import { listAudit, type AuditFilters } from "../../repo.js";
import { adminJson, err } from "../lib/respond.js";

/** The longest filter value accepted: longer than any action, kind, id or email we write. */
const MAX_FILTER = 200;

export async function handleActivity(
  req: Request,
  db: Db,
  slug: string,
): Promise<Response> {
  const url = new URL(req.url);
  const beforeAt = url.searchParams.get("beforeAt");
  const beforeId = url.searchParams.get("beforeId");
  const limit = Number(url.searchParams.get("limit")) || 50;

  const filters: AuditFilters = {};
  const bad: string[] = [];
  for (const name of ["action", "actor", "targetKind", "targetId"] as const) {
    const raw = url.searchParams.get(name);
    if (raw === null || raw === "") continue;
    if (raw.length > MAX_FILTER) bad.push(name);
    else filters[name] = raw;
  }
  for (const name of ["since", "until"] as const) {
    const raw = url.searchParams.get(name);
    if (raw === null || raw === "") continue;
    const n = Number(raw);
    if (!Number.isSafeInteger(n) || n < 0) bad.push(name);
    else filters[name] = n;
  }
  if (bad.length) {
    return err(422, ErrorCode.BadRequest, "invalid activity filter", {
      fields: bad,
    });
  }

  const rows = await listAudit(db, slug, {
    beforeAt: beforeAt ? Number(beforeAt) : undefined,
    beforeId: beforeId ?? undefined,
    limit,
    ...filters,
  });
  const items = rows.map((r) => ({
    id: r.id,
    at: r.at,
    actor: {
      sub: r.actor_sub ?? "",
      name: r.actor_name ?? "",
      email: r.actor_email ?? "",
    },
    action: r.action,
    target: r.target_kind
      ? { kind: r.target_kind, id: r.target_id ?? "" }
      : null,
    summary: r.summary ?? "",
  }));
  const last = rows[rows.length - 1];
  const nextCursor =
    rows.length >= limit && last
      ? { beforeAt: last.at, beforeId: last.id }
      : null;
  return adminJson({ items, nextCursor });
}
