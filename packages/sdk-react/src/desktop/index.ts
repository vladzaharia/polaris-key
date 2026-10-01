// @polaris-key/react/desktop — the Electron/Tauri transport. Import the `PolarisBridge`
// type on the Node/preload side to implement the IPC contract; `@polaris-key/node`'s
// `PolarisKeyClient.getSyncState()` satisfies its state half unchanged.

export {
  DesktopAdapter,
  desktopAdapter,
  type DesktopAdapterOptions,
} from "./desktopAdapter.js";
export {
  BRIDGE_VERSION,
  resolveBridge,
  type PolarisBridge,
  type PolarisBridgeWindow,
  type BridgeState,
  type BridgeOidcBegin,
  type BridgeOidcPoll,
  type BridgeActivation,
  type BridgeImportBundle,
} from "./bridge.js";
