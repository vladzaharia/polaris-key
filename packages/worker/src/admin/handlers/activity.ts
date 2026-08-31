/**
 * Per-product audit activity feed (`/api/products/<slug>/activity`): a keyset-paginated
 * list of audit rows, newest first, with a `nextCursor` when more remain.
 */

import type { Db } from "../../db/types.js";
import { clampAuditLimit, listAudit } from "../../repo.js";
import { adminJson } from "../lib/respond.js";

export async function handleActivity(
  req: Request,
  db: Db,
  slug: string,
): Promise<Response> {
  const url = new URL(req.url);
  const beforeAt = url.searchParams.get("beforeAt");
  const beforeId = url.searchParams.get("beforeId");
  // B4-03. `Number(param) || 50` looked like a guard and was not one: `-1` is truthy, so it
  // survived to `listAudit`, whose `Math.min(…, 200)` has no floor either, and reached SQLite as
  // `LIMIT -1` — unbounded. Clamped HERE as well as there, with the same function, for a second
  // reason: `nextCursor` below compares `rows.length` against this variable, so if the handler's
  // idea of the page size and the query's ever diverged, `?limit=500` would return 200 rows and
  // then report that there were no more.
  const raw = url.searchParams.get("limit");
  const limit = clampAuditLimit(raw === null ? undefined : Number(raw));
  const rows = await listAudit(db, slug, {
    beforeAt: beforeAt ? Number(beforeAt) : undefined,
    beforeId: beforeId ?? undefined,
    limit,
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
