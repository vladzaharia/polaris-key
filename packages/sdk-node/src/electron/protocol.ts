// The wire between `exposePolarisBridge` (Electron main) and the preload's PolarisBridge (SDK
// parity pass SP-N10, v4 in SP-31). This module is imported by BOTH sides, so it has no Node or Electron
// import: a sandboxed preload can bundle it.
//
// Every call is `ipcRenderer.invoke("<prefix>:<method>", ...args)` answered by an
// `ipcMain.handle` that never rejects: it resolves an envelope, because Electron flattens a
// rejected handler into a bare message and the React desktop adapter maps refusals by their
// `code` (and an update refusal by its `detail`). The preload unwraps the envelope and rethrows
// an `Error` carrying `code` and `detail`.
//
// State pushes go the other way: the main process sends `<prefix>:stateChanged` to every
// renderer that subscribed (`<prefix>:subscribe`), whenever `client.events` reports a license or
// config change, and after any verb that changes state.

/** The PolarisBridge protocol revision this host speaks (`@polaris-key/react`'s BRIDGE_VERSION). */
export const POLARIS_BRIDGE_VERSION = 6;

/** The default channel prefix and `window` key. */
export const DEFAULT_BRIDGE_CHANNEL = "polaris-key";
export const DEFAULT_BRIDGE_KEY = "polarisKey";

/** The v4 bridge methods that cross IPC, each an `ipcMain.handle` channel `<prefix>:<method>`. */
const BRIDGE_V4_METHODS = [
  "getSyncState",
  "refresh",
  "beginSignIn",
  "pollSignIn",
  "submitKey",
  "signOut",
  "invoke",
  "fetchSchema",
  "importBundle",
  "openExternal",
  "subscribe",
  "unsubscribe",
] as const;

/** v5 (I-47b): the automatic and nearby sign-in methods. Permits never cross IPC: the renderer
 *  holds only an `askId` (128 random bits, single use, bound to the sender's `webContents.id`). */
export const BRIDGE_V5_METHODS = [
  "autoSignIn",
  "nearbyStart",
  "nearbyChoose",
  "nearbyConfirm",
  "nearbyDecline",
  "nearbyCancel",
  "approverStart",
  "approverStop",
  "approverPick",
  "approverDeny",
  "approverChoose",
] as const;

/** Every bridge method that crosses IPC (v4 and v5), each an `ipcMain.handle` channel. */
export const BRIDGE_METHODS = [
  ...BRIDGE_V4_METHODS,
  ...BRIDGE_V5_METHODS,
] as const;
export type BridgeMethod = (typeof BRIDGE_METHODS)[number];

/** The `invoke(service, method, args)` verbs a host answers by default: every one the React
 *  desktop adapter sends to a v4 host (`test/electronBridge.test.ts` enumerates the adapter's
 *  calls and fails on a pair missing here). Anything else answers `invoke-not-allowed`; a host
 *  widens the list with `exposePolarisBridge(..., { invoke: { extra } })`. */
export const DEFAULT_INVOKE_VERBS = [
  // v3
  "devices.list",
  "devices.rename",
  "devices.deauthorize",
  "devices.report",
  "update.check",
  "update.decide",
  "release.changelog",
  "release.installUrl",
  "release.downloadUrl",
  // Discovery's `core.presentation` (HA-13): one verified icon's bytes. The member itself rides
  // every state push (`presentation`).
  "core.presentationIcon",
  // v4 (SP-R07)
  "config.mint",
  "commerce.binding",
  "commerce.claim",
  "core.discovery",
  "core.storeStatus",
  "devices.id",
  // v4 (SP-12)
  "core.boot",
  "core.crashTags",
  // v4 (SP-58): `client.backend.headers()`, the licence and device headers for the app's own backend
  "core.backendHeaders",
  "release.fetch",
  "distribution.downloadModel",
  "distribution.thisPlatform",
  "update.feedUrl",
  // v4 (SP-13 config.local, SP-14 update-health events)
  "config.set",
  "config.clear",
  "update.journal",
  // v4 (SP-15 install driver, boot guard)
  "update.install",
  "update.restart",
  "update.markBootAttempt",
  "update.confirmBoot",
  // I-10a.9: the account, over `invoke` (no new bridge method)
  "identity.subject",
  "identity.attach",
  "identity.openAccount",
  // v6 (UK-42.22.7): the licence and device choice after a device sign-in ends in `choose`. The
  // `grant` argument is an opaque ref the host bound to the polling window; no grant crosses IPC.
  "identity.choice.licenses",
  "identity.choice.devices",
  "identity.choice.complete",
  "identity.choice.cancel",
] as const;

/** What every handler resolves. */
export type BridgeEnvelope =
  | { ok: true; value: unknown }
  | { ok: false; code: string; message: string; detail?: string | null };

export function channelOf(prefix: string, method: BridgeMethod): string {
  return `${prefix}:${method}`;
}

export function stateChannel(prefix: string): string {
  return `${prefix}:stateChanged`;
}

/** v4 (UK-06): the main process sends `<prefix>:updateProgress` (a `BridgeUpdateProgress`) to
 *  every subscribed renderer while `update.install` runs. Optional: an older host never sends it. */
export function updateProgressChannel(prefix: string): string {
  return `${prefix}:updateProgress`;
}

/** A view the host can ask the renderer to open (`@polaris-key/react`'s `KitView`). */
export type KitView = "settings" | "update" | "nearby";
export const KIT_VIEWS: readonly KitView[] = ["settings", "update", "nearby"];

/** v4 (UK-06): the main process sends `<prefix>:open` (a `KitView`) when a native menu item asks
 *  the renderer to open Settings or Update. Optional: an older host never sends it. */
export function openChannel(prefix: string): string {
  return `${prefix}:open`;
}
