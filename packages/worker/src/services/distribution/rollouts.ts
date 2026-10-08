/**
 * Outlet-scoped rollouts and halts (P2b-04, README §3.9) — one implementation, reached by the
 * console (`admin.ts`, a platform-admin session) and by CI (`routes.ts`, a `pkeyci_` token with
 * the opt-in `distribution:rollout` scope).
 *
 * The split README §3.9 draws: release owns the channel POINTER, floor, `critical` and yanks, per
 * deliverable; distribution owns rollout percentage, pause, resume, halt and completion, per
 * OUTLET and channel. Apple's phased release, Play's `userFraction` and Polaris Key's own
 * client-evaluated buckets are all per outlet.
 *
 * ── SEMANTICS ───────────────────────────────────────────────────────────────────────────────
 *
 * `rollout_bp` is basis points, 0–10000. Starting a rollout of a NEW release gives it a fresh
 * random `rollout_salt` (16 bytes, hex), so the same devices are not always first. The bucket is
 * evaluated on the device — `u32(sha256(salt ‖ installId)[0..4]) mod 10000` (README §3.6) — so
 * the feed stays identical for everyone and the Worker never evaluates it.
 *
 *     set       (POST …/rollouts/<outlet>/<channel>, `{deliverable?, releaseId, bp}`)
 *               a new release starts a new rollout (fresh salt, `active`, whatever state the
 *               previous release's row was in); the same release changes `bp` while `active`
 *               or `paused`, and is refused while `halted` (resume first) or `complete`.
 *     pause     active → paused
 *     resume    paused → active, halted → active (a halt is lifted only by an explicit resume)
 *     halt      active | paused → halted
 *     complete  active → complete, and `bp` := 10000
 *
 * Anything else is refused (409 `invalid_transition`). A `mirrored = 1` row belongs to a store
 * connector (P5-02/P5-03) and refuses every direct edit (409 `rollout_mirrored`). The verbs take
 * an optional `releaseId`; when given it must be the row's release (409 `stale_release`), so a CI
 * job that halts "v1.4.0" never halts the v1.5.0 rollout that replaced it.
 *
 * ── WHAT A HALT DOES ────────────────────────────────────────────────────────────────────────
 *
 * The signed channel feed (P3-03), the app-updater feeds (P3-09), the storefront feeds and the
 * download page all read these rows, so a pause or halt stops offering the release there at
 * once. Moving download URLs apply yanks and pins (P2-05), not holds.
 *
 * Every change is audited with its actor (`admin:<sub>` via the session, `ci:<subject>`, or
 * `system:auto-halt` — P6-03's telemetry auto-halt, which may only halt), as
 * `distribution.rollout.<verb>`.
 */

import { APP_DELIVERABLE_ID } from "@polaris-key/manifest";
import { randomHex, randomId, type Db } from "../../core/platform.js";
import type {
  RolloutRecord,
  RolloutState,
  ServiceHooks,
} from "../../core/hooks.js";
import { appendAudit } from "../../core/data.js";
import { audit, type AdminSession } from "../../core/adminApi.js";
import { ciActor, type CiPrincipal } from "../../core/ciScope.js";
import { getOutlet } from "./outlets.js";

// ── Vocabulary ───────────────────────────────────────────────────────────────────────────────

export const ROLLOUT_STATES: readonly RolloutState[] = [
  "active",
  "paused",
  "halted",
  "complete",
];

/** The four state-changing verbs, plus `set` (start a rollout, or change its percentage). */
export type RolloutVerb = "set" | "pause" | "resume" | "halt" | "complete";
export const ROLLOUT_VERBS: readonly Exclude<RolloutVerb, "set">[] = [
  "pause",
  "resume",
  "halt",
  "complete",
];

export function isRolloutVerb(
  value: string,
): value is Exclude<RolloutVerb, "set"> {
  return (ROLLOUT_VERBS as readonly string[]).includes(value);
}

/** The transition table: which states each verb may leave, and where it goes. */
export const TRANSITIONS: Readonly<
  Record<
    Exclude<RolloutVerb, "set">,
    { from: readonly RolloutState[]; to: RolloutState }
  >
> = {
  pause: { from: ["active"], to: "paused" },
  resume: { from: ["paused", "halted"], to: "active" },
  halt: { from: ["active", "paused"], to: "halted" },
  complete: { from: ["active"], to: "complete" },
};

/** Basis points in a whole rollout. */
export const FULL_ROLLOUT_BP = 10000;

/** A channel name as a path segment may carry it (the release channel alphabet). */
const CHANNEL = /^[a-z0-9][a-z0-9-]{0,63}$/;

// ── Rows ─────────────────────────────────────────────────────────────────────────────────────

export interface DistRolloutRow {
  product: string;
  deliverable_id: string;
  outlet_id: string;
  channel: string;
  release_id: string;
  rollout_bp: number;
  rollout_salt: string;
  state: string;
  mirrored: number;
  source: string;
  started_at: number;
  updated_at: number;
  updated_by: string;
}

/** A stored state, read fail-closed: anything outside the CHECK reads as `halted`. */
function readState(value: string): RolloutState {
  return (ROLLOUT_STATES as readonly string[]).includes(value)
    ? (value as RolloutState)
    : "halted";
}

export function rolloutRecord(row: DistRolloutRow): RolloutRecord {
  return {
    deliverableId: row.deliverable_id,
    outletId: row.outlet_id,
    channel: row.channel,
    releaseId: row.release_id,
    rolloutBp: row.rollout_bp,
    rolloutSalt: row.rollout_salt,
    state: readState(row.state),
    mirrored: row.mirrored === 1,
    source: row.source,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

export function listRollouts(
  db: Db,
  product: string,
): Promise<DistRolloutRow[]> {
  return db.all<DistRolloutRow>(
    `SELECT * FROM dist_rollouts WHERE product = ?
      ORDER BY CASE deliverable_id WHEN 'app' THEN 0 ELSE 1 END, deliverable_id,
               outlet_id, channel`,
    product,
  );
}

export function getRollout(
  db: Db,
  product: string,
  deliverable: string,
  outlet: string,
  channel: string,
): Promise<DistRolloutRow | null> {
  return db.first<DistRolloutRow>(
    `SELECT * FROM dist_rollouts
      WHERE product = ? AND deliverable_id = ? AND outlet_id = ? AND channel = ?`,
    product,
    deliverable,
    outlet,
    channel,
  );
}

/** 16 random bytes, hex: a new release's bucket salt. */
export function newRolloutSalt(): string {
  return randomHex(16);
}

// ── Actors and refusals ──────────────────────────────────────────────────────────────────────

/**
 * Who applies a verb. `system` is an AUTOMATIC action (P6-03's telemetry auto-halt): it may
 * only HALT — every other verb, `set` included, is refused (`system_halt_only`) whatever the
 * caller — and it carries the reason, with the numbers that tripped it, into the one audit row.
 * The row's `source` becomes the system source (`auto-halt`), `updated_by` `system:<source>`.
 */
export type RolloutActor =
  | { kind: "admin"; session: AdminSession }
  | { kind: "ci"; principal: CiPrincipal }
  | {
      kind: "system";
      source: SystemRolloutSource;
      label: string;
      reason: string;
    };

/** The automatic actions that may halt a rollout. */
export type SystemRolloutSource = "auto-halt";

/** `admin:<sub>`, `ci:<subject>` or `system:<source>` — what `updated_by` records. */
function actorId(actor: RolloutActor): string {
  if (actor.kind === "admin") return `admin:${actor.session.sub}`;
  if (actor.kind === "system") return `system:${actor.source}`;
  return ciActor(actor.principal);
}

/** What `source` records: the actor kind, or the system source. */
function actorSource(actor: RolloutActor): string {
  return actor.kind === "system" ? actor.source : actor.kind;
}

/** A refusal both the console and CI can render (P2-05's `PolicyRefusal` shape). */
export interface RolloutRefusal {
  ok: false;
  status: 404 | 409 | 422;
  code: "not_found" | "bad_request";
  /** Machine-readable reason (`invalid_transition`, `rollout_mirrored`, …). */
  reason: string;
  message: string;
  fields?: string[];
}

export type RolloutResult =
  | { ok: true; rollout: RolloutRecord }
  | RolloutRefusal;

function refuse(
  status: RolloutRefusal["status"],
  reason: string,
  message: string,
  fields?: string[],
): RolloutRefusal {
  return {
    ok: false,
    status,
    code: status === 404 ? "not_found" : "bad_request",
    reason,
    message,
    ...(fields ? { fields } : {}),
  };
}

async function auditChange(
  db: Db,
  product: string,
  actor: RolloutActor,
  now: number,
  action: string,
  targetId: string,
  summary: string,
): Promise<void> {
  const target = { kind: "rollout", id: targetId };
  if (actor.kind === "admin") {
    await audit(db, product, actor.session, now, action, target, summary);
    return;
  }
  await appendAudit(db, {
    product,
    id: randomId("aud"),
    at: now,
    actor_sub: actorId(actor),
    actor_name: actor.kind === "system" ? actor.label : "CI",
    actor_email: null,
    action,
    target_kind: target.kind,
    target_id: target.id,
    parent_id: null,
    summary,
  });
}

// ── The operation ────────────────────────────────────────────────────────────────────────────

export interface RolloutContext {
  db: Db;
  product: string;
  hooks: ServiceHooks;
  now: number;
}

/** What a request asked for, before validation. */
export interface RolloutInput {
  outlet: string;
  channel: string;
  /** Request body fields, unvalidated. */
  deliverable?: unknown;
  releaseId?: unknown;
  bp?: unknown;
}

/**
 * Apply one rollout verb. Validates the outlet (a live declared outlet), the channel, the
 * deliverable and release (through Release's catalog hook), the percentage and the transition;
 * writes the row; audits it.
 */
export async function applyRollout(
  ctx: RolloutContext,
  verb: RolloutVerb,
  input: RolloutInput,
  actor: RolloutActor,
): Promise<RolloutResult> {
  const { db, product, now } = ctx;
  const { outlet, channel } = input;

  // An automatic action may only halt (THREAT-MODEL.md §9: an automatic action never gains a
  // verb other than halt). Refused before anything is read, so no system caller can pause,
  // resume, complete or start a rollout through this function.
  if (actor.kind === "system" && verb !== "halt")
    return refuse(
      409,
      "system_halt_only",
      `an automatic action may only halt a rollout, not ${verb} one`,
    );

  if (!CHANNEL.test(channel))
    return refuse(404, "unknown_channel", "no such channel");
  const outletRow = await getOutlet(db, product, outlet);
  if (!outletRow || outletRow.removed_at !== null)
    return refuse(404, "unknown_outlet", `no outlet ${outlet} on ${product}`);

  if (input.deliverable !== undefined && typeof input.deliverable !== "string")
    return refuse(422, "invalid_body", "deliverable must be a string", [
      "deliverable",
    ]);
  const deliverable =
    (input.deliverable as string | undefined) ?? APP_DELIVERABLE_ID;
  const catalog = ctx.hooks.releaseCatalog();
  if (!catalog)
    return refuse(404, "unknown_deliverable", "no such deliverable");
  const deliverables = await catalog.deliverables();
  if (!deliverables.some((d) => d.id === deliverable))
    return refuse(
      404,
      "unknown_deliverable",
      `no deliverable ${deliverable} on ${product}`,
    );

  if (input.releaseId !== undefined && typeof input.releaseId !== "string")
    return refuse(422, "invalid_body", "releaseId must be a string", [
      "releaseId",
    ]);
  const releaseId = input.releaseId as string | undefined;
  const targetId = `${deliverable}:${outlet}:${channel}`;
  const existing = await getRollout(db, product, deliverable, outlet, channel);
  if (existing?.mirrored === 1)
    return refuse(
      409,
      "rollout_mirrored",
      `the ${outlet} rollout is mirrored from its store connector (${existing.source}); change it there`,
    );

  if (verb === "set") {
    if (!releaseId)
      return refuse(422, "invalid_body", "releaseId is required", [
        "releaseId",
      ]);
    const bp = input.bp;
    if (
      typeof bp !== "number" ||
      !Number.isInteger(bp) ||
      bp < 0 ||
      bp > FULL_ROLLOUT_BP
    )
      return refuse(
        422,
        "invalid_body",
        `bp must be an integer from 0 to ${FULL_ROLLOUT_BP}`,
        ["bp"],
      );
    const release = (await catalog.releases(deliverable)).find(
      (r) => r.releaseId === releaseId,
    );
    if (!release)
      return refuse(
        404,
        "unknown_release",
        `no release ${releaseId} of ${deliverable}`,
      );
    if (release.yanked)
      return refuse(
        409,
        "release_yanked",
        `${releaseId} is yanked; unyank it before rolling it out`,
      );

    const fresh = !existing || existing.release_id !== releaseId;
    if (!fresh) {
      const state = readState(existing.state);
      if (state === "halted")
        return refuse(
          409,
          "invalid_transition",
          "the rollout is halted; resume it before changing its percentage",
        );
      if (state === "complete")
        return refuse(
          409,
          "invalid_transition",
          "the rollout is complete; start a new release instead",
        );
    }
    const by = actorId(actor);
    await db.run(
      `INSERT INTO dist_rollouts
         (product, deliverable_id, outlet_id, channel, release_id, rollout_bp, rollout_salt,
          state, mirrored, source, started_at, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 0, ?, ?, ?, ?)
       ON CONFLICT (product, deliverable_id, outlet_id, channel) DO UPDATE SET
         release_id = excluded.release_id,
         rollout_bp = excluded.rollout_bp,
         rollout_salt = CASE WHEN ? THEN excluded.rollout_salt ELSE dist_rollouts.rollout_salt END,
         state = CASE WHEN ? THEN 'active' ELSE dist_rollouts.state END,
         source = excluded.source,
         started_at = CASE WHEN ? THEN excluded.started_at ELSE dist_rollouts.started_at END,
         updated_at = excluded.updated_at,
         updated_by = excluded.updated_by
       WHERE dist_rollouts.mirrored = 0`,
      product,
      deliverable,
      outlet,
      channel,
      releaseId,
      bp,
      newRolloutSalt(),
      actorSource(actor),
      now,
      now,
      by,
      fresh ? 1 : 0,
      fresh ? 1 : 0,
      fresh ? 1 : 0,
    );
    await auditChange(
      db,
      product,
      actor,
      now,
      "distribution.rollout.set",
      targetId,
      fresh
        ? `Started the ${deliverable} rollout of ${releaseId} on ${outlet}/${channel} at ${bp / 100}%`
        : `Set the ${deliverable} rollout of ${releaseId} on ${outlet}/${channel} to ${bp / 100}%`,
    );
    const row = await getRollout(db, product, deliverable, outlet, channel);
    return { ok: true, rollout: rolloutRecord(row!) };
  }

  if (!existing)
    return refuse(
      404,
      "no_rollout",
      `no ${deliverable} rollout on ${outlet}/${channel}`,
    );
  if (releaseId !== undefined && releaseId !== existing.release_id)
    return refuse(
      409,
      "stale_release",
      `the ${outlet}/${channel} rollout is of ${existing.release_id}, not ${releaseId}`,
    );
  const rule = TRANSITIONS[verb];
  const from = readState(existing.state);
  if (!rule.from.includes(from))
    return refuse(
      409,
      "invalid_transition",
      `cannot ${verb} a rollout that is ${from}`,
    );

  // Conditional on the state read above, so two concurrent verbs cannot both apply.
  const changed = await db.runChanges(
    `UPDATE dist_rollouts
        SET state = ?, rollout_bp = CASE WHEN ? THEN ? ELSE rollout_bp END,
            source = ?, updated_at = ?, updated_by = ?
      WHERE product = ? AND deliverable_id = ? AND outlet_id = ? AND channel = ?
        AND state = ? AND mirrored = 0`,
    rule.to,
    verb === "complete" ? 1 : 0,
    FULL_ROLLOUT_BP,
    actorSource(actor),
    now,
    actorId(actor),
    product,
    deliverable,
    outlet,
    channel,
    existing.state,
  );
  if (changed === 0)
    return refuse(
      409,
      "invalid_transition",
      "the rollout changed while this request was in flight; read it and try again",
    );
  const verbs: Record<typeof verb, string> = {
    pause: "Paused",
    resume: "Resumed",
    halt: "Halted",
    complete: "Completed",
  };
  await auditChange(
    db,
    product,
    actor,
    now,
    `distribution.rollout.${verb}`,
    targetId,
    `${verbs[verb]} the ${deliverable} rollout of ${existing.release_id} on ${outlet}/${channel}` +
      (actor.kind === "system" ? `: ${actor.reason}` : ""),
  );
  const row = await getRollout(db, product, deliverable, outlet, channel);
  return { ok: true, rollout: rolloutRecord(row!) };
}

// ── Store mirrors (P5-02) ────────────────────────────────────────────────────────────────────

/** What a store connector says a store's own staged rollout is doing. */
export interface MirroredRollout {
  deliverable: string;
  outlet: string;
  channel: string;
  releaseId: string;
  bp: number;
  state: RolloutState;
  /** The connector kind (`asc`, later `play`): the row's `source`. */
  source: string;
}

/**
 * Mirror a store's staged rollout into `dist_rollouts` as a `mirrored = 1` row (Apple's phased
 * release, Play's `userFraction`). The store is the authority: the row is overwritten whatever
 * its previous state or owner — an operator's own rollout on the same (deliverable, outlet,
 * channel) included — and refuses direct edits from then on (`rollout_mirrored`). A new release
 * starts a new row (fresh salt and `started_at`). Audited as `distribution.rollout.mirror`, only
 * when something changed, with `audit`. Validation (the outlet, the release) is the caller's.
 *
 * The mirror is INFORMATIVE: Apple applies a phased release to automatic updates only, and anyone
 * can download the version by hand at any time. It must never be read as an access control.
 */
export async function mirrorRollout(
  ctx: { db: Db; product: string; now: number },
  m: MirroredRollout,
  audit: (targetId: string, summary: string) => Promise<void>,
): Promise<{ changed: boolean; rollout: RolloutRecord }> {
  const { db, product, now } = ctx;
  const bp = Math.max(0, Math.min(FULL_ROLLOUT_BP, Math.round(m.bp)));
  const existing = await getRollout(
    db,
    product,
    m.deliverable,
    m.outlet,
    m.channel,
  );
  const fresh = !existing || existing.release_id !== m.releaseId;
  const changed =
    fresh ||
    existing.state !== m.state ||
    existing.rollout_bp !== bp ||
    existing.mirrored !== 1 ||
    existing.source !== m.source;
  if (changed) {
    await db.run(
      `INSERT INTO dist_rollouts
         (product, deliverable_id, outlet_id, channel, release_id, rollout_bp, rollout_salt,
          state, mirrored, source, started_at, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
       ON CONFLICT (product, deliverable_id, outlet_id, channel) DO UPDATE SET
         release_id = excluded.release_id,
         rollout_bp = excluded.rollout_bp,
         rollout_salt = CASE WHEN ? THEN excluded.rollout_salt ELSE dist_rollouts.rollout_salt END,
         state = excluded.state,
         mirrored = 1,
         source = excluded.source,
         started_at = CASE WHEN ? THEN excluded.started_at ELSE dist_rollouts.started_at END,
         updated_at = excluded.updated_at,
         updated_by = excluded.updated_by`,
      product,
      m.deliverable,
      m.outlet,
      m.channel,
      m.releaseId,
      bp,
      newRolloutSalt(),
      m.state,
      m.source,
      now,
      now,
      `connector:${m.source}`,
      fresh ? 1 : 0,
      fresh ? 1 : 0,
    );
    await audit(
      `${m.deliverable}:${m.outlet}:${m.channel}`,
      `Mirrored the ${m.outlet} rollout of ${m.releaseId} on ${m.channel}: ${m.state} at ${bp / 100}%` +
        (existing && existing.mirrored !== 1
          ? ` (replacing a ${existing.source} rollout of ${existing.release_id})`
          : ""),
    );
  }
  const row = await getRollout(db, product, m.deliverable, m.outlet, m.channel);
  return { changed, rollout: rolloutRecord(row!) };
}
