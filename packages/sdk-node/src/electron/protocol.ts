// The wire between `exposePolarisBridge` (Electron main) and the preload's PolarisBridge (SDK
// parity pass SP-N10). This module is imported by BOTH sides, so it has no Node or Electron
// import: a sandboxed preload can bundle it.
//
// Every call is `ipcRenderer.invoke("<prefix>:<method>", ...args)` answered by an
// `ipcMain.handle` that never rejects: it resolves an envelope, because Electron flattens a
// rejected handler into a bare message and the React desktop adapter maps refusals by their
// `code` (and an update refusal by its `detail`). The preload unwraps the envelope and rethrows
// an `Error` carrying `code` and `detail`.
//
// State pushes go the other way: the main process sends `<prefix>:stateChanged` to every
// renderer that subscribed (`<prefix>:subscribe`), whenever `client.events` reports a licence or
// config change, and after any verb that changes state.

/** The PolarisBridge protocol revision this host speaks (`@polaris-key/react`'s BRIDGE_VERSION). */
export const POLARIS_BRIDGE_VERSION = 3;

/** The default channel prefix and `window` key. */
export const DEFAULT_BRIDGE_CHANNEL = "polaris-key";
export const DEFAULT_BRIDGE_KEY = "polarisKey";

/** The bridge methods that cross IPC, each an `ipcMain.handle` channel `<prefix>:<method>`. */
export const BRIDGE_METHODS = [
  "getSyncState",
  "refresh",
  "beginSignIn",
  "pollSignIn",
  "submitKey",
  "signOut",
  "invoke",
  "fetchSchema",
  "importBundle",
  "subscribe",
  "unsubscribe",
] as const;
export type BridgeMethod = (typeof BRIDGE_METHODS)[number];

/** The `invoke(service, method, args)` verbs a host answers by default: exactly the ones the
 *  React desktop adapter calls. Anything else answers `invoke-not-allowed`; a host widens the
 *  list with `exposePolarisBridge(..., { invoke: { extra } })`. */
export const DEFAULT_INVOKE_VERBS = [
  "devices.list",
  "devices.rename",
  "devices.deauthorize",
  "devices.report",
  "update.check",
  "update.decide",
  "release.changelog",
  "release.installUrl",
  "release.downloadUrl",
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
