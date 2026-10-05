> Research note for [Godot on Polaris Key](../README.md), 2026-10-04. The SDK parity pass,
> commissioned on the owner's request of 2026-10-04: "Please run a pass on SDK parity. All features
> should be available to all platforms and languages. We should be able to do as much as possible
> from each with little to no work to integrate. All services should be available. UI kits and
> components should be available if applicable." Six read-only audits (Node, React, Python, Swift,
> Kotlin, Godot) were run against `main` at `248fef64` and reconciled here. The reconciled matrix
> is in [`PARITY.md`](../PARITY.md) §5. Docs only: no product code, registry, corpus or manifest
> was changed. Paths: `W/` = `packages/worker/src/`, `N/` = `notes/`, `P/` = `program/`, `SN/` =
> `packages/sdk-node/src/`, `SR/` = `packages/sdk-react/src/`, `SP/` =
> `sdks/python/src/polaris_key/`, `SS/` = `sdks/swift/Sources/`, `SK/` = `sdks/kotlin/`, `SG/` =
> `sdks/godot/addons/polaris_key/`.

# SDK parity pass: matrix, target experience and plan

## Owner decisions (2026-10-05)

The owner answered §8 on 2026-10-05. These answers win over the sections below where they differ.

| §8  | Decision                                                                                                                                                                                                                                                                                                                               |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | **React bearer mode** when the page is cross-origin or inside Tauri, **cookie** when first-party (§3.17 as recommended). Cookie mode therefore stays long-term, which makes wire item W10 (sign the browser-session document) applicable: package SP-10.                                                                               |
| Q2  | **Python UI is Qt plus the terminal.** No Tk kit for now (SP-P13 is not scheduled).                                                                                                                                                                                                                                                    |
| Q3  | **Kotlin JVM desktop gets full parity:** a Compose Desktop kit, an OS keyring store and a desktop updater driver (SP-K12).                                                                                                                                                                                                             |
| Q4  | **Canonical platform values `tvos`, `visionos` and `watchos`** (wire item W8, plan mode): package SP-08.                                                                                                                                                                                                                               |
| Q5  | **CI builds and signs the Godot native plugins** (xcframework, AARs, GDExtensions, `pkey_win.dll`) with the existing signing identities, shipped as an optional addon package (SP-G10).                                                                                                                                                |
| Q6  | **SDKs do not build portal URLs client-side.** They wait for the server-supplied `manageUrl` (PX-W8, wire item W2). §3.5's client-side builder and the `portal-links.json` URL corpus are dropped; `portal.links` covers server-supplied links only (`manageUrl`, `signInUrl` and discovery's `accountPortal`) and SP-00 redefines it. |
| Q7  | **`commerce.receipt` is required on Node and Python.** This reverses LX-20's planned Python `allowedNa`; SP-00 changes the registry and the LX-20 brief is amended.                                                                                                                                                                    |
| Q8  | **Swift keychain class `AfterFirstUnlockThisDeviceOnly` everywhere** (`KeychainStore` and `PolarisKeyPlatform` alike).                                                                                                                                                                                                                 |
| Q9  | **Node `engines >= 22.12` is accepted.** Electron releases before 35 are out of scope.                                                                                                                                                                                                                                                 |
| Q10 | **X-01 (C#/.NET) and X-02 (Tauri plugin) do not move up.** They stay optional.                                                                                                                                                                                                                                                         |

**Plan mode.** SP-00 and the wire items W1–W12 (§6) are approved to proceed through plan mode, in
the order of §7. Packages: SP-00 (registry and corpus plan), SP-08 (W8), SP-09 (W9) and SP-10
(W10). The other wire items are existing packages; see the program README §8, phase SP.

**Refusal links.** On the same day the owner fixed the link name: `manageUrl` on both `device_limit`
and `key_entry_limit`, with `license_owned` keeping `signInUrl`. Portal paths are root paths
(`/activate`, `/signin`). §6 W1 and §3.5 below are corrected to match.

**UI-kit answers, recorded for reference.** The UI kit spec is updated separately.

- Product presentation gains an optional **accent colour**. SP-11 was dropped in favour of HA-04
  (manifest `presentation { icon, accent, accentDark }`) and HA-11 to HA-14 (discovery, SDKs and
  kit defaults); the UI kits consume that path (`docs/design/UI-KITS.md`, owner decisions).
- **Launch locales:** English, `de`, `fr`, `es`, `pt-BR`, `it`, `ja`, `ko` and `zh-Hans`. There is
  no Arabic or other right-to-left locale yet.
- **Apple floors** are raised to iOS 18 and macOS 15.
- **Web components** are built on Lit 3.
- The **UI kit build programme** is approved. Its items are phase UK of the program graph; UK-40
  is SP-K12 (Kotlin JVM desktop keyring and updater), and Tk (SP-P13, UK-30) is dropped.

## 0. Summary

**Where we are.** Every SDK agrees on the wire: the corpus, the transcripts and `parity:check`
hold the verdicts. The drift is in what a developer gets _on top of_ the wire:

- **Godot is the reference.** It implements every shipped server feature, including commerce,
  attestation, update-health events, a boot guard and a ten-scene UI kit. Its gaps are a devices
  scene, sign-out, runtime pack progress, What's new, desktop keyrings and the native plugins,
  which are built but not distributed.
- **Kotlin (Android) is close behind.** It has a full Compose kit, drivers and a boot guard. It
  lacks commerce, Play Integrity attestation and update-health events, and its JVM desktop side is
  second-class.
- **Node, Python and Swift are strong cores with thin edges.** None has commerce or update-health
  events, and none has a verified download, an install driver or a boot guard (Swift has Sparkle
  only). Swift has one UI view. Node and Python have only a seven-verb CLI kit.
- **React's browser transport is same-origin only.** It runs on the Worker's first-party cookie
  session, which never answers CORS (`build/web-cors.md`). A React app on its own domain, or in a
  Tauri webview, cannot sign in or hold a licence. The Godot web export already proves the fix: a
  bearer device token over the CORS-covered routes.

**Four defects to fix first.** They are real bugs, not missing features:

1. **Activation errors are collapsed.** Node, Python, Swift and Kotlin map every 403 other than
   `fingerprint_required` either to "device limit" or to a raw body string.
   - `enroll_claimed`, `license_disabled` and `attestation_required` are mislabelled today.
   - I-09's `license_owned` and `key_entry_limit` would be mislabelled too.
2. **`isEntitled` answers `true` after revocation.** Kotlin and Godot confirmed it, and it is
   likely in all six SDKs (S-19 G11).
3. **Fleets are invisible to auto-halt.** Every SDK except Godot sends no update-health events
   (P6-03), so staged-rollout auto-halt cannot see those fleets.
4. **The manifests overclaim in three places:**
   - Node `ui.stages` is not exported.
   - Kotlin `ui.kit` does not exist on the JVM.
   - The Godot `identity.oidc` note suggests the deprecated `/auth/poll`.

**What closes without a wire change.** About 85% of the gaps are SDK, UI-kit, sample or doc work
against routes the server already ships (§4–§5). The rest (§6) waits on planned server work:
I-08/I-09/I-15, PX-W8, LX-18/19, U-\*, commerce v2 and three small contract items. Those go
through plan mode and are named here, not designed.

**Shared names.** §3 is the spec every SDK follows for each new helper and component, so the
same call has the same name and behaviour everywhere. Each helper is tied to a parity id, either
an existing one or one of nine proposed ids. A proposed id becomes real only through the
registry plan, SP-00.

---

## 1. Inputs and method

- **Audits.** One per SDK. Each graded every server capability as full, partial, missing or N/A,
  and graded the UI kit separately, with evidence paths. The server inventory came from
  `W/router.ts`, each service's `routes.ts` and discovery fragment, `conformance/parity/*`, the 18
  transcripts, `PARITY.md`, notes S-16 to S-19 and `P/workpackages.json`.
- **Reconciliation rules:**
  - A cell is graded against what the **server ships today**. Planned server work is ○, and
    wire-flagged in §6.
  - Where two audits disagreed, the code was re-read. One disagreement mattered:
    - The Godot audit proposed browser sign-in over `/identity/auth/poll`.
    - `W/services/identity/index.ts:66` says that route is unadvertised, completes only
      device-bound flows nothing starts, and is kept only until the native redirect token route
      replaces it.
    - **Decision: no SDK builds on `/auth/poll`.** Browser sign-in for native SDKs waits on
      I-15 (§6, W4). Until then, "Sign in with browser" is device code opened in the system
      browser (§3.12).
  - A registry N/A that is a **design choice**, not a runtime limit, is shown as N/A with a
    footnote proposing to close it. Examples are React web `devices.register` and
    `devices.manage`, which Godot web does with a bearer token.
- **Plan mode.** New registry ids, new transcripts and new corpus cases are conformance changes.
  CLAUDE.md puts those through plan mode even when the server is untouched. They are gathered into
  **SP-00** (§5.0), the first package of the pass.

---

## 2. Target developer experience per SDK

The bar the owner set is "little to no work to integrate". Concretely, in every SDK:

1. **One call** to a working, gated, updating app.
2. **Trust pins and product facts generated**, never pasted.
3. **Drop-in components** for every screen a licensed app needs.
4. Every shipped service reachable from the client object, with typed N/As where a runtime truly
   cannot.

The shared calls named below are specified in §3.

### 2.1 Node: servers, CLIs and the Electron main process

```ts
import { createClient } from "@polaris-key/node";
import config from "./polaris.config.js"; // written by `pkey sdk --lang node --write`

const client = await createClient(config); // version from package.json or app.getVersion()
const outcome = await client.boot({ onStage }); // sync → gate → register/enroll → decide → packs → guard
```

- **CLI apps:** `@polaris-key/node/cli` provides the full verb set: `activate`, `enroll`,
  `sign-in` (terminal QR), `deactivate`, `status`, `devices`, `config list|get|set|reset`,
  `update check|apply`, `changelog`, `packs status|ensure`, `offline-request`, `import-bundle`,
  `doctor`. It hooks into commander, yargs and citty.
- **Electron:** a single setup on each side. In the main process,
  `exposePolarisBridge(client, { ipcMain })`. In the preload,
  `import "@polaris-key/node/electron/preload"`. The React kit then works unchanged in the
  renderer. The main process also gets a `safeStorage` store and an updater driver
  (electron-updater or Velopack) behind `client.update.install()`.
- **Servers:** `verifyLicenseDocument(jws, trust)` checks a licence that a client presents, with no
  device state. There is a recipe for Express or Fastify middleware.
- **Platforms:** Node ≥ 22.12 servers and CLIs, single-executable builds, Electron ≥ 35 main.

### 2.2 React: browser, Electron renderer, Tauri webview

```tsx
<PolarisKeyProvider product="acme" config={polarisConfig} mode="auto">
  {/* gate → update decision → required packs → boot confirm */}
  <PolarisBoot>
    <App />
  </PolarisBoot>
</PolarisKeyProvider>
```

- **Browser on any origin.** It uses **bearer mode** (§3.17): `devices/register` or
  `license/activate` mints the token, IndexedDB holds it, and the signed `license/document` and
  `config/document` are verified by `client-core`. The cookie session stays as the first-party
  mode.
- **Provider configuration.** The Provider accepts `trust`, `update` (release keys, packs) and
  `offlineStore`, so offline bundles and signed decisions need no hand-built adapter. It is
  SSR-safe: no network in render, and `"use client"` on its entry points.
- **Electron renderer.** Uses the shipped bridge (§2.1).
- **Tauri.** Uses the X-02 Rust plugin; until then, bearer mode.
- **Components (§3.18):** the full kit, including device-code sign-in, offline activation,
  devices, pack progress, What's new, the entitlement gate, account, purchase/restore and a
  download button.

### 2.3 Python: desktop tools, servers, Ren'Py and Pygame games

```python
client = polaris_key.create(**polaris_config.CONFIG, auto_discover=True)   # generated config module
outcome = client.boot(on_stage=print)
# async hosts:
client = await polaris_key.AsyncClient.create(**polaris_config.CONFIG)
```

- **CLI.** The full verb set (as for Node), with argparse, click and typer hooks and a terminal QR.
- **GUI.** An optional dependency-free Tk kit, `polaris_key.ui.tk`: gate, activation, sign-in,
  devices, settings, update prompt and pack progress. This is owner question Q2.
- **Commerce.** Steam claim through any Steamworks binding.
- **Defaults.** The `keyring` extra is installed by default in the desktop recipe.

### 2.4 Swift: macOS, iOS and iPadOS, then tvOS and visionOS

```swift
let client = try await PolarisKeyClient.fromBundle()   // reads PolarisKey.plist written by `pkey sdk --lang swift --write`
WindowGroup { ContentView().polarisKey(client) }        // environment + PolarisBoot shell + gate
```

- **One client.** `PolarisKeyClient` exposes `update`, `packs`, `devices.attest()` and
  `commerce`, so the one-import promise covers updates and packs too.
- **Commerce.** `commerce.purchase(productID)` runs binding → StoreKit purchase with
  `appAccountToken` → claim → finish → sync, and keeps a `Transaction.updates` loop.
- **Attestation.** App Attest runs automatically on `attestation_required`.
- **Updates.** One call on macOS, `PolarisSparkle.start(client:)`. On iOS, store or TestFlight
  hand-off.
- **Components.** The SwiftUI kit reaches Kotlin's depth (§3.18), with an `.xcstrings` catalog.
  `@Observable` models observe `client.changes`, an `AsyncStream`.
- **Platforms.** macOS, iOS, iPadOS and Mac Catalyst in CI. tvOS, visionOS and watchOS wait on
  owner question Q4 and wire item W8.

### 2.5 Kotlin: Android, then JVM desktop

```kotlin
val client = PolarisKey.create(context, PolarisConfig)   // generated by the Gradle plugin from .pkey/
setContent { PolarisKeyApp(client) { App() } }            // boot shell, gate, update prompt, pack progress wired
```

- **Gradle plugin `im.plrs.key`.** It generates `PolarisConfig` (product, base URL, trust and
  release pins, version from `versionName`), the catalog mirror and the content stamp, and it
  applies a BOM so artifact flavours stay aligned.
- **Android.** `devices.attest()` uses Play Integrity. `commerce.purchase()` uses Play Billing with
  `obfuscatedAccountId`. Sync is lifecycle-aware (ProcessLifecycleOwner, WorkManager).
- **Java callers.** `CompletableFuture` adapters.
- **JVM desktop (owner question Q3).** Compose Desktop kit, an OS keyring store, the download
  installer and open it, and default `UpdateSlots`.

### 2.6 Godot: every export target

Godot already has one-call setup: `PolarisKey.boot()` with `PKeyBoot`. What remains is
distribution and the last components:

- the native plugins, CI-built and shipped in the addon package (owner question Q5);
- a fixed README quickstart;
- `PKeyDeviceList`, `PKeyAccount` (sign-out), `PKeyPackProgress`, `PKeyWhatsNew`,
  `PKeyPurchaseButton` and restore;
- persisted settings by default;
- translations;
- mirror generation in the setup dock.

---

## 3. Shared spec for new helpers and components

**Naming rule** (PARITY §2.1): one name per concept, `camelCase` in TS, Swift and Kotlin,
`snake_case` in Python and GDScript.

**Proof.** Every helper has one of:

- a registry id, existing or proposed;
- a proof file, existing or new in SP-00;
- a unit test tagged `@pkey-feature <id>`.

**Proposed ids** are marked ⊕. They need SP-00 before any SDK tags a test with them.

### 3.1 Typed activation results (`license.activate`, `license.enroll`)

| Kind                  | Wire status and code                   | Fields                                  |
| --------------------- | -------------------------------------- | --------------------------------------- |
| `ok`                  | 200                                    | `state`                                 |
| `deviceLimit`         | 403 `device_limit`                     | `limit?`, `deviceCount?`, `code`        |
| `fingerprintRequired` | 403 `fingerprint_required`             | `code`                                  |
| `hardwareMismatch`    | 409 `hardware_mismatch`                | `code`                                  |
| `enrollClaimed`       | 403 `enroll_claimed`                   | `code` (copy: "sign in to use it")      |
| `licenseDisabled`     | 403 `license_disabled`                 | `code`                                  |
| `licenseExpired`      | 403 `license_expired`                  | `code`                                  |
| `attestationRequired` | 403 `attestation_required`             | `code`; triggers §3.10 where available  |
| `rateLimited`         | 429 `rate_limited`                     | `retryAfterSeconds?`, `code`            |
| `unauthorized`        | 401                                    | `code`                                  |
| `enrollDisabled`      | the existing enrol-closed code         | `code`                                  |
| `refused`             | **any other 4xx with a registry code** | `code`, `status`, `message`             |
| `error`               | transport or 5xx                       | `code` (`network`, `server`), `status?` |

**Rules:**

- Every kind carries `code`.
- **An unknown 403 is never `deviceLimit`.** It becomes `refused` with the server's code. This
  rule makes the I-09 additions (§6, W1) a pure addition later.
- Mapping goes by the body's `error` code, never by status alone.
- **Proof.** Extend `activate-enroll-deactivate.json` with refusal steps that record today's
  server bodies (SP-00), and add a unit table in each SDK.

### 3.2 Error copy catalog: `core.copy` ⊕

- **API.** `copy.message(code, detail?, locale?) → string` and
  `copy.title(code) → string`.
- **Keys:** every registry code in `conformance/parity/errors.json`, every gate status and every
  §3.1 kind.
- **Source.** One generated English base, `conformance/parity/copy.en.json` (new in SP-00), emitted
  per language by `gen-sdk-constants`.
- **Kits.** Each kit's copy (React `theme.ts`, Kotlin `strings.xml`, Godot `pkey_ui_copy.gd`, Swift
  `PolarisCopy`) is generated from or checked against that base.
- **Locales.** English, plus French as the proof locale. More locales are content, not code.
- **Missing codes** fall back to a generic message plus the code, never the raw body.

### 3.3 Licence conveniences (`license.entitlements`)

- **`isEntitled(name)`** returns `false` whenever `isUsable(status())` is false (S-19 G11). This
  is a behaviour change: document it in each changelog.
- **`licenseInfo()`** returns
  `{ licenseId, tier, tierLabel, deviceLimit, deviceCount?, expiresAt?, profile, entitledChannels }`,
  read from the enforced entitlement names in `shared-protocol/src/license.ts`.
- **`entitlementValue(name)`** returns the raw non-boolean value.

### 3.4 One-call boot: `ui.boot` ⊕

`client.boot({ onStage, consent?, requiredPacks?, registration? }) → BootOutcome`. It drives the
existing `ui.stages` reducer (`stage-matrix.json`) end to end:

1. discover (when services are not pinned);
2. sync;
3. reacquire: register, then enrol, then `needsActivation`, following `core.registration` from
   discovery;
4. decide;
5. fetch the required packs (`packs.bootFetch`);
6. guard (`update.bootguard`).

**Rules:**

- An activation prompt is never invented: `needsActivation` is an outcome that the UI shell
  renders.
- **Existing equivalents:** Godot `PolarisKey.boot()` and Kotlin `bootHost()`. Kotlin's defaults
  must wire `fetch` to `PacksClient.bootFetch` and `guard` to `BootGuard`.
- `ensureActivated()` is the sub-call that stops after step 3.
- **Proof:** `stage-matrix.json` plus one new transcript, `boot-cold-register.json` (SP-00).

### 3.5 Portal links: `portal.links` ⊕

- **API.** `portal.url(flow, { for?, returnTo?, key?, platform? })`, with
  `flow ∈ account | library | activate | freeDevice | download | devices`.
- **Built from:** the discovery base origin and the **shipped** SPA routes in
  `packages/admin/src/portal/router.ts` (`#/?activate=`, `#/p/<slug>/free-device?for=&return=`,
  `#/p/<slug>/download`).
- **`returnTo` must match the portal's return allowlist.** When it does not, the helper drops it
  and does not fail.
- **When PX-W8 lands (W2),** a server-supplied `manageUrl` overrides the built
  URL. Kits put a "Manage devices" button on `deviceLimit`.
- **Superseded by the owner's Q6 answer (2026-10-05):** SDKs do not build portal URLs; they
  surface the server's `manageUrl` only. The API and corpus above are not implemented.
- **Proof:** a unit table of URL vectors in `conformance/corpus/v2/portal-links.json` (new,
  SP-00).
- **Coupling:** owner question Q6.

### 3.6 Verified download: `release.fetch` ⊕

`release.fetch(target, { to, onProgress, signal }) → { path, size, sha256 }`. `target` is a build
from a decision, a release record, or `{ version, platform, arch }`.

**Rules:**

- Streams with the device bearer and the `X-PKey-*` headers, which gated delivery needs.
- Resumes with `Range`/`If-Range`.
- **Verifies size and sha256 against the verified release record before returning.**
- Never leaves a partial file at `to`.
- URLs come from discovery `distribution.endpoints` and the build templates, never from the
  legacy `release/dl` alias. The existing `downloadUrl()` builders switch to discovery too.

**Proof:** `packs-chunk-range.json` already covers `Range`. Add `release-fetch-gated.json`
(SP-00). **Existing equivalent:** Godot `core/download.gd`.

### 3.7 Updater feed URLs: `update.feeds` ⊕

- **API.** `update.feedUrl(kind, { channel?, velopackChannel?, buildId? })`, with
  `kind ∈ appcast | winsparkle | velopack | appInstaller | zsync`.
- **Rules.** Expanded from discovery `update.endpoints` templates. A missing template returns a
  typed `Unsupported{reason: product}`.
- `appcastUrl()` stays as an alias.
- **Proof:** URL vectors in `discovery-capabilities.json` assertions.

### 3.8 Distribution model: `release.distribution` ⊕

- **API.** `distribution.downloadModel() → { platforms[], stores[], current }`, a typed wrapper for
  `GET /<p>/distribution/download.json`. Also `distribution.thisPlatform()`.
- **This is the `client.distribution` sub-client** that the `distribution` service slug already
  implies.
- **Proof:** new transcript `distribution-download-model.json`.

### 3.9 Commerce (`commerce.receipt`)

- **Base API (all SDKs):**
  - `commerce.binding() → { bindingId, … }` (`GET /distribution/commerce/binding`);
  - `commerce.claim(store, payload) → ClaimResult` (`POST /distribution/commerce/claim`).
  - **`ClaimResult` kinds:** `ok` (then sync), `notOwned`, `attestationRequired`, `refused{code}`.
- **One-call helpers where a store SDK is in reach:**
  - `commerce.purchase(productId)`: binding → store purchase with the binding token → claim →
    finish only after a successful claim → sync.
  - `commerce.restore()`: re-claim current entitlements.
  - A background **renewals loop** (StoreKit `Transaction.updates`, Play `PurchasesUpdatedListener`)
    that claims new transactions.
- **Store payloads:**
  - Steam: hex ticket from `GetAuthTicketForWebApi`.
  - App Store: transaction JWS.
  - Play: purchase token.
- **Proof:** `commerce-claim.json`, which exists and which today's non-Godot runners skip.

### 3.10 Attest and retry (`devices.attest`)

- **API.** `devices.attest()` runs challenge → platform token → `POST /devices/attest`, persists
  the key id, and re-attests on `invalid_key`.
- **Retry rule.** Every call that can answer 403 `attestation_required` (mint, gated
  delivery, commerce claim) attests once and retries once. The retry happens only when the
  runtime supports `devices.attest` and the product has not opted out.
- **Elsewhere** the caller gets the typed refusal, and the kits show copy for it.

### 3.11 Persisted local overrides and change events: `config.local` ⊕, `core.sync`

- **API.** `config.set(key, value)` validates against the catalog type. Also
  `config.clear(key)`, `config.setting(key)` (a reactive handle) and
  `onConfigChange(key | *, fn)`.
- **Persisted by default** in each platform's store:
  - IndexedDB on the web;
  - `user://` on Godot;
  - UserDefaults or a file on Apple;
  - DataStore on Android;
  - a JSON file in the state directory on Node and Python.
- **`client.events`** is one multi-subscriber stream with kinds `license`, `config`,
  `updateAvailable`, `packs` and `store`. It uses each language's idiom (PARITY §2.3):
  `EventEmitter`, `AsyncStream`, `Flow`, signals, callbacks plus async iterators.
- **Forward compatibility.** U-06 and U-20 (Cloud Sync, W6) later add an account layer and sync
  state under the same API, which is why the names follow S-17 §5.11.
- **Refresh.** The default is on for UI hosts. Each SDK refreshes on foreground, `online` and
  `visibilitychange` where the runtime has them, honouring `ETag` and backoff.

### 3.12 Sign-in conveniences (`identity.devicecode`, `identity.oidc`)

- **`identity.signInWithBrowser()`.** Device code with `verificationUriComplete` opened in the
  system browser, then poll. It needs no new route. This is the interim for native SDKs until
  I-15 (W4).
- **Attach opt-in.** `pollSignIn` and `acceptSignIn({ confirmIdentity, attachLicense })` send
  P1-07's opt-in, which `W/services/identity/oidc.ts` reads.
- **`SignInPoll.ready`** carries `identity` and `attached`.
- **`identity.signOut()`** is an alias of `license.deactivate()`, plus clearing the identity and
  emitting `license`. **`identity.current()`** returns `{ name, email, activatedAt }` or null.
- **QR helper.** `qr.svg(text)` and `qr.terminal(text)` (headless). Kits use their native
  renderer. Godot's `qr_encoder.gd` is the reference vectors.

### 3.13 Update-health events: `telemetry.updates` ⊕

**Journal.** Each SDK keeps a persisted journal of P6-03 events
(`conformance/parity/enums.json` `updateEvent`, `W/core/updateHealth.ts`). At most 16 events go
per report; the rest wait for the next. A report marks the events it carried as sent.

| Event               | Emitted by                                          |
| ------------------- | --------------------------------------------------- |
| `update_offered`    | `update.decide` returning a newer build             |
| `update_downloaded` | `release.fetch`, a driver, or `packs.apply` success |
| `update_applied`    | driver hand-off or a pack switch                    |
| `update_confirmed`  | `update.bootguard` confirm                          |
| `update_reverted`   | bootguard rollback                                  |
| `pack_failed`       | pack pipeline failure                               |
| `boot_rolled_back`  | bootguard N failed boots                            |

- `devices.report` also carries `outlet`, `gate` and `packInstalls` wherever the SDK knows them.
  These are allowlisted in `W/core/devices.ts` `REPORT_KEYS`.
- **Proof:** extend `telemetry-report.json` with an `updates` array (SP-00).
- **Existing equivalent:** Godot `core.gd` `pending_events`.

### 3.14 Crash tags: `crash.tags` ⊕

- **API.** `crashTags() → { release: "<deliverable>@<version>[+<build>]", environment: <channel>, "pkey.outlet": <outlet> }`.
- This is exactly the convention in `W/services/distribution/sentry.ts`.
- **No crash SDK dependency.** A docs recipe per SDK shows the matching Sentry init.

### 3.15 Boot guard for the app build (`update.bootguard`)

- **API.** `update.markBootAttempt()` at startup, `update.confirmBoot()` once healthy.
  `MAX_FAILED_BOOTS` comes from `client-core`.
- **Slots** are stored beside the token store.
- **When the driver can roll back** (Velopack, a kept previous APK, a pack set) it does so after
  N failures. Otherwise it reports `boot_rolled_back`, with `reason: "no-previous"`, and surfaces
  a typed outcome.
- **Proof:** `stage-matrix.json`, which exists.

### 3.16 Install driver interface (`update.driver`)

- **API.** `update.install(decision, { onProgress }) → InstallOutcome`.
- **InstallOutcome kinds:** `restartRequired`, `handedOff`, `storeOpened`, `unsupported{reason}`.
- **Adapters per runtime:**
  - **Node/Electron:** electron-updater, Velopack, single-executable self-replace.
  - **Python:** Velopack (PyInstaller, Briefcase), binary self-replace for CLIs.
  - **Swift:** Sparkle on macOS; store or TestFlight link on iOS.
  - **Kotlin:** Play, direct APK, desktop installer open.
  - **Godot:** the existing bridges.
  - **React web:** service-worker `skipWaiting` then reload.
- Every adapter sends the update-health events (§3.13).

### 3.17 React bearer mode (closes design-choice N/As)

- **Option.** `browserAdapter({ auth: "bearer" | "cookie" })`. The default is `"bearer"` when
  the page's origin differs from the Worker's, otherwise `"cookie"`.
- **Bearer mode** uses only CORS-covered routes:
  - `devices/register`, `license/activate`, `license/token`;
  - `license/document` and `config/document`, verified;
  - `devices/*`, mint, release, update, distribution;
  - the device-code flow.
- **Storage.** The token lives in IndexedDB behind the `core.store` contract, with surfaced
  degradation.
- **This closes:**
  - web `core.cache` (a verified IndexedDB cache);
  - `devices.register`, `devices.manage`, `devices.report`;
  - `config.mint`;
  - `identity.devicecode` on TV and kiosk browsers;
  - entitled changelog, feeds, downloads and gated pack bytes.
- **Signed documents.** The unsigned fused session document stays only in cookie mode.
- **Security trade-off** (a token readable by any script on the page): owner question Q1.

### 3.18 UI components: names, states and shared behaviour

One canonical component list. Each kit uses its prefix: React `Polaris*`, SwiftUI `Polaris*`,
Compose `Polaris*`, Godot `PKey*`, Python Tk `polaris_key.ui.tk.*`.

| Component                  | Shows / does                                                                                                   | States it must render                                        |
| -------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `Boot`                     | the §3.4 shell: progress per stage, consent for metered pack download, error card with copy                    | every `stage-matrix` outcome                                 |
| `Gate`                     | routes gate statuses to screens, grace banner                                                                  | every `gate-matrix` status                                   |
| `Activation`               | key entry, "Continue free" (enrol, when discovery allows), "Sign in", "Buy" (portal), "Activate offline" link  | every §3.1 kind; `deviceLimit` shows "Manage devices" (§3.5) |
| `SignIn`                   | device code: URL, user code, QR, countdown, cancel, "Open browser"; attach confirmation                        | pending, slowDown, expired, denied, ready (+identity)        |
| `OfflineActivation`        | request code (product + device id) with copy and QR; import by file, paste or drop                             | idle, imported, invalid bundle (copy by code)                |
| `Settings`                 | `config.list` rows typed from the catalog (toggle, select, number, text), lock for enforced, reset, provenance | enforced, default, local, env                                |
| `Devices`                  | roster, this-device marker, rename, deauthorise, sign out this device                                          | loading, empty, refused (copy), unsupported (portal link)    |
| `Account`                  | signed-in identity or licence summary (`licenseInfo()`), sign out / deactivate, "Manage account"               | signed in, key-only, signed out                              |
| `Entitled`                 | renders children when `isEntitled(name)`, otherwise a fallback or upgrade prompt                               | entitled, not entitled, gate not usable                      |
| `EntitlementBadge`         | tier or flag label                                                                                             | —                                                            |
| `UpdatePrompt`             | decision (required vs optional, blocked reasons), release notes, download progress, "Restart to finish"        | every `update-matrix` action; driver outcomes                |
| `WhatsNew`                 | changelog since last seen version                                                                              | loading, empty, refused                                      |
| `PackProgress`             | runtime `packs.ensure`/background progress, size estimate and consent                                          | queued, downloading, applying, ready, failed (copy)          |
| `ChannelPicker`            | entitled channels, outlet lock (`channelSwitch`), persisted via `config.local`                                 | locked, switchable                                           |
| `PurchaseButton`/`Restore` | §3.9 one-call purchase and restore                                                                             | idle, purchasing, claimed, notOwned, unsupported             |
| `DownloadButton`           | §3.8 this platform first, "Also on" list                                                                       | —                                                            |
| `StatusBanner`             | last checked, grace remaining, store degraded                                                                  | —                                                            |
| `DevMenu`                  | build, outlet, device, channel, gate, copy diagnostics, force check                                            | —                                                            |

**Rules for every kit:**

- Copy comes from §3.2.
- Each component takes an optional slot or override for every text and action.
- The default theme is neutral, with the Polaris brand opt-in (as Godot does).
- Keyboard, focus and screen-reader labels are covered.
- Key entry is hidden automatically on store outlets where the store rules require it
  (App Store 3.1.1, Play payments).

**Headless SDKs** get the same list as CLI verbs (§2.1) where it makes sense. `Boot`, `Gate`,
`Settings` and `PackProgress` map to progress lines and prompts.

### 3.19 Tooling: generated configuration and mirrors

- **`pkey sdk --lang <node|react|python|swift|kotlin|godot> --write [--out <path>]`** fetches
  discovery and writes a typed config module with:
  - product, base URL;
  - `trust.pinnedKeys` from discovery;
  - pinned release keys from the release-key endpoint;
  - expected services.

  Release keys are matched against the discovery `releaseKeyFingerprints`. The CLI refuses on a
  mismatch.

- **`pkey mirror --lang <…>`** publishes `tools/gen-mirrors.ts` through the CLI, so adopters can
  generate typed catalog mirrors without the monorepo.
- **Wrappers.** Kotlin's Gradle plugin and Godot's setup dock call these two commands.
- **Drift gate.** New CLI commands are routes in the generated CLI reference, so the docs freshness
  gate applies (AGENTS rule 3).

---

## 4. Cross-SDK themes

| Theme                                 | Node | React | Python | Swift | Kotlin | Godot | Spec  |
| ------------------------------------- | ---- | ----- | ------ | ----- | ------ | ----- | ----- |
| 403 collapse in activation (bug)      | ✗    | ✗     | ✗      | ✗     | ✗      | ◐     | §3.1  |
| `isEntitled` after revocation (G11)   | ?    | ?     | ?      | ?     | ✗      | ✗     | §3.3  |
| Update-health events                  | ✗    | ✗     | ✗      | ✗     | ✗      | ✓     | §3.13 |
| Commerce binding/claim                | ✗    | ✗     | ✗      | ✗     | ✗      | ◐     | §3.9  |
| Attest and retry                      | N/A  | N/A   | N/A    | ✗     | ✗      | ◐     | §3.10 |
| Verified download                     | ✗    | ✗     | ✗      | ✗     | ◐      | ✓     | §3.6  |
| Updater feed URL helpers              | ◐    | ✗     | ◐      | ◐     | ✗      | ✓     | §3.7  |
| Boot guard (app build)                | ✗    | ✗     | ✗      | ✗     | ✓      | ✓     | §3.15 |
| One-call boot                         | ✗    | ✗     | ✗      | ✗     | ◐      | ✓     | §3.4  |
| Persisted overrides + config events   | ✗    | ◐     | ✗      | ✗     | ✗      | ◐     | §3.11 |
| Error copy and locales                | ✗    | ◐     | ✗      | ✗     | ◐      | ◐     | §3.2  |
| Portal links                          | ✗    | ✗     | ✗      | ✗     | ✗      | ✗     | §3.5  |
| Distribution model                    | ✗    | ✗     | ✗      | ✗     | ✗      | ✗     | §3.8  |
| Crash tags                            | ✗    | ✗     | ✗      | ✗     | ✗      | ✗     | §3.14 |
| Generated pins/config (`pkey sdk`)    | ✓    | ✓     | ✓      | ✓     | ✓      | ✓     | §3.19 |
| Mirror generator outside the monorepo | ✓    | ✓     | ✓      | ✓     | ✓      | ✓     | §3.19 |
| Runnable sample app                   | ✗    | ✗     | ✗      | ✗     | ✗      | ✗     | §5.7  |

`?` means not confirmed by that audit. Treat it as ✗ until a test proves otherwise (SP-00 adds the
G11 unit case to the gate matrix).

---

## 5. Gap list per SDK: tasks closable without a wire change

Each task names its parity id, its spec section and the proof the engineer adds. **S/M/L** is
effort: under 2 days, under 1 week, and 1–3 weeks. The tasks are ordered within each SDK.

### 5.0 Cross-cutting (do first)

- **SP-00. Registry and corpus plan (plan mode; no server change).** One plan that adds:
  - **Proposed ids:** `core.copy`, `ui.boot`, `portal.links`, `release.fetch`, `update.feeds`,
    `release.distribution`, `config.local`, `telemetry.updates` and `crash.tags`, with their
    allowed N/As.
  - **Registry changes:**
    - Replace `ui.kit`'s `headless` N/A with a `ui.cli` expectation for Node and Python.
    - Revisit LX-20's planned Python `allowedNa` for `commerce.receipt` (owner question Q7).
  - **Transcripts:** activation refusals, `boot-cold-register.json`,
    `release-fetch-gated.json`, `distribution-download-model.json`, and `telemetry-report.json`
    with `updates`.
  - **Corpus:** `portal-links.json`, a G11 row in `gate-matrix.json`, and `copy.en.json` plus its
    `gen-sdk-constants` emitters.

  It sets every SDK's manifest honestly: new ids start as `planned` with the SP task named.
  **Gates:** `pnpm parity:check -- --check`, `pnpm gen:corpus -- --check`, the generated parity
  docs page. **L.**

- **SP-01. Manifest corrections, no code.**
  - Node `ui.stages`: change to `planned` until SP-N05.
  - Kotlin `ui.kit`: add a `jvm` exception.
  - Godot `identity.oidc` note: say it waits on I-15; drop the `/auth/poll` idea.
  - Python `devices.report` note: list the missing keys.
  - React notes for web N/As: "design choice, closable by bearer mode".

  **Gate:** `parity:check`. **S.**

- **SP-02. `pkey sdk --write` and `pkey mirror`** (§3.19) in `packages/cli`, with a per-language
  template test. **Gates:** CLI reference docs freshness, `pnpm test`. **M.**
- **SP-03. Copy base and French proof locale** (§3.2): `copy.en.json`, `copy.fr.json`, emitters,
  and a test that every registry code has a key. **M.**

### 5.1 Node (`@polaris-key/node`)

1. **SP-N01. Fix activation mapping** (§3.1) in `SN/license/endpoints.ts`. Add every kind and
   `refused{code}` for unknown codes. Update the CLI `describeFailure()` to use `core.copy`.
   Proof: the extended transcript. **S.**
2. **SP-N02. G11** (§3.3): gate `isEntitled` on `isUsable`, and add `licenseInfo()` and
   `entitlementValue()`. **S.**
3. **SP-N03. Update-health journal** (§3.13). Persist it under the state directory. Add `updates`,
   `outlet` and `gate` to `buildSnapshot` in `SN/core/telemetry.ts`, and emit from decide, packs
   and drivers. **M.**
4. **SP-N04. Commerce client** (§3.9) in `SN/commerce/`. `binding()` and `claim()`. Steam helper
   `claimSteam(ticketHex)` with no Steamworks dependency: the host passes the ticket. Stop skipping
   `commerce-claim.json` in the Node runner. **M.**
5. **SP-N05. Export and drive `ui.stages`:**
   - re-export `BOOT_STAGES`, `bootTransition` and `bootGuardAction` from `client-core`;
   - implement `client.boot()` and `ensureActivated()` (§3.4).

   **M.**

6. **SP-N06. App boot guard** (§3.15): slots in the state directory, `markBootAttempt` and
   `confirmBoot`. **M.**
7. **SP-N07. `release.fetch`** (§3.6) over `fetch` streams, with resume and sha256. Switch
   `installUrl()`/`downloadUrl()` to discovery `distribution.endpoints`. **M.**
8. **SP-N08. `update.feedUrl()`** (§3.7) and **`client.distribution`** (§3.8). **S.**
9. **SP-N09. Install drivers** (§3.16):
   - `electronUpdaterDriver`, `velopackDriver`, `seaSelfReplaceDriver`, `storeLinkDriver`;
   - all as optional peer dependencies, under `@polaris-key/node/update/drivers/*`.

   **L.**

10. **SP-N10. Electron bridge host** (§2.1): `@polaris-key/node/electron` exports
    `exposePolarisBridge(client, { ipcMain, webContents })`, with `/preload` doing the
    `contextBridge` exposure.
    - Implements PolarisBridge v3 in full: `getSyncState`, `refresh`, `beginSignIn`,
      `pollSignIn`, `submitKey`, `signOut`, `invoke`, `fetchSchema`, `importBundle` and `on`.
    - Pushes `stateChanged` from `client.events`.
    - Proof: a bridge round-trip test against `SR/desktop/bridge.ts` types. **L.**
11. **SP-N11. `SafeStorageStore`** for the Electron main process, behind the `core.store`
    contract, with surfaced degradation. **S.**
12. **SP-N12. Device-code attach opt-in, signInWithBrowser, signOut, QR helper** (§3.12):
    `qr.terminal`, `qr.svg`. **M.**
13. **SP-N13. `config.local` and `client.events`** (§3.11): a persisted JSON store, `config.set`
    and `config.clear`, a default refresh loop for long-running hosts, and online/wake triggers
    where available. **M.**
14. **SP-N14. Full CLI kit** (`@polaris-key/node/cli`, §2.1). Each verb gets a test.
    - Verbs: `sign-in` (terminal QR), `devices list|rename|deauthorize`,
      `config list|set|reset`, `update check|apply`, `changelog`, `packs status|ensure`
      (progress bar), `offline-request`, `doctor` (supports, store status, discovery), `secret`
      and `mint`.

    **L.**

15. **SP-N15. Outlet:** autoload the P1-11 build stamp from a packaged resource, and read the
    Windows `SignatureKind` through the existing PowerShell/CIM path. **M.**
16. **SP-N16. Server-side verify recipe** (`verifyLicenseDocument`) and `crashTags()`
    (§3.14). **S.**
17. **SP-N17. Version autoload** from `package.json` or `app.getVersion()` when `version` is
    omitted, with a warning when it cannot be found. **S.**
18. **SP-N18. Docs and samples:**
    - runnable samples in `examples/`: Express middleware, a commander CLI with sign-in, an
      Electron app with the React kit over the bridge;
    - a device-limit recovery recipe;
    - a note that attestation-gated products refuse Node.

    **M.**

### 5.2 React (`@polaris-key/react`)

1. **SP-R01. Provider options:** `trust`, `update` (release keys, packs) and `offlineStore`. Keep
   the adapter stable across inline-object props, comparing values rather than identity. Expose
   `useDiscovery()` and `useOfflineDeviceId()`. **M.**
2. **SP-R02. Bearer mode** (§3.17) in `SR/browser/`. Includes:
   - `IndexedDbTokenStore`;
   - a signed-document sync with `ETag`/304 and backoff;
   - a verified licence and config cache in IndexedDB (`core.cache`);
   - `devices.register`, `devices.manage`, `devices.report` (with browser facts from the
     allowlist), `config.mint` and the device-code flow.

   Update `parity.json` so web N/As move to `implemented`. Proof: replay the transcripts that
   `test/transcripts.test.ts` skips today. **L.**

3. **SP-R03. Typed activation and copy** (§3.1, §3.2):
   - adapters carry `wireCode`, `limit` and `deviceCount`;
   - delete `describeAuthError`'s regex on message text;
   - generate `theme.ts` copy from `copy.en.json`;
   - ship a locale bundle mechanism;
   - G11: `useEntitlement` answers `false` when the gate is not usable (§3.3).

   **M.**

4. **SP-R04. Hooks:** `useLicenseInfo`, `useEntitlementValue`, `useConfigSetting(key)` (typed
   over the mirror), `useBoot`, `usePacks`, `usePackProgress`, `useWhatsNew` and `usePortalUrl`.
   **M.**
5. **SP-R05. Components** (§3.18). Each gets a snapshot test:
   - **New:** `PolarisBoot`, `PolarisSignIn` (device code with QR; fixes PolarisLogin dropping
     the handle), `PolarisOfflineActivation`, `PolarisAccount`, `PolarisEntitled`,
     `PolarisWhatsNew`, `PolarisPackProgress`, `PolarisChannelPicker`, `PolarisDownloadButton`,
     `PolarisPurchaseButton`, `PolarisDevMenu`.
   - **Upgrades:** `ConfigPanel` gets typed catalog inputs with persistence through
     `config.local`; `DeviceManager` gets a portal link; `LicenseGate` and the activation screen
     get device-limit remediation.

   **L.**

6. **SP-R06. Re-export `ui.stages`** and implement `boot()` (§3.4). **S.**
7. **SP-R07. Bridge v4 (an in-process contract, not server wire).** Add
   `invoke('packs' | 'config.mint' | 'commerce' | 'telemetry')` and pushed pack progress. Bump
   `PolarisBridge` to v4, accepting v3. Implemented on both sides with SP-N10. **M.**
8. **SP-R08. Update driver for the web:** a service-worker update hand-off (waiting SW, then
   `skipWaiting`, then reload) and `update.feedUrl()` for desktop hosts. **M.**
9. **SP-R09. `release.fetch`** for licensed downloads in bearer mode. `distribution` model and
   `DownloadButton`. **S.**
10. **SP-R10. Commerce** over the bridge (to SP-N04) and on the web in bearer mode. Restore UI.
    **M.**
11. **SP-R11. Telemetry:** web reports in bearer mode (`caps`, `updates`, `packInstalls`,
    `packSetId`). Desktop `report(extras)` forwards renderer events. **S.**
12. **SP-R12. `core.local`:** a network-free adapter for tests, previews and kiosk builds. **S.**
13. **SP-R13. SSR safety:** no network in the constructor or render, `"use client"` banners, and
    a Next.js recipe. **S.**
14. **SP-R14. Docs and samples:** a Vite web app (cross-origin, bearer), the Electron sample
    shared with SP-N18, a CORS and same-origin explainer in the React docs, and a Tauri status
    note. **M.**

### 5.3 Python (`polaris-key`)

1. **SP-P01. Activation mapping** (§3.1) in `SP/license/endpoints.py`, so unknown 403s no longer
   map to `ActivationDeviceLimit`. Device calls keep the server's code: replace
   `device_*_failed` with `refused{code}`. **S.**
2. **SP-P02. G11, `license_info()` and `entitlement_value()`.** **S.**
3. **SP-P03. Telemetry completeness:** add `gate`, `outlet`, `updates` (journal, §3.13) and
   `packInstalls` to `SP/core/telemetry.py`. **M.**
4. **SP-P04. `create(auto_discover=True)`**, and make it the default when `expected_services` is
   omitted. **S.**
5. **SP-P05. `AsyncPolarisKeyClient`** over `httpx.AsyncClient`, with async `wait_for_sign_in`, an
   async pack-progress iterator and `asyncio` cancellation. It shares the core with the sync
   client. **L.**
6. **SP-P06. Commerce** (§3.9): `binding()`, `claim()` and `claim_steam(ticket_hex)`. Unskip
   `commerce-claim.json` in `tests/test_transcripts.py`. **M.**
7. **SP-P07. `release.fetch`, `update.feed_url()`, `distribution`** (§3.6–3.8). Fix
   `download_url` to use discovery. **M.**
8. **SP-P08. `boot()`, `ensure_activated()` and the app boot guard** (§3.4, §3.15). **M.**
9. **SP-P09. Install drivers** (§3.16): Velopack (PyInstaller, Briefcase), binary self-replace
   for CLIs, store link. **M.**
10. **SP-P10. Sign-in:** attach opt-in, `sign_in_with_browser()` (`webbrowser.open`),
    `sign_out()`, a terminal QR, and `ready` carrying the identity (§3.12). **M.**
11. **SP-P11. `config.local`, `subscribe()` and `client.events`** (§3.11). Per-key config and
    entitlement events. **M.**
12. **SP-P12. CLI kit:** the full verb set (as SP-N14) for argparse, click and typer. **L.**
13. **SP-P13. Tk kit** (`polaris_key.ui.tk`, dependency-free) with gate, activation, sign-in
    (QR), devices, settings, update prompt and pack progress. Subject to owner question Q2.
    **L.**
14. **SP-P14. `portal.url()`, `copy`, `crash_tags()`.** **S.**
15. **SP-P15. Packaging and docs:**
    - make the `keyring` extra the desktop default in the docs;
    - fix the stale "wire contract v3" metadata in `pyproject.toml` and the package docstring;
    - samples: a CLI, a Tk app and a Ren'Py snippet;
    - document Pyodide and Python-on-mobile as unsupported until fingerprint and outlet readers
      exist. Map the `Emscripten` platform to `web`, which needs no wire change because `web` is
      already canonical.

    **M.**

### 5.4 Swift (`PolarisKey*`)

1. **SP-S01. Activation mapping** (§3.1) in `SS/PolarisKeyLicense/Endpoints.swift:106-128`.
   - Make `PolarisError` conform to `LocalizedError` through `core.copy`.
   - Move the activation copy from `PolarisGateModel` into `PolarisCopy`.
   - Fix "this Mac" on iOS.

   **S.**

2. **SP-S02. G11, `licenseInfo()`, and typed config getters** (`bool`, `int`, `double`,
   `string`, `decode<T>`). Also `isEnabled(flag:)`. **S.**
3. **SP-S03. Umbrella client:** add `client.update`, `client.packs`, `client.devices` (with
   `attest`) and `client.commerce` to `PolarisKeyClient`. Load the pins from a bundled
   `PolarisKey.plist` written by SP-02 (`PolarisKeyClient.fromBundle()`). **M.**
4. **SP-S04. `client.changes`** as a multi-subscriber `AsyncStream`, and `@Observable` models.
   - Sync on `scenePhase` and `didBecomeActive`.
   - `PolarisGateModel` observes the client.
   - A convenience init from `PolarisKeyClient`.
   - A `.polarisKey(client)` environment modifier.

   **M.**

5. **SP-S05. Telemetry:** `outlet`, `updates` (journal) and `report(extras:)`, with emitters in
   `UpdateClient`, `PacksClient` and the Sparkle delegate. **M.**
6. **SP-S06. App Attest** (§3.10). Wire `PolarisKeyPlatform/AppAttest.swift` into
   `devices.attest()` with challenge, `attestKey`, POST, the key id in the keychain and re-attest
   on `invalid_key`. Add attest-and-retry. macOS is a typed N/A. **M.**
7. **SP-S07. Commerce** (§3.9). StoreKit 2 `purchase(productID)` with `appAccountToken`, claim,
   finish after the claim, sync, a `Transaction.updates` loop and restore. Wrap
   `PolarisKeyPlatform/Store.swift` as Swift types instead of `PlatformObject` JSON. Unskip
   `commerce-claim.json`. **L.**
8. **SP-S08. Background Assets adapter:** a `PackObjectTransport` over `AssetPacks.swift`
   (`packs.transport.apple`). **M.**
9. **SP-S09. Boot guard** (§3.15) and **`boot()`** (§3.4). **M.**
10. **SP-S10. Update hand-off:**
    - `PolarisSparkle.start(client:)` reconfigures when entitlements or channels change;
    - on iOS, `update.install()` opens the App Store, TestFlight or alt-marketplace link;
    - `update.feedUrl()`, `release.fetch` and `distribution`.

    **M.**

11. **SP-S11. Device code:** `ready` carries `identity` and `attached`. Add the attach opt-in,
    `signInWithBrowser()` (`ASWebAuthenticationSession` showing the device-code URL) and
    `signOut()`. The gate hides "Sign in" when discovery says identity is off, and defaults to
    device code instead of a no-op closure. **M.**
12. **SP-S12. SwiftUI kit** (§3.18). Each gets a snapshot test:
    - `PolarisBoot`, `PolarisSignIn` (CoreImage QR), `PolarisSettings`, `PolarisDevices`,
      `PolarisAccount`, `PolarisEntitled`, `PolarisUpdatePrompt`, `PolarisWhatsNew`,
      `PolarisPackProgress`, `PolarisOfflineActivation` (fileImporter, drop, paste),
      `PolarisChannelPicker`, `PolarisPurchaseButton` (wrapping `ProductView`),
      `PolarisDevMenu`;
    - a keyless "Continue free" button on the gate.

    **L.**

13. **SP-S13. Localisation:** an `.xcstrings` catalog generated from `copy.en.json`, with
    accessibility strings, resolved through `Bundle.module`. **M.**
14. **SP-S14. `config.local`** (UserDefaults-backed) and a decoded catalog model for
    `fetchSchema()`. **M.**
15. **SP-S15. Keychain options:** `accessGroup` and app-group cache directory options. Unify the
    accessibility class once owner question Q8 is answered. **S.**
16. **SP-S16. Mac Catalyst CI job.** For tvOS, visionOS and watchOS, add `identifierForVendor`
    branches in `DeviceID.swift` and `Fingerprint.swift` now. The platform header waits on W8.
    **S.**
17. **SP-S17. Docs:** a DocC catalog, a sample macOS and iOS app, an iOS quickstart covering
    StoreKit, App Attest and update hand-off, and an install snippet that tells iOS-only apps to
    skip `PolarisKeyUpdate`. **M.**

### 5.5 Kotlin (`im.plrs.key`)

1. **SP-K01. Activation mapping** (§3.1) in `LicenseEndpoints.activationLike()`:
   - `enroll_claimed` and `license_disabled` get their own kinds;
   - `ActivationResult` carries `code`;
   - the kit's `errorMessage()` uses `core.copy`;
   - ship `values-fr` in the release AAR, generated from `copy.fr.json`.

   **S.**

2. **SP-K02. G11** in `LicenseClient.isEntitled`, plus `licenseInfo()`. **S.**
3. **SP-K03. Update-health events** (§3.13) from `UpdateClient`, `BootGuard`, `PackEngine` and
   both install drivers, carried in `report()`. **M.**
4. **SP-K04. Play Integrity attestation** (§3.10): `devices.attest()` in `:android` over
   `platform/Integrity.kt`, plus attest-and-retry. **M.**
5. **SP-K05. Commerce** (§3.9). `binding()` and `claim()` in `:sdk`. Play Billing helper in
   `:android-play`: `obfuscatedAccountId` set to the binding, claim on purchase and restore,
   acknowledge after the claim. Steam claim on the JVM. Unskip `TranscriptTest.kt:459`. **L.**
6. **SP-K06. Boot wiring:** `bootHost()` defaults `fetch` to `PacksClient.bootFetch` and `guard`
   to `BootGuard`, and keeps the `UpdateCheck` for the prompt. Add an `updateActions()` adapter
   that calls `client.update.install()`. Add a `PolarisKeyApp {}` composable with
   `CompositionLocal` and `remember*` helpers. **M.**
7. **SP-K07. `config.local`** (DataStore), `config.setting(key): StateFlow` and a `configChanges`
   Flow. Settings becomes editable (typed catalog inputs). **M.**
8. **SP-K08. Lifecycle:** sync on ProcessLifecycleOwner foreground, a WorkManager periodic sync,
   and an ActivityLifecycleCallbacks helper for `AndroidOptions.activity`. Handle the In-App
   Updates result and resume. Play flexible updates get download progress and a "restart to
   finish" state. **M.**
9. **SP-K09. Kit additions:** `PolarisOfflineActivation` (SAF picker), "Continue free",
   `PolarisAccount` (sign out), `PolarisWhatsNew`, `PolarisChannelPicker` with runtime channel
   switching under the outlet lock, `PolarisDevMenu`, `PolarisPurchaseButton` and Restore, and
   `PolarisDownloadButton`. **L.**
10. **SP-K10. Gradle plugin `im.plrs.key`** (§2.5). It generates `PolarisConfig` through SP-02,
    the mirror, the content stamp and the `<queries>` entries for probes. It ships a BOM. **L.**
11. **SP-K11. Java interop:** `CompletableFuture` adapters (`PolarisKeyFutures`) and
    `@JvmOverloads` on options. **M.**
12. **SP-K12. JVM desktop** (owner question Q3):
    - an OS keyring store (Keychain, Credential Manager, Secret Service through `java-keyring` or
      JNA), keeping the `dependency` N/A when it is absent;
    - a desktop install driver that downloads the installer for the OS and arch through
      `release.fetch` and opens it;
    - default `UpdateSlots`;
    - the Compose Multiplatform desktop target of `:ui`.

    **L.**

13. **SP-K13. `release.fetch`, `update.feedUrl()`, `distribution`, `portal.url()`,
    `crashTags()`.** Read endpoints from discovery instead of hard-coding them in
    `Endpoints.kt`. **M.**
14. **SP-K14. Samples:** a runnable Android sample and a JVM CLI sample. **M.**

### 5.6 Godot (`addons/polaris_key`)

1. **SP-G01. Fix the README:** remove the stray diff3 marker at `sdks/godot/README.md:72` and
   trim the stray repo-layout block. **S, do immediately.**
2. **SP-G02. G11** in `SG/services/license.gd:112`. **S.**
3. **SP-G03. Activation:** unknown 403s become `refused{code}` with copy (§3.1, §3.2). Add copy
   for `registration_closed`, `attestation_required`, `managed_by_admin`, `not_entitled`, the pack
   refusals, commerce refusals and mint failures. **S.**
4. **SP-G04. Attest and retry** (§3.10) on mint, gated delivery and commerce claim. **S.**
5. **SP-G05. Persist settings by default:** `PKeyConfigFileStore` at `user://pkey_settings.cfg`,
   opt-out through an option. **S.**
6. **SP-G06. Scenes:**
   - **New:** `PKeyDeviceList`, `PKeyAccount` (signed-in chip, sign out, deactivate),
     `PKeyPackProgress` (runtime `ensure()`/`background()`, consent and metered prompt),
     `PKeyWhatsNew`, `PKeyPurchaseButton` and restore, `PKeyChannelPicker`.
   - **Changes:** `PKeyUpdatePrompt` shows release notes and `download_progress`; key entry is
     hidden on store outlets automatically.

   **L.**

7. **SP-G07. `identity.sign_out()`** and `identity.current()` (§3.12). **S.**
8. **SP-G08. `set_channel()`:** an SDK-owned persisted channel preference that update check,
   decide and the dev menu read. **S.**
9. **SP-G09. Commerce one-calls:** `purchase(flag)` and `restore()`, `claim_play()` and
   `claim_steam()` helpers, and Play Billing in `PKeyAndroid` through the Kotlin `:android-play`
   helper once SP-K05 lands. Mac App Store StoreKit through `PKeyApple` on macOS. **M.**
10. **SP-G10. Native plugin distribution:** CI builds the xcframework, the AARs, the macOS Sparkle
    GDExtension and `pkey_win.dll`, and packages them as an optional "native" addon zip. The
    setup dock checks for them. This needs owner question Q5. **L.**
11. **SP-G11. Desktop keyring stores:** macOS Keychain through a `PKeyApple` macOS build, Windows
    DPAPI through `pkey_win.dll`, libsecret through a small GDExtension. Desktop `core.store`
    becomes full when they are present. **L.**
12. **SP-G12. Setup dock:** run `pkey mirror` and `pkey sdk --lang godot --write` (fetching
    release keys too), and add `pkey_packs/*` to the export filters automatically. **M.**
13. **SP-G13. Translations:** generate `.po` files from `copy.en.json` and `copy.fr.json`.
    **S.**
14. **SP-G14. `crash_tags()`, `portal.url()`, `distribution` model** (§3.5, §3.8, §3.14).
    **S.**
15. **SP-G15. Outlet:** a Windows MSIX package-identity reader in `pkey_win.dll`, and macOS
    `AppTransaction` through `PKeyApple`. **M.**
16. **SP-G16. Web:** document the CORS allowlist step in the setup dock. Mitigate a cleared
    IndexedDB by reusing the bearer through `license/token` on re-entry of the same key, and
    explain in the docs that a seat can be consumed. **S.**
17. **SP-G17. Sample project:** a minimal boot, gate, settings and commerce scene in `examples/`,
    until D-02 Diceroll. **M.**

### 5.7 Docs and samples (all SDKs)

- **SP-D01.** One "Integrate in 5 minutes" page per SDK, built on SP-02's generated config
  (done: `build/quickstart/`). The per-SDK service-guide tabs are deferred to SP-D04. Correction:
  no service guide has per-SDK tabs today, for any SDK; the guides hold one TypeScript, one Swift
  and one Kotlin block in total.
- **SP-D02.** One sample per primary host, in `examples/<sdk>-<host>/` and built in CI. Each
  appears in its SDK's task list above.
- **SP-D03.** Recipes: device-limit recovery, server-side licence verification, Sentry tagging,
  attestation-gated products, and store outlets (hiding key entry).
- **SP-D04.** Per-SDK tabs (Node, React, Python, Swift, Kotlin, Godot) in each service guide under
  `services/`, one snippet per SDK per guide, built on the same generated config as SP-D01.
- **Drift gates.** New docs pages go through the docs freshness gate. Sample builds join CI. They
  join the green gate only if fast.

---

## 6. Items that need a wire change (plan mode later, not implemented here)

Each one is an all-languages event: contract → catalog → corpus → SDKs. The "SDKs that follow"
column lists who must ship the client side.

| #   | Item                                                                                                                                                      | Work packages                                        | SDKs that follow                                         | Client side once it lands                                                                                 |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| W1  | `key_entry_limit` (+ `manageUrl`, `keyEntries`) and `license_owned` (+ `signInUrl`) on `/license/activate`; `POST /identity/attach`                       | I-09, I-10a, I-10b, PX-W9                            | all six + every kit                                      | two new §3.1 kinds (additive once the §3.1 fix ships), attach call, `Activation` states with QR/deep link |
| W2  | `manageUrl` on `device_limit` and portal URL in discovery                                                                                                 | PX-W8, PX-17                                         | all six + every kit                                      | overrides §3.5 built URLs; "Manage devices" button                                                        |
| W3  | Licence document v2: per-entry `expiresAt`, `licenseExpiresAt`, grants, 401 reasons, `not_entitled` reasons; `licenseId` change tolerance                 | LX-17, LX-18, LX-19                                  | all six                                                  | `entitlement(name)`, `grants()`, `licenseExpiresAt()`, `isEntitled` on expiry, badge "Trial N days"       |
| W4  | Identity layer 1: passthrough sign-in, web redirect code exchange to a device token, native redirect token route (replaces `/auth/poll`), subject/account | I-08, I-10a, I-10b, I-13, I-15, PX-W13               | all six; React web gains cross-origin sign-in            | `signIn({redirect})`, `subject()`, `openAccount()`, Custom Tabs / ASWebAuthenticationSession / loopback   |
| W5  | Identity exchange (Apple, Google, Firebase, Steam, Game Center, Play Games), BYO auth, Sign in with <Product>                                             | I-13, I-14, I-21, I-22                               | Swift, Kotlin, Godot, React, then Node/Python            | `exchange(kind, token)`                                                                                   |
| W6  | Cloud Sync: settings, saves, collections, live pokes; account override layer (doc shape unchanged)                                                        | U-01…U-25 (U-03, U-06, U-13, U-20, U-21, U-22, U-14) | all six + kits (synced badge, SaveConflict, MergePrompt) | extends §3.11 `config.set`/`setting` with sync state                                                      |
| W7  | Commerce v2: AppTransaction claim, subscriptions and dunning, restore `transferred`, redeem/gift codes, many-to-many store mappings                       | LX-11, LX-20, LX-23, LX-25                           | all with §3.9                                            | new `ClaimResult` kinds, subscription status                                                              |
| W8  | Canonical platform values for tvOS, visionOS, watchOS (or an agreed mapping to `ios`)                                                                     | new (shared-protocol + `headers.json`)               | Swift; Godot, React follow the enum                      | header values                                                                                             |
| W9  | Velopack package route drops `Authorization` on its cross-origin 302 under licensed/entitled delivery                                                     | S-11 §5.2 follow-up                                  | Godot, Node, Python, Kotlin (Velopack drivers)           | none beyond driver retry                                                                                  |
| W10 | (Optional) sign the browser-session document, if cookie mode is kept as a long-term mode beside bearer mode                                               | new                                                  | React                                                    | verify the session doc like every other doc                                                               |
| W11 | Named-user seats; per-seat features                                                                                                                       | I-24, LX-24                                          | all six                                                  | seat claims                                                                                               |
| W12 | Developer-backend APIs: entitlements admin, product-backend assertion, Cloud Sync server API                                                              | LX-13, I-25, U-16                                    | Node, Python (server clients)                            | new server-side client packages                                                                           |

**Not wire, but contracts (still planned before code):**

- PolarisBridge v4 (SP-R07 with SP-N10). It is an in-process contract between `sdk-react` and
  `sdk-node`, versioned and accepted both ways.
- SP-00's registry, transcript and corpus additions.

---

## 7. Suggested order

1. **Wave 0, now (S):** SP-G01, SP-01, then the four §0 defects: SP-N01, SP-P01, SP-S01, SP-K01,
   SP-G03 (activation) and SP-N02, SP-P02, SP-S02, SP-K02, SP-G02 and SP-R03's G11 check (`isEntitled` after revocation), each with unit tests. These need no new ids, only
   extended tests.
2. **Wave 1:** SP-00 (plan), SP-02, SP-03.
3. **Wave 2, shipped server features with no client:**
   - commerce: SP-N04, SP-P06, SP-S07, SP-K05, SP-R10, SP-G09;
   - update-health: SP-N03, SP-P03, SP-S05, SP-K03, SP-R11;
   - attest: SP-S06, SP-K04, SP-G04.
4. **Wave 3, one-call and download:** `boot()`, the boot guard, `release.fetch`, feed URLs,
   distribution and drivers.
5. **Wave 4, kits:**
   - React bearer mode (SP-R02) and components;
   - the SwiftUI kit, the Electron bridge, the CLI kits;
   - the Godot scenes and native distribution;
   - the Kotlin Gradle plugin and JVM work.
6. **Wave 5:** samples and docs. These run alongside each wave where a sample proves the wave.

---

## 8. Owner questions

1. **Q1. React bearer mode on the web.** Adopt §3.17, so React apps work on any origin and in
   Tauri? The trade-off: a device token in IndexedDB can be read by any script on the page, while
   the cookie today is HttpOnly. **Recommendation:** yes, bearer by default cross-origin, cookie
   first-party. It matches Godot web, which ships today.
2. **Q2. Python UI.** CLI kit only, or also a dependency-free Tk kit (SP-P13)? Are a Qt extra and
   Ren'Py screens in scope? Ship the `asyncio` client (SP-P05) now? **Recommendation:** CLI and Tk
   now, async now, Qt later on demand.
3. **Q3. Kotlin JVM desktop.** Commit to full desktop parity (Compose Desktop kit, keyring,
   desktop driver; SP-K12), or declare the JVM a headless or server runtime with N/As?
   **Recommendation:** full parity. The server already serves desktop updater feeds.
4. **Q4. Apple TV, Vision Pro and Apple Watch.** Add canonical platform values (W8) and support
   the platforms, or map them to `ios` and leave them undeclared?
5. **Q5. Godot native binaries.** May CI build, sign and ship the native plugins (xcframework,
   AARs, GDExtensions, `pkey_win.dll`) as an optional addon package (SP-G10)? Which signing
   identities?
6. **Q6. Portal links before PX-W8.** Is it acceptable for SDKs to build portal SPA URLs
   client-side (§3.5)? That couples them to `packages/admin/src/portal/router.ts` routes as a
   public contract. The alternative is waiting for W2.
7. **Q7. Commerce scope.** Make `commerce.receipt` required on Node and Python (Steam titles on
   Electron, Ren'Py, Pygame), reversing LX-20's planned Python `allowedNa`?
   **Recommendation:** yes. The claim is plain HTTP.
8. **Q8. Swift keychain class.** `AfterFirstUnlock` (the `KeychainStore` today) or
   `AfterFirstUnlockThisDeviceOnly` (`PolarisKeyPlatform`)? The second blocks restoring the token
   from a backup.
9. **Q9. Electron floor.** `engines.node >= 22.12` excludes Electron releases before 35. Accept
   it, or support older Electron with the WASM zstd path?
10. **Q10. Priorities outside this pass.** Do Tauri (X-02 Rust plugin) and Godot C# bindings
    (X-01) move up now that the React bearer mode and Godot parity work make both cheaper?
