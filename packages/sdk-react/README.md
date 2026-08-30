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
  invoke: dispatch, // see below — an explicit switch, NEVER a reflective lookup
  on: (event, cb) => /* subscribe to host-side state changes */,
};
// expose via contextBridge as window.polarisKey
```

`BridgeState` additionally carries `capabilities` (the product's `services` map) and `config`
(the config document's entries — v3 split them off the license document). Omit `invoke` and the
device/update capabilities simply report as unsupported.

### Wiring `invoke` — the allow-list

`invoke` is the versioned escape hatch that keeps every new service capability from becoming a
breaking change to a contract shipped inside somebody else's Electron app. It accepts **exactly
four `(service, method)` pairs**, exported as a runtime value so your host can validate against
the same list the renderer is typed against:

```ts
import { DESKTOP_BRIDGE_METHODS } from "@polaris-key/react/desktop";
// [ { service: "devices", method: "list" },
//   { service: "devices", method: "rename" },
//   { service: "devices", method: "deauthorize" },
//   { service: "update",  method: "check" } ]
```

Dispatch them with an **explicit switch**. Every branch names one verb, so the set of things the
renderer can reach is the set of things you wrote down:

```ts
const dispatch: PolarisBridge["invoke"] = async (service, method, args) => {
  switch (`${service}.${method}`) {
    case "devices.list":
      return client.devices.list();
    case "devices.rename": {
      const { deviceId, label } = args as {
        deviceId: string;
        label: string | null;
      };
      return client.devices.rename(deviceId, label);
    }
    case "devices.deauthorize": {
      const { deviceId } = args as { deviceId: string };
      return client.devices.deauthorize(deviceId);
    }
    case "update.check":
      return client.update.check(args as { channel?: string });
    default:
      // Fail closed. A renderer asking for anything else is not a version skew to paper over.
      throw new Error(`polaris bridge: refused ${service}.${method}`);
  }
};
```

**Never implement `invoke` reflectively.** A `client[service][method](args)` lookup hands
**every script running in the renderer** — your own code, a third-party bundle, anything that
lands there through an XSS — the privileged process's entire sub-client surface. That includes
`client.config.getSecret(key)`, which returns the **plaintext managed secret** that both the
desktop and browser adapters deliberately return `null` for, and `client.license.deactivate()`,
which wipes the install. The TypeScript signature refuses an off-list pair at compile time, but
**types are not present in the renderer at runtime** — the `switch` and its `default` are what
actually enforce the boundary.

The same reasoning is why `getSecret()` returns `null` on the desktop adapter: if a renderer
genuinely needs one secret, expose a purpose-built bridge method for that one key rather than
widening `invoke`.

## Browser transport: the trust model

The browser adapter performs **no signature verification**, and that is a property of the
server rather than a gap in this package. `GET /<product>/identity/session` deliberately answers
with the fused session document as **plain JSON inside the response body**, never as a compact
JWS: the Worker mints it for a _page_, not for an SDK, and a page has no cache or disk boundary
for a signature to survive across. There is nothing here to verify.

Authenticity therefore rests on exactly two things:

1. **TLS to the control-plane origin.** `baseUrl` must be `https:` — or `http:` on
   `localhost` / `127.0.0.1` / `::1` for local development. Anything else throws
   `InsecureBaseUrlError` (a `PolarisError` with `code: "insecure-base-url"`) **at construction**,
   the same https-or-loopback rule the Node, Python and Swift SDKs enforce.
2. **A first-party session cookie set by that origin** — `HttpOnly; Secure; SameSite=Lax`,
   scoped `Path=/<product>`.

`SameSite=Lax` is the consequential part: a browser does not attach a Lax cookie to a
**cross-site** subresource request, so `fetch(..., { credentials: "include" })` from a page on
some other origin carries no session at all. **The browser adapter is same-origin only** — it
works from a page served by the control plane itself, and a third-party origin pointing
`baseUrl` at `key.plrs.im` gets an unauthenticated session rather than a silently weaker one.

If you need an offline-verifiable, cross-origin credential, that is what the signed
license/config document pair and `@polaris-key/node` (or the desktop bridge above) are for. Both
transports still run the identical `@polaris-key/client-core` gate — mode-parity is about the gate,
not about how the documents were authenticated.

One rule follows the same predicate outward: `<UpdatePrompt>`'s default action refuses to
`window.open` an update URL that is not `https:` (or `http:` on loopback), because `latest.url`
comes off an update feed and `javascript:` there is script execution in your window. A refused
URL is not opened and the component says so in place of navigating. Supply `onUpdate` to take
the action — and the policy — over yourself.

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
