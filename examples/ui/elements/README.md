# Tidewater Studio: the web components sample

Tidewater Studio by Harbor Audio, gated by `<pk-gate>` from `@polaris-key/elements`. It shows:

- **the two-line drop-in**: `index.html` is a script tag (`src/main.ts` imports the package) and
  `<pk-gate config='{"product":"tidewater"}'>` around the app. The gate builds the browser client
  from `config`, reads the license and draws every screen it calls for, then the app. The product's
  name, accent and icon come from the SDK's presentation source with no code;
- **the gate on fixtures**: `play.html` runs the same gate with no Worker, no network and no keys,
  from `src/fixtures.ts` (`PolarisKey.theme({ product })` names the product there).

The framework page is [Web components](https://key.plrs.im/docs/build/ui/frameworks/elements/).

## Run it

`index.html` talks to the Worker the config names (`baseUrl`, default `https://key.plrs.im`) and,
in cookie mode, must be served from that origin; on another origin the SDK signs in with a device
token and needs `trust` in the config. Run it for a real product, or open the fixtures page:

```sh
npm install
npm run dev
```

`play.html` is Welcome, and it clicks through. **Sign in** opens the one sign-in form as a sheet on a
fake `SignInPrimitives` (`fakeSignIn()` in `src/fixtures.ts`): methods, the browser handoff, the
license choice, then the app. **Use a license key** opens Activate: any `pkey_` key activates,
`pkey_full` meets the device limit, anything else is refused. `?state=ok`, `grace`, `expired` or
`revoked` pins the gate for one load.

`states.html` is the index: the gate's states as links, the sign-in sheet, the Devices and Settings
panes on fixture data (rename, remove and change a setting), and an optional update as a dialog.

The package and its CDN module (`https://key.plrs.im/elements/<major>/pk.js`) are not published, so
this sample runs on the repository's build.

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
