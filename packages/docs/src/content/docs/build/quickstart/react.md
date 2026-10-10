---
title: "React"
description: "Integrate @polaris-key/react: install from the feed, generate polaris.config.ts, then take the drop-in screens, slot your own, or build on the hooks."
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

It writes `polaris.config.ts`: `productSlug`, `baseUrl`, `expectServices` and `trust.pinnedKeys`. A page
on another origin, or in Tauri, signs in with a device token and verifies every document in the
page against those pins. Without them the page makes no request, developers see a console error and
users see a neutral error screen. The file also exports `pinnedKeys` and `pinnedReleaseKeys` for the
Electron main process, whose `@polaris-key/node` client verifies. A local Polaris Key to run
against is planned.

## Choose your path

| Path                        | You write                                   | Page                                                               |
| --------------------------- | ------------------------------------------- | ------------------------------------------------------------------ |
| Drop-in                     | `<PolarisKeyProvider>` and `<LicenseGate>`  | [Below](#drop-in-screens)                                          |
| Drop-in with your own slots | `slots` for the screens you replace         | [React kit](/docs/build/ui/frameworks/react/#piecemeal)            |
| Your own UI on the hooks    | `useLicenseGate()` and the other hooks      | [Your own UI](/docs/build/sdks/react/your-own-ui/)                 |
| Your own UI without React   | the adapter, `subscribe()` and `snapshot()` | [Without React](/docs/build/sdks/react/your-own-ui/#without-react) |

## Drop-in screens

```tsx
import { PolarisKeyProvider } from "@polaris-key/react";
import { LicenseGate } from "@polaris-key/react/license";
import { polarisConfig } from "./polaris.config";

export function App() {
  return (
    <PolarisKeyProvider {...polarisConfig} version={APP_VERSION}>
      <LicenseGate>
        <YourApp />
      </LicenseGate>
    </PolarisKeyProvider>
  );
}
```

`LicenseGate` renders `YourApp` only when the license is usable, and otherwise the screen for the
state: loading, sign-in, expired, revoked, a version block or an error. The look is neutral and
follows the page; `branding="polaris-key"` opts into the Polaris Key design system.

In the Electron renderer the provider takes the bridge the main process exposes
([the Node quickstart](/docs/build/quickstart/node/#drop-in-electron)):

```tsx
import { PolarisKeyProvider } from "@polaris-key/react";
import { LicenseGate } from "@polaris-key/react/license";
import { polarisConfig } from "./polaris.config";

export function App() {
  return (
    <PolarisKeyProvider productSlug={polarisConfig.productSlug} mode="desktop">
      <LicenseGate allowGrace>
        <YourApp />
      </LicenseGate>
    </PolarisKeyProvider>
  );
}
```

## The same eight checkpoints

| #   | Checkpoint         | Drop-in                                                       | Your own UI                                            |
| --- | ------------------ | ------------------------------------------------------------- | ------------------------------------------------------ |
| 1   | Install            | above                                                         | above                                                  |
| 2   | Config             | above                                                         | above                                                  |
| 3   | First activation   | `LicenseGate`'s sign-in card takes a key                      | `usePolarisAuth().submitKey(key)`                      |
| 4   | Each refusal       | The card keeps the key, says why, and offers Replace a device | `PolarisError.activation.kind`, `describeError(error)` |
| 5   | Sign-in            | `PolarisLogin` inside the gate                                | `usePolarisAuth().signInWithOidc()`, then `profile`    |
| 6   | Status and offline | `LicenseGate` (`allowGrace` keeps the app open in grace)      | `useLicenseGate()`, `useLicense()`                     |
| 7   | An update offer    | `<UpdatePrompt source="decision" />`                          | `useUpdateDecision()`                                  |
| 8   | Tests              | `<PolarisKeyProvider adapter={…}>`                            | `browserAdapter({ fetchImpl, … })`                     |

[Your own UI](/docs/build/sdks/react/your-own-ui/) gives each call with its state and its words. The
whole API is the [React SDK reference](/docs/build/sdks/react/).
