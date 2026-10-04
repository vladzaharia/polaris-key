/**
 * The platform audit seam (A-16). An action on the platform as a whole — a team-level store
 * credential set, cleared or opened, the Apple Team ID changed, an app assigned to a product —
 * belongs to no product, and `audit.product` is `NOT NULL REFERENCES products`.
 *
 * Its home is A-12's `platform_audit` table (notes/S-13 §6.1, the product-less twin of `audit`).
 * A-12 had not merged when A-16 was written, so every platform event goes through this ONE
 * function, which writes the S-13 row shape into `platform_audit` when the table exists and,
 * until it does, emits the same row as one structured `console.log` line (Workers Logs keep it)
 * instead of dropping it. When A-12 merges the table appears and this starts writing rows with no
 * code change; the follow-up is only to route callers through A-12's `platformAudit()` helper and
 * delete the fallback.
 *
 * A caller must never put a secret, key material or anything derived from one (a hash, a length)
 * in any field: `summary`, `before` and `after` are display text.
 */

import type { Db } from "../db/types.js";
import { randomId } from "../crypto.js";

export interface PlatformEventActor {
  sub: string;
  name: string | null;
  email: string | null;
}

/** The actor of a platform event the Worker itself caused (a connector opening a team key). */
export const PLATFORM_SYSTEM_ACTOR: PlatformEventActor = {
  sub: "system:distribution",
  name: "Distribution service",
  email: null,
};

export interface PlatformEvent {
  actor: PlatformEventActor;
  at: number;
  action: string;
  target: { kind: string; id: string } | null;
  summary: string;
  before?: unknown;
  after?: unknown;
}

/** Where the last event went — exported for tests. */
export type PlatformEventSink = "platform_audit" | "log";

/** Append one platform event. Never throws for a missing table; rethrows anything else. */
export async function appendPlatformEvent(
  db: Db,
  e: PlatformEvent,
): Promise<PlatformEventSink> {
  const row = {
    id: randomId("paud"),
    at: e.at,
    actor_sub: e.actor.sub,
    actor_name: e.actor.name,
    actor_email: e.actor.email,
    action: e.action,
    target_kind: e.target?.kind ?? null,
    target_id: e.target?.id ?? null,
    summary: e.summary,
    before_json: e.before === undefined ? null : JSON.stringify(e.before),
    after_json: e.after === undefined ? null : JSON.stringify(e.after),
  };
  try {
    await db.run(
      `INSERT INTO platform_audit (id, at, actor_sub, actor_name, actor_email, action, target_kind, target_id, summary, before_json, after_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.id,
      row.at,
      row.actor_sub,
      row.actor_name,
      row.actor_email,
      row.action,
      row.target_kind,
      row.target_id,
      row.summary,
      row.before_json,
      row.after_json,
    );
    return "platform_audit";
  } catch (err) {
    if (!/no such table/i.test(err instanceof Error ? err.message : ""))
      throw err;
    console.log(JSON.stringify({ event: "platform_audit", ...row }));
    return "log";
  }
}
