// The cloudSync family (ui-matrix.json `cloudSync`, U-42.0): CloudSyncStatus and the three Cloud
// Sync screens, UnlockSync, RecoveryCode and RingChange. Security points the rows pin (U-sync
// clients plan §9, S5, S13, T22, T23):
//   - the recovery code is entered only in the app, and the screen says no one will ask for it;
//   - the code is never an input or a copy argument: the kit draws it from the host, once;
//   - Start over warns that synced data will be lost before it runs;
//   - nearby unlock is never offered in v0.10.0 (NearbyApproval does not ship);
//   - a changed ring is confirmed on its own screen: `ring-changed` never offers Unlock, Accept
//     hands the host the ring the person was shown (`changed.served`), and without one there is
//     nothing to accept, only the recovery code.

import type { Context } from "../input.js";
import type { SyncScreenName } from "../vocabulary.js";
import { hiddenView, makeView, type View } from "../view.js";

// ── CloudSyncStatus ────────────────────────────────────────────────────────────────────────────

export type CloudSyncState =
  | "synced"
  | "syncing"
  | "offline"
  | "conflict"
  | "error"
  | "locked"
  | "ring-changed"
  | "hidden";

/** A small Cloud Sync status. It never implies universal backup. */
export function cloudSyncStatusView(
  ctx: Context,
): View<"CloudSyncStatus", CloudSyncState> {
  const sync = ctx.input.cloudSync;
  if (!ctx.on("sync") || !sync) return hiddenView(ctx, "CloudSyncStatus");
  // A locked device holds no key: it says so and offers Unlock sync, never a sync time.
  if (sync.state === "locked")
    return makeView(ctx, "CloudSyncStatus", {
      state: "locked",
      copy: ["cloudSync.locked", "cloudSync.unlock"],
      primary: "cloudSync.unlock",
      tone: "neutral",
      focus: null,
    });
  // A changed ring is confirmed first (S5). The kit owns that screen, so Review always shows.
  if (sync.state === "ring-changed")
    return makeView(ctx, "CloudSyncStatus", {
      state: "ring-changed",
      copy: ["cloudSync.ringChanged", "common.review"],
      primary: "common.review",
      tone: "neutral",
      focus: null,
    });
  const error = sync.state === "error";
  // A sync that failed because nobody is signed in is not a fault: it says so and offers Sign in
  // to sync, in a neutral tone (DL6). Review shows only when the host handles it.
  const signedOut = error && sync.signedIn === false;
  const review = sync.state === "conflict" && sync.canReview === true;
  return makeView(ctx, "CloudSyncStatus", {
    state: sync.state,
    copy: signedOut
      ? ["cloudSync.signedOut", "cloudSync.signIn"]
      : [`cloudSync.${sync.state}`, review && "common.review"],
    args: { time: sync.lastSynced },
    primary: signedOut ? "cloudSync.signIn" : review ? "common.review" : null,
    tone: signedOut ? "neutral" : error ? "danger" : null,
    focus: null,
  });
}

// ── UnlockSync ─────────────────────────────────────────────────────────────────────────────────

export type UnlockSyncState =
  | "code"
  | "invalid"
  | "working"
  | "failed"
  | "start-over-failed"
  | "no-code"
  | "start-over"
  | "hidden";

/** Unlock the synced data with the recovery code, or start over. */
export function unlockSyncView(
  ctx: Context,
): View<"UnlockSync", UnlockSyncState> {
  const u = ctx.input.unlockSync;
  if (!ctx.on("sync") || !u) return hiddenView(ctx, "UnlockSync");
  // `u.nearby` is read by no branch: v0.10.0 never offers a nearby unlock.
  switch (u.step) {
    case "working":
      return makeView(ctx, "UnlockSync", {
        state: "working",
        copy: ["unlockSync.title", "common.working"],
        focus: null,
      });
    case "failed":
      return makeView(ctx, "UnlockSync", {
        state: "failed",
        copy: [
          "unlockSync.title",
          "unlockSync.failed",
          "common.tryAgain",
          "common.cancel",
        ],
        primary: "common.tryAgain",
        tone: "danger",
        errorSlot: "screen",
      });
    case "start-over-failed":
      // Start over did not run: not an unlock failure. Try again repeats it.
      return makeView(ctx, "UnlockSync", {
        state: "start-over-failed",
        copy: [
          "unlockSync.title",
          "unlockSync.startOverFailed",
          "common.tryAgain",
          "common.cancel",
        ],
        primary: "common.tryAgain",
        tone: "danger",
        errorSlot: "screen",
      });
    case "no-code":
      // The account holds no recovery code: nothing to enter, so Start over is the way on.
      return makeView(ctx, "UnlockSync", {
        state: "no-code",
        copy: [
          "unlockSync.title",
          "unlockSync.noCode",
          "unlockSync.startOver",
          "common.cancel",
        ],
        primary: "unlockSync.startOver",
        tone: "neutral",
        focus: null,
      });
    case "start-over":
      // The warning comes first: the sync key is replaced only from this step (T22). Cancel takes
      // the first focus, never the destructive control. `focus` means KEYBOARD focus (and the
      // focus engine) in native kits; a screen reader's first stop is the heading, which names
      // what is being confirmed before any button is read.
      return makeView(ctx, "UnlockSync", {
        state: "start-over",
        copy: [
          "unlockSync.startOverTitle",
          "unlockSync.startOverWarning",
          "unlockSync.startOverConfirm",
          "common.cancel",
        ],
        primary: "unlockSync.startOverConfirm",
        tone: "neutral",
        focus: "common.cancel",
      });
    default: {
      const invalid = u.step === "invalid";
      return makeView(ctx, "UnlockSync", {
        state: invalid ? "invalid" : "code",
        copy: [
          "unlockSync.title",
          "unlockSync.lede",
          "unlockSync.field",
          invalid && "unlockSync.invalid",
          "recoveryCode.noAsk",
          "unlockSync.unlock",
          "unlockSync.startOver",
          "common.cancel",
        ],
        primary: "unlockSync.unlock",
        tone: invalid ? "danger" : null,
        errorSlot: invalid ? "unlockSync.field" : null,
        focus: "unlockSync.field",
      });
    }
  }
}

// ── RecoveryCode ───────────────────────────────────────────────────────────────────────────────

export type RecoveryCodeState = "show" | "saved" | "hidden";

/** The new recovery code, shown once. Done waits for the person to confirm they saved it. */
export function recoveryCodeView(
  ctx: Context,
): View<"RecoveryCode", RecoveryCodeState> {
  const r = ctx.input.recoveryCode;
  if (!ctx.on("sync") || !r) return hiddenView(ctx, "RecoveryCode");
  const saved = r.saved === true;
  return makeView(ctx, "RecoveryCode", {
    state: saved ? "saved" : "show",
    copy: [
      "recoveryCode.title",
      "recoveryCode.lede",
      "recoveryCode.noAsk",
      "recoveryCode.copy",
      "recoveryCode.saved",
      saved && "common.done",
    ],
    primary: saved ? "common.done" : null,
    focus: saved ? undefined : "heading",
  });
}

// ── RingChange ─────────────────────────────────────────────────────────────────────────────────

export type RingChangeState = "confirm" | "failed" | "hidden";

/** Confirm a changed ring: it names the device (`changed.by`) and offers to accept the ring that
 *  was shown (`changed.served`). The recovery code is the primary, safer way in. */
export function ringChangeView(
  ctx: Context,
): View<"RingChange", RingChangeState> {
  const r = ctx.input.ringChange;
  if (!ctx.on("sync") || !r) return hiddenView(ctx, "RingChange");
  const by = r.by?.trim() ? r.by : undefined;
  const failed = r.failed === true;
  return makeView(ctx, "RingChange", {
    state: failed ? "failed" : "confirm",
    copy: [
      "ringChange.title",
      by ? "ringChange.body" : "ringChange.bodyUnknown",
      // Nothing was served to confirm: no Accept, only the recovery code.
      r.served ? "ringChange.warning" : "ringChange.warningNoServed",
      failed && "ringChange.failed",
      r.served && "ringChange.accept",
      "ringChange.useCode",
      "common.cancel",
    ],
    args: { device: by },
    primary: "ringChange.useCode",
    tone: failed ? "danger" : "neutral",
    errorSlot: failed ? "screen" : null,
  });
}

/** The Cloud Sync screens' models, by name (they join `MODELS` with the kits that draw them). */
export const SYNC_MODELS: Readonly<
  Record<SyncScreenName, (ctx: Context) => View<SyncScreenName>>
> = {
  UnlockSync: unlockSyncView,
  RecoveryCode: recoveryCodeView,
  RingChange: ringChangeView,
};
