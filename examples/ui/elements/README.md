# Tidewater Studio: the web components sample

Tidewater Studio by Harbor Audio, gated by `<pk-gate>` from `@polaris-key/elements`. It shows:

- **the drop-in**: `<pk-gate>` around the app in `index.html`; the gate draws every screen the
  license calls for, then the app;
- **the product as the hero**: the name and accent come from `PolarisKey.theme({ product })` in
  `src/main.ts` (a live app gets them from the SDK's presentation source with no code).

The framework page is [Web components](https://key.plrs.im/docs/build/ui/frameworks/elements/).

## Run it against the fixtures

The page runs on the Tidewater fixture in `src/fixtures.ts`: no Worker, no network, no keys.

```sh
npm install
npm run dev
```

The default page is Welcome, and it clicks through. **Sign in** opens the one sign-in form as a
sheet on a fake `SignInPrimitives` (`fakeSignIn()` in `src/fixtures.ts`): methods, the browser
handoff, the license choice, then the app. **Use a license key** opens Activate: any `pkey_` key
activates, `pkey_full` meets the device limit, anything else is refused. `?state=ok`, `grace`,
`expired` or `revoked` pins the gate for one load.

`states.html` is the index: the gate's states as links, the sign-in sheet, the Devices and Settings
panes on fixture data (rename, remove and change a setting), and an optional update as a dialog.

There is no `--live` switch: the kit does not drive `<pk-gate>` from the SDK yet, so `src/main.ts`
plays the adapter's part against the fixtures. The package and its CDN module
(`https://key.plrs.im/elements/<major>/pk.js`) are not published, so this sample runs on the
repository's build.

Fonts need no setup: the module registers Rubik from the files beside it, and a bundler (Vite,
webpack) emits them. `import "@polaris-key/elements/fonts.css"` is the same faces as a stylesheet;
`PolarisKey.fonts(false)` leaves fonts to the page.

## Inside this repository

```sh
mise exec node@22 -- pnpm --filter @polaris-key/elements build
cd examples/ui/elements
mise exec node@22 -- ../../../packages/admin/node_modules/.bin/vite --config vite.repo.config.ts
mise exec node@22 -- ../../../node_modules/.bin/tsc --noEmit -p tsconfig.repo.json
```

`vite.repo.config.ts` points `@polaris-key/elements` at the repo's build.
