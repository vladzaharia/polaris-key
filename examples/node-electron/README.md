# Electron with the React kit over the bridge

One setup line on each side:

- **main** (`src/main.ts`): `exposePolarisBridge(client, { ipcMain })`, with the token in
  `SafeStorageStore` and updates through `electronUpdaterDriver`. The boot guard counts each
  launch (`markBootAttempt` / `confirmBoot`).
- **preload** (`src/preload.ts`): `import "@polaris-key/node/electron/preload"`, bundled.
- **renderer** (`src/renderer.tsx`): `<PolarisKeyProvider mode="desktop">` and `<LicenseGate>`
  from `@polaris-key/react`, unchanged.

The renderer holds no credential: the sign-in's device code stays in the main process, and the
bridge answers only the verbs the React kit uses.

```sh
npm install && npm start
```

Add an `index.html` that loads `dist/renderer.js` into `<div id="root">`. Replace
`src/polaris.config.ts` with the file `pkey sdk --lang node --write` generates.
