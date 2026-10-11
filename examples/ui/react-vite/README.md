# Tidewater Studio: the React kit sample (Vite)

Tidewater Studio by Harbor Audio, gated by `@polaris-key/react`. It shows:

- **the drop-in**: `<PolarisKeyProvider>` and `<PolarisKeyGate>` in `src/main.tsx`; the gate draws
  every screen the license calls for, then the app;
- **the product as the hero**: Tidewater's name and accent come from the SDK's presentation, with
  no theme code;
- **the parts**: `<UpdatePrompt>`, `<Devices>`, `<Settings>` and `<About>` from
  `@polaris-key/react/kit` on the Settings page, fed from the SDK's hooks.

The framework page is [React](https://key.plrs.im/docs/build/ui/frameworks/react/).

## Run it against the fixtures

The default runs on the Tidewater fixture in `src/fixtures.ts`: no Worker, no network, no keys.

```sh
# .npmrc: @polaris-key:registry=https://pkg.plrs.im/npm/polaris-key/
npm install
npm run dev
```

- `pkey_tidewater_7Q2Mx9cLr4TbV0aZ3WPLDA` activates.
- Any other `pkey_tidewater_` key hits the device limit once, then activates.
- Sign in shows a code, then signs in about four seconds later.
- `?state=ok`, `grace`, `expired` or `revoked` pins the gate for one load.

## Run it against a Worker

Replace `src/polaris.config.ts` with the file `pkey sdk --lang react --write` generates, then:

```sh
npm run live
```

## Inside this repository

```sh
mise exec node@22 -- pnpm --filter @polaris-key/react build
cd examples/ui/react-vite
mise exec node@22 -- ../../../node_modules/.bin/vite --config vite.repo.config.ts
mise exec node@22 -- ../../../node_modules/.bin/tsc --noEmit -p tsconfig.repo.json
```

`vite.repo.config.ts` points `@polaris-key/react` at the repo's build and its React.
