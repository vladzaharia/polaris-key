# @polaris-key/react

One React hook API over **two transports**, plus brandable drop-in UIs for Polaris Key
services.

- **Desktop** (Electron/Tauri): wraps `@polaris-key/node` through an injected
  `PolarisBridge` (default `window.polarisKey`). The privileged process owns the token,
  keyring, and loopback-OIDC; the renderer is a thin proxy.
- **Browser**: a first-party page uses the cookie session against `key.plrs.im` over
  `fetch(..., { credentials: "include" })`, signing in by a full-page redirect. A cross-origin
  or Tauri page uses bearer mode (a device token in IndexedDB, documents verified in-page against
  `trust.pinnedKeys`). See "Changes in the SDK parity pass" below.

Both adapters satisfy the **same `PolarisAdapter`** and the hooks return the **same shapes**,
so a component renders identically in either mode (mode-parity). The gate itself is
`@polaris-key/client-core`'s — the one implementation every JS SDK and the
conformance corpus run, clock floor included.

## Changes in the SDK parity pass

Three changes can break an existing integration:

- **Entitlements are false unless the gate is usable (S-19 G11).** `isEntitled()`,
  `useEntitlement()` and the entitlement-value reads now answer `false` (or `undefined`) when the
  licence is revoked, expired, blocked or otherwise not usable, even though the snapshot still
  holds the last verified grants. Before, a lapsed licence's grants kept unlocking features.
- **The browser auth mode defaults to `"auto"`.** A page on the Worker's own origin keeps the
  cookie session. A page on another origin (an opaque `"null"` origin counts) or inside Tauri
  now uses bearer mode: a device token in IndexedDB over the CORS-covered routes, every document
  verified in-page. Bearer mode needs `trust.pinnedKeys` (a Provider prop or a
  `browserAdapter()` option); without them an `"auto"` page reports `invalid-options` as its
  identity error and makes no request. Pass `auth: "cookie"` to keep the old behaviour. The
  Provider also builds its adapter without I/O and starts it from an effect, so a render
  (server-side included) makes no request.
- **`PolarisAdapter` has new required methods.** `enroll`, `beginSignIn`, `mintToken`,
  `commerceBinding`, `commerceClaim`, `discovery`, `offlineDeviceId` and `storeStatus`. The
  built-in adapters implement all of them, throwing the typed `UnsupportedError` where a
  transport cannot serve one. A custom adapter passed through `<PolarisKeyProvider adapter>`
  must add them.

## Install

The `@polaris-key` packages are published to Polaris Key's npm feed only (not npmjs). Route the
scope to it once, in the project's `.npmrc` (Yarn, Bun and the rest:
[Installing the SDKs from the feeds](/docs/build/install-from-feeds/)):

```ini
@polaris-key:registry=https://pkg.plrs.im/npm/polaris-key/
```

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

## `supports()`: typed "unsupported here"

`adapter.supports(feature)` (also `usePolarisKey().supports`) says whether a parity feature works
through this adapter. It is offline, synchronous and side-effect free:

```tsx
import { Feature, usePolarisKey } from "@polaris-key/react";

const { supports } = usePolarisKey();
const secret = supports(Feature.configSecret);
// { supported: false, feature: "config.secret", reason: "runtime", detail: "…" }
```

The browser adapter answers as runtime `web` and the desktop adapter as `desktop-bridge`, from a
capability table generated from `parity.json`. `reason` is one of the generated
`UnsupportedReason` values:

- `runtime`: this transport cannot do it at all. On both transports this covers `config.secret`,
  `core.store`, `license.enroll`, `license.reregister`, the device fingerprint, facts and
  register, and the platform pack transports. On `web` only, it also covers `devices.manage`,
  `devices.report` and `identity.devicecode`.
- `product`: the owning service is off in the capability map above.
- `version`: this SDK version does not implement the feature yet, or does not know the id.

A verb whose feature is unsupported here throws `UnsupportedError`, which is a `PolarisError`
carrying `feature`, `reason` and `detail`. `getSecret()` throws it with code `unsupported`; it
used to return `null`. The browser's device-management verbs and `report()` keep their codes,
`device-management-unsupported` and `report-unsupported`. `adapter.caps()` lists the feature ids
`supports()` answers Supported for.

React does not send `caps` telemetry itself. A browser holds no device token, and on desktop
the host's Node SDK sends the report with its own `caps`.

## Subpath exports

Two axes, and they compose — a **transport** entry says how you talk to the control plane, a
**service** entry says what you are talking to.

| entry                         | contents                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------- |
| `@polaris-key/react`          | everything except `createBrowserPacks` and the pack handlers (those are on `/packs`)  |
| `@polaris-key/react/core`     | mode-agnostic types + the shared state model (no React)                               |
| `@polaris-key/react/browser`  | the browser adapter + discovery client                                                |
| `@polaris-key/react/desktop`  | the desktop adapter + the `PolarisBridge` IPC contract                                |
| `@polaris-key/react/license`  | `useLicense`, `useLicenseGate`, `useImportBundle`, `<LicenseGate>`, `<DeviceManager>` |
| `@polaris-key/react/config`   | `useManagedConfig`, `useConfigSetting`, `<ConfigPanel>`                               |
| `@polaris-key/react/identity` | `usePolarisAuth`, `<PolarisLogin>`, `<PolarisLogout>`                                 |
| `@polaris-key/react/update`   | `useLatestVersion`, `useUpdateDecision`, `<UpdatePrompt>`, `createBrowserPacks`       |
| `@polaris-key/react/release`  | `useChangelog`                                                                        |
| `@polaris-key/react/packs`    | `createBrowserPacks` and the pack ports, with no React import (P4-18)                 |

## Bundle size

Measured on every build (`pnpm --filter @polaris-key/react size`: a Vite production build of each
case, gzip, JS of the initial load over a bare React 18 app) and enforced in CI, which fails over
budget. Packs, `@polaris-key/zstd-wasm` and `hash-wasm` load by dynamic `import()`, only when a pack
or a release payload is first handled, so none of their wasm is emitted or inlined into the initial
load.

| app imports                              | gzip JS over bare React | budget |
| ---------------------------------------- | ----------------------- | ------ |
| `<PolarisKeyProvider>` + `useLicense`    | +78.3 KB                | 80 KB  |
| `<PolarisKeyProvider>` + `<LicenseGate>` | +99.9 KB                | 102 KB |

**Breaking:** the root no longer re-exports `createBrowserPacks`, `opfsPackStore`, `PackError`,
`WASM_MEM_BUDGET`, `defaultWebMemBudget`, `DataJsonHandler`, `L10nTableHandler`, `MlModelHandler`
and the types `BrowserPacks`, `BrowserPacksOptions`, `StagedPack`, `PackCheckRefusal`, `L10nTable`
and `MlModel`. Import them from `@polaris-key/react/packs` (or `/update`).

## Components

- **`<PolarisKeyProvider>`** — the context root: owns the adapter, the gate state, and the
  `--pk-*` theme variables. Everything else must render inside it.
- **`<LicenseGate>`** (`./license`) — the drop-in status gate above.
- **`<PolarisLogin>` / `<PolarisLogout>`** (`./identity`) — the sign-in card (Sign in, and a
  license key behind "Use a license key", each shown only when its service is enabled; titled
  "Welcome to {product}" once `copy.productName` is set) and a sign-out button.
- **`<ConfigPanel>`** (`./config`) — a settings panel over the shipped
  `listUserConfig`/`getConfigSource` data layer (one row per document entry, `hidden` ones
  excluded), with per-entry provenance badges and an override affordance on `default`-state
  keys only. It saves an override itself through `config.set` (and offers a reset for one it
  set) wherever `supports("config.local")`; a host that keeps its own overrides passes
  `onOverride`, which takes over the save.
- **`<DeviceManager>`** (`./license`) — list / rename / remove (with an inline confirm; "Sign out"
  on this device's row), rendering the `device-management-unsupported` refusal as an
  explanation rather than an error, and a failed load as a load error with Try again.

`<DeviceManager>` and `<ConfigPanel>` sit in your page: they start at your container's start edge,
fill it up to 40rem, and keep their border at every width. Pass **`bare`** when you frame the
panel yourself: it drops the border, background, radius and inline padding, and keeps the title
and the row dividers.

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
| `useManagedConfig()`     | `{ config, get(key, fallback), listUserConfig, getConfigSource, enabled, set, clear, … }`    |
| `useConfigSetting(key)`  | `{ value, source, locked, overridden, set, clear }` — one key, re-rendered on change         |
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

## When every seat is taken

On a device-limit refusal, `PolarisError.manageUrl` carries the customer-portal link that frees a
seat (WIRE-CONTRACT-V4 §5.3), validated, and only while the product's portal is on. `<PolarisLogin>`
(and `<LicenseGate>`, which keeps a refused key on that card) shows a neutral callout under the
key field ("Your license is on 3 of 3 devices", "Replace a device in your browser. … continues
when you're done.") and **Replace a device** as the card's one filled action, focused. It opens
the link in a new tab with the key fragment on an `/activate` link and `return=` set to
`returnUrl` when you pass one; when the person comes back to the app, the key is tried again
once. `openManageUrl(url, { key, returnUrl })` and the `withManageReturn` / `withManageKey`
helpers are exported for a custom screen. The link is never an auth failure: nothing is wiped.

## Signing in by browser (device code)

A page that signs in with a device token (`auth: "bearer"`) and a desktop host that reports a code
do not navigate away. `signInWithOidc()` resolves to a handle
(`{ verificationUrl, verificationUri, userCode, expiresAt, cancel }`), and `<PolarisLogin>` turns
into the hand-off: the code, **Open browser** (the one filled action, focused), Copy, the address
for typing by hand, how long the code lasts, and Cancel (or Escape), which stops the polling and
gives Sign in back without an error. At 0:00 the card says the code has expired and offers Sign
in again; a refusal from the server lands in the card under Sign in. Links are shown and opened
only when they are https (or loopback http); the web draws no QR. A custom screen reads the same
handle and calls `handle.cancel?.()`.

A refusal of what the person typed or started (a wrong key, the device limit, a failed sign-in)
survives `refresh()`, including a refresh that fails, and clears when the licence is usable. A
revoked or expired licence shows Sign in, "Use a different key" and Try again; in bearer mode its
401s back off like a 5xx (an automatic refresh waits, Try again and `refresh()` from a hook go
through).

A page cross-origin to the Worker without `trust.pinnedKeys`, or with an origin the product does
not list under `web.origins`, gets one `console.error` in development builds; its users see the
neutral error screen and no developer words.

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

### Device-local overrides (`config.local`)

`adapter.config` is the same API as `@polaris-key/node`'s `client.config`: `set(key, value)`,
`clear(key)`, `clearAll()`, `setting(key)` and `onConfigChange(key | "*", listener)`. A write is
validated against the catalog type (`bad_request`; the catalog is the `catalog` option, or
fetched once on the first write) and refused for a key the operator locked
(`managed_by_admin`). Every move of a resolved value, a local write or a sync, fires one change.

- **Browser:** `localStorage`, one entry per product (`configStorage` replaces it). Storage that
  cannot be used keeps the values in memory and `config.persistent()` answers false.
- **Desktop:** forwarded to the host's `client.config` over bridge v4 (`invoke("config", "set" |
"clear")`, the stored values on `BridgeState.localConfig`). A v3 host refuses the write with
  the typed `UnsupportedError` (reason `version`).

Device-local only: Cloud Sync adds sync state under the same names later.

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
- **Floors never stop play.** `binary`, `store` and `platform` with `mandatory: true`, and
  every `blocked {app-floor}` or `blocked {content-floor}`, are prompts the player cannot dismiss
  (`undismissable`), shown over an app that keeps running: `<UpdatePrompt>` renders them as a
  persistent `role="alert"` banner with no dismiss control, whatever the `variant`, never as a
  full-window dialog. A non-mandatory `platform` answer, and `packs`, boot as `none`;
  `<UpdatePrompt>` renders `packs` as nothing.
- **Revoked required content stops the boot.** `boot` is `required` only for revoked required
  content (`blocked {revoked-content}`, or an answer with `contentBlock: "revoked-content"`).
  `useUpdateDecision().reason` is `"revoked-content"` or `"content-floor"` (else `null`) so a host
  can localise its copy. `<UpdatePrompt>` renders the revoked-content hard stop as a full-window
  message with no dismiss control, using the theme copy `updateRevokedContentTitle` and
  `updateRevokedContentBody` ("Some of this game's content was withdrawn by its developer and
  can't be used. Update the app to keep playing."), with the offer's button when the answer is an
  offer and none for `blocked`; a content floor uses `updateContentFloorBody`.
- **Outlet.** A host's `update.outlet` (a kind such as `"direct"`, the Polaris Key outlet, or
  `{id, kind, subkind?}`) wins. Otherwise the
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
import { createBrowserPacks } from "@polaris-key/react/packs";

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
  fails the reload's check and is planned again from scratch. Staging bytes go through a
  dedicated module worker holding sync access handles (`opfsWorker.js`, beside the SDK's
  modules; bundlers emit it from `new Worker(new URL(…, import.meta.url))`) whenever one starts,
  else through the main-thread API. `opfsWorker: false` keeps the main thread; a function spawns
  your own copy of the worker; `opfsRoot` (tests) keeps the main thread too.
- **zstd and SHA-256.** `@polaris-key/zstd-wasm`'s browser entry (wasm32, so the delta memory
  budget is at most 2^30) and `hash-wasm` (streaming; WebCrypto's digest does not stream).
  **Both are WebAssembly modules: a page with a Content Security
  Policy needs `'wasm-unsafe-eval'` in `script-src`** to compile them.
- **Memory.** The default budget is a quarter of `navigator.deviceMemory`, clamped to
  64 MiB–2^30 (256 MiB when the browser does not report it; `defaultWebMemBudget()`). A delta
  peaks at about 2 × `memBytes` (base and output, plus the frame), and S-04 measured about 3× a
  37 MB payload resident on a 2 GB device, so keep web packs lean. The WASM decoder cannot stream,
  so a `full` frame plus its payload must fit the budget too; a pack that fits no strategy is
  refused with `plan-no-strategy` before anything is fetched.
- **Custom stores.** `storage: {storage, state}` takes a host's own store. Its `state` must
  implement `quarantine`, `quarantined` and `clearQuarantine` (required by `PackStateStore`);
  a store that lacks them at run time has a torn document treated as `unreadable`, so nothing is
  written over it. `read` must answer null only for a missing document and throw otherwise.
- **State.** Every load re-hashes the active and previous payloads. A torn `state.json` is kept
  aside as `state.json.torn`, garbage collection waits for `recoverState()`, and an unreadable
  one is never written over (`pack-state-unreadable`); `state().stateIssue` says which.
- **Boot.** `bootOptions()` and `bootFetch({send, consent, metered, answer})` drive the stage
  machine's FETCH stage with `fetch.consent`, `fetch.progress` and `fetch.done`.
- **Telemetry.** A browser session holds no device bearer, so it cannot post `devices/report`
  (the registered web N/A); `packSetId()` gives the active set's id for whatever the host
  reports. On desktop the host's `@polaris-key/node` client reports it.
- Errors are client-core's `PackError` (`code`, `detail`, `path`), exported from
  `@polaris-key/react` and `@polaris-key/react/update`.
- **Web deltas** (P4-18, see below).
- **Feed-offered deltas** (P4-29). When the adapter's `update.packs` is this facet,
  `decideUpdate()` hands it the decided feed's delta menu (`recordFeedDeltas`), and the next
  installs plan those lazy deltas beside the records' own. Before any decision, the adapter
  seeds it at construction with the menu of the most recently committed feed in its cache
  (`seedFeedDeltas`), so a reload offers the menu offline too; `feedDeltas: () => menu` supplies a
  menu of the host's own instead. The payload URL answers `dcz` from a lazy delta's base, and
  without the dictionary the frame comes from the blob route and decodes in WASM. Every byte is
  checked against the CI-signed record, any failure falls back, and at most one feed-offered
  delta is tried per install. On desktop the host's `@polaris-key/node` client runs this.
- **Delegated content** (P4-19). Content-key releases of compatible or standalone packs install
  through the same engine, on the web and through the desktop bridge: the delegation is fetched
  by the hash in the record's `pkd1-` kid and verified against `pinnedReleaseKeys` only, every
  file passes the data-only rule (`pack-not-data-only`, with the `path`), and a release under a
  revoked delegation is `pack-revoked`, detail `delegation`. A pinned release kid matching
  `pkd1-<64 hex>` is `invalid-options`. There is no UI change.

### What the web gets: payload URLs and Compression Dictionary Transport

A browser has no native zstd API (`DecompressionStream` offers gzip and deflate only), but it
does decode HTTP content encodings. So for a **container** variant (a pack type whose handler is
`layout: "container"`, such as one a host registers for `godot.pck`), the SDK runs the plan's
`full` and `zstd-patch-from` delta strategies through Distribution's **payload URL** first:

- **The whole payload** comes from `…/distribution/packs/<pack>/<variant>/payload/<sha256>`
  with `Content-Encoding: zstd`; the browser decodes it (no WASM), and for an ungated payload of
  at most 100 MiB keeps the decoded body as a **dictionary** for that pack and variant.
- **A planned delta** asks for the target's payload URL with `?via=dcz`. When the browser still
  holds the installed payload as a dictionary (Chromium and Edge 130+), it offers it, and the
  Worker answers `Content-Encoding: dcz`: the stored delta plus 40 bytes, applied natively (the
  content corpus's 5.26 MB v1 → v2 update moves 312,744 bytes). Without a dictionary the Worker
  answers `409` with no body, never a silent full download.
- **Every result is verified** (size and SHA-256 against the signed record): the dictionary is
  in the evictable HTTP cache. A decline (`409`, `406`) runs the same strategy over the blob route
  with the WASM decoder; a failure (a broken transfer, a wrong hash) is reported as a `fallback`
  pack event (`via: "native"`) and does the same; then the plan's remaining candidates follow.
- In the OPFS store the transfer runs in the store's worker, straight into the plan's output.

| Situation                                                        | What runs                               |
| ---------------------------------------------------------------- | --------------------------------------- |
| Chromium, base installed whole through the payload URL           | dcz: the delta plus 40 bytes, no WASM   |
| Base evicted, or never fetched whole (chunk-assembled, embedded) | `409`, then the WASM delta (blob route) |
| Firefox, Safari (no Compression Dictionary Transport)            | `409`, then the WASM delta              |
| A gated pack (`private, no-store`: never a dictionary)           | no dcz request; the WASM delta          |
| A base over 100 MiB (Chromium's dictionary limit)                | no dcz request; the WASM delta          |
| A tree pack (`files.tree`, `data.json`, `l10n.table`)            | unchanged: the blob route and WASM      |

`nativePayload: false` turns this off (always the blob route and WASM), and
`onNativePayload(e)` reports each attempt (`kind` `zstd` or `dcz`, `outcome` `used`, `declined`
with the `status`, or `failed`, and `via` `worker` or `page`). The payload URL is derived from
`distribution.endpoints.blobs` (its sibling path on the same host); a blob template that is not
the canonical `…/distribution/blobs/sha256/{sha256}` turns it off. The page fetches it
cross-origin under the product's `web.origins`, like the blob route. Godot web builds that fetch
the target payload URL through the browser get dcz the same way.

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

**A product accent: set the label colour yourself.** The kit does not resolve contrast for an
accent yet (UK-03 brings `resolveAccent`). If you set `theme.tokens.accent`, set `accentText` (the
label on a filled button) and `ring` (the focus ring) with it, and check the pair is at least 4.5:1
for the label and 3:1 for the fill against the page, in both schemes. A pale accent such as
`#f5c518` needs a dark label; a navy one needs a light one. Without an accent the primary is ink.
Brand through the Provider's `theme` (tokens + copy + logo): no CSS-in-JS dependency. The
Provider publishes the tokens as `--pk-*` custom properties **twice**: on a wrapper element, so
two providers can carry different brands without leaking into each other, and on `:root`, so
anything React portals (a dialog, a toast) still inherits them. The `tokens` prop is the
supported way to change them until UK-05's stylesheet.

The neutral default sets `font-family: inherit`, so the SDK uses your app's font. With font
inherit on a page that sets no font, the kit uses system-ui.

**Two brandings.** Polaris Key branding is optional:

- **Neutral (the default).** A quiet greyscale theme that inherits your app's font
  (`font-family: inherit`) and shows no Polaris Key mark, name or badge. Point any token at your
  own colours (`tokens: { accent: "var(--app-primary)" }`) to blend in completely.
- **Polaris Key.** One option switches to the Polaris Key design system (`@polaris-key/brand`, see
  `docs/design/BRAND.md`): its surfaces and text, the violet accent and focus ring, Rubik when the
  page loads it, and the Polaris Key marks. You do not need to load the brand's `tokens.css`; the
  Provider sets every value itself.

```tsx
// Neutral, nothing to configure:
<PolarisKeyProvider productSlug="acme">…</PolarisKeyProvider>

// The Polaris Key brand, one option (or theme={polarisKeyTheme}, or theme={{ branding: "polaris-key" }}):
<PolarisKeyProvider productSlug="acme" branding="polaris-key">…</PolarisKeyProvider>

// Everything else is optional and works under either branding:
<PolarisKeyProvider
  productSlug="acme"
  colorScheme="system" // "system" (default) | "dark" | "light"
  theme={{
    tokens: { accent: "#ff5c00", accentText: "#000000" }, // both schemes
    lightTokens: { background: "#fbfaf7" }, // one scheme only
    logo: <AcmeLogo />, // your logo atop the screens; null for none
    poweredBy: true, // "Powered by Polaris Key" on the sign-in card and device list (off by default)
  }}
>
```

- **Scheme.** "system" matches the page the kit sits on. The first ancestor of the Provider that
  paints a background decides, light or dark by its luminance. On a page that paints none, the
  kit is dark only when the page opts in to dark (`color-scheme`, or `<meta name="color-scheme">`,
  includes `dark`) and the OS prefers dark; otherwise light. It re-resolves when the OS
  preference changes or your app switches theme with a class or `data-theme` on `<html>` or
  `<body>`. "dark" and "light" pin it. The wrapper carries `data-theme="dark|light"` and the
  matching `color-scheme`, so form controls follow. Persisting a user's choice is yours.
- **Tokens.** `neutralDarkTokens`, `neutralLightTokens`, `polarisKeyDarkTokens`,
  `polarisKeyLightTokens`, `defaultTheme` (neutral dark), `lightTheme` (neutral light),
  `polarisKeyTheme` and `highContrastTheme` (AAA text) are exported. Every token maps to one `--pk-*` variable
  (`themeVars`). If you change a colour, keep text at 4.5:1 and control borders and the focus
  ring at 3:1 against the surfaces. A host accent in the dark scheme needs `darkTokens.ring` too
  for a visible focus ring (the ring defaults to the neutral grey).
- **Identity.** The screens show the product's identity, never a Polaris Key mark: your `logo`;
  otherwise, once `copy.productName` is set, a monogram tile of its initial; otherwise nothing.
- **Copy.** Every default string is a value from the kit and core copy catalogs; any one is
  overridable through `copy`.
- **Layout.** A blocking screen is a centred card that never scrolls inside. Below 35rem of
  window width it goes full-bleed with the title in the upper third and the actions docked at
  the bottom; below 30rem of height (a phone on its side) it lays out in two columns, the title
  beside the controls. The dismissible update dialog sits over a scrim with your app visible
  behind it, as a bottom sheet on a phone. Everything is sized in rem and works from 320 px wide
  and with a larger default font.
- **"Powered by Polaris Key".** Off by default under both brandings. `poweredBy: true` (or `"horizontal"` /
  `"stacked"`) adds it to the sign-in card and the device list; `<PoweredByPolarisKey>` places it
  on your about or credits screen. It never renders below its minimum size (compact 232 × 88,
  horizontal 376 × 144, stacked 288 × 336).
- **Focus and CSP.** Keyboard focus draws a 2 px `--pk-ring` outline; a pointer press, and the
  focus a screen moves to its first action when it opens, draw none. A blocking screen keeps
  Tab inside and makes the page behind it inert. The components style through React's `style`
  prop, which the browser applies through the CSSOM, and render no `<style>` or `<script>`
  element, so they need no `'unsafe-inline'` in your Content-Security-Policy.

## Develop

```sh
pnpm --filter @polaris-key/react typecheck
pnpm --filter @polaris-key/react test
pnpm --filter @polaris-key/react build
```
