# Tidewater Studio: the Electron Forge sample

Tidewater Studio by Harbor Audio, gated by the Polaris Key kit in an Electron Forge app (Vite
plugin). Two lines wire it:

- **main** (`src/main.ts`): `exposePolarisBridge(client, { ipcMain, appOrigin, downloadDir, notifications, electron })`.
  The app menu (macOS) or the Help menu gets `bridge.menuItems()`.
- **preload** (`src/preload.ts`): `import "@polaris-key/node/electron/preload"`.
- **renderer** (`src/renderer.tsx`): `<PolarisKeyProvider><PolarisKeyGate><App/></PolarisKeyGate></PolarisKeyProvider>`
  and `@polaris-key/react/styles.css`. `<PolarisKeyGate theme={{ platform: "auto" }}>` picks the
  chrome (Windows, macOS, GNOME) and the host accent from the OS the bridge reports.

The window uses `contextIsolation: true` and `sandbox: true`, refuses popups and navigation, and
the bridge answers only the top frame of `appOrigin` (the dev server's origin, or `app://main`
in a build, pinned by scheme and host).

## Run it against the fixture

`src/fixtures.ts` stands in for the client: no Worker, no network, no keys. The bridge, preload
and kit are the real ones.

The `@polaris-key/node` and `@polaris-key/react` entries in `package.json` are the repo's workspace
versions (`^0.0.0`). Outside the repo, install the released versions from the registry that
publishes them (set `@polaris-key:registry` in an `.npmrc`) and change the two ranges to match.

```sh
npm install
npm start
```

- `pkey_tidewater_7Q2Mx9cLr4TbV0aZ3WPLDA` activates; any other `pkey_tidewater_` key hits the
  device limit once.
- Sign in shows a code, then signs in about four seconds later.
- Check for Updates (menu) offers 2.5.0 and installs it with progress.
- `TIDEWATER_STATE=ok|grace|expired|revoked|version-too-old|version-too-new|channel-not-entitled npm start`
  pins the gate.
- `npm run smoke` launches, waits for the gate and exits (`--shot=<png>` saves the window,
  `--scheme=dark|light` sets the scheme).

## Run it against a Worker

Replace `src/polaris.config.ts` with the file `pkey sdk --lang node --write` generates, then:

```sh
npm run live
```

`--live` builds the real client with `SafeStorageStore` and `electronUpdaterDriver`
(`src/live.ts`).

## Inside this repository

The folder has no installed `@polaris-key` packages; the Vite configs alias them to the repo's
builds.

```sh
mise exec node@22 -- pnpm --filter @polaris-key/node --filter @polaris-key/react build
cd examples/ui/electron
# install electron, Forge, Vite and React (the @polaris-key entries are aliased)
mise exec node@22 -- ./node_modules/.bin/electron-forge start -- --smoke
mise exec node@22 -- ./node_modules/.bin/tsc --noEmit -p tsconfig.repo.json
```

For your own UI on the same bridge see [`../../node-electron`](../../node-electron).
