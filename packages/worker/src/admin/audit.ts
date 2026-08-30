// Every admin mutation appends one audit row. The actor (sub/name/email) is taken from the
// VERIFIED session, never from a request field; `at` is server time. Product-scoped like
// everything else. Reads use the parent repo's keyset-paginated `listAudit`.

import type { Db } from "../db/types.js";
import { appendAudit } from "../repo.js";
import { randomId } from "../crypto.js";
import type { AdminSession } from "./session.js";

/**
 * The three session fields an audit row records.
 *
 * Narrower than `AdminSession` so a non-session actor can be audited too: a manifest resync
 * runs from a GitHub push webhook and has no session at all, yet it rewrites more product state
 * than any console action — see `MANIFEST_ACTOR` in `services/release/resync.ts`. Every session
 * satisfies this shape, so no existing caller changes; what it deliberately does NOT admit is
 * anything reaching for `groups` or `csrf` to make an authorization decision down here.
 */
export type AuditActor = Pick<AdminSession, "sub" | "name" | "email">;

export async function audit(
  db: Db,
  product: string,
  session: AuditActor,
  now: number,
  action: string,
  target: { kind: string; id: string } | null,
  summary: string,
): Promise<void> {
  await appendAudit(db, {
    product,
    id: randomId("aud"),
    at: now,
    actor_sub: session.sub,
    actor_name: session.name,
    actor_email: session.email,
    action,
    target_kind: target?.kind ?? null,
    target_id: target?.id ?? null,
    parent_id: null,
    summary,
  });
}
