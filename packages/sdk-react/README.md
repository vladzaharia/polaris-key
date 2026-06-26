# @polaris-key/react

One React hook API over **two transports**, plus a brandable drop-in login gate.

- **Desktop** (Electron/Tauri): wraps [`@polaris-key/node`](../sdk-node) through an injected
  `PolarisBridge` (default `window.polarisKey`). The privileged process owns the token,
  keyring, and loopback-OIDC; the renderer is a thin proxy.
- **Browser**: cookie-session OIDC against `key.plrs.im` over `fetch(..., { credentials:
"include" })`. Online-only — no token/keyring/loopback. Sign-in is a full-page redirect.

Both adapters satisfy the **same `PolarisAdapter`** and the hooks return the **same shapes**,
so a component renders identically in either mode (mode-parity).

## Install

```sh
pnpm add @polaris-key/react react react-dom
```

React 18+ is a peer dependency.

## Quick start

```tsx
import { PolarisKeyProvider, LicenseGate } from "@polaris-key/react";

export function App() {
  return (
    <PolarisKeyProvider
      productSlug="acme"
      mode="auto" // desktop if a bridge exists, else browser
      theme={{ tokens: { accent: "#ff5c00" }, copy: { productName: "Acme" } }}
    >
      <LicenseGate>
        <YourApp />
      </LicenseGate>
    </PolarisKeyProvider>
  );
}
```

`<LicenseGate>` renders its children only when the license is **usable** (`ok` or `grace`);
otherwise it renders the screen for the current status (loading / login / revoked / expired /
version-block / error). Every screen is overridable per `slots` render-prop.

## Components

- **`<PolarisKeyProvider>`** — the context root: owns the adapter, the gate state, and the
  `--pk-*` theme variables. Everything else must render inside it.
- **`<LicenseGate>`** — the drop-in status gate above. Shows your children only when usable.
- **`<PolarisLogin>`** — the drop-in sign-in card: an OIDC button plus (desktop only) a typed
  license-key entry. Embedded by `<LicenseGate>`'s login screen; usable standalone too.
- **Sign-out** is an _action_, not a separate component — call `signOut` from
  `usePolarisKey()` (or `usePolarisAuth()`) and wire it to your own button:

  ```tsx
  function SignOutButton() {
    const { signOut } = usePolarisKey();
    return <button onClick={() => signOut()}>Sign out</button>;
  }
  ```

## Hooks

| Hook                   | Returns                                                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `usePolarisKey()`      | full state + bound actions (`refresh`, `signInWithOidc`, `submitKey`, `signOut`, `getConfig`, `getSecret`, `isEntitled`) |
| `useLicense()`         | `{ gate, status, usable, loading }`                                                                                      |
| `useManagedConfig()`   | `{ config, get(key, fallback) }`                                                                                         |
| `useEntitlement(name)` | `boolean`                                                                                                                |
| `usePolarisAuth()`     | profile + auth actions + `supportsKeyEntry`                                                                              |
| `useLicenseGate()`     | headless gate (`screen`, `state`, `theme`, `retry`) for a fully custom UI                                                |

## Modes

```tsx
// Force browser mode against a custom origin:
<PolarisKeyProvider productSlug="acme" mode="browser" baseUrl="https://key.plrs.im" />

// Force desktop mode with an explicit bridge (otherwise window.polarisKey):
<PolarisKeyProvider productSlug="acme" mode="desktop" bridge={myBridge} />
```

## Layered config

`useManagedConfig().get(key, fallback)` (and the bound `getConfig` action) resolve a config
value through the **same precedence** as every Polaris Key SDK:

```
enforced | hidden (remote)  >  local override  >  environment  >  remote default  >  fallback
```

`enforced`/`hidden` values are locked to the server and cannot be overridden; `hidden` keys
are additionally withheld from the user-facing list (`listUserConfig`) but still applied. In
**desktop** mode, env/local overrides resolve in the privileged process (the `@polaris-key/node`
client, honoring `PKEY_CONFIG_*`); in **browser** mode the value comes straight from the
signed remote doc.

### Desktop bridge contract

Implement `PolarisBridge` (from `@polaris-key/react/desktop`) in your Electron/Tauri preload,
delegating each method to `@polaris-key/node`:

```ts
import type { PolarisBridge } from "@polaris-key/react/desktop";

const bridge: PolarisBridge = {
  getState: () => /* client.status() + cached doc */,
  refresh: () => /* client.refresh() */,
  beginSignIn: () => /* start loopback OIDC */,
  pollSignIn: (flowId) => /* poll it */,
  submitKey: (key) => /* client.activateWithKey(key) */,
  signOut: () => /* client.deactivate() */,
  on: (event, cb) => /* subscribe to host-side state changes */,
};
// expose via contextBridge as window.polarisKey
```

## Theming

Brand entirely through CSS custom properties (`--pk-*`) — no CSS-in-JS dependency. Pass a
partial `theme` (tokens + copy + logo) to the Provider; it writes the `--pk-*` variables on a
wrapper element. You can also override any `--pk-*` var from your own stylesheet.

## Subpath exports

- `@polaris-key/react` — everything
- `@polaris-key/react/core` — mode-agnostic types + gate model (no React)
- `@polaris-key/react/browser` — the browser adapter
- `@polaris-key/react/desktop` — the desktop adapter + `PolarisBridge` IPC contract

## Develop

```sh
pnpm --filter @polaris-key/react typecheck
pnpm --filter @polaris-key/react test
pnpm --filter @polaris-key/react build
```
