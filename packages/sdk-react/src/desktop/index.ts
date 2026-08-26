// @plrs/react/desktop — the Electron/Tauri transport. Import the `PolarisBridge`
// type on the Node/preload side to implement the IPC contract.

export {
  DesktopAdapter,
  desktopAdapter,
  type DesktopAdapterOptions,
} from "./desktopAdapter.js";
export {
  resolveBridge,
  type PolarisBridge,
  type PolarisBridgeWindow,
  type BridgeState,
  type BridgeOidcBegin,
  type BridgeOidcPoll,
  type BridgeActivation,
} from "./bridge.js";
