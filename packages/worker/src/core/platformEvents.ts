/**
 * The platform audit seam (A-16). An action on the platform as a whole — a team-level store
 * credential set, cleared or opened team-wide, a store setting changed, an app assigned to a
 * product — belongs to no product, so it is a row of A-12's `platform_audit` (written by
 * `appendPlatformAudit` in `repo.ts`, read by `GET /manage/api/platform/activity`, pruned by the
 * nightly 180-day retention with the rest of the table). This adapter only lets Core code that has
 * no admin session (a team-wide key open on an admin's behalf) write the same row shape.
 *
 * A caller must never put a secret, key material or anything derived from one (a hash, a length)
 * in any field: `summary`, `before` and `after` are display text.
 */

import type { Db } from "../db/types.js";
import { randomId } from "../crypto.js";
import { appendPlatformAudit } from "../repo.js";

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

/** Append one platform event to `platform_audit` (through A-12's `appendPlatformAudit`). */
export async function appendPlatformEvent(
  db: Db,
  e: PlatformEvent,
): Promise<void> {
  await appendPlatformAudit(db, {
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
  });
}
