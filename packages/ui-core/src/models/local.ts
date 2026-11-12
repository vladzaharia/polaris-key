// Pair with a Code (ui-matrix.json `local`, CC-29K): LocalPairing, the windows two devices of one
// app on one network pair in by an 8-digit code or a QR with no account, and PairedDevices, the
// list of what they paired. Rules the rows pin:
//   - the code is the largest thing on the show screen; nothing else takes focus first on confirm,
//     so a stray Enter never pairs, and Pair on the field's screen is the person's yes: the
//     categories come before it, in the DOM too;
//   - a name the other device sent is unauthenticated text: it is isolated (`device` is in the
//     view's `isolate`) and never truncated in the consent title;
//   - Pair is drawn but unavailable (`disabled`) with its reason on screen when the field holds
//     fewer than 8 digits, the code that just failed, or a prefix with no dial left;
//   - after Too many tries the code stays gone for 30 seconds (the cooldown is the model's), and
//     a window that ran out has none;
//   - the Can connect switches show only when more than 8 devices are paired or one is off.
//
// `localPairingLayout` is the window rule for the show screen (UI-KITS 4.3, LocalPairing).

import type { Context, PairedDeviceInput } from "../input.js";
import type { ConnectScreenName } from "../vocabulary.js";
import { countdown } from "../link.js";
import { hiddenView, identityText, makeView, type View } from "../view.js";

/** The most paired devices that can connect at once (`MAX_LIVE_LOCAL_ADVERTS`). */
export const MAX_CONNECTABLE = 8;
/** The most paired devices one device holds (`MAX_LOCAL_LINKS`). */
export const MAX_PAIRED = 32;
/** The longest name a person may give a paired device. */
export const MAX_NAME = 64;
/** Seconds a new code waits after Too many tries. */
export const COOLDOWN_SECONDS = 30;

const FAILED_BODY = {
  declined: "linkPairing.failedDeclined",
  timeout: "linkPairing.failedTimeout",
  full: "localPairing.failedFull",
  closed: "linkPairing.failedClosed",
} as const;

export type LocalPairingState =
  | "choose"
  | "opening"
  | "show"
  | "closed"
  | "enter"
  | "joining"
  | "confirm"
  | "waiting"
  | "paired"
  | "failed"
  | "network-blocked"
  | "off"
  | "scan-prompt"
  | "scan"
  | "camera-off"
  | "hidden";

/** The categories line: the heading, or the words that nothing is shared. */
function sharesKey(categories: readonly string[] | undefined): string {
  return (categories ?? []).length === 0
    ? "linkPairing.sharesNone"
    : "linkPairing.shares";
}

const SCAN_NOTICE = {
  "other-app": "localPairing.otherApp",
  "not-found": "localPairing.scanNotFound",
  stale: "localPairing.scanStale",
  "not-ready": "localPairing.scannerNotReady",
  preparing: "localPairing.scannerPreparing",
} as const;

/** A scan notice that is a refusal of what was read (the others are passing news). */
const SCAN_REFUSAL = new Set(["other-app", "not-found", "stale"]);

/** The pairing screens, by state. */
export function localPairingView(
  ctx: Context,
): View<"LocalPairing", LocalPairingState> {
  const p = ctx.input.localPairing;
  if (!ctx.on("connect") || !p) return hiddenView(ctx, "LocalPairing");
  const device = p.device?.trim() ? p.device : undefined;
  const app = identityText(ctx).inlineName || undefined;
  const C = "LocalPairing" as const;
  switch (p.step) {
    case "choose":
      return makeView(ctx, C, {
        state: "choose",
        copy: [
          "localPairing.title",
          "localPairing.chooseBody",
          p.scanNotice && p.sheetScan && SCAN_NOTICE[p.scanNotice],
          p.canScan && "localPairing.scan",
          "localPairing.show",
          (!p.canScan || p.sheetScan) && "localPairing.enter",
          p.canScan && p.sheetScan && p.scanShares && sharesKey(p.categories),
          p.prePrompt && !p.full && "localPairing.prePrompt",
          p.full && "core.codes.local-links-full.title",
          p.full && "core.codes.local-links-full.message",
          p.full && "localPairing.pairedDevices",
          "common.cancel",
        ],
        args: { app },
        disabled: p.full
          ? [
              p.canScan ? "localPairing.scan" : "localPairing.enter",
              "localPairing.show",
            ]
          : [],
        tone: p.full
          ? "neutral"
          : p.sheetScan && p.scanNotice && SCAN_REFUSAL.has(p.scanNotice)
            ? "danger"
            : null,
        // Neither way is the primary: either device can show the code.
        focus: "heading",
      });
    case "opening":
      // The window is being opened: the code tile is a placeholder until the first code arrives, so
      // a slow start is never mistaken for nothing happening.
      return makeView(ctx, C, {
        state: "opening",
        copy: [
          "localPairing.title",
          "localPairing.showBody",
          "a11y.busy",
          "localPairing.toEnter",
          "common.cancel",
        ],
        focus: "heading",
      });
    case "show": {
      const n = p.notice;
      const renewing = p.busy === "new-code";
      return makeView(ctx, C, {
        state: "show",
        copy: [
          "localPairing.title",
          "localPairing.showBody",
          p.code && "a11y.linkCode",
          "a11y.qrPairing",
          "localPairing.expires",
          "localPairing.waitingDevice",
          "localPairing.toEnter",
          "common.cancel",
          (n === "rotated" || n === "guessing") && "localPairing.rotatedTitle",
          n === "rotated" && "localPairing.rotatedBody",
          n === "declined" && "localPairing.rotatedBody",
          n === "declined" && "localPairing.notPairedWith",
          (n === "rotated" || n === "declined" || n === "guessing") &&
            "a11y.newCode",
          n === "blocked" && "localPairing.blockedTitle",
          n === "blocked" && "localPairing.blockedBody",
          n === "guessing" && "localPairing.tooManyAgainBody",
          n && n !== "blocked" && "localPairing.showNew",
          renewing && "a11y.busy",
        ],
        args: {
          code: p.code,
          time: countdown(p.secondsLeft ?? 0),
          device,
        },
        disabled: [renewing && "localPairing.showNew"],
        tone: n ? "neutral" : null,
        focus: "heading",
      });
    }
    case "closed": {
      const cooling = (p.cooldownLeft ?? 0) > 0;
      const shown = cooling ? "localPairing.showNewIn" : "localPairing.showNew";
      return makeView(ctx, C, {
        state: "closed",
        copy: [
          "linkPairing.failedTitle",
          p.closedBy === "too-many-tries"
            ? "localPairing.failedTooMany"
            : "localPairing.failedExpired",
          p.warn && "localPairing.tooManyAgainTitle",
          p.warn && "localPairing.tooManyAgainBody",
          shown,
          "common.close",
        ],
        args: { time: countdown(p.cooldownLeft ?? 0) },
        disabled: [cooling && "localPairing.showNewIn"],
        primary: shown,
        tone: "neutral",
        // The primary cannot be pressed during the wait: focus rests on the heading.
        focus: cooling ? "heading" : shown,
      });
    }
    case "scan-prompt":
      // Once, before the system asks for the camera: the person's own words come first.
      return makeView(ctx, C, {
        state: "scan-prompt",
        copy: [
          "localPairing.cameraPromptTitle",
          "localPairing.cameraPrePrompt",
          "common.continue",
          "localPairing.enterInstead",
        ],
        args: { app },
        primary: "common.continue",
        focus: "heading",
      });
    case "scan":
      // Pairs as soon as a code reads: a QR is this person's yes, so the categories come first.
      return makeView(ctx, C, {
        state: "scan",
        copy: [
          "localPairing.title",
          "localPairing.scanBody",
          "a11y.cameraView",
          p.cameraBusy && "localPairing.cameraBusy",
          p.scanNotice && SCAN_NOTICE[p.scanNotice],
          sharesKey(p.categories),
          "localPairing.enterInstead",
          "common.back",
        ],
        tone: p.scanNotice && SCAN_REFUSAL.has(p.scanNotice) ? "danger" : null,
        focus: "heading",
      });
    case "camera-off":
      return makeView(ctx, C, {
        state: "camera-off",
        copy: [
          "localPairing.title",
          "localPairing.cameraOffTitle",
          "localPairing.cameraOffBody",
          p.canOpenSettings !== false && "localPairing.openSettings",
          sharesKey(p.categories),
          "localPairing.enterInstead",
          "common.back",
        ],
        tone: "neutral",
        focus: "heading",
      });
    case "enter":
    case "joining": {
      const busy = p.step === "joining";
      const e = p.error;
      const spent = !busy && p.triesLeft === 0 && e === undefined;
      return makeView(ctx, C, {
        state: p.step,
        copy: [
          "localPairing.title",
          "localPairing.enterBody",
          "localPairing.codeLabel",
          !busy && !p.entry && "localPairing.codePlaceholder",
          sharesKey(p.categories),
          "localPairing.pair",
          busy
            ? "a11y.busy"
            : p.canScan
              ? "localPairing.scanInstead"
              : "localPairing.toShow",
          busy ? "common.cancel" : "common.back",
          !busy && e === "wrong" && "localPairing.wrongCode",
          !busy &&
            (e === "wrong" || e === undefined) &&
            p.triesLeft === 1 &&
            "localPairing.triesLeft",
          !busy && (e === "spent" || spent) && "localPairing.spentCode",
          !busy && e === "too-many" && "localPairing.cooldownTitle",
          !busy && e === "too-many" && "localPairing.cooldownBody",
          !busy && e === "not-found" && "localPairing.notFoundTitle",
          !busy && e === "not-found" && "localPairing.notFoundBody",
          !busy && e === "not-a-code" && "localPairing.notACode",
        ],
        args: { left: p.triesLeft ?? undefined },
        disabled: [(busy || p.pairDisabled) && "localPairing.pair"],
        primary: "localPairing.pair",
        tone: e === "wrong" || e === "not-a-code" ? "danger" : null,
        errorSlot:
          e === "wrong" || e === "not-a-code" ? "localPairing.codeLabel" : null,
        // The field takes focus on a fine pointer (DL9 sends a coarse one to the heading); a busy
        // Pair keeps it, so the screen reader keeps its place.
        focus: busy ? "localPairing.pair" : "localPairing.codeLabel",
      });
    }
    case "confirm":
      return makeView(ctx, C, {
        state: "confirm",
        copy: [
          device ? "localPairing.confirmTitle" : "localPairing.confirmUnnamed",
          "localPairing.confirmBody",
          sharesKey(p.categories),
          "localPairing.pair",
          "common.notNow",
          p.busy && "a11y.busy",
        ],
        args: { device },
        // A press is being answered: both controls wait, whichever was pressed.
        disabled: p.busy ? ["localPairing.pair", "common.notNow"] : [],
        primary: "localPairing.pair",
        // Not now first, behind the 250 ms guard: Enter on arrival never pairs.
        focus: "common.notNow",
      });
    case "waiting":
      return makeView(ctx, C, {
        state: "waiting",
        copy: [
          "linkPairing.waiting",
          device && "localPairing.waitingWith",
          sharesKey(p.categories),
          "common.cancel",
        ],
        args: { device },
        focus: "heading",
      });
    case "paired":
      return makeView(ctx, C, {
        state: "paired",
        copy: [
          "localPairing.pairedTitle",
          "localPairing.pairedBody",
          "localPairing.nameLabel",
          "localPairing.nameHint",
          p.cantConnect && "localPairing.cantConnectTitle",
          p.cantConnect && "localPairing.cantConnectBody",
          p.cantConnect && "localPairing.pairedDevices",
          p.nameError && "devices.renameFailed",
          "common.done",
        ],
        args: { device: device ?? "", max: p.max ?? MAX_CONNECTABLE },
        primary: "common.done",
        tone: p.nameError ? "danger" : p.cantConnect ? "neutral" : null,
        errorSlot: p.nameError ? "localPairing.nameLabel" : null,
        focus: "heading",
      });
    case "failed": {
      const reason = p.reason ?? "closed";
      return makeView(ctx, C, {
        state: "failed",
        copy: [
          "linkPairing.failedTitle",
          FAILED_BODY[reason],
          "common.tryAgain",
          "common.close",
        ],
        // "full" cannot succeed until a pairing is forgotten: Close leads.
        primary: reason === "full" ? "common.close" : "common.tryAgain",
        tone: "neutral",
        focus: "heading",
      });
    }
    case "network-blocked":
      return makeView(ctx, C, {
        state: "network-blocked",
        copy: [
          "core.codes.nearby-permission-denied.title",
          "core.codes.nearby-permission-denied.message",
          p.canOpenSettings && "localPairing.openSettings",
          "common.tryAgain",
          "common.close",
        ],
        // Try again returns to the step the person was on, with the field kept.
        primary: p.canOpenSettings
          ? "localPairing.openSettings"
          : "common.tryAgain",
        tone: "neutral",
        focus: "heading",
      });
    default:
      return makeView(ctx, C, {
        state: "off",
        copy: [
          "core.codes.local-pairing-off.title",
          "core.codes.local-pairing-off.message",
          "common.close",
        ],
        // Close is the only way out of a refusal: it is not the filled one.
        tone: "neutral",
        focus: "heading",
      });
  }
}

// ── PairedDevices ──────────────────────────────────────────────────────────────────────────────

export type PairedDevicesState =
  | "loading"
  | "list"
  | "renaming"
  | "forgetting"
  | "empty"
  | "load-failed"
  | "off"
  | "hidden";

/** The Can connect column (M8): only when more than 8 are paired or one is off; with every device
 *  on and 8 or fewer, the switch would do nothing useful. */
export function showSwitchColumn(
  devices: readonly Pick<PairedDeviceInput, "reachable">[],
): boolean {
  return devices.length > MAX_CONNECTABLE || devices.some((d) => !d.reachable);
}

/** True when the eight that can connect are all on and more are paired: the off switches wait. */
export function reachableFull(
  devices: readonly Pick<PairedDeviceInput, "reachable">[],
): boolean {
  return (
    devices.length > MAX_CONNECTABLE &&
    devices.filter((d) => d.reachable).length >= MAX_CONNECTABLE
  );
}

const NOTICE = {
  "not-found": ["pairedDevices.notFoundTitle", "pairedDevices.notFoundBody"],
  busy: ["pairedDevices.busyTitle", "common.tryAgain"],
  unknown: ["core.codes.link-unknown.title", "core.codes.link-unknown.message"],
} as const;

/** The paired devices and what the person is doing to one row. */
export function pairedDevicesView(
  ctx: Context,
): View<"PairedDevices", PairedDevicesState> {
  const p = ctx.input.pairedDevices;
  if (!ctx.on("connect") || !p) return hiddenView(ctx, "PairedDevices");
  const C = "PairedDevices" as const;
  const devices = p.devices ?? [];
  const full = devices.length >= MAX_PAIRED;
  // Until the first read answers nothing is said about what is paired, not even "none yet".
  if (p.step === "loading")
    return makeView(ctx, C, {
      state: "loading",
      copy: ["pairedDevices.title", "a11y.busy", "common.done"],
      focus: "heading",
    });
  if (p.step === "load-failed")
    return makeView(ctx, C, {
      state: "load-failed",
      copy: [
        "pairedDevices.title",
        "pairedDevices.loadFailed",
        "common.tryAgain",
        "common.done",
      ],
      primary: "common.tryAgain",
      tone: "danger",
      errorSlot: "screen",
      focus: "heading",
    });
  if (p.step === "off")
    return makeView(ctx, C, {
      state: "off",
      copy: [
        "pairedDevices.title",
        "core.codes.local-pairing-off.title",
        "pairedDevices.offBody",
        devices.some((d) => d.lastSeen !== null) && "pairedDevices.lastSeen",
        devices.length > 0 && "a11y.deviceOptions",
        devices.length > 0 && "devices.rename",
        devices.length > 0 && "pairedDevices.forget",
        "common.done",
      ],
      args: { device: devices[0]?.label ?? undefined, when: undefined },
      primary: "common.done",
      tone: "neutral",
      focus: "heading",
    });
  if (devices.length === 0)
    return makeView(ctx, C, {
      state: "empty",
      copy: [
        "pairedDevices.title",
        "pairedDevices.empty",
        "pairedDevices.pair",
        "common.done",
      ],
      primary: "pairedDevices.pair",
      focus: "heading",
    });
  const switches = showSwitchColumn(devices);
  const state: PairedDevicesState =
    p.step === "renaming"
      ? "renaming"
      : p.step === "forgetting"
        ? "forgetting"
        : "list";
  // A row being edited is the one thing on screen: the list's notices wait.
  const waits = state === "list" && reachableFull(devices);
  const notice = state === "list" && p.notice ? NOTICE[p.notice.kind] : null;
  const target = devices.find((d) => d.id === p.target);
  const name = target?.label?.trim() ? target.label : (devices[0]?.label ?? "");
  return makeView(ctx, C, {
    state,
    copy: [
      "pairedDevices.title",
      "pairedDevices.lede",
      devices.some((d) => d.lastSeen !== null) && "pairedDevices.lastSeen",
      "a11y.deviceOptions",
      "devices.rename",
      "pairedDevices.forget",
      switches && "pairedDevices.canConnect",
      switches && "a11y.letConnect",
      waits && "pairedDevices.reachableFullTitle",
      waits && "pairedDevices.reachableFullBody",
      state === "list" && full && "core.codes.local-links-full.title",
      state === "list" && full && "pairedDevices.fullBody",
      notice?.[0],
      notice?.[1],
      state === "renaming" && "devices.renameLabel",
      state === "renaming" && "localPairing.nameHint",
      state === "renaming" && "common.save",
      state === "renaming" && "common.cancel",
      state === "renaming" &&
        p.renameError === "long" &&
        "pairedDevices.renameLong",
      state === "renaming" &&
        p.renameError === "empty" &&
        "pairedDevices.renameEmpty",
      state === "renaming" &&
        p.renameError === "failed" &&
        "devices.renameFailed",
      state === "forgetting" && "pairedDevices.forgetConfirm",
      state === "forgetting" && "pairedDevices.forgetBody",
      state === "forgetting" && p.forgetError && "pairedDevices.forgetFailed",
      state === "forgetting" && "common.cancel",
      "pairedDevices.pair",
      "common.done",
    ],
    args: {
      device: p.notice?.device ?? name,
      max: p.renameError === "long" ? MAX_NAME : MAX_CONNECTABLE,
    },
    disabled: [full && "pairedDevices.pair"],
    // The row being edited owns the filled control; otherwise Pair with a Code is the one primary
    // (drawn unavailable when there is no room).
    primary:
      state === "renaming"
        ? "common.save"
        : state === "forgetting"
          ? "pairedDevices.forget"
          : "pairedDevices.pair",
    tone: state === "renaming" && p.renameError ? "danger" : null,
    errorSlot:
      state === "renaming" && p.renameError ? "devices.renameLabel" : null,
    focus:
      state === "renaming"
        ? "devices.renameLabel"
        : state === "forgetting"
          ? "common.cancel"
          : "heading",
  });
}

// ── The window rule ─────────────────────────────────────────────────────────────────────────────

/** A window's size, in px at the root text size, and how the person's text is scaled. */
export interface WindowSize {
  width: number;
  height: number;
  /** 1 is the root size; 2 is 200 % text. */
  textScale?: number;
  /** A TV or a console: always two panes, inside the title-safe area. */
  tv?: boolean;
}

/** How the show screen lays out for a window size (UI-KITS 4.3, LocalPairing). */
export interface LocalPairingLayout {
  /** 2: the QR sits beside the code; 1: under it. */
  panes: 1 | 2;
  /** False in a window under 480 tall: it shows its own logo, so the kit's would only cost room. */
  logo: boolean;
  /** True when the one column is taller than the window: the window scrolls and nothing clips. */
  scrolls: boolean;
  /** True when the notice must come before the QR in a window that scrolls, so a wrong code's
   *  notice is not left under the QR out of view; the live region announces it either way. */
  noticeBeforeQr: boolean;
}

/**
 * Two panes from 600 px of window at the root text size (so 200 % text keeps one column), at any
 * height, and always on a TV. A window under 480 tall drops the logo. A window both narrow and
 * short keeps one column that scrolls, with the notice before the QR.
 */
export function localPairingLayout(w: WindowSize): LocalPairingLayout {
  const scale = w.textScale && w.textScale > 0 ? w.textScale : 1;
  const panes = w.tv === true || w.width / scale >= 600 ? 2 : 1;
  const short = w.height < 480 && w.tv !== true;
  return {
    panes,
    logo: !short,
    scrolls: panes === 1 && short,
    noticeBeforeQr: panes === 1 && short,
  };
}

/** The pairing screens' models, by name. */
export const LOCAL_MODELS: Readonly<
  Record<
    Extract<ConnectScreenName, "LocalPairing" | "PairedDevices">,
    (ctx: Context) => View<ConnectScreenName>
  >
> = {
  LocalPairing: localPairingView,
  PairedDevices: pairedDevicesView,
};
