# Tidewater Studio: the React kit sample (Next.js App Router)

Tidewater Studio by Harbor Audio is gated by `@polaris-key/react`. This sample shows:

- **the drop-in**: `app/client-shell.tsx` is the explicit `"use client"` boundary. It creates the
  fixture adapter, calls the React hooks, and renders the canonical
  `<PolarisKeyProvider config={polarisKey}>` / `<PolarisKeyGate>` pair;
- **the product as hero**: Tidewater's name and accent come from the SDK presentation, without
  sample theme code;
- **App Router pages**: `/` is the host Studio page and `/settings` renders client content with
  the `UpdatePrompt`, Devices, Settings and About parts from `@polaris-key/react/kit`, fed by the
  SDK hooks.

The framework page is [React](https://key.plrs.im/docs/build/ui/frameworks/react/).

## Run it against the fixtures

The default runs on the in-memory Tidewater fixture in `app/fixtures.ts`: no Worker, network, or
keys are needed.

```sh
# .npmrc: @polaris-key:registry=https://pkg.plrs.im/npm/polaris-key/
npm install
npm run dev
```

- `pkey_tidewater_7Q2Mx9cLr4TbV0aZ3WPLDA` activates.
- Any other `pkey_tidewater_` key hits the device limit once, then activates.
- Sign in shows a code, then signs in as Mara Fennick about four seconds later.
- `?state=ok`, `grace`, `expired`, or `revoked` pins the gate for one load.
- The Devices and Settings parts render the fixture adapter's current state; managed settings retain
  their device-local overrides for the current adapter instance.

## Run it against a Worker

Replace `app/polaris.config.ts` with the configuration generated for your product, including its
pinned trust keys, then start Next through the live-aware script:

```sh
npm run dev -- --live
# or
npm run live
```

`--live` is consumed by `scripts/dev.mjs`, which starts `next dev` with
`NEXT_PUBLIC_POLARIS_LIVE=1`. Without it the script always sets that value to `0`, so the fixture
remains the default even if the parent shell exports a live value.

## Inside this repository

Build the SDK before typechecking the sample against this checkout's generated declarations:

```sh
mise exec node@22 -- pnpm --filter @polaris-key/react build
cd examples/ui/react-next
npm install
npm run repo:typecheck
```
