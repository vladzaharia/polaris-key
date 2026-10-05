// `@polaris-key/node/electron`: the Electron main process's half of the integration (SDK parity
// pass §2.1). `exposePolarisBridge` serves `@polaris-key/react`'s DesktopAdapter over IPC, and
// `SafeStorageStore` keeps the device token under Electron's safeStorage. The preload half is
// `@polaris-key/node/electron/preload` (or `/electron/renderer` for a custom preload).

export {
  bridgeActivation,
  bridgeState,
  exposePolarisBridge,
  type ExposePolarisBridgeOptions,
  type IpcMainInvokeEventLike,
  type IpcMainLike,
  type PolarisBridgeHandle,
  type WebContentsLike,
} from "./main.js";
export {
  SafeStorageStore,
  type SafeStorageLike,
  type SafeStorageStoreOptions,
} from "./safeStorage.js";
export {
  BRIDGE_METHODS,
  DEFAULT_BRIDGE_CHANNEL,
  DEFAULT_BRIDGE_KEY,
  DEFAULT_INVOKE_VERBS,
  POLARIS_BRIDGE_VERSION,
  type BridgeEnvelope,
} from "./protocol.js";
