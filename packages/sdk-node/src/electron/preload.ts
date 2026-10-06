// `import "@polaris-key/node/electron/preload"` in an Electron preload exposes the PolarisBridge
// as `window.polarisKey`, matching `exposePolarisBridge(client, { ipcMain })` in the main
// process. A sandboxed preload (Electron's default) runs no ES modules from node_modules, so
// bundle the preload (Vite, esbuild, webpack) or, in a CommonJS preload, call
// `exposePolarisBridgeInMainWorld(require("electron"))` from `@polaris-key/node/electron/renderer`.
//
// `electron` is the host's own dependency; this package does not install it.

import { contextBridge, ipcRenderer } from "electron";
import { exposePolarisBridgeInMainWorld } from "./renderer.js";

exposePolarisBridgeInMainWorld({ contextBridge, ipcRenderer });
