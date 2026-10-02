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

`PolarisState.capabilities` is a `Record<ServiceSlug, { enabled: boolean }>` over the six
services (`license`, `config`, `release`, `distribution`, `update`, `identity`). It is **fail-closed**:

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

| entry                         | contents                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------- |
| `@polaris-key/react`          | everything                                                                            |
| `@polaris-key/react/core`     | mode-agnostic types + the shared state model (no React)                               |
| `@polaris-key/react/browser`  | the browser adapter + discovery client                                                |
| `@polaris-key/react/desktop`  | the desktop adapter + the `PolarisBridge` IPC contract                                |
| `@polaris-key/react/license`  | `useLicense`, `useLicenseGate`, `useImportBundle`, `<LicenseGate>`, `<DeviceManager>` |
| `@polaris-key/react/config`   | `useManagedConfig`, `<ConfigPanel>`                                                   |
| `@polaris-key/react/identity` | `usePolarisAuth`, `<PolarisLogin>`, `<PolarisLogout>`                                 |
| `@polaris-key/react/update`   | `useLatestVersion`, `useUpdateDecision`, `<UpdatePrompt>`, `createBrowserPacks`       |
| `@polaris-key/react/release`  | `useChangelog`                                                                        |

## Components

- **`<PolarisKeyProvider>`** — the context root: owns the adapter, the gate state, and the
  `--pk-*` theme variables. Everything else must render inside it.
- **`<LicenseGate>`** (`./license`) — the drop-in status gate above.
- **`<PolarisLogin>` / `<PolarisLogout>`** (`./identity`) — the sign-in card (OIDC button plus
  typed license-key entry, each shown only when its service is enabled) and a sign-out button.
- **`<ConfigPanel>`** (`./config`) — a settings panel over the shipped
  `listUserConfig`/`getConfigSource` data layer (one row per document entry, `hidden` ones
  excluded), with per-entry provenance badges and an override affordance on `default`-state
  keys only.
- **`<DeviceManager>`** (`./license`) — list / rename / disconnect, rendering the
  `device-management-unsupported` refusal as an explanation rather than an error.
- **`<UpdatePrompt>`** (`./update`) — a polite banner (or a blocking dialog) over
  `useLatestVersion`, or, with `source="decision"`, over wire v4's signed decision
  (`useUpdateDecision`): one state per action, and a prompt the player cannot dismiss for a
  mandatory offer and for `blocked` (below).

All five are assembled from the exported primitives (`MessageScreen`, `Button`, `Panel`,
`TextField`), so a custom screen inherits the same a11y contract instead of re-deriving it.

## Hooks

| Hook                     | Returns                                                                                      |
| ------------------------ | -------------------------------------------------------------------------------------------- |
| `useLicense()`           | `{ gate, status, usable, loading, enabled, activation, highWaterMark, entitledChannels, … }` |
| `useImportBundle()`      | `{ importBundle(jws), busy, error, activation }` — offline bundles (§7)                      |
| `useChangelog(opts)`     | `{ entries, busy, error, enabled, reload }` — the Release changelog                          |
| `useManagedConfig()`     | `{ config, get(key, fallback), listUserConfig, getConfigSource, enabled }`                   |
| `usePolarisAuth()`       | profile + auth actions + `supportsOidcLogin` / `supportsKeyEntry`                            |
| `useLatestVersion(opts)` | `{ latest, updateAvailable, busy, error, enabled, check }`                                   |
| `useUpdateDecision(o)`   | `{ check, decision, boot, undismissable, busy, error, enabled, decide }` — wire v4 (below)   |
| `useEntitlement(name)`   | `boolean`                                                                                    |
| `useCapabilities()`      | the service map + `has(slug)`                                                                |
| `useLicenseGate()`       | headless gate (`screen`, `state`, `theme`, `retry`) for a fully custom UI                    |
| `usePolarisKey()`        | **deprecated** — the whole-client surface; prefer the per-service hooks                      |

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
additionally withheld from the user-facing list (`listUserConfig`) but still applied. The list
holds the document's entries only (WIRE-CONTRACT-V3 §2.2.1 rule 4): a key that only a local
override supplies is not listed, though it stays in `config` and `get`. The **environment**
layer never applies in React: a browser has no environment and a renderer must not inherit the
privileged process's, so env layering resolves in `@polaris-key/node` on the desktop side and
nowhere at all in the browser (rule 3; `config-matrix.json` pins it as `expectNoEnv`).

The browser adapter sends `X-PKey-Platform: web`, `X-PKey-SDK: react` and no `X-PKey-Arch`
(§5.2).

## Adapter verbs beyond the gate

Both adapters implement the same verbs, so a hook never branches on transport:

| verb                                           | browser                                        | desktop                             |
| ---------------------------------------------- | ---------------------------------------------- | ----------------------------------- |
| `entitledChannels()`                           | the `channels` grants, or `["stable"]`         | the same, off the bridge's document |
| `fetchSchema()` → catalog or `null`            | `GET /<p>/config/schema`                       | the bridge's `fetchSchema`          |
| `changelog()`, `installUrl()`, `downloadUrl()` | `GET /<p>/release/changelog`; URLs built here  | `invoke("release", …)`              |
| `importBundle(jws)`                            | verified in-page, kept in IndexedDB            | the bridge's `importBundle` (v3)    |
| `report()`                                     | throws `report-unsupported` (no device bearer) | `invoke("devices", "report")`       |
| `decideUpdate({channel, staged, skipVersion})` | feed + record fetched and verified in-page     | `invoke("update", "decide", …)`     |
| `buildUrl(version, buildId)` (optional)        | discovery's `distribution.endpoints.builds`    | — (absent)                          |

A refused release read throws `release-refused`; `error.wireCode` carries the refusal body's own
code (`unauthorized`, `channel_not_allowed`, …), which is what the other SDKs report as their
error code. A refused bundle throws `bundle-rejected` with the §7 step as `wireCode` and writes
nothing.

**Offline bundles in a browser.** A browser has no hardware fingerprint, so the browser adapter
mints a random device id once and keeps it in IndexedDB (`adapter.offlineDeviceId()` reads it:
mint the bundle against that id). Pass the product's pinned keys as `trust: { pinnedKeys }` —
a bundle verifies against those only. The imported artifacts are re-verified from IndexedDB on
every load, so editing storage can remove an activation but never invent one; an authenticated
session supersedes the bundle, and `signOut()` wipes it.

## Signed update decisions (wire v4)

`decideUpdate()` and `useUpdateDecision()` answer "what should this install do next?" from the
signed channel feed (`pkey-feed+jws`) and the release record it pins (`pkey-release+jws`), with
the same `@polaris-key/client-core` functions every SDK runs against `update-matrix.json`. The
answer is an `UpdateCheck`: `channel` (the canonical channel, the feed's own claim, which a host
records as `staged.channel`), `decision`, `feed` (`network` or `committed`), `record`
(`network`, `cache` or `none`) and `errors`. `useLatestVersion` and the unsigned
`/update/version` path are unchanged beside it.

```tsx
browserAdapter({
  productSlug: "acme",
  version: "1.4.0",
  trust: { pinnedKeys: { "acme-2026": "<raw base64url>" } },
  update: {
    pinnedReleaseKeys: { "acme-release-2026": "<raw base64url>" },
    // outlet: "web" is the default for a browser build (the synthesised stamp)
  },
});

<UpdatePrompt source="decision" onAction={(ctx) => /* act on ctx.decision */} />;
```

- **Browser.** The adapter reads `update.endpoints.feed` and `release.endpoints.record` from
  discovery (absent ⇒ `service-unavailable`: fall back to `checkUpdate()`), fetches the feed with
  `?platform=web`, verifies it against the pinned product keys and the record against
  `pinnedReleaseKeys` only (hash before signature; a release key that is also a trust pin throws
  `invalid-options` at construction; an empty map makes `decideUpdate()` throw
  `not-configured`). The `feeds` and `releaseRecords` slices persist in IndexedDB as signed JWSs
  and are re-verified on every decision, so each channel's `seq` floor survives a reload, a
  sign-out and a bundle import.
- **Desktop.** The renderer forwards `{channel, staged, skipVersion}` through
  `invoke("update", "decide", …)`; an Electron host answers with `client.update.decide()`.
- **No v4 answer stops play.** `binary`, `store` and `platform` with `mandatory: true`, and
  every `blocked {app-floor}`, are prompts the player cannot dismiss (`undismissable`), shown
  over an app that keeps running: `<UpdatePrompt>` renders them as a persistent
  `role="alert"` banner with no dismiss control, whatever the `variant`, never as a full-window
  dialog; `boot` is never `required`. A non-mandatory `platform` answer
  boots as `none`.
- **Outlet.** A host's `update.outlet` (a kind, or `{id, kind, subkind?}`) wins. Otherwise the
  browser adapter detects in-page (`update.detect`, default true): `readOutletSignals()` reads
  the display mode (`matchMedia('(display-mode: standalone)')`, `navigator.standalone`, an
  `android-app://` referrer) and client-core's `detectOutlet` (re-exported here) maps it, with
  the stamp (`WEB_OUTLET_STAMP` by default), to the result `resolveUpdateOutlet` takes as
  `detected`. `adapter.outlet` and `adapter.detected` expose it. The desktop adapter defers to the
  host, whose `@polaris-key/node` client detects in the main process.

## Packs (`update.packs`, web)

`createBrowserPacks` is the pack facet for the web transport (plans/P4-01.md §2.6–§2.9): the
page's **content stamp** (bundled with the build; without one there are no packs) pins one
release per pack, and `ensure` installs it into the Origin Private File System.

```ts
import { createBrowserPacks } from "@polaris-key/react/update";

const packs = createBrowserPacks({
  baseUrl: "https://key.plrs.im",
  product: "diceroll",
  discovery, // the verified discovery document
  releaseKeys: { "diceroll-release-2026": "…" },
  productTrust: pinnedKeys,
  contentStamp: await (await fetch("/pkey-content.json")).text(),
  axes: { locale: [navigator.language.slice(0, 2), "en"] },
});
await packs.ensure(["diceroll.l10n"]);
const strings = await packs.readFile("diceroll.l10n", "fr/strings.json");
```

- It is client-core's `PackEngine`, the one `@polaris-key/node` runs: records by hash against the
  pinned release keys, objects from `distribution.endpoints.blobs` with `Range`/`If-Range`
  (credentialed `fetch`), the same planner and appliers.
- **Storage.** OPFS by default: the Cache API refuses 206 responses. Without OPFS, `ensure`
  raises `not-configured` unless the host passes `storage: "memory"` (or a store of its own);
  there is no silent fallback. Call `requestPersistence()` after engagement; an evicted payload
  fails the reload's check and is planned again from scratch.
- **zstd and SHA-256.** `@polaris-key/zstd-wasm`'s browser entry (wasm32, so the delta memory
  budget is at most 2^30) and `hash-wasm` (streaming; WebCrypto's digest does not stream).
  `dcz` in Chromium is P4-18.
- **Boot.** `bootOptions()` and `bootFetch({send, consent, metered, answer})` drive the stage
  machine's FETCH stage with `fetch.consent`, `fetch.progress` and `fetch.done`.
- **Telemetry.** A browser session holds no device bearer, so it cannot post `devices/report`
  (the registered web N/A); `packSetId()` gives the active set's id for whatever the host
  reports. On desktop the host's `@polaris-key/node` client reports it.
- Errors are client-core's `PackError` (`code`, `detail`, `path`), re-exported here.

## Desktop bridge contract (protocol v3)

Implement `PolarisBridge` (from `@polaris-key/react/desktop`) in your Electron/Tauri preload,
delegating each method to `@polaris-key/node`. `BridgeState` mirrors `PolarisKeyClient.getSyncState()`
field for field, so the state method is a straight passthrough:

```ts
import type { PolarisBridge } from "@polaris-key/react/desktop";

const bridge: PolarisBridge = {
  version: 3,
  getSyncState: () => client.getSyncState(),
  refresh: async () => (await client.sync(), client.getSyncState()),
  beginSignIn: () => /* start loopback OIDC */,
  pollSignIn: (flowId) => /* poll it */,
  submitKey: (key) => /* client.license.activate(key) */,
  signOut: () => client.license.deactivate(),
  // Protocol v3: offline bundles, verified and cached in the privileged process.
  importBundle: (jws) => client.importBundle(jws),
  fetchSchema: () => client.config.fetchSchema(),
  // The versioned escape hatch: any sub-client verb, without growing this interface for it.
  invoke: (service, method, args) => /* dispatch to client[service][method](args) */,
  on: (event, cb) => /* subscribe to host-side state changes */,
};
// expose via contextBridge as window.polarisKey
```

`BridgeState` additionally carries `capabilities` (the product's `services` map) and `config`
(the config document's entries — v3 split them off the license document). Omit `invoke` and the
device, update, release and telemetry capabilities simply report as unsupported; a v2 host
without `importBundle` reports bundle import as `bundle-import-unsupported`.

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
