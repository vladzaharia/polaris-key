// The deviceLimit and devices families (ui-matrix.json `deviceLimit`, `devices`): Replace a device
// (PORTAL §4.25, SIGN-IN.md §3.7, D-08) and the license's device list. Replacing another device
// never touches this device's files; "This device" shows only when the runtime knows it.

import type { Context, DeviceInput } from "../input.js";
import { platformClass } from "../input.js";
import { linkVerdict } from "../link.js";
import { loadingVisible } from "../loading.js";
import { hiddenView, identityText, makeView, type View } from "../view.js";

// ── DeviceLimit ────────────────────────────────────────────────────────────────────────────────

export type DeviceLimitState =
  | "default"
  | "busy"
  | "removed"
  | "failed"
  | "browser-mode"
  | "hidden";

/** The device a Replace preselects: the least recently used one that is not this device. */
export function leastRecent(
  devices: readonly DeviceInput[],
): DeviceInput | null {
  let pick: DeviceInput | null = null;
  for (const d of devices)
    if (
      !d.current &&
      (pick === null || (d.lastSeenDays ?? -1) > (pick.lastSeenDays ?? -1))
    )
      pick = d;
  return pick;
}

/** The focused Replace a device flow on the key path. */
export function deviceLimitView(
  ctx: Context,
): View<"DeviceLimit", DeviceLimitState> {
  if (!ctx.on("license")) return hiddenView(ctx, "DeviceLimit");
  const a = ctx.input.activation;
  const product = identityText(ctx).name;
  const args = {
    product,
    used: a?.deviceCount,
    limit: a?.limit,
  };
  const replacement = ctx.input.replacement;
  if (replacement?.outcome === "done")
    return makeView(ctx, "DeviceLimit", {
      state: "removed",
      copy: ["deviceLimit.removed"],
      args: { ...args, device: replacement.device },
    });
  if (replacement?.outcome === "failed")
    return makeView(ctx, "DeviceLimit", {
      state: "failed",
      copy: ["deviceLimit.failed", "common.tryAgain"],
      args: { ...args, device: replacement.device },
      primary: "common.tryAgain",
      tone: "danger",
      errorSlot: "deviceLimit.primary",
    });
  if (ctx.input.pending === "replace")
    return makeView(ctx, "DeviceLimit", {
      state: "busy",
      copy: ["deviceLimit.primary", "common.working", "a11y.busy"],
      args,
      primary: "deviceLimit.primary",
    });
  const devices = ctx.input.devices;
  const link = linkVerdict(a?.manageUrl, ctx.platform, "replace-device");
  // Layer 1 has no device list on the key path: Replace a device opens the link (PX-W8), as a QR
  // on a TV or a console.
  if (link.url !== null && !devices) {
    const c = platformClass(ctx.platform);
    const tv = c === "tv" || c === "console";
    return makeView(ctx, "DeviceLimit", {
      state: "browser-mode",
      copy: [
        "deviceLimit.title",
        "deviceLimit.browser",
        tv ? "deviceLimit.scan" : "deviceLimit.openBrowser",
        tv ? "a11y.qr" : "a11y.externalLink",
      ],
      args,
      primary: tv ? null : "deviceLimit.openBrowser",
      tone: "neutral",
      link,
    });
  }
  const list = devices ?? [];
  const pick = leastRecent(list);
  return makeView(ctx, "DeviceLimit", {
    state: "default",
    copy: [
      "deviceLimit.title",
      "deviceLimit.heading",
      "deviceLimit.lede",
      a?.limit !== undefined && "part.seatMeter.caption",
      a?.limit !== undefined && "a11y.seatMeter",
      list.length > 0 && "signin.replace.meta",
      list.length > 0 && "a11y.formFactor",
      pick !== null && "signin.replace.leastRecent",
      pick !== null && "deviceLimit.confirmTitle",
      pick !== null && "deviceLimit.consequence",
      "deviceLimit.primary",
      "common.back",
    ],
    args: { ...args, device: pick?.name ?? undefined },
    // A full license is a limit, not an error: Replace and continue is its fix (DL6).
    primary: "deviceLimit.primary",
    tone: "neutral",
  });
}

// ── Devices ────────────────────────────────────────────────────────────────────────────────────

export type DevicesState =
  | "loading"
  | "list"
  | "renaming"
  | "confirming"
  | "empty"
  | "browser-mode"
  | "error"
  | "hidden";

/** The license's devices: rename and remove inline, "This device" only when known. */
export function devicesView(ctx: Context): View<"Devices", DevicesState> {
  if (!ctx.on("license")) return hiddenView(ctx, "Devices");
  const { devices, edit, error } = ctx.input;
  if (ctx.input.loading)
    return makeView(ctx, "Devices", {
      state: "loading",
      copy: loadingVisible(ctx.input.elapsedMs)
        ? ["devices.title", "common.loading"]
        : [],
      focus: null,
    });
  if (error) {
    // A failed load is an error state with Try again, never "No devices" (DL7); a failed edit's
    // message sits in its row.
    const [key, slot] =
      edit?.kind === "rename"
        ? ["devices.renameFailed", "devices.renameLabel"]
        : edit?.kind === "remove"
          ? ["devices.removeFailed", "devices.remove"]
          : ["devices.loadFailed", "screen"];
    return makeView(ctx, "Devices", {
      state: "error",
      copy: [key, "common.tryAgain"],
      args: { device: edit?.device },
      primary: "common.tryAgain",
      tone: "danger",
      errorSlot: slot,
    });
  }
  if (ctx.input.browserMode)
    return makeView(ctx, "Devices", {
      state: "browser-mode",
      copy: ["devices.browser", "devices.manage", "a11y.externalLink"],
      primary: "devices.manage",
    });
  if (edit?.kind === "rename")
    return makeView(ctx, "Devices", {
      state: "renaming",
      copy: ["devices.renameLabel", "common.save", "common.cancel"],
      args: { device: edit.device },
      primary: "common.save",
      focus: "devices.renameLabel",
    });
  if (edit?.kind === "remove")
    return makeView(ctx, "Devices", {
      state: "confirming",
      copy: ["devices.removeConfirm", "devices.remove", "common.cancel"],
      args: { device: edit.device },
      primary: "devices.remove",
    });
  const list = devices ?? [];
  if (list.length === 0)
    return makeView(ctx, "Devices", {
      state: "empty",
      copy: ["devices.empty"],
    });
  return makeView(ctx, "Devices", {
    state: "list",
    copy: [
      "devices.title",
      "devices.lede",
      "devices.count",
      "devices.meta",
      "a11y.formFactor",
      "devices.rename",
      "devices.remove",
      "a11y.renameDevice",
      "a11y.removeDevice",
      // "This device" only when the runtime knows which row it is (Must not).
      list.some((d) => d.current) && "part.thisDeviceTitle",
      list.some((d) => !d.name) && "devices.unnamed",
    ],
    args: { count: list.length },
    // An embedded pane: row actions only, none filled; the heading takes focus.
  });
}
