---
title: "React"
description: "Integrate @polaris-key/react in five minutes: generate polaris.config.ts, wrap the app in the provider and the licence gate."
sidebar:
  order: 2
---

For the browser (same origin as Polaris Key) and the Electron renderer over the desktop bridge.

```sh
pnpm add @polaris-key/react react react-dom
pkey sdk --lang react --write   # writes polaris.config.ts
```

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

`polarisConfig` holds the provider's product facts (`productSlug`, `baseUrl`, `expectServices`).
The look is neutral by default and follows the host's colour scheme; `branding="polaris-key"`
opts into the Polaris Key design system. The module also exports `pinnedKeys` and
`pinnedReleaseKeys` for the Electron main process, whose `@polaris-key/node` client verifies.

:::note[Browser on another origin]
The browser adapter runs on the Worker's first-party cookie session, which does not answer CORS.
An app on its own domain or in a Tauri webview waits on bearer mode (see the
[parity matrix](/docs/reference/parity/)); use the desktop bridge or a same-origin deployment
until then.
:::

Next: the full [React SDK reference](/docs/build/sdks/react/).
