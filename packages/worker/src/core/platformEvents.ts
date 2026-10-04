/**
 * The platform audit seam (A-16). An action on the platform as a whole — a team-level store
 * credential set, cleared or opened, a store setting changed, an app assigned to a product —
 * belongs to no product, and `audit.product` is `NOT NULL REFERENCES products`.
 *
 * Its home is A-12's `platform_audit` table (notes/S-13 §6.1, the product-less twin of `audit`).
 * A-12 had not merged when A-16 was written, so A-16's migration creates the same table with the
 * same statement (`IF NOT EXISTS`; see `0055_platform_store_connections.sql`) and every platform
 * event goes through this ONE function. When A-12 merges, the follow-up is only to route callers
 * through A-12's `platformAudit()` helper (same columns) and delete this file.
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

/** Append one platform event to `platform_audit`. */
export async function appendPlatformEvent(
  db: Db,
  e: PlatformEvent,
): Promise<void> {
  await db.run(
    `INSERT INTO platform_audit (id, at, actor_sub, actor_name, actor_email, action, target_kind, target_id, summary, before_json, after_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    randomId("paud"),
    e.at,
    e.actor.sub,
    e.actor.name,
    e.actor.email,
    e.action,
    e.target?.kind ?? null,
    e.target?.id ?? null,
    e.summary,
    e.before === undefined ? null : JSON.stringify(e.before),
    e.after === undefined ? null : JSON.stringify(e.after),
  );
}
