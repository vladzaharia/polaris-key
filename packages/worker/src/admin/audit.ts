// Every admin mutation appends one audit row. The actor (sub/name/email) is taken from the
// VERIFIED session, never from a request field; `at` is server time. Product-scoped like
// everything else. Reads use the parent repo's keyset-paginated `listAudit`.
//
// A-12: an action on the platform as a whole (no product) goes through `platformAudit` into
// `platform_audit` instead, read by `GET /manage/api/platform/activity`.

import type { Db } from "../db/types.js";
import {
  appendAudit,
  appendPlatformAudit,
  auditStatement,
  platformAuditStatement,
  type PlatformAuditRow,
} from "../repo.js";
import type { DbStatement } from "../db/types.js";
import { randomId } from "../crypto.js";
import type { AdminSession } from "./session.js";

export async function audit(
  db: Db,
  product: string,
  session: AdminSession,
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

/** `audit` as a statement, for a batch that commits the row with the change it records. */
export function auditStatementFor(
  product: string,
  session: AdminSession,
  now: number,
  action: string,
  target: { kind: string; id: string } | null,
  summary: string,
): DbStatement {
  return auditStatement({
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

/**
 * Append one `platform_audit` row (A-12): an admin action that belongs to no product. Same actor
 * rule as `audit` (the verified session, server time). `change.before` / `change.after` are
 * stored as JSON so the activity feed can show what changed; a caller must never pass a secret,
 * key material or anything derived from one (a hash, a length) in either.
 */
function platformAuditRow(
  session: AdminSession,
  now: number,
  action: string,
  target: { kind: string; id: string } | null,
  summary: string,
  change: { before?: unknown; after?: unknown },
): PlatformAuditRow {
  return {
    id: randomId("paud"),
    at: now,
    actor_sub: session.sub,
    actor_name: session.name,
    actor_email: session.email,
    action,
    target_kind: target?.kind ?? null,
    target_id: target?.id ?? null,
    summary,
    before_json:
      change.before === undefined ? null : JSON.stringify(change.before),
    after_json:
      change.after === undefined ? null : JSON.stringify(change.after),
  };
}

export async function platformAudit(
  db: Db,
  session: AdminSession,
  now: number,
  action: string,
  target: { kind: string; id: string } | null,
  summary: string,
  change: { before?: unknown; after?: unknown } = {},
): Promise<void> {
  await appendPlatformAudit(
    db,
    platformAuditRow(session, now, action, target, summary, change),
  );
}

/** `platformAudit` as a statement, for a batch that commits it with the change it records. */
export function platformAuditStatementFor(
  session: AdminSession,
  now: number,
  action: string,
  target: { kind: string; id: string } | null,
  summary: string,
  change: { before?: unknown; after?: unknown } = {},
): DbStatement {
  return platformAuditStatement(
    platformAuditRow(session, now, action, target, summary, change),
  );
}
