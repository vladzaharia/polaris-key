# @polaris-key/react

One React hook API over **two transports**, plus brandable drop-in UIs for Polaris Key
services.

- **Desktop** (Electron/Tauri): wraps `@polaris-key/node` through an injected
  `PolarisBridge` (default `window.polarisKey`). The privileged process owns the token,
  keyring, and loopback-OIDC; the renderer is a thin proxy.
- **Browser**: cookie-session OIDC against `key.plrs.im` over `fetch(..., { credentials:
"include" })`. Online-only — no token/keyring/loopback. Sign-in is a full-page redirect.

Both adapters satisfy the **same `PolarisAdapter`** and the hooks return the **same shapes**,
so a component renders identically in either mode (mode-parity). The gate itself is
`@polaris-key/client-core`'s — the one implementation every JS SDK and the
conformance corpus run, clock floor included.

## Install

```sh
pnpm add @polaris-key/react react react-dom
```

`react` / `react-dom` `>=18` are peer dependencies. The package is `sideEffects: false`.

## Quick start

```tsx
import { PolarisKeyProvider } from "@polaris-key/react";
import { LicenseGate } from "@polaris-key/react/license";

export function App() {
  return (
    <PolarisKeyProvider
      productSlug="acme"
      mode="auto" // desktop if a bridge exists, else browser
      expectServices={["license", "config", "identity"]}
      theme={{ tokens: { accent: "#ff5c00" }, copy: { productName: "Acme" } }}
    >
      <LicenseGate>
        <YourApp />
      </LicenseGate>
    </PolarisKeyProvider>
  );
}
```

`<LicenseGate>` renders its children only when the license is **usable** (`ok`, `grace`, or
`not-applicable`); otherwise it renders the screen for the current status (loading / login /
revoked / expired / version-block / error). Every screen is overridable per `slots`
render-prop.

## Capabilities (D-21)

`PolarisState.capabilities` is a `Record<ServiceSlug, { enabled: boolean }>` over the five
services (`license`, `config`, `release`, `update`, `identity`). It is **fail-closed**:

| situation                       | what the client believes                         |
| ------------------------------- | ------------------------------------------------ |
| discovery answered              | the document's `services` map; absent ⇒ disabled |
| discovery failed / was rejected | the provider's `expectServices` prop             |
| neither                         | `license` + `config`                             |

It is never all-true. A product that does not run the identity service gets no OIDC button;
one that does not run the license service gets `status: "not-applicable"` and a `<LicenseGate>`
that renders children straight through (D-08).

## Subpath exports

Two axes, and they compose — a **transport** entry says how you talk to the control plane, a
**service** entry says what you are talking to.

| entry                         | contents                                                           |
| ----------------------------- | ------------------------------------------------------------------ |
| `@polaris-key/react`          | everything                                                         |
| `@polaris-key/react/core`     | mode-agnostic types + the shared state model (no React)            |
| `@polaris-key/react/browser`  | the browser adapter + discovery client                             |
| `@polaris-key/react/desktop`  | the desktop adapter + the `PolarisBridge` IPC contract             |
| `@polaris-key/react/license`  | `useLicense`, `useLicenseGate`, `<LicenseGate>`, `<DeviceManager>` |
| `@polaris-key/react/config`   | `useManagedConfig`, `<ConfigPanel>`                                |
| `@polaris-key/react/identity` | `usePolarisAuth`, `<PolarisLogin>`, `<PolarisLogout>`              |
| `@polaris-key/react/update`   | `useLatestVersion`, `<UpdatePrompt>`                               |

## Components

- **`<PolarisKeyProvider>`** — the context root: owns the adapter, the gate state, and the
  `--pk-*` theme variables. Everything else must render inside it.
- **`<LicenseGate>`** (`./license`) — the drop-in status gate above.
- **`<PolarisLogin>` / `<PolarisLogout>`** (`./identity`) — the sign-in card (OIDC button plus
  typed license-key entry, each shown only when its service is enabled) and a sign-out button.
- **`<ConfigPanel>`** (`./config`) — a settings panel over the shipped
  `listUserConfig`/`getConfigSource` data layer, with per-entry provenance badges and an
  override affordance on `default`-state keys only.
- **`<DeviceManager>`** (`./license`) — list / rename / disconnect, rendering the
  `device-management-unsupported` refusal as an explanation rather than an error.
- **`<UpdatePrompt>`** (`./update`) — a polite banner (or a blocking dialog) over
  `useLatestVersion`.

All five are assembled from the exported primitives (`MessageScreen`, `Button`, `Panel`,
`TextField`), so a custom screen inherits the same a11y contract instead of re-deriving it.

## Hooks

| Hook                     | Returns                                                                    |
| ------------------------ | -------------------------------------------------------------------------- |
| `useLicense()`           | `{ gate, status, usable, loading, enabled, activation, highWaterMark, … }` |
| `useManagedConfig()`     | `{ config, get(key, fallback), listUserConfig, getConfigSource, enabled }` |
| `usePolarisAuth()`       | profile + auth actions + `supportsOidcLogin` / `supportsKeyEntry`          |
| `useLatestVersion(opts)` | `{ latest, updateAvailable, busy, error, enabled, check }`                 |
| `useEntitlement(name)`   | `boolean`                                                                  |
| `useCapabilities()`      | the service map + `has(slug)`                                              |
| `useLicenseGate()`       | headless gate (`screen`, `state`, `theme`, `retry`) for a fully custom UI  |
| `usePolarisKey()`        | **deprecated** — the whole-client surface; prefer the per-service hooks    |

`busy` and `error` are **per service**: a config refresh no longer greys out the sign-out
button, and an identity failure no longer reads as a license failure. `usePolarisKey()` still
exposes the aggregates (`busy`, `error`) alongside `busyByService` / `errorByService`.

## Layered config

`useManagedConfig().get(key, fallback)` resolves a config value through the **same precedence**
as every Polaris Key SDK:

```
enforced | hidden (remote)  >  local override  >  environment  >  remote default  >  fallback
```

`enforced`/`hidden` values are locked to the server and cannot be overridden; `hidden` keys are
additionally withheld from the user-facing list (`listUserConfig`) but still applied. The
**environment** layer never applies in React: a browser has no environment and a renderer must
not inherit the privileged process's, so env layering resolves in `@polaris-key/node` on the desktop
side and nowhere at all in the browser.

## Desktop bridge contract (protocol v2)

Implement `PolarisBridge` (from `@polaris-key/react/desktop`) in your Electron/Tauri preload,
delegating each method to `@polaris-key/node`. `BridgeState` mirrors `PolarisKeyClient.getSyncState()`
field for field, so the state method is a straight passthrough:

```ts
import type { PolarisBridge } from "@polaris-key/react/desktop";

const bridge: PolarisBridge = {
  version: 2,
  getSyncState: () => client.getSyncState(),
  refresh: async () => (await client.sync(), client.getSyncState()),
  beginSignIn: () => /* start loopback OIDC */,
  pollSignIn: (flowId) => /* poll it */,
  submitKey: (key) => /* client.license.activate(key) */,
  signOut: () => client.license.deactivate(),
  // The versioned escape hatch: any sub-client verb, without growing this interface for it.
  invoke: (service, method, args) => /* dispatch to client[service][method](args) */,
  on: (event, cb) => /* subscribe to host-side state changes */,
};
// expose via contextBridge as window.polarisKey
```

`BridgeState` additionally carries `capabilities` (the product's `services` map) and `config`
(the config document's entries — v3 split them off the license document). Omit `invoke` and the
device/update capabilities simply report as unsupported.

## Theming

Brand entirely through CSS custom properties (`--pk-*`) — no CSS-in-JS dependency. Pass a
partial `theme` (tokens + copy + logo) to the Provider. It publishes the variables **twice**: on
a wrapper element, so two providers can carry different brands without leaking into each other,
and on `:root`, so anything React portals (a dialog, a toast) still inherits them. You can also
override any `--pk-*` var from your own stylesheet.

## Develop

```sh
pnpm --filter @polaris-key/react typecheck
pnpm --filter @polaris-key/react test
pnpm --filter @polaris-key/react build
```
