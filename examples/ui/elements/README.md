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

`?state=ok`, `grace`, `expired` or `revoked` pins the gate for one load; the default is Welcome.

There is no `--live` switch: the kit does not drive `<pk-gate>` from the SDK yet. The package and
its CDN module (`https://key.plrs.im/elements/<major>/pk.js`) are not published, so this sample
runs on the repository's build.

## Inside this repository

```sh
mise exec node@22 -- pnpm --filter @polaris-key/elements build
cd examples/ui/elements
mise exec node@22 -- ../../../packages/admin/node_modules/.bin/vite --config vite.repo.config.ts
mise exec node@22 -- ../../../node_modules/.bin/tsc --noEmit -p tsconfig.repo.json
```

`vite.repo.config.ts` points `@polaris-key/elements` at the repo's build.
