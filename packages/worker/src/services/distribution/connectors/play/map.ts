/**
 * Google Play's vocabulary and Distribution's (P5-03; notes/E2 §A1 "Tracks"). Pure functions,
 * no I/O: parsing what `edits.tracks.list` answers, mapping a track release onto availability and
 * an outlet rollout, the in-app update priority policy, and planning a control's PATCH.
 *
 * ── STATUS ──────────────────────────────────────────────────────────────────────────────────
 *
 *     Play status    rollout state   availability   meaning (notes/E2 §A1)
 *     inProgress     active          live           served to `userFraction` (0 < f < 1)
 *     halted         halted          approved       not served to anyone new; users keep it
 *     completed      complete        live           served to everyone (10000 bp)
 *     draft          —               pending        created through the API, not served
 *
 * A halted release passed review and could be served again (resume), so it reads `approved`,
 * not `live` and not `removed`. A draft writes no rollout: nothing is being served.
 * `userFraction` → `rollout_bp` is `round(f × 10000)` (0.05 → 500).
 *
 * ── PRIORITY ────────────────────────────────────────────────────────────────────────────────
 *
 * `inAppUpdatePriority` (0–5) is what the Android plugin's In-App Updates flow keys on (notes/E2
 * §E2; P5-06), and it CANNOT change once a release starts rolling out. So it is set only on a
 * release that has not started (a `draft`), and the policy is operator-owned: a release on a
 * channel Release marks `critical` → 5; a release on a channel whose floor (`minSupported`) is
 * above the version the track serves now → 4; otherwise the operator's default (0 unless set).
 */

import { compareSemver } from "../../../../core/entitlements.js";
import type { RolloutState } from "../../../../core/hooks.js";
import type { AvailabilityState } from "../../availability.js";

export const PLAY_STATUSES = [
  "draft",
  "inProgress",
  "halted",
  "completed",
] as const;
export type PlayStatus = (typeof PLAY_STATUSES)[number];

export function isPlayStatus(v: unknown): v is PlayStatus {
  return (
    typeof v === "string" && (PLAY_STATUSES as readonly string[]).includes(v)
  );
}

/** One release of one track, as read. `raw` is the release object exactly as Play sent it, so a
 *  control can send it back with only the fields it means to change. */
export interface PlayRelease {
  name: string | null;
  /** Decimal digit strings (Play's int64 encoding), in Play's order. */
  versionCodes: string[];
  /** `null` = a status this build does not know: read fail-closed, never served. */
  status: PlayStatus | null;
  userFraction: number | null;
  inAppUpdatePriority: number | null;
  raw: Record<string, unknown>;
}

export interface PlayTrack {
  track: string;
  releases: PlayRelease[];
}

const VERSION_CODE = /^[1-9][0-9]{0,18}$/;

function versionCodesOf(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const c of v) {
    const s = typeof c === "number" && Number.isSafeInteger(c) ? String(c) : c;
    if (typeof s === "string" && VERSION_CODE.test(s) && !out.includes(s))
      out.push(s);
  }
  return out;
}

/** Parse one release object; `null` for something that is not one. */
export function parseRelease(v: unknown): PlayRelease | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  const f = r.userFraction;
  const p = r.inAppUpdatePriority;
  return {
    name: typeof r.name === "string" ? r.name : null,
    versionCodes: versionCodesOf(r.versionCodes),
    status: isPlayStatus(r.status) ? r.status : null,
    userFraction:
      typeof f === "number" && Number.isFinite(f) && f >= 0 && f <= 1
        ? f
        : null,
    inAppUpdatePriority:
      typeof p === "number" && Number.isInteger(p) && p >= 0 && p <= 5
        ? p
        : null,
    raw: structuredClone(r),
  };
}

/** Parse one Track object; `null` for something that is not one. */
export function parseTrack(v: unknown): PlayTrack | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const t = v as Record<string, unknown>;
  if (typeof t.track !== "string" || t.track === "") return null;
  const releases = Array.isArray(t.releases)
    ? t.releases.map(parseRelease).filter((r): r is PlayRelease => r !== null)
    : [];
  return { track: t.track, releases };
}

/** Parse an `edits.tracks.list` response (`{kind, tracks: [...]}`). */
export function parseTrackList(doc: unknown): PlayTrack[] {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return [];
  const tracks = (doc as Record<string, unknown>).tracks;
  if (!Array.isArray(tracks)) return [];
  const seen = new Set<string>();
  const out: PlayTrack[] = [];
  for (const t of tracks) {
    const parsed = parseTrack(t);
    if (parsed && !seen.has(parsed.track)) {
      seen.add(parsed.track);
      out.push(parsed);
    }
  }
  return out;
}

// ── Mapping ──────────────────────────────────────────────────────────────────────────────────

/** Play status → rollout state; `null` = not served (a draft, or a status this build does not
 *  know). */
export function statusToRolloutState(
  status: PlayStatus | null,
): RolloutState | null {
  switch (status) {
    case "inProgress":
      return "active";
    case "halted":
      return "halted";
    case "completed":
      return "complete";
    default:
      return null;
  }
}

/** Play status → availability state (see the file comment); `null` for an unknown status. */
export function statusToAvailability(
  status: PlayStatus | null,
): AvailabilityState | null {
  switch (status) {
    case "inProgress":
    case "completed":
      return "live";
    case "halted":
      return "approved";
    case "draft":
      return "pending";
    default:
      return null;
  }
}

/** When one build is on several tracks of one outlet, the most-served state speaks. */
export const AVAILABILITY_RANK: Readonly<Record<string, number>> = {
  live: 3,
  approved: 2,
  pending: 1,
};

/** `userFraction` → basis points: `round(f × 10000)`, clamped to 0–10000. */
export function userFractionToBp(f: number): number {
  return Math.max(0, Math.min(10000, Math.round(f * 10000)));
}

/** The basis points a release's rollout row mirrors. A completed release is everyone; a halted
 *  one with no fraction was a completed release (halting it rolled the track back). */
export function releaseBp(r: PlayRelease): number {
  if (r.status === "completed") return 10000;
  if (r.userFraction !== null) return userFractionToBp(r.userFraction);
  return r.status === "halted" ? 10000 : 0;
}

/**
 * The release a track's rollout row mirrors: the staged one (`inProgress` or `halted`) when there
 * is one, else the completed one; `null` when only drafts (or nothing) are on the track.
 */
export function rolloutReleaseOf(track: PlayTrack): PlayRelease | null {
  return (
    track.releases.find(
      (r) => r.status === "inProgress" || r.status === "halted",
    ) ??
    track.releases.find((r) => r.status === "completed") ??
    null
  );
}

/** The largest version code of a release (numeric order), or `null`. */
export function topVersionCode(codes: readonly string[]): string | null {
  let best: string | null = null;
  for (const c of codes)
    if (best === null || BigInt(c) > BigInt(best)) best = c;
  return best;
}

// ── Priority policy ──────────────────────────────────────────────────────────────────────────

export const MAX_PRIORITY = 5;

export function isPriority(v: unknown): v is number {
  return (
    typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= MAX_PRIORITY
  );
}

/**
 * The policy priority of a release about to start rolling out on a channel: 5 when Release marks
 * the channel `critical`; 4 when the channel's floor is above `servedVersion` (the version the
 * track serves now, so players on it are below the floor); otherwise the operator's default.
 */
export function policyPriority(input: {
  critical: boolean;
  minSupported: string | null;
  servedVersion: string | null;
  defaultPriority: number;
}): { priority: number; reason: "critical" | "floor" | "default" } {
  if (input.critical) return { priority: 5, reason: "critical" };
  if (
    input.minSupported !== null &&
    input.servedVersion !== null &&
    compareSemver(input.servedVersion, input.minSupported) < 0
  )
    return { priority: 4, reason: "floor" };
  return {
    priority: isPriority(input.defaultPriority) ? input.defaultPriority : 0,
    reason: "default",
  };
}

// ── Control planning ─────────────────────────────────────────────────────────────────────────

export type PlayControlVerb =
  | "fraction"
  | "halt"
  | "resume"
  | "complete"
  | "priority";

export interface ControlPlanInput {
  verb: PlayControlVerb;
  /** The track's releases as read inside the control's edit. */
  releases: readonly PlayRelease[];
  /** Index of the release the control acts on. */
  target: number;
  /** `fraction`: the new `userFraction` (0 < f < 1). */
  userFraction?: number;
  /** `fraction` on a draft, `priority`: the priority to set, when the release has none yet
   *  (`fraction`) or always (`priority`). */
  priority?: number;
  /** `halt` of a `completed` release: the operator confirmed the rollback. */
  confirmRollback?: boolean;
}

export type ControlPlan =
  | {
      ok: true;
      /** The whole `releases` array to PATCH, the target changed, the rest as read. */
      releases: Record<string, unknown>[];
      /** The status the target will have. */
      to: PlayStatus;
      /** The priority set on the target by this change, if any. */
      prioritySet: number | null;
      /** Halting a completed release: Play rolls the track back to the previous one. */
      rollback: boolean;
    }
  | {
      ok: false;
      status: 409 | 422;
      reason: string;
      message: string;
    };

const refusePlan = (
  status: 409 | 422,
  reason: string,
  message: string,
): ControlPlan => ({ ok: false, status, reason, message });

/**
 * What PATCH one control sends (notes/E2 §A1 staged-rollout payloads): the track's releases as
 * read, with only the target's `status` / `userFraction` / `inAppUpdatePriority` changed, and on
 * `complete` the previously completed release dropped (a track serves one completed release).
 *
 *     fraction   draft → inProgress at f (a draft without a priority gets `priority`);
 *                inProgress → inProgress at f. Halted: resume first. Completed: refused.
 *     halt       inProgress → halted; completed → halted only with `confirmRollback` (Play
 *                rolls the track back to the previously completed release).
 *     resume     halted → inProgress at its fraction, or → completed when it has none (it was a
 *                completed release halted into a rollback).
 *     complete   inProgress → completed (fraction removed).
 *     priority   draft only: `inAppUpdatePriority` cannot change after a rollout starts.
 */
export function planControl(input: ControlPlanInput): ControlPlan {
  const target = input.releases[input.target];
  if (!target)
    return refusePlan(422, "unknown_release", "no such release on the track");
  const status = target.status;
  const next = { ...target.raw };
  let to: PlayStatus;
  let prioritySet: number | null = null;
  let rollback = false;
  const drop = new Set<number>();

  switch (input.verb) {
    case "fraction": {
      const f = input.userFraction;
      if (typeof f !== "number" || !(f > 0 && f < 1))
        return refusePlan(
          422,
          "invalid_body",
          "userFraction must be a number strictly between 0 and 1",
        );
      if (status === "halted")
        return refusePlan(
          409,
          "invalid_transition",
          "the release is halted; resume it before changing its fraction",
        );
      if (status !== "draft" && status !== "inProgress")
        return refusePlan(
          409,
          "invalid_transition",
          `cannot set the fraction of a ${status ?? "release in an unknown state"}`,
        );
      next.status = "inProgress";
      next.userFraction = f;
      if (
        status === "draft" &&
        target.inAppUpdatePriority === null &&
        input.priority !== undefined
      ) {
        if (!isPriority(input.priority))
          return refusePlan(422, "invalid_body", "priority must be 0 to 5");
        next.inAppUpdatePriority = input.priority;
        prioritySet = input.priority;
      }
      to = "inProgress";
      break;
    }
    case "halt": {
      if (status === "completed") {
        if (input.confirmRollback !== true)
          return refusePlan(
            409,
            "confirmation_required",
            "halting a completed release rolls the track back to the previously completed release; send confirmRollback: true to do it",
          );
        rollback = true;
      } else if (status !== "inProgress")
        return refusePlan(
          409,
          "invalid_transition",
          `cannot halt a ${status ?? "release in an unknown state"}`,
        );
      next.status = "halted";
      to = "halted";
      break;
    }
    case "resume": {
      if (status !== "halted")
        return refusePlan(
          409,
          "invalid_transition",
          `cannot resume a ${status ?? "release in an unknown state"}`,
        );
      if (target.userFraction !== null && target.userFraction < 1) {
        next.status = "inProgress";
        to = "inProgress";
      } else {
        next.status = "completed";
        delete next.userFraction;
        to = "completed";
        input.releases.forEach((r, i) => {
          if (i !== input.target && r.status === "completed") drop.add(i);
        });
      }
      break;
    }
    case "complete": {
      if (status !== "inProgress")
        return refusePlan(
          409,
          "invalid_transition",
          status === "halted"
            ? "the release is halted; resume it before completing it"
            : `cannot complete a ${status ?? "release in an unknown state"}`,
        );
      next.status = "completed";
      delete next.userFraction;
      to = "completed";
      input.releases.forEach((r, i) => {
        if (i !== input.target && r.status === "completed") drop.add(i);
      });
      break;
    }
    case "priority": {
      if (!isPriority(input.priority))
        return refusePlan(422, "invalid_body", "priority must be 0 to 5");
      if (status !== "draft")
        return refusePlan(
          409,
          "priority_locked",
          "inAppUpdatePriority cannot change after a release starts rolling out; set it on a draft, before its rollout starts",
        );
      next.inAppUpdatePriority = input.priority;
      prioritySet = input.priority;
      to = "draft";
      break;
    }
  }
  const releases = input.releases
    .map((r, i) => (i === input.target ? next : { ...r.raw }))
    .filter((_, i) => !drop.has(i));
  return { ok: true, releases, to, prioritySet, rollback };
}
