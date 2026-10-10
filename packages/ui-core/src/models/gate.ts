// The gate family (ui-matrix.json `gate`): PolarisKeyGate, Boot, StatusScreen, GraceBanner and
// Toast. The gate routes; Boot draws the stage machine (client-core `stages.ts`, `ui.stages`);
// StatusScreen draws each blocking status with its own fix (never one collapsed error); the grace
// banner never extends grace visually; a toast is never the only record of an error.

import { codeCopy } from "../errors.js";
import type { Context } from "../input.js";
import { loadingVisible } from "../loading.js";
import { hiddenView, identityText, makeView, type View } from "../view.js";

/** The statuses that block the app, each a StatusScreen state with its own fix. */
export const BLOCKING_STATUSES = [
  "revoked",
  "expired",
  "version-too-old",
  "version-too-new",
  "channel-not-entitled",
] as const;
type Blocking = (typeof BLOCKING_STATUSES)[number];
const isBlocking = (s: string | undefined): s is Blocking =>
  (BLOCKING_STATUSES as readonly (string | undefined)[]).includes(s);

// ── PolarisKeyGate ─────────────────────────────────────────────────────────────────────────────

export type GateState =
  | "booting"
  | "needs-activation"
  | "licensed"
  | "grace"
  | "blocked"
  | "error";

/** The drop-in root: which screen the gate shows over (or instead of) the app. */
export function gateView(ctx: Context): View<"PolarisKeyGate", GateState> {
  const { gate, stage } = ctx.input;
  const status = gate?.status;
  // License off: the gate never stands between the person and the app.
  if (!ctx.on("license") || status === "not-applicable" || status === "ok")
    return makeView(ctx, "PolarisKeyGate", {
      state: "licensed",
      copy: [],
      focus: null,
    });
  if (stage?.outcome === "error")
    return makeView(ctx, "PolarisKeyGate", {
      state: "error",
      copy: ["gate.error.title", "common.tryAgain"],
      primary: "common.tryAgain",
      tone: "danger",
      errorSlot: "screen",
    });
  // A cached license being re-checked stays `booting`: activation never flashes (Must not).
  if (gate?.checking || status === undefined)
    return makeView(ctx, "PolarisKeyGate", {
      state: "booting",
      copy: loadingVisible(ctx.input.elapsedMs) ? ["gate.checking"] : [],
      focus: null,
    });
  if (status === "needs-activation")
    return makeView(ctx, "PolarisKeyGate", {
      state: "needs-activation",
      copy: [
        "core.gate.needs-activation.title",
        "core.gate.needs-activation.message",
      ],
      // Welcome draws the paths; the gate itself has no control.
      focus: null,
    });
  if (status === "grace")
    return makeView(ctx, "PolarisKeyGate", {
      state: "grace",
      copy: [
        "core.gate.grace.title",
        "core.gate.grace.message",
        "common.reconnect",
      ],
      // The app renders; the grace banner carries Reconnect and never takes focus.
      focus: null,
    });
  if (isBlocking(status))
    return makeView(ctx, "PolarisKeyGate", {
      state: "blocked",
      copy: ["part.status.blocked"],
      tone: "neutral",
      // StatusScreen draws the fix.
      focus: null,
    });
  return makeView(ctx, "PolarisKeyGate", {
    state: "error",
    copy: ["gate.error.title", "common.tryAgain"],
    primary: "common.tryAgain",
    tone: "danger",
    errorSlot: "screen",
  });
}

// ── Boot ───────────────────────────────────────────────────────────────────────────────────────

export type BootState =
  | "progress"
  | "consent"
  | "fetching"
  | "offline"
  | "blocked"
  | "declined"
  | "rolled-back"
  | "error";

/** The progress line for each running stage (no invented progress: one label, a still shimmer). */
const STAGE_LABEL: Readonly<Record<string, string>> = {
  idle: "boot.starting",
  shell: "boot.starting",
  guard: "boot.starting",
  sync: "boot.syncing",
  gate: "gate.checking",
  decide: "boot.deciding",
  mount: "common.loading",
  background: "common.loading",
};

/** First paint while the stage machine runs. */
export function bootView(ctx: Context): View<"Boot", BootState> {
  const stage = ctx.input.stage ?? { stage: "idle", outcome: "running" };
  const emit = stage.emit;
  const product = identityText(ctx).name;
  if (emit?.type === "boot_rolled_back")
    return makeView(ctx, "Boot", {
      state: "rolled-back",
      copy: ["boot.rolledBack"],
      args: { product },
      focus: null,
    });
  switch (stage.outcome) {
    case "error":
      return makeView(ctx, "Boot", {
        state: "error",
        copy: ["gate.error.title", "boot.error.body", "common.tryAgain"],
        primary: "common.tryAgain",
        tone: "danger",
        errorSlot: "screen",
      });
    case "blocked":
      if (emit?.reason === "content-declined")
        return makeView(ctx, "Boot", {
          state: "declined",
          copy: [
            "boot.declined.title",
            "boot.declined.body",
            "common.tryAgain",
          ],
          primary: "common.tryAgain",
          tone: "neutral",
        });
      // `update-required` and `not-available`: StatusScreen names the exact refusal; Boot stops
      // on the update it needs.
      return makeView(ctx, "Boot", {
        state: "blocked",
        copy: [
          "core.gate.version-too-old.title",
          "core.gate.version-too-old.message",
          "status.update",
        ],
        primary: "status.update",
        tone: "neutral",
      });
    case "offline": {
      const playable = emit?.canPlayOffline === true;
      return makeView(ctx, "Boot", {
        state: "offline",
        copy: [
          "boot.offline.title",
          playable ? "boot.offline.playable" : "boot.offline.body",
          playable && "boot.continueOffline",
          "common.tryAgain",
        ],
        args: { product },
        primary: playable ? "boot.continueOffline" : "common.tryAgain",
      });
    }
    case "waiting":
      if (emit?.type === "consent_needed") {
        const metered = emit.metered === true;
        return makeView(ctx, "Boot", {
          state: "consent",
          // Both choices stay on screen, metered or not (Must not).
          copy: [
            "boot.consent.title",
            metered ? "boot.consent.bodyMetered" : "boot.consent.body",
            "boot.consent.download",
            "common.notNow",
          ],
          args: {
            size: typeof emit.bytes === "number" ? emit.bytes : undefined,
          },
          primary: "boot.consent.download",
        });
      }
      break;
    case "ready":
      return makeView(ctx, "Boot", {
        state: "progress",
        copy: ["boot.ready"],
        focus: null,
      });
  }
  if (stage.stage === "fetch") {
    // A determinate bar only for counted bytes (DL7): before the first report there is none.
    const counted = emit?.type === "fetch_progress";
    return makeView(ctx, "Boot", {
      state: "fetching",
      copy: counted
        ? ["boot.fetchingProgress", "a11y.progress"]
        : ["boot.fetching"],
      args: counted
        ? { done: emit.done as number, total: emit.total as number }
        : {},
      focus: null,
    });
  }
  return makeView(ctx, "Boot", {
    state: "progress",
    copy: [STAGE_LABEL[stage.stage] ?? "common.loading", "a11y.busy"],
    focus: null,
  });
}

// ── StatusScreen ───────────────────────────────────────────────────────────────────────────────

export type StatusState = Blocking | "hidden";

/** One blocking status and its fix (DL6: a neutral refusal whose fix is the primary). */
export function statusScreenView(
  ctx: Context,
): View<"StatusScreen", StatusState> {
  const status = ctx.input.gate?.status;
  if (!ctx.on("license") || !isBlocking(status))
    return hiddenView(ctx, "StatusScreen");
  const allowed = ctx.input.gate?.allowed ?? {};
  const range =
    allowed.min !== undefined && allowed.max !== undefined
      ? "status.allowedRange"
      : allowed.min !== undefined
        ? "status.allowedMin"
        : allowed.max !== undefined
          ? "status.allowedMax"
          : null;
  const head = [`core.gate.${status}.title`, `core.gate.${status}.message`];
  const id = identityText(ctx);
  const args = {
    product: id.name,
    developer: id.developer ?? undefined,
    min: allowed.min,
    max: allowed.max,
  };
  switch (status) {
    case "revoked":
      return makeView(ctx, "StatusScreen", {
        state: status,
        copy: [...head, "signin.key.differentKey", "common.signOut"],
        args,
        primary: "signin.key.differentKey",
        tone: "neutral",
      });
    case "expired":
      return makeView(ctx, "StatusScreen", {
        state: status,
        copy: [...head, "status.renew", "status.useAnotherLicense"],
        args,
        primary: "status.renew",
        tone: "neutral",
      });
    case "version-too-old":
      return makeView(ctx, "StatusScreen", {
        state: status,
        copy: [...head, range, "status.update"],
        args,
        primary: "status.update",
        tone: "neutral",
      });
    case "version-too-new":
      // No fix the kit can reach: it is named in words (DL6), and the heading takes focus.
      return makeView(ctx, "StatusScreen", {
        state: status,
        copy: [...head, range === "status.allowedMin" ? null : range],
        args,
        tone: "neutral",
      });
    case "channel-not-entitled":
      return makeView(ctx, "StatusScreen", {
        state: status,
        copy: [...head, "status.switchChannel", "status.contact"],
        args,
        primary: "status.switchChannel",
        tone: "neutral",
      });
  }
}

// ── GraceBanner ────────────────────────────────────────────────────────────────────────────────

export type GraceState = "days-left" | "last-day" | "expired" | "hidden";

/** Offline grace: never shows a day that is not left (Must not). */
export function graceBannerView(ctx: Context): View<"GraceBanner", GraceState> {
  const gate = ctx.input.gate;
  if (!ctx.on("license")) return hiddenView(ctx, "GraceBanner");
  if (gate?.status === "expired")
    return makeView(ctx, "GraceBanner", {
      state: "expired",
      copy: ["core.gate.expired.title", "core.gate.expired.message"],
      tone: "neutral",
      focus: null,
    });
  if (gate?.status !== "grace") return hiddenView(ctx, "GraceBanner");
  const days = gate.graceDaysLeft;
  if (days !== undefined && days <= 1)
    return makeView(ctx, "GraceBanner", {
      state: "last-day",
      copy: ["grace.lastDay", "common.reconnect"],
      primary: "common.reconnect",
      focus: null,
    });
  return makeView(ctx, "GraceBanner", {
    state: "days-left",
    copy: [
      "grace.daysLeft",
      "grace.deadline",
      "common.reconnect",
      "common.dismiss",
    ],
    args: { days },
    primary: "common.reconnect",
    focus: null,
  });
}

// ── Toast ──────────────────────────────────────────────────────────────────────────────────────

export type ToastState =
  | "info"
  | "success"
  | "warning"
  | "error"
  | "with-progress"
  | "hidden";

/** One toast. An error toast persists (no timer) and never stands alone (Must not). */
export function toastView(ctx: Context): View<"Toast", ToastState> {
  const kind = ctx.input.toast?.kind;
  switch (kind) {
    case "update":
      if (!ctx.on("update")) return hiddenView(ctx, "Toast");
      return makeView(ctx, "Toast", {
        state: "info",
        copy: ["toast.updateAvailable", "common.dismiss", "a11y.toastTimer"],
        args: { version: ctx.input.update?.version },
        focus: null,
      });
    case "copied":
      return makeView(ctx, "Toast", {
        state: "success",
        copy: ["common.copied"],
        focus: null,
      });
    case "warning":
      return makeView(ctx, "Toast", {
        state: "warning",
        copy: ["common.dismiss"],
        focus: null,
      });
    case "error": {
      return makeView(ctx, "Toast", {
        state: "error",
        copy: [...codeCopy(ctx.input.error?.code), "common.dismiss"],
        tone: "danger",
        focus: null,
      });
    }
    case "progress":
      return makeView(ctx, "Toast", {
        state: "with-progress",
        copy: ["updateProgress.downloading", "toast.undo"],
        args: { fraction: ctx.input.update?.progress?.fraction },
        focus: null,
      });
    default:
      return hiddenView(ctx, "Toast");
  }
}
