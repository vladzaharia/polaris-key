---
title: "React"
description: "Integrate @polaris-key/react: install from the feed, generate polaris.config.ts, then take the drop-in screens, compose kit parts, or build on the hooks."
sidebar:
  order: 2
---

For a browser page (on Polaris Key's origin, your own, or in Tauri) and the Electron renderer.
React 18 or later.

## Install

Route the scope to the feed, then install the kit and, as a dev dependency, the `pkey` CLI:

```ini
# .npmrc
@polaris-key:registry=https://pkg.plrs.im/npm/polaris-key/
```

```sh
pnpm add @polaris-key/react react react-dom
pnpm add -D @polaris-key/cli
```

Other package managers, and the age gates that delay a new version:
[Installing the SDKs from the feeds](/docs/build/install-from-feeds/).

## Config

```sh
pnpm exec pkey sdk --lang react --product <slug> --write
```

It writes `polaris.config.ts`: `productSlug`, `baseUrl`, `expectedServices` and `trust.pinnedKeys`. A page
on another origin, or in Tauri, signs in with a device token and verifies every document in the
page against those pins. Without them the page makes no request, developers see a console error and
users see a neutral error screen. The file also exports `pinnedKeys` and `pinnedReleaseKeys` for the
Electron main process, whose `@polaris-key/node` client verifies. [Run Polaris Key locally](/docs/build/local/) to try this without a registered product.

## Choose your path

| Path                        | You write                                                         | Page                                                               |
| --------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------ |
| Drop-in                     | `<PolarisKeyProvider config={polarisKey}>` and `<PolarisKeyGate>` | [Below](#drop-in-screens)                                          |
| Compose kit parts           | kit components with `input` and action handlers                    | [React kit](/docs/build/ui/frameworks/react/#piecemeal)            |
| Your own UI on the hooks    | `useLicenseGate()` and the other hooks                            | [Your own UI](/docs/build/sdks/react/your-own-ui/)                 |
| Your own UI without React   | the adapter, `subscribe()` and `snapshot()`                       | [Without React](/docs/build/sdks/react/your-own-ui/#without-react) |

## Drop-in screens

```tsx
import { PolarisKeyProvider } from "@polaris-key/react";
import { PolarisKeyGate } from "@polaris-key/react/kit";
import { polarisKey as productPolarisKey } from "./polaris.config";

const polarisKey = {
  ...productPolarisKey,
  version: APP_VERSION,
};

export function App() {
  return (
    <PolarisKeyProvider config={polarisKey}>
      <PolarisKeyGate>
        <YourApp />
      </PolarisKeyGate>
    </PolarisKeyProvider>
  );
}
```

`PolarisKeyGate` renders `YourApp` only when the license is usable, and otherwise the screen for the
state: loading, sign-in, expired, revoked, a version block or an error. It receives the product
presentation from the provider configuration.

In the Electron renderer, put desktop mode in the same configuration while the provider uses the
bridge the main process exposes ([the Node quickstart](/docs/build/quickstart/node/#drop-in-electron)):

```tsx
import { PolarisKeyProvider } from "@polaris-key/react";
import { PolarisKeyGate } from "@polaris-key/react/kit";
import { polarisKey as productPolarisKey } from "./polaris.config";

const polarisKey = {
  ...productPolarisKey,
  mode: "desktop" as const,
  version: APP_VERSION,
};

export function App() {
  return (
    <PolarisKeyProvider config={polarisKey}>
      <PolarisKeyGate>
        <YourApp />
      </PolarisKeyGate>
    </PolarisKeyProvider>
  );
}
```

## The same eight checkpoints

| #   | Checkpoint         | Drop-in                                                       | Your own UI                                            |
| --- | ------------------ | ------------------------------------------------------------- | ------------------------------------------------------ |
| 1   | Install            | above                                                         | above                                                  |
| 2   | Config             | above                                                         | above                                                  |
| 3   | First activation   | `PolarisKeyGate`'s sign-in screen takes a key                    | `usePolarisAuth().submitKey(key)`                      |
| 4   | Each refusal       | The screen keeps the key, says why, and offers Replace a device  | `PolarisError.activation.kind`, `describeError(error)` |
| 5   | Sign-in            | The kit sign-in screen inside the gate                            | `usePolarisAuth().signInWithOidc()`, then `profile`    |
| 6   | Status and offline | `PolarisKeyGate` handles usable offline grace                    | `useLicenseGate()`, `useLicense()`                     |
| 7   | An update offer    | The kit update screen                                             | `useUpdateDecision()`                                  |
| 8   | Tests              | `<PolarisKeyProvider config={testPolarisKey}>`                   | `browserAdapter({ fetchImpl, … })`                     |

For a fixture test, create `const testPolarisKey = { ...polarisKey, adapter };` and pass that same
configuration to the provider.
[Your own UI](/docs/build/sdks/react/your-own-ui/) gives each call with its state and its words. The
whole API is the [React SDK reference](/docs/build/sdks/react/).
