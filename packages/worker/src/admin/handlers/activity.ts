/**
 * Per-product audit activity feed (`/api/products/<slug>/activity`): a keyset-paginated
 * list of audit rows, newest first, with a `nextCursor` when more remain.
 */

import type { Db } from "../../db/types.js";
import { listAudit } from "../../repo.js";
import { adminJson } from "../lib/respond.js";

export async function handleActivity(req: Request, db: Db, slug: string): Promise<Response> {
  const url = new URL(req.url);
  const beforeAt = url.searchParams.get("beforeAt");
  const beforeId = url.searchParams.get("beforeId");
  const limit = Number(url.searchParams.get("limit")) || 50;
  const rows = await listAudit(db, slug, {
    beforeAt: beforeAt ? Number(beforeAt) : undefined,
    beforeId: beforeId ?? undefined,
    limit,
  });
  const items = rows.map((r) => ({
    id: r.id,
    at: r.at,
    actor: { sub: r.actor_sub ?? "", name: r.actor_name ?? "", email: r.actor_email ?? "" },
    action: r.action,
    target: r.target_kind ? { kind: r.target_kind, id: r.target_id ?? "" } : null,
    summary: r.summary ?? "",
  }));
  const last = rows[rows.length - 1];
  const nextCursor = rows.length >= limit && last ? { beforeAt: last.at, beforeId: last.id } : null;
  return adminJson({ items, nextCursor });
}
