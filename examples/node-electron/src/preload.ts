// The whole preload: expose window.polarisKey (PolarisBridge v3) for the React kit. Bundle it
// (Vite, esbuild): Electron's sandboxed preloads load no ES modules from node_modules.
import "@polaris-key/node/electron/preload";
