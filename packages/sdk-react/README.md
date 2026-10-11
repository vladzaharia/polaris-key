# @polaris-key/react

Install the React SDK from Polaris Key's npm feed:

```ini
# .npmrc
@polaris-key:registry=https://pkg.plrs.im/npm/polaris-key/
```

```sh
pnpm add @polaris-key/react react react-dom
```

Gate an app with the provider and the self-starting kit gate:

```tsx
import {
  PolarisKeyProvider,
  type PolarisKeyConfig,
} from "@polaris-key/react";
import { PolarisKeyGate } from "@polaris-key/react/kit";

const polarisKey = {
  productSlug: "acme",
} satisfies PolarisKeyConfig;

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

For the kit components, theming, server-rendered hosts, headless models and fixture samples, see
[React UI kit](https://key.plrs.im/docs/build/ui/frameworks/react/).
