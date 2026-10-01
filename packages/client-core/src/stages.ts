// The boot stage machine — client boot behaviour, outside the wire contract.
//
// One pure reducer every renderer drives (Godot's PKeyBoot, React, SwiftUI, a terminal): the
// host does the work of each stage and reports its result as an event; the machine decides
// the next stage and what to emit. It does no I/O, reads no clock, uses no randomness and
// never mutates its input, so the same inputs reach the same stages, emits and outcome in
// every language. `conformance/corpus/v2/stage-matrix.json` pins it row by row, and the Node,
// Python and Swift runners replay every row and every probe of its `accepts` table.
//
// The normal path is idle → shell → guard → sync → gate → decide → fetch → mount → ready, and
// every stage is entered even when it has nothing to do. An event the current stage does not
// accept, or a malformed event, is IGNORED: the input state comes back unchanged (the same
// object) with no emits. Every accepted event emits something, so an empty list always means
// the event was ignored.
//
// The only import is a type, so this module adds no runtime dependency.

import type { LicenseStatus } from "@polaris-key/protocol/license";

/** Every stage, in boot order, then the three stops. */
export const BOOT_STAGES = [
  "idle",
  "shell",
  "guard",
  "sync",
  "gate",
  "decide",
  "fetch",
  "mount",
  "ready",
  "background",
  "offline",
  "blocked",
  "error",
] as const;

/** The outcome a renderer reports: `running` until the boot stops or the gate waits. */
export const BOOT_OUTCOMES = [
  "running",
  "waiting",
  "ready",
  "blocked",
  "offline",
  "error",
] as const;

/** The events a host sends, dotted. */
export const BOOT_EVENT_TYPES = [
  "start",
  "shell.done",
  "guard.done",
  "sync.done",
  "sync.timeout",
  "gate.status",
  "decide.done",
  "fetch.done",
  "mount.done",
  "background.start",
  "background.done",
  "retry",
  "play-offline",
  "fail",
] as const;

/** The emits the machine produces, snake_case: the signal names renderers expose. */
export const BOOT_EMIT_TYPES = [
  "stage_changed",
  "waiting",
  "update_available",
  "blocked",
  "offline",
  "error",
  "boot_rolled_back",
  "boot_ready",
] as const;

/** What `bootGuardAction` decides at launch. */
export const BOOT_GUARD_ACTIONS = [
  "none",
  "apply-staged",
  "roll-back",
] as const;

/** Unconfirmed launches of the active slot that trigger a rollback on the next launch. */
export const MAX_FAILED_BOOTS = 2;

export type BootStage = (typeof BOOT_STAGES)[number];
export type BootOutcome = (typeof BOOT_OUTCOMES)[number];
export type BootEventType = (typeof BOOT_EVENT_TYPES)[number];
export type BootEmitType = (typeof BOOT_EMIT_TYPES)[number];
export type BootGuardAction = (typeof BOOT_GUARD_ACTIONS)[number];

export type BootGuardResult = "ok" | "applied" | "rolled-back";
export type BootSyncResult = "ok" | "offline" | "error";
export type BootDecision = "none" | "optional" | "required";
export type BootFetchResult = "ok" | "offline" | "failed";
export type BootBlockedReason = "update-required" | "not-available";

export type BootEvent =
  | { type: "start" | "shell.done" | "sync.timeout" | "mount.done" }
  | { type: "background.start" | "background.done" | "retry" | "play-offline" }
  | { type: "guard.done"; result: BootGuardResult }
  | { type: "sync.done"; result: BootSyncResult }
  | { type: "gate.status"; status: LicenseStatus }
  | { type: "decide.done"; decision: BootDecision }
  | {
      type: "fetch.done";
      result: BootFetchResult;
      /** The pack ids present after the fetch, compared by exact string. */
      installed: readonly string[];
    }
  /** The host's own work for the current stage failed in a way its event cannot express. */
  | { type: "fail"; code: string };

export type BootEmit =
  | { type: "stage_changed"; stage: BootStage; previous: BootStage }
  | { type: "waiting"; status: LicenseStatus }
  | { type: "update_available" | "boot_rolled_back" | "boot_ready" }
  | { type: "blocked"; reason: BootBlockedReason }
  /** `canPlayOffline` is `false` on every v1 path. */
  | { type: "offline"; canPlayOffline: boolean }
  /** `sync-failed`, `fetch-failed`, or the code of the host's `fail`. */
  | { type: "error"; code: string };

export interface BootOptions {
  /** Continue on local state when the sync gets no answer or an unusable one. Default true. */
  allowOffline?: boolean;
  /** Let `grace` pass the gate. Default true. */
  allowGrace?: boolean;
  /** Pack ids that must be installed before `mount`. Default []. Copied. */
  requiredPacks?: readonly string[];
}

export interface BootState {
  readonly stage: BootStage;
  readonly outcome: BootOutcome;
  readonly options: Readonly<Required<BootOptions>>;
  /** The latest sync result; a timeout is `offline`. */
  readonly sync: "pending" | BootSyncResult;
  /** Where `retry` goes: `shell` before `shell.done`, `guard` before `guard.done`, then `sync`. */
  readonly resume: "shell" | "guard" | "sync";
}

export interface BootTransition {
  readonly state: BootState;
  readonly emits: readonly BootEmit[];
}

const LICENSE_STATUSES: readonly string[] = [
  "ok",
  "grace",
  "expired",
  "revoked",
  "needs-activation",
  "version-too-old",
  "version-too-new",
  "channel-not-entitled",
  "not-applicable",
];

/** stage idle, outcome running, sync `pending`, resume `shell`. */
export function initialBootState(options: BootOptions = {}): BootState {
  return {
    stage: "idle",
    outcome: "running",
    options: {
      allowOffline: options.allowOffline ?? true,
      allowGrace: options.allowGrace ?? true,
      requiredPacks: [...(options.requiredPacks ?? [])],
    },
    sync: "pending",
    resume: "shell",
  };
}

/** The launch decision of the boot guard: roll back, apply a staged update, or neither. */
export function bootGuardAction(input: {
  staged: boolean;
  failedBoots: number;
}): BootGuardAction {
  if (input.failedBoots >= MAX_FAILED_BOOTS) return "roll-back";
  if (input.staged) return "apply-staged";
  return "none";
}

type Patch = Partial<Omit<BootState, "options">>;

/** Move to `stage` (emitting `stage_changed` first when it changes), then at most one emit. */
function go(
  state: BootState,
  stage: BootStage,
  outcome: BootOutcome,
  extra: BootEmit | null,
  patch: Patch = {},
): BootTransition {
  const emits: BootEmit[] = [];
  if (stage !== state.stage)
    emits.push({ type: "stage_changed", stage, previous: state.stage });
  if (extra) emits.push(extra);
  return { state: { ...state, ...patch, stage, outcome }, emits };
}

function ignore(state: BootState): BootTransition {
  return { state, emits: [] };
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function oneOf(value: unknown, allowed: readonly string[]): boolean {
  return typeof value === "string" && allowed.includes(value);
}

/** The stop a failed sync leads to: offline after no answer, error after an unusable one. */
function syncStop(
  state: BootState,
  sync: BootSyncResult,
  patch: Patch = {},
): BootTransition {
  return sync === "offline"
    ? go(
        state,
        "offline",
        "offline",
        { type: "offline", canPlayOffline: false },
        patch,
      )
    : go(
        state,
        "error",
        "error",
        { type: "error", code: "sync-failed" },
        patch,
      );
}

function onSync(state: BootState, result: BootSyncResult): BootTransition {
  if (result === "ok" || state.options.allowOffline)
    return go(state, "gate", "running", null, { sync: result });
  return syncStop(state, result, { sync: result });
}

function onGateStatus(state: BootState, status: LicenseStatus): BootTransition {
  switch (status) {
    case "ok":
    case "not-applicable":
      return go(state, "decide", "running", null);
    case "grace":
      if (state.options.allowGrace) return go(state, "decide", "running", null);
      return gateHolds(state, status);
    case "expired":
      return gateHolds(state, status);
    case "needs-activation":
    case "revoked":
      return go(state, "gate", "waiting", { type: "waiting", status });
    case "version-too-old":
      return go(state, "blocked", "blocked", {
        type: "blocked",
        reason: "update-required",
      });
    case "version-too-new":
    case "channel-not-entitled":
      return go(state, "blocked", "blocked", {
        type: "blocked",
        reason: "not-available",
      });
  }
}

/** `expired`, or `grace` the options refuse: the player can renew after a sync that was
 *  answered, otherwise the boot stops for the reason the sync failed. */
function gateHolds(state: BootState, status: LicenseStatus): BootTransition {
  if (state.sync === "offline" || state.sync === "error")
    return syncStop(state, state.sync);
  return go(state, "gate", "waiting", { type: "waiting", status });
}

function missingPacks(state: BootState, installed: readonly string[]): boolean {
  return state.options.requiredPacks.some((id) => !installed.includes(id));
}

/**
 * The reducer. Returns the next state and the emits the event produced, `stage_changed` first.
 * An event the current stage does not accept, or a malformed one, returns the input state
 * itself and no emits.
 */
export function bootTransition(
  state: BootState,
  event: BootEvent,
): BootTransition {
  const e = event as unknown as Record<string, unknown> | null;
  if (typeof e !== "object" || e === null) return ignore(state);
  const waiting = state.stage === "gate" && state.outcome === "waiting";

  switch (e.type) {
    case "start":
      return state.stage === "idle"
        ? go(state, "shell", "running", null)
        : ignore(state);

    case "shell.done":
      return state.stage === "shell"
        ? go(state, "guard", "running", null, { resume: "guard" })
        : ignore(state);

    case "guard.done": {
      if (
        state.stage !== "guard" ||
        !oneOf(e.result, ["ok", "applied", "rolled-back"])
      )
        return ignore(state);
      return go(
        state,
        "sync",
        "running",
        e.result === "rolled-back" ? { type: "boot_rolled_back" } : null,
        { resume: "sync" },
      );
    }

    case "sync.done":
      if (
        state.stage !== "sync" ||
        !oneOf(e.result, ["ok", "offline", "error"])
      )
        return ignore(state);
      return onSync(state, e.result as BootSyncResult);

    case "sync.timeout":
      return state.stage === "sync" ? onSync(state, "offline") : ignore(state);

    case "gate.status":
      if (state.stage !== "gate" || !oneOf(e.status, LICENSE_STATUSES))
        return ignore(state);
      return onGateStatus(state, e.status as LicenseStatus);

    case "decide.done":
      if (state.stage !== "decide") return ignore(state);
      switch (e.decision) {
        case "none":
          return go(state, "fetch", "running", null);
        case "optional":
          return go(state, "fetch", "running", { type: "update_available" });
        case "required":
          return go(state, "blocked", "blocked", {
            type: "blocked",
            reason: "update-required",
          });
        default:
          return ignore(state);
      }

    case "fetch.done": {
      if (
        state.stage !== "fetch" ||
        !oneOf(e.result, ["ok", "offline", "failed"]) ||
        !Array.isArray(e.installed) ||
        !e.installed.every(isString)
      )
        return ignore(state);
      if (!missingPacks(state, e.installed as readonly string[]))
        return go(state, "mount", "running", null);
      if (e.result === "offline")
        return go(state, "offline", "offline", {
          type: "offline",
          canPlayOffline: false,
        });
      return go(state, "error", "error", {
        type: "error",
        code: "fetch-failed",
      });
    }

    case "mount.done":
      return state.stage === "mount"
        ? go(state, "ready", "ready", { type: "boot_ready" })
        : ignore(state);

    case "background.start":
      return state.stage === "ready"
        ? go(state, "background", "ready", null)
        : ignore(state);

    case "background.done":
      return state.stage === "background"
        ? go(state, "ready", "ready", null)
        : ignore(state);

    case "retry":
      if (
        !waiting &&
        state.stage !== "offline" &&
        state.stage !== "blocked" &&
        state.stage !== "error"
      )
        return ignore(state);
      return go(state, state.resume, "running", null, { sync: "pending" });

    case "fail": {
      const failing =
        state.stage === "shell" ||
        state.stage === "guard" ||
        state.stage === "sync" ||
        (state.stage === "gate" && !waiting) ||
        state.stage === "decide" ||
        state.stage === "fetch" ||
        state.stage === "mount";
      if (!failing || !isString(e.code)) return ignore(state);
      return go(state, "error", "error", { type: "error", code: e.code });
    }

    // `play-offline` is accepted nowhere in v1: `canPlayOffline` is never true.
    default:
      return ignore(state);
  }
}
