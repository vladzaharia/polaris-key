# SDK and UI-kit usability (2026-10-08)

The owner asked: **"Are the SDKs good? Are they easily usable?"** The owner's direction on the same
day: the console's Integration page offers the drop-in path (the kit, with generated code) and links
to the docs for integrating directly on the library with your own UI; the docs carry both paths as
equal, clearly forked lanes per SDK.

Structured data (scores, every accepted change with its covering work package, new packages):
[`findings.json`](findings.json).

---

## 1. The answer

**Good: yes, underneath. Easily usable: not yet.**

- **The engines are good in all six SDKs.** Documents are verified offline against pinned keys,
  activation refusals are typed values with a ready "Replace a device" link, the defaults are
  secure, and every SDK has test seams (transport, store, clock). The Node and Python terminal kits
  are genuinely modern.
- **Nobody can try it.** There is no way to run against anything but a registered production
  product. All 18 trials built a backend out of the Worker's test internals or hand-wrote a stub.
- **The first documented step fails or misleads in every SDK.** The npm feed has 9 versions that
  cannot install, the Python install line resolves public PyPI, the Kotlin and Swift snippets do not
  compile, the React quickstart renders an error screen, the Node kit snippet points at production,
  and the Godot boot snippet strands the player after Retry. On Android 16 the documented Kotlin
  path cannot activate a licence at all.
- **The drop-in kits dead-end on states customers will hit** (expired, revoked, offline, sign-in),
  and **building your own UI means re-deriving the state model** in 110–410 lines of glue, because
  the logic a custom UI needs lives inside the kits.
- **Neither the console nor the docs present the choice.** The console shows a library-only
  snippet with no docs link; the docs describe a kit specification, not the shipped kits, and have
  no "your own UI" page for any SDK.

Average **5.3/10**. The fixes are small and known. Sixteen new packages (about 15–22
engineer-weeks) can start now on today's names and should bring each SDK to about 7; 8 and above
needs the 0.9 consolidation (SP-35 → SP-32b) and the must-tier kits.

## 2. Scorecard

| SDK                                   | Score   | Verdict                                                                                                          | Drop-in kit                                                                                                                           | Own UI on the library                                                                                                        | Minutes to first activation (kit / own UI / newcomer) |
| ------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| **Node** (library, terminal kit, CLI) | **6**   | Best engine and best kit; a newcomer still cannot start unaided, and the kit does not drop into a real CLI.      | **6.5.** The most polished terminal flow in the suite; registers every verb, collides with host commands, visible bugs.               | **7** for servers and CLIs, **5.5** for your own GUI: everything is reachable, nothing is shaped for a GUI.                  | 10 / 7 / 10                                           |
| **React**                             | **4.5** | A sound core under a default path that fails three times in week 0: install, trust pins, sign-in.                | **3.** Key activation works once pins are passed; sign-in cannot finish, refusals and revoked dead-end, the 2019 look.                | **6.** The stronger path, but undocumented; no sync outcome, a StrictMode bug, +77 KB gzip.                                  | 12 / 16 / 12                                          |
| **Python** (library, terminal kit)    | **6**   | A good engine; the kit does not mount, and three fail-open or leak defects need a patch release.                 | **5.** Polished and in nine locales; every mounted verb demands `--product`, offline tracebacks, the slug as product name.            | **7.** About 120 lines under PySide6; two copy systems, an untyped async client whose `is_licensed()` is a truthy coroutine. | 5 / 11 / 11                                           |
| **Swift**                             | **5.5** | An excellent core; the one-line drop-in exists but is undocumented and leaves an expired user stuck.             | **4.5.** `.polarisKey(client)` works; terminal states offer only Retry, English only, no account, device, update or settings screens. | **6.** About 250 lines of glue; no headless model outside SwiftUI, no sync reason, kit copy unreachable.                     | 32 / 31 / 11                                          |
| **Kotlin** (Android, JVM)             | **4**   | A well-designed engine; on Android the documented path cannot activate a licence.                                | **3.** The right shape (`PolarisKeyApp`); inherits the Android blockers and shows a revoked licence as valid.                         | **4.5** on Android (not main-safe, live state silent), **6.5** on the JVM once the docs are corrected.                       | 28 / 14 / 12                                          |
| **Godot**                             | **5.5** | A solid pure-GDScript core with a real headless layer; the drop-in has blockers and the docs name wrong classes. | **5.** Six lines to a gate; Retry strands the player, offline activation impossible, no gamepad focus, the Polaris mark on the gate.  | **6.** About 110 lines over static controllers; undocumented, and `sync()` reports success while offline.                    | 13.5 / 10 / 10.5                                      |

Minutes are wall-clock from start to the first successful activation, as each trial reported them.
They include standing up a backend (problem 1), which took most of the time in several trials (10–18
of Swift's minutes). The Kotlin own-UI figure is the JVM; on Android that trial needed 36 minutes
and four workarounds to reach a licensed screen.

**How this was checked.** Eighteen trials: per SDK, an engineer adopting the drop-in kit, an
engineer building their own UI on the library, and a newcomer following the public docs literally.
A lead per SDK reproduced every blocking and major finding (scratch dirs under
`/Users/vlad/Repos/pk-wt/_sdk-trials/<sdk>-lead/`) and settled disagreements; two cross reviews
covered API consistency and the UI kits in a real terminal and browser. For this report I re-ran the
npm feed closure check (read-only, `_sdk-trials/report-lead/closure2.py`: 9 broken versions today,
two more than the Node lead found) and spot-checked the code citations the ranking rests on.

## 3. The two paths, compared across SDKs

| SDK    | Drop-in today                                                                                                | Where the kit is missing or breaks                                                                                                                                                                | What the library hides from your own UI                                                                                                                                                                                                                                                                                                       | Glue the own-UI trial wrote                                    |
| ------ | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Node   | CLI: `registerPolarisCommands` (terminal kit). Electron: the bridge plus the React kit. Server: none needed. | No Electron kit (UK-06). The terminal kit mounts all 19+ verbs, throws on a host command named `config`, and drops the grouped help once the host adds a command.                                 | No JSON-serialisable state snapshot or `subscribe`; the headless views live in `/cli` with `cli.*` copy keys and CLI verbs; `bridgeState()` is `Record<string, unknown>` and the preload bridge's methods are `Promise<never>`; `lastVerifiedAt` in ms beside `graceUntil` in s; one failure in four error shapes; expiry reads "Signed out". | about 410 lines (Electron IPC)                                 |
| React  | `<PolarisKeyProvider>` + `<LicenseGate>`, plus `UpdatePrompt`, `DeviceManager`, `ConfigPanel`                | Sign-in starts a device-code flow but never shows the code; a refused key replaces the form with "Something went wrong"; revoked has no actions; no locale input.                                 | Copy helpers only in `/core`; a 503 leaves status `ok` (refresh clears errors); no activation state apart from the gate; no hook-level sign-in handle; `onConfigChange` never fires under StrictMode; the root bundle pulls in packs and zstd (+77 KB gzip and a 69 KB `.wasm`).                                                              | built on hooks; two trials hand-built a 43-member fake adapter |
| Python | CLI: `register_argparse`, click, typer (terminal kit); a Textual app                                         | Every mounted verb requires `--product` and exposes `--trust`/`--base-url`; no Qt kit (the docs name `polaris_key.ui.qt.run_gate`, which raises `ImportError`); no gate helper for host commands. | Two copy systems, the documented one English-only; `AsyncClient` is untyped (`Any`) and `is_licensed()` returns a truthy coroutine; the only view→copy-key mapping is in `terminal/screens.py`; who signed in is lost on restart.                                                                                                             | about 120 lines (PySide6)                                      |
| Swift  | `.polarisKey(client, theme:)` (undocumented) and `PolarisGate`                                               | No status, account, devices, update or settings screens; expired and revoked show only Retry; 915 keys in nine locales ship and are never read.                                                   | The only observable model is in `PolarisKeyUI` (imports SwiftUI); core copy needs the kit; `DocOutcome.error` has no reason; `identity.current()` returns the licence holder; no Sparkle custom driver.                                                                                                                                       | about 250 lines                                                |
| Kotlin | Android: `PolarisKeyApp(client) { }` (Compose)                                                               | No desktop kit (UK-10); settings editors built but never drawn; English only; device-code sign-in on phones.                                                                                      | Not main-safe on Android; no licence `StateFlow`; `licenseChanges` silent on deactivate and on revoke; `entitlements()` and `entitlementValue()` ungated; the state holders live in the Compose AAR, unusable from Compose Desktop or Views.                                                                                                  | 120–205 lines (view model)                                     |
| Godot  | `await PolarisKey.boot()` and `PKeyGateView`                                                                 | Retry strands the player on an empty scene; offline activation shows no request code; no re-gate after sign-out; no starting focus for a gamepad.                                                 | The four static controllers are undocumented; the README's copy path gives different text from the kit; `sync()` reports `ok` offline; the manual start omits `discover()`.                                                                                                                                                                   | about 110 lines                                                |

What the comparison shows:

1. **Kits are missing by host, not by SDK.** CLIs (Node, Python), web (React), SwiftUI, Compose on
   Android and Godot have one. Electron, Compose Desktop, Qt, UIKit/AppKit and Python GUIs do not;
   all are planned (UK-06, UK-10, UK-12, UK-31 recipes). Servers need none: there the library is the
   drop-in.
2. **In every SDK the kit holds logic the library should expose.** Node's headless views sit in
   `/cli`, Python's view→copy mapping in the terminal kit, Kotlin's state holders in the Compose AAR,
   Swift's only model in `PolarisKeyUI`, React's copy helpers in `/core`. A custom UI re-derives the
   state machine the kit already has.
3. **So the fix for both lanes is one move:** publish the headless layer as its own module, before
   the views, and document it as the direct path. The plan already says "headless layer first";
   this report makes it an acceptance line: UK-03 also serves a Node main process with a plain
   renderer; UK-07 ships the presentation core as a SwiftUI-free product; UK-09 ships a
   Compose-free `ui-core` artifact first; UK-12 gives every Python view its copy keys; Godot's
   controllers are documented now (SP-45b). The drop-in then becomes a skin over the same model and
   copy catalog the "integrate directly" docs describe.

## 4. Presenting the two choices: the docs and the Integration page

### 4.1 The model (owner's direction, adopted)

- **Console, Integration page (ST-41).** One generated snippet per detected host: the drop-in, with
  the product's real slug, pins, services and version. Under it, two links:
  **"Customise the screens →"** (the kit's framework page: styled parts, theming, headless) and
  **"Integrate directly with the library →"** (the SDK's own-UI page). A host without a kit
  (Compose Desktop, Qt, UIKit/AppKit, a server) shows the library start, the direct link first,
  and a recipe link. Each feature card (licensing, config, sign-in, updates) shows that feature's
  drop-in and links to the matching anchor on the own-UI page. The per-service usage blocks with
  real catalog keys and entitlement names stay in the console, since those calls are identical on
  both paths.
- **Docs.** Per SDK, the quickstart forks after the shared setup into two lanes of equal weight,
  "Drop-in screens" and "Your own UI", each reaching the same checkpoints, each continuing into its
  own page. Service guides keep the plan's per-SDK tabs and link both lanes.
- **Not adopted.** The plan's "headless tab" in the console (SP-33a): the generator still renders
  the headless and direct blocks, as compiled docs goldens, and the console links to them. A
  "hosted card" tab (UI-kit review): the hosted sign-in is a presentation option of the drop-in,
  documented in its lane. Brand values in generated snippets: HA-13 reads them from discovery and
  lands before ST-41 shows kit snippets. A live gate preview in the product's accent is worth doing
  once UK-04's elements can render fixture states; it is a later ST-41 follow-up.

**Both lanes reach the same checkpoints** (the page skeleton every SDK follows):

1. Install from the feed (strict index, registry line first).
2. Config: generated, or `pkey dev` to try it locally (SP-41).
3. First activation.
4. Each refusal: wrong key, device limit with "Replace a device", expired with renew.
5. Sign-in, showing who signed in.
6. Status and offline.
7. An update offer.
8. Tests (SP-42's test doubles).

The drop-in lane gives the line that does each; the own-UI lane gives the call, the state, and the
copy key for each.

**Where the pages live.**

- `build/quickstart/<sdk>.md`: steps 1–2 shared, then the two lanes covering 3–8 briefly.
- Drop-in depth: `build/ui/frameworks/<kit>.mdx`. Existing: `terminal-node`, `terminal-python`,
  `compose`. New now: `react`, `swiftui`, `godot`. Later: `electron` (UK-06), `qt` (UK-12).
- Own-UI depth: new `build/sdks/<sdk>/your-own-ui.md`. `build/sdks/<sdk>.mdx` becomes
  `build/sdks/<sdk>/index.mdx`, so its slug is unchanged.
- `build/ui/index.mdx`: the layer table lists shipped names with a status badge ("Ships today" or
  "Planned in UK-xx"), and gains Terminal (Node), Terminal (Python) and Electron rows.

### 4.2 Per SDK: what the console shows and what the docs need

| SDK and host        | Console drop-in snippet                                                                                                                           | "Customise the screens →"               | "Integrate directly →"                                       | Console shows the drop-in only after   |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------ | -------------------------------------- |
| Node, CLI           | `registerPolarisCommands(program, { config: polarisConfig, verbs })` and `await polarisGate(program)`                                             | `frameworks/terminal-node/#piecemeal`   | `sdks/node/your-own-ui/#cli`                                 | UK-46, UK-45, P0-48's factory fix      |
| Node, Electron      | `exposePolarisBridge(client, { ipcMain, allowSender })` in main; `<PolarisKeyProvider><LicenseGate>` in the renderer (it picks the bridge)        | `frameworks/react/` (later `electron`)  | `sdks/node/your-own-ui/#electron` (a plain renderer)         | UK-47, SP-31                           |
| Node, server        | none: the library start is the drop-in                                                                                                            | n/a                                     | `sdks/node/` (reference)                                     | P0-52                                  |
| React               | install; config with pins and version; `<PolarisKeyProvider>` + `<LicenseGate>`; per card `UpdatePrompt`, `DeviceManager`, `ConfigPanel`, sign-in | `frameworks/react/#piecemeal`           | `sdks/react/your-own-ui/` (hooks; client-core without React) | P0-47; UK-47 for products with sign-in |
| Python, CLI         | `register_argparse(sub, client=..., verbs=END_USER)` and `require_license(client)`                                                                | `frameworks/terminal-python/#piecemeal` | `sdks/python/your-own-ui/`                                   | UK-48, SP-48                           |
| Python, Qt or none  | library: `create()` and `boot()`; Qt drop-in after UK-12                                                                                          | n/a                                     | `sdks/python/your-own-ui/#qt`                                | UK-12 for a Qt drop-in                 |
| Swift               | `WindowGroup { Root().polarisKey(client, theme:) }` (`.polarisKeyGate` in 0.9); a third link "UIKit or AppKit app"                                | `frameworks/swiftui/#piecemeal`         | `sdks/swift/your-own-ui/`                                    | UK-49                                  |
| Kotlin, Android     | `PolarisKeyAndroid.client(context, …)` in `Application`; `PolarisKeyApp(client) { App() }`                                                        | `frameworks/compose/#piecemeal`         | `sdks/kotlin/your-own-ui/`                                   | SP-50, SP-51                           |
| Kotlin, desktop/JVM | library: `PolarisKeyDesktop.create(...)` (no kit until UK-10)                                                                                     | n/a                                     | `sdks/kotlin/your-own-ui/#compose-desktop` (a recipe)        | SP-50 (keyring artifact)               |
| Godot               | The generated config (imported by the dock after SP-33b, no Node); six-line `await PolarisKey.boot()`                                             | `frameworks/godot/#scenes`              | `sdks/godot/your-own-ui/` (the controllers)                  | UK-50                                  |

Until a row's precondition lands, its card shows the library start and the same two links. Kotlin
on Android is the exception that needs saying plainly: until SP-50, neither Android path works on
Android 16 without workarounds, so SP-50 is the first Kotlin package.

| SDK    | Quickstart                                                                               | Drop-in lane page                                                                                                                                         | Own-UI lane page (new)                                                                                                                                                                                | Fix now                                                                                                                        |
| ------ | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Node   | Fork by host (CLI, Electron, server), then by lane                                       | `terminal-node`: the factory spreads `polarisConfig`; `theme.product` until HA-13; `verbs`, mount and `polarisGate` once UK-46 lands                      | Electron over `exposePolarisBridge` with a plain renderer; CLI screens on `copy.activation`; the state table; testing with `InMemoryStore`, `fetchImpl`, `status(now)`                                | the factory snippet (writes go to production), the Electron `whenReady` snippet (hangs), the CLI install line                  |
| React  | "Choose your path" table: drop-in, drop-in with slots, your own UI on hooks, client-core | new `frameworks/react`: today's `LicenseGate`, `PolarisLogin`, `UpdatePrompt`, `DeviceManager`, `ConfigPanel`; spec-only names labelled "coming in UK-05" | the hook per task; a state table (loading, login, refused, signing-in, ok, grace, offline, expired, revoked, version-block) with the copy helper for each; refresh patterns; `storeStatus()`; testing | pins and version in the quickstart; delete the stale "waits on bearer mode" note; remove `useActivate()` and cookie-era claims |
| Python | Fork: CLI kit, your own UI, no UI                                                        | `terminal-python`: the `client_factory` signature, theming and copy overrides, `now`, `require_license` once UK-48 lands                                  | `ui.core` views with `Copy`; `AsyncClient` with `events.stream()` for Qt and asyncio; the thread contract; `refresh_interval_seconds`; offline                                                        | strict-index install everywhere; mark Qt "planned"; remove the false PyPI and Poetry `^0.1` lines                              |
| Swift  | Lead with the drop-in; Package.swift and Xcode tabs; no `print(result)`                  | new `frameworks/swiftui`: `.polarisKey`, then `PolarisSignIn`, `PolarisOfflineActivation`, `PolarisGate(model:)`, then `PolarisKeyModel`                  | `create()`, `events`, an `@Observable` wrapper, every `ActivationResult` case with its copy, `ManageLink`, sign-in, `decide()` with Sparkle, testing                                                  | the five README snippets that do not compile; theming's `KitPending` tab; say the kit is English-only until UK-07              |
| Kotlin | Fork by host: Android, Compose Desktop, JVM CLI                                          | `compose`: Android only, today's names, Compose cells marked planned                                                                                      | sealed `ActivationResult`, `Copy`, the licence `StateFlow` (SP-51), threading (SP-50), the Compose Desktop recipe (about 100 lines, keyring dependency)                                               | the quickstart (6 compile errors, Android crash), version 0.1.0 → current, the console's Kotlin snippet                        |
| Godot  | Three-way choice: drop-in, scenes, controllers; the feed link                            | new `frameworks/godot`: the classes that ship (`PKeyGateView`, `PKeyActivationPanel`) in three layers                                                     | the four controllers, a status → screen → copy-key table, the signals, a manual start with `discover()`, `sync()` with `classify()`                                                                   | the layer table's `PKeyGate`/`PKeyActivate.tscn` names; the boot snippet after UK-50; the README privacy sentence              |

### 4.3 Which work packages take it

| Package                                            | Change                                                                                                                                                                                                                                                                                                                             |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P0-47** (edit)                                   | Now, in today's TrustPanel quick start: the two links per SDK (through `DOCS_LINKS`, so the drift test guards them), React pins plus `LicenseGate` plus a declared version, and the Kotlin snippet on `PolarisKeyAndroid.client`.                                                                                                  |
| **SP-45a / SP-45b** (new)                          | Now: the lane skeleton, the new framework and own-UI pages, the fixes in the table above, status badges, and one compiled-snippet lane for every README and docs page.                                                                                                                                                             |
| **SP-33a** (edit)                                  | `sdkFit` gains host types (Node: CLI, Electron, server; Kotlin: Android, desktop; Python: CLI, Qt, none). The console start is the drop-in only; the headless and direct blocks render as docs goldens; each block carries its docs link target. Strict-index `renderFeedSetup`; a warning when Update is on without release keys. |
| **ST-41** (edit)                                   | Renders 4.1: one snippet, two links, the preconditions in 4.2 (a host whose drop-in is not ready shows the library start).                                                                                                                                                                                                         |
| **SP-33b** (edit)                                  | `gen:integration` writes both lanes' snippets into the SP-45 skeleton (no new page structure).                                                                                                                                                                                                                                     |
| **SP-37** (edit)                                   | "One start path" forks into the two lanes; trimming `build/sdks/*` to reference keeps each `your-own-ui` page.                                                                                                                                                                                                                     |
| **UK-05, UK-06, UK-07, UK-09/UK-10, UK-11, UK-12** | Replace SP-45's interim framework pages in place with the rebuilt kits' pages.                                                                                                                                                                                                                                                     |
| **ST-29** (edit, owner decision)                   | The links work only if the integrator can open the docs: today `/docs` needs a platform-admin session, and ST-29 keeps it at Superadmin and Platform admin. See §12.                                                                                                                                                               |

## 5. Top problems across all SDKs, ranked

**1. Nobody can try Polaris Key without the hosted service.**
_Evidence:_ every one of the 18 trials and both cross reviews built a backend from Worker test
internals (`dispatchWith`, `makeTestDb`, `KvMock`, `seed.ts`) or hand-wrote a 200–360-line stub; two
stubs invented a `license_expired` answer the real Worker never sends. No integrator page covers a
local run; `products/gen-seed.ts` says "not a live onboarding path"; quickstart step 1 needs a
registered production product. The expired, device-limit, revoked and update screens cannot be
produced on demand.
_Fix:_ `pkey dev` (SP-41): the real Worker router in-process with a seeded example product, test
keys for each state and control switches; test doubles on the real client (SP-42). The harness the
trials built took 3–6 minutes, so this is cheap.

**2. The first documented step or snippet fails in every SDK.**
_Evidence:_

- npm: 9 published versions pin a sibling that was never published (verified today:
  `node@0.8.28`, `cli@0.8.28`, `client-core@0.8.28` → `jws@0.8.28`; `react`, `cli`, `client-core`,
  `manifest`, `catalog` and `jws` `@0.8.29` → `protocol@0.8.29`). pnpm's one-day age gate lands on
  them whenever they are the newest eligible version. Cause: `publish-sdks.yml:124-131`, legs stuck
  in `waiting` and `fail-fast: false` letting dependents publish.
- Python: `uv add "polaris-key[keyring]"` resolves the unclaimed public PyPI name (404 today, so
  it fails; squattable tomorrow).
- Kotlin: the quickstart has 6 compile errors, its version 0.1.0 is a 404, and on Android its
  `create()` throws.
- Swift: 5 README snippets do not compile, and the quickstart prints the device token.
- React: the quickstart without trust pins renders the error screen.
- Node: the documented kit factory points the client at production; the Electron snippet hangs.
- Godot: the boot snippet leaves the player on an empty scene after Retry.

_Fix:_ P0-52 (feed coherence), P0-48 amended with these safety fixes, UK-50 for Godot's boot, and
SP-45a/b's compiled-snippet lane so a README or docs block that does not compile fails CI.

**3. On Android, the documented Kotlin path cannot activate a licence.**
_Evidence (reproduced on emulators):_ on API 36 the default Ed25519 backend resolves to
AndroidKeyStore and rejects every valid signature, including the RFC 8032 test vector; suspend calls
throw `NetworkOnMainThreadException` when a response spans TCP segments (always, on a real
network); `PolarisKeyAndroid.client()` is never started, so the device header is empty; the
documented artifact set fails AAR metadata checks; R8 fails on `java.lang.management`.
_Fix:_ SP-50 before anything else in Kotlin.

**4. Fail-open and credential-leak defaults.**
_Evidence:_ the device token prints from `print(result)`, `repr` or `console.log` in Node, Python
and Swift (Swift's quickstart does it); a typo in Python's `expected_services` (`'licence'`) makes
`is_licensed()` true for a device never activated; Python's async `is_licensed()` is a truthy
coroutine; Kotlin keeps a revoked or deactivated device licensed in the gate and in
`entitlements()`, and `entitlementValue()` ignores the gate; the Node kit's `secret` and `mint` verbs
print values in a product's end-user CLI; `login` silently swaps a paid key licence for the
account's free one (Node kit, Swift).
_Fix:_ SP-46, SP-48, SP-51, UK-45, UK-46, UK-49 now; SP-35 records gating semantics with a corpus
case; I-10a/b make confirm-and-attach the default.

**5. The drop-in kits dead-end on states customers will hit.**
_Evidence:_ React sign-in never shows the code and a refused key loses the form; Swift's expired and
revoked screens offer only Retry, across relaunches; Godot's Retry strands the player, offline
activation shows no code, a signed-out player is stuck; Kotlin's gate keeps a revoked licence and
retries the token route into a 429; Node's `update apply` ends "Not available here" and `login`
refuses before discovery; Python's mounted verbs exit 2 and offline verbs print tracebacks.
_Fix:_ UK-45 to UK-50 now. The rebuilds are 5 to 16 weeks out (UK-05 sits at the end of the
plan's longest chain), and the plan's kit rule 3 allows correctness fixes to the old components.

**6. Expired, disabled and replaced devices read as a wrong key or "Signed out", in all six.**
_Evidence:_ the Worker answers 401 `unauthorized` for every unusable licence (`authz.ts:381-382`;
`activate-refusals.json:123` records it), and every SDK maps a sync 401 to revoked.
`ActivationResult` kinds for expired and disabled can never occur. A paying customer whose licence
lapsed is told to retype the key.
_Fix:_ LX-18 gives a reason to a key that matched and to an authenticated device token (unknown keys
keep the single anti-enumeration 401); LX-19 maps it; interim neutral copy with a renew or manage
link in each fix package.

**7. Building your own UI means re-deriving the state model.**
_Evidence:_ 110–410 lines of glue per trial (§3). Sync failure looks like success (React clears
errors on refresh, Godot reports `ok`, Python, Swift and Kotlin give no reason); licence events
differ by SDK and even by entry point (Kotlin never emits on deactivate or revoke; Python and Swift
emit only from the root client); copy is unreachable or unlocalised outside the kit.
_Fix:_ the headless layer published first (§3); SP-43 sync outcomes; SP-35 event triggers; SP-39
one copy pipeline; SP-45a/b own-UI pages.

**8. The docs and the console do not present the choice, and the docs describe a spec.**
_Evidence:_ the console snippet (`sdkQuickStart.ts`) is library-only with no docs link, and its
Kotlin snippet crashes on Android. `build/ui/index.mdx` names `<PolarisKeyGate>`, `.polarisKeyGate`,
`PolarisKeyGate(client)`, `PKeyGate` and `run_gate`, none of which ship; there is no React, SwiftUI
or Godot framework page and no own-UI page for any SDK; the Node and Python quickstarts never mention
their kits. `/docs` requires a platform-admin session.
_Fix:_ §4.

**9. The product is not the hero.**
_Evidence:_ no SDK client reads `core.presentation` yet (HA-13 is todo). The kits show the slug
("acme", "tidewater"), "Welcome to this app", or the Polaris mark (Godot, React's brand look,
Compose); the hosted device-code page shows the Polaris Key logo and "Product: tidewater".
_Fix:_ HA-13 and HA-14 before ST-41 shows kit snippets; I-08's acceptance covers the device-code
page; interim bundle-name defaults (UK-48, UK-49).

**10. One concept, several behaviours.**
_Evidence:_ `lastVerifiedAt` is milliseconds in Node, React, Python, Swift and Kotlin while
client-core documents seconds (Node's devices screen: "last seen in 20,713,544 days");
`identity.current()` returns the licence holder in Python, Swift, Godot and React ("Signed in as
Ada" after a key); `network` vs `network-error`, and 5xx mapped to `not_found` in four SDKs' update
clients; `boot()` keyless-enrols in Node only; Swift's `expiresAt` is the document's expiry.
_Fix:_ SP-35 widened to record result shapes, units, semantics and error codes, not only names
(§8); the consumer bugs fixed now in the fix packages.

## 6. What is genuinely good

- **Offline-first licensing that holds up.** `create()` makes no network call where services are
  pinned; gate, entitlements and enforced config answer from the verified cache with the network
  down; grace and expiry advance locally; revocation turns `isEntitled` false. Even Kotlin's broken
  Android 16 path refused documents rather than trusting them.
- **Typed refusals.** `ActivationResult` is a discriminated union or sealed type in five SDKs, with
  `limit`, `deviceCount` and a validated `manageUrl` on device-limit. "Replace a device" is one line.
- **Secure by default.** HTTPS only except loopback; pinned trust keys; `pkey sdk` prints every
  pin's fingerprint and refuses release keys the server does not advertise; sign-in prompts and
  minted tokens redact themselves.
- **The terminal kits.** Node's is the most polished drop-in in the suite (clack-style rail, masked
  key entry with a live verdict, a seat meter with a portal hand-off, versioned `--json`, documented
  exit codes, `NO_COLOR`/`TERM=dumb`/`--ascii`, nine locales). Python's is close behind.
- **Testable seams.** `fetchImpl`, `PolarisTransport`, httpx `MockTransport`, `InMemoryStore`,
  injectable clocks: three trials faked offline, expiry and refusals without patching globals.
- **Platform fit.** Swift is Swift 6 strict-concurrency clean with one `AsyncStream` of events;
  Godot is pure GDScript with coroutines, signals and Ed25519 on the worker pool; Kotlin has
  explicit API mode with KDoc and Java-friendly futures; Python's `AsyncClient` ran unchanged under
  `QtAsyncio`.
- **Updates.** Godot's and Swift's outlet-aware decisions verify the signed feed and record, and a
  store build is never pushed to self-update.
- **Feeds.** One scoped `.npmrc` line or `exclusiveContent` block, anonymous, 0.5–5 s installs, and
  scope routing that blocks dependency confusion.
- **Copy.** The core sentences (`describeError`, `copy.activation`, `Copy.forStatus`) are
  product-quality and never leak server text; the kit catalog already holds the hand-off,
  device-limit and eight-locale strings the fixes need.
- **The Worker's own test helpers.** Clean enough that every trial stood up the real router in
  minutes: strong evidence that `pkey dev` is cheap.

## 7. Per SDK

Severity: **B** blocking, **M** major, **m** minor. "Now" packages ship on today's names in 0.8.x;
renames wait for SP-35's 0.9 pass.

### 7.1 Node (`@polaris-key/node` 0.8.33, terminal kit, `pkey` CLI)

| Accepted change                                                                                                                                                                                                                | Sev | Covered by                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --- | --------------------------------------------- |
| Repair the npm feed; publish lockstep legs in dependency order and only when every dependency succeeded; read the feed back after each publish; document pnpm's `minimumReleaseAge`.                                           | B   | P0-52                                         |
| `pkey dev`: a local Polaris Key with a seeded product, test keys per state, a fake IdP, a signed release, control commands.                                                                                                    | B   | SP-41                                         |
| Present the two paths: `sdkFit` by host (CLI → terminal kit, Electron → bridge plus React kit, server → library); console drop-in plus docs links; generated lanes; terminal and Electron rows in the layer table.             | M   | SP-33a, ST-41, SP-33b, SP-45a, SP-37          |
| The kit's one-line flow uses the generated config: fix the snippet now (`{ ...polarisConfig, version }`); adapters accept `config`; one name for pins (`trust.pinnedKeys`).                                                    | M   | P0-48, UK-46, SP-32a, SP-35                   |
| The terminal kit drops into an existing CLI: `verbs` allow-list, a documented `mount`, clear collision errors, grouped help with the host's commands first, `polarisGate()` and `withLicense()`, yargs on its own subpath.     | M   | UK-46                                         |
| Kit bugs: "last seen in 20,713,544 days", "pro license ·", login without "Signed in as", `update apply` dead end, vendor-first strings, two spellings of licence, contradictory help.                                          | M   | UK-45                                         |
| `login` on a device holding a key licence confirms before attaching (the SDK already supports `waitForSignIn({confirm})`).                                                                                                     | M   | UK-45; I-10a, UK-43                           |
| Tell expired or disabled apart from a wrong key or sign-out; interim copy covers both; `core.gate.revoked` not titled "Signed out" for key-only devices.                                                                       | M   | LX-18, LX-19; UK-45; SP-39                    |
| One time unit: fix the kit's consumer and client-core's comment now; epoch seconds everywhere in 0.9, recorded in `api.json`.                                                                                                  | M   | UK-45; SP-35                                  |
| One error taxonomy: every fetch wrapped, one network code, 5xx → server, 429 → `rate_limited` with `retryAfterSeconds`, only a real 404 → `not_found`; keep the server's message; refuse sign-in locally when identity is off. | M   | SP-46; SP-35 (spelling); SP-43 (sync reasons) |
| Redact the token in `ActivationResult` (`inspect`, `toJSON`) now; drop it from the public result in 0.9.                                                                                                                       | M   | SP-46; SP-35                                  |
| A GUI-shaped headless layer: serialisable `snapshot()`/`subscribe()`, views returning `{key, args}`, typed bridge state from `/electron`, an own-UI-in-Electron page, an `identity` event kind.                                | M   | UK-03, SP-31, UK-06, I-10a; SP-45a (page)     |
| Electron snippet: `app.whenReady().then(...)`; launch the Electron example in CI.                                                                                                                                              | M   | P0-48; SP-36; UK-06                           |
| Examples installable: stamp real versions over `^0.0.0` now; the CI-built tree later.                                                                                                                                          | M   | P0-48; SP-36                                  |
| CLI onboarding: an install line in the quickstart; `pkey sdk` names a missing `--product`; `pkey --version`; bump smol-toml; never document a bare `npx pkey`.                                                                 | M   | P0-48; SP-33a; owner step (§12)               |
| Read the product's presentation in the client; until then the docs say a real client needs `theme.product`.                                                                                                                    | M   | HA-13; SP-45a                                 |
| README points to `copy.activation(kind)` for refusals; one copy source later.                                                                                                                                                  | m   | SP-45a; SP-39; UK-03                          |
| README reference gaps: `fetchImpl`, `deviceName` (and `''`), a testing section, keychain scope, sync on focus.                                                                                                                 | m   | SP-45a; SP-37                                 |
| `install-from-feeds.md`: stale versions, the `beta` wording, the pnpm age gate.                                                                                                                                                | m   | P0-52; SP-33a                                 |
| Library ergonomics: a local key-shape check, `appcastUrl()` fails clearly before discovery, `boot()` skips enrolment when the product offers none.                                                                             | m   | I-10a; SP-32a; SP-35                          |
| Skip the OSC 11 probe when `PKEY_THEME` or `COLORFGBG` decides.                                                                                                                                                                | m   | UK-45                                         |
| Investigate the same-second config drop; surface it as `stale`; strictly increasing issue time on the Worker.                                                                                                                  | m   | SP-43                                         |

| Declined                                                     | Why                                                                                                                                                                   |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pkey sdk` writes the product's name and accent into config. | A second, stale copy of the brand; HA-13 reads it from verified discovery.                                                                                            |
| Scope the keychain entry by `configDir`.                     | Keychain items are per user and per app by convention; re-keying orphans every token. (Non-default hosts are namespaced by SP-41, which leaves production untouched.) |
| Remove the dead `license-expired`/`license-disabled` kinds.  | LX-18 makes them live; removing and re-adding is two breaking changes.                                                                                                |
| A fake client in `@polaris-key/node/testing`.                | A second client per SDK, drifting. SP-42's doubles drive the real client over a scripted transport instead.                                                           |
| The kit runs `npm i -g` or `brew upgrade` itself.            | CLI convention (gh, npm, rustup) prints the command; UK-45 prints it.                                                                                                 |
| A push channel for config changes.                           | New server infrastructure for what an hourly refresh plus sync on focus already meets.                                                                                |
| A `sync` event kind (started, finished, offline).            | Partly overruled: SP-43 adds sync status as state and one `sync` event fired only when that status changes, not per pass.                                             |
| Reasons for unknown, malformed or other-product keys.        | The single 401 is the anti-enumeration posture; only matched keys and authenticated tokens get a reason (LX-18).                                                      |
| The drop-in as the only in-app path for every Node host.     | A server has no screens; `sdkFit` routes servers to the library.                                                                                                      |
| Default the verb set to the services discovered at runtime.  | Verbs register before any network call; UK-46 uses `expectedServices` plus an allow-list.                                                                             |
| A non-hostname default device label.                         | The hostname is the wire contract's default (§12.7.1) with an opt-out; document it.                                                                                   |

### 7.2 React (`@polaris-key/react` 0.8.33 over client-core)

| Accepted change                                                                                                                                                                         | Sev | Covered by                                                           |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | -------------------------------------------------------------------- |
| Drop-in sign-in in bearer mode shows the device-code hand-off (code, open, copy, QR, expiry, cancel); every rejection shown in the card; sign-in hidden unless configured.              | B   | UK-47; UK-05; I-10a                                                  |
| Quickstart, generated config and console snippet carry trust pins, a declared version and `<LicenseGate>`; a missing-pins error logs for developers and shows end users neutral copy.   | B   | P0-47 (edit), P0-48 (edit: audit quick win 2), SP-32a, SP-33b; UK-47 |
| Every published `@polaris-key` set installs; yank the incoherent sets; document the age gates.                                                                                          | B   | P0-52                                                                |
| Activation refusals stay on the sign-in screen with the typed key, the custom slot and "Replace a device"; a background refresh never clears a refusal.                                 | M   | UK-47; UK-03; UK-05                                                  |
| Revoked gets a way out (use a different key, sign in, retry); repeated 401s back off; distinct reasons on the wire.                                                                     | M   | UK-47; LX-18, LX-19; UK-05                                           |
| The Provider's adapter lifecycle is StrictMode-safe.                                                                                                                                    | M   | UK-47                                                                |
| A failed sync is visible: `refresh()` reports the outcome; hooks expose the last sync.                                                                                                  | M   | SP-43 (names via SP-35)                                              |
| The update check is honest and shared: typed codes, never "up to date" after a failure, one check behind both components, release pins as a Provider prop.                              | M   | UK-47; SP-32a; P2-12; SP-15                                          |
| The product is the hero: verified presentation as the default identity.                                                                                                                 | M   | HA-13; UK-03, UK-05                                                  |
| Localise the kit (eight launch locales); stop-gap: hard-coded strings into `theme.copy`.                                                                                                | M   | SP-39, UK-05; UK-47                                                  |
| Present the paths: drop-in only in the console, links to the own-UI page; "Choose your path"; a React own-UI page; a React framework page naming today's components.                    | M   | P0-47, SP-45a, SP-33a, ST-41, SP-37; UK-05, UK-31                    |
| Own-UI gaps: copy helpers exported from the root now; a gate-aware entitlement-value hook, activation on the licence hook and a sign-in handle in 0.9; remove raw `state.entitlements`. | M   | UK-47 (root export); SP-35, I-10a, SP-39                             |
| Local development and testing without production: a test adapter and `pkey dev`.                                                                                                        | M   | SP-41, SP-42                                                         |
| Bundle diet: packs, zstd and hash-wasm only through dynamic import; a size budget in CI.                                                                                                | M   | SP-47                                                                |
| Types and units: `React.JSX.Element`, a React 18 and 19 consumer typecheck with `skipLibCheck: false`, `lastVerifiedAt` in seconds, one code spelling.                                  | m   | UK-47; SP-35                                                         |
| Cut the chatter: one discovery fetch per load; device reports on load or change only.                                                                                                   | m   | UK-47                                                                |
| `ConfigPanel` and `DeviceManager` polish.                                                                                                                                               | m   | UK-05                                                                |
| `pkey sdk` friction: name the missing flag, default to `src/`, accept advertised release keys with fingerprints shown.                                                                  | m   | SP-33a, SP-32a; P0-48                                                |
| Keep the signed-in identity apart from the licence holder.                                                                                                                              | m   | I-10a, SP-35                                                         |
| Remove the README's cookie-era claims.                                                                                                                                                  | m   | SP-45a; SP-37                                                        |

| Declined                                                            | Why                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pkey dev` must not ship the real Worker (a replay server instead). | **Overruled.** Refusals must match production (two trial stubs invented an answer the Worker never sends); a replay server needs state for revoke and config changes, which makes it a second server; the repository is public under MIT. Dev-only routes are kept out of production bundles by a build test (SP-41). |
| Never name Polaris Key on product buttons.                          | Only `branding="polaris-key"` says it, and that account really is a Polaris Key account. The default uses `{product}`.                                                                                                                                                                                                |
| Rename "Sign out" or add a confirmation.                            | Freeing the seat is the safe default; "Sign out" is the platform convention.                                                                                                                                                                                                                                          |
| Stop polling while revoked.                                         | Revocation is reversible; back off instead.                                                                                                                                                                                                                                                                           |
| Call `navigator.storage.persist()` by default.                      | Firefox prompts; document `storeStatus()`.                                                                                                                                                                                                                                                                            |
| `useConfigChange(key, cb)`.                                         | `useConfigSetting` re-renders; derive from state. The real defect is the StrictMode bug.                                                                                                                                                                                                                              |
| An `expectedServices` alias (audit quick win 7).                    | The owner ruled removal, not aliases.                                                                                                                                                                                                                                                                                 |
| Re-point the `beta` dist-tag.                                       | Beta includes stable by rule; the docs wording is wrong, fixed in P0-52.                                                                                                                                                                                                                                              |
| Slow down `latest`.                                                 | The failure is incoherent sets, not cadence.                                                                                                                                                                                                                                                                          |
| Refresh on focus by default.                                        | Polling stays off by default for integrations in production; document the pattern.                                                                                                                                                                                                                                    |
| Split the cookie and bearer transports.                             | SP-40 removes cookie mode in 0.9.                                                                                                                                                                                                                                                                                     |
| Rename raw `state.entitlements`.                                    | 0.9 removes it.                                                                                                                                                                                                                                                                                                       |
| A headless tab in the console start.                                | The owner's shape: one snippet and links; the blocks become docs goldens.                                                                                                                                                                                                                                             |

### 7.3 Python (`polaris-key` 0.8.33, terminal kit, `ui.core`)

| Accepted change                                                                                                                                                                                                                        | Sev | Covered by                                  |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | ------------------------------------------- |
| Mount contract: the adapters take the client binding (`client=` or `config=`, `version=`) and hide `--product`, `--trust`, `--base-url`, `--service`, `--config-dir`; `verbs=` with an end-user default; per-verb help; samples fixed. | B   | UK-48; SP-35 (names)                        |
| Strict-index install snippets everywhere; remove the false PyPI claims; Poetry constraint from the feed; keyring on desktops.                                                                                                          | B   | P0-48 (now); SP-33a; SP-37                  |
| Map transport and server errors once (`network-error`, `server-error`); `update.check` and `release` stop collapsing to `not_found`; verbs never re-raise; an offline golden per verb.                                                 | M   | SP-48; SP-35 (errors section)               |
| Validate `expected_services` in `create()`: an unknown slug raises.                                                                                                                                                                    | M   | SP-48; SP-32a fixtures                      |
| Hide credentials from reprs (`ActivationOk`, `RegisterOk`, `Reacquired`).                                                                                                                                                              | M   | SP-48                                       |
| Async client safe: now, gate coroutines refuse truthiness (a wrapper whose `__bool__` raises); in 0.9, cache-only reads synchronous and typed facets.                                                                                  | M   | SP-48 (guard); SP-49                        |
| `Literal` discriminators, generic `get_config`, typed `create()` keywords, a client `Protocol`, snake_case fields with one time unit in 0.9.                                                                                           | M   | SP-49; SP-35                                |
| Brand the kit from discovery; prove the samples on recorded transcripts.                                                                                                                                                               | M   | HA-13, UK-41, SP-36                         |
| Expired distinct from a wrong key or a revoke; renew copy and action.                                                                                                                                                                  | M   | LX-18, LX-19 (acceptance line)              |
| Persist who signed in; the kit's signed-in state comes only from identity.                                                                                                                                                             | M   | I-10a (acceptance: survives a restart)      |
| Updates for pip, pipx and uv-tool installs: positive detection, an instructions update method, the available screen without signed decisions, warnings when Update is on without release keys.                                         | M   | SP-44; P2-12; UK-48; SP-32a; SP-33a         |
| A local backend.                                                                                                                                                                                                                       | M   | SP-41                                       |
| Console and docs lead with the drop-in per host and link to the direct paths.                                                                                                                                                          | M   | SP-33a, ST-41, SP-37, SP-33b, SP-45a; UK-12 |
| One copy table: `polaris_key.copy` reads the localised kit tables.                                                                                                                                                                     | M   | SP-39                                       |
| Complete the headless layer: every `ui.core` view carries its copy keys and actions; mark `run_gate`/`ActivateViewModel` as planned in the docs now.                                                                                   | M   | UK-02b, UK-12; SP-45a                       |
| Run every sample's advertised commands in CI; fix `mytool.py` now.                                                                                                                                                                     | M   | SP-36 (acceptance); UK-48                   |
| Docs corrections (`user_entered_key`, `--product`, key format, `register()`/`deactivate()` out of the happy path, `config.set` claim, `client_factory` signature, theming, `refresh_interval_seconds`, the thread contract).           | M   | SP-45a; SP-37                               |
| Kit copy and output contract: revoked hint, "code chosen" vs "no browser", `<Product> sign-in`, kebab-case `--json` enums, locale dates, no private attributes.                                                                        | m   | UK-48                                       |
| `require_license()` and `require_entitlement()` for host commands; wire or remove the Textual Updates pane.                                                                                                                            | m   | UK-48                                       |
| Log listener exceptions; a reason on `SyncResult`; an offline signal.                                                                                                                                                                  | m   | SP-48 (logging); SP-43                      |
| Validate `config.set` against the cached catalog.                                                                                                                                                                                      | m   | U-06; SP-45a (README)                       |
| The server's message in device sign-in errors; `doctor()` explains an identity product without working sign-in.                                                                                                                        | m   | SP-48; SP-32a                               |
| Namespace keyring item and state directory by host for non-default base URLs (production unchanged).                                                                                                                                   | m   | SP-41 (all SDKs); SP-32a                    |
| `polaris_key.testing`: scenario presets over a mock control plane that signs with a throwaway key.                                                                                                                                     | m   | SP-42                                       |
| Version from `importlib.metadata` in `from_config()`.                                                                                                                                                                                  | m   | SP-32a (amends audit §5.1)                  |
| Lazy sub-package imports (95 modules, 140–245 ms on every CLI start).                                                                                                                                                                  | m   | SP-48                                       |

| Declined                                                    | Why                                                                                                                                      |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| A placeholder `polaris-key` on public PyPI.                 | Owner decision 3 (feeds only, no placeholders); strict-index snippets are the chosen defence. Residual risk goes back as a re-ask (§12). |
| `pkey sdk` writes name and accent into `polaris_config.py`. | A second presentation path; HA-13; SP-32a deletes the file.                                                                              |
| Refuse Identity without an OIDC block on the Worker.        | Track F retires the per-product OIDC engine.                                                                                             |
| A Python-native config generator.                           | One generator; the console's `polaris-key.json` download removes the Node step.                                                          |
| Split fonts and Qt assets into another distribution.        | A second lockstep distribution to save 556 KB of 5.6 MB.                                                                                 |
| Localise argparse help now.                                 | Waits for catalog keys (UK-02a); end-user screens are already localised.                                                                 |
| A Paywall screen in the terminal kit.                       | Purchases happen in the portal or store (UK-13).                                                                                         |
| Expand the Textual app.                                     | Optional, outside the must tier; only dead affordances are fixed.                                                                        |
| Default the outlet to `direct`.                             | An undetected store install would self-update against store policy; SP-44 detects package managers positively.                           |
| `boot()` starts a background refresh thread by default.     | A hidden thread is unsafe for GUI hosts; document the thread contract.                                                                   |
| A new `malformed` activation kind.                          | A six-SDK API change; only an empty key is refused locally.                                                                              |
| An `environment` option.                                    | Host namespacing covers it with no new option.                                                                                           |
| Settle `supports('ui.kit')` now.                            | UK-02b redefines the `ui.*` rows once for every SDK.                                                                                     |

### 7.4 Swift (`PolarisKey`, `PolarisKeyUI`, `PolarisKeyUpdate` 0.8.33)

| Accepted change                                                                                                                                                                           | Sev | Covered by                              |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | --------------------------------------- |
| Every blocking gate state gets a way out: "Use a different key", Sign in, Renew or Manage, Update, a host action; copy matches the controls.                                              | B   | UK-49; UK-07, UK-02b                    |
| A local sandbox for integrators.                                                                                                                                                          | B   | SP-41                                   |
| Document the drop-in that ships: a SwiftUI framework page led by `.polarisKey`; replace the README's `PolarisGateModel(license:)` recipe; theming tab.                                    | M   | SP-45b; UK-07, SP-37                    |
| In the console, the SwiftUI drop-in as the only start snippet for iOS and macOS, with "Your own UI", "UIKit or AppKit app" and "Full API" links.                                          | M   | SP-33a, ST-41, SP-37, SP-45b            |
| The one-line drop-in matches the old gate: device-limit "Replace a device", `GateOptions` (key entry, offline activation off on iOS, free tier, return URL); one model and view in UK-07. | M   | UK-49; UK-07; SP-35                     |
| Redact the device token in `ActivationResult` (description, debug, reflection); the quickstart switches on the result.                                                                    | M   | UK-49; P0-48; SP-33a/b                  |
| Fix the 5 README snippets; `platforms:` and `from:` in the install snippet; compile every Swift block in CI; labelled accessors on `UpdateDecision`.                                      | M   | UK-49; SP-45b (lane); SP-36; SP-35      |
| Expired and disabled apart from a wrong key; interim neutral copy with Manage.                                                                                                            | M   | LX-18, LX-19; UK-49                     |
| Localise the kit; core copy reachable from `PolarisKeyCore`; the docs say English-only until then.                                                                                        | M   | UK-07; SP-39 (amend); SP-45b            |
| The accent override goes through the contrast resolver (white on `#FF6A3D` is 2.85:1 today).                                                                                              | M   | UK-49; UK-07                            |
| Form errors reachable: Return submits, VoiceOver announces the refusal, focus moves to it.                                                                                                | M   | UK-49; UK-07                            |
| The product is the hero: bundle display name by default now; presentation, then bundle, then monogram in UK-07; the Polaris look in the product's accent with a `native` preset.          | M   | UK-49; HA-13, UK-07                     |
| Missing must-tier screens: status, account and licence, update prompt, devices, settings, paywall.                                                                                        | M   | UK-07, UK-08 (UK-25 revived with LX-23) |
| One start call: fix the `init(options:)` comment now; `init(options:)` not public in 0.9; a gate that owns boot and never flashes the activation card.                                    | M   | P0-48; SP-35, SP-32b, UK-07; UK-49      |
| The presentation core ships as its own SwiftUI-free product with public preview states.                                                                                                   | M   | UK-07 (amend)                           |
| Sync observable: reasons on errors, identical bytes as unchanged, strictly increasing issue time, a sync status.                                                                          | M   | SP-43                                   |
| The update check never fails silently: no `try?` in `client.update`, `configureUpdate` documented, outlet settable in config and reported by `doctor()`.                                  | M   | UK-49; SP-32a/b                         |
| `StoreError` explains itself (`-34018`: missing keychain entitlement).                                                                                                                    | M   | UK-49; SP-32b                           |
| Xcode installation documented (`--global`, then Add Package Dependencies).                                                                                                                | M   | SP-45b; SP-33a                          |
| Sign-in shows who signed in before closing; phone-appropriate sign-in in UK-07.                                                                                                           | M   | UK-49; UK-07, I-15, I-10b               |
| A custom update UI on Sparkle: an injectable user driver.                                                                                                                                 | M   | UK-08 (amend); UK-49 (README)           |
| Never silently swap a paid key licence on sign-in.                                                                                                                                        | M   | I-10b, UK-43                            |
| Field meanings and units: `documentExpiresAt` vs `licenseExpiresAt`, one time unit, `identity` only for a real sign-in.                                                                   | m   | SP-35, LX-18, LX-19, I-10b              |
| Typed sign-in failures.                                                                                                                                                                   | m   | I-10b, SP-35                            |
| The `ASWebAuthenticationSession` isolation violation.                                                                                                                                     | m   | UK-49                                   |
| CLI and quickstart traps: `--product`, `pkey --version`, the no-Node CLI path.                                                                                                            | m   | P0-48, SP-33a, SP-45b                   |
| Previews and tests without hand-signed documents: a `PolarisKeyTesting` product.                                                                                                          | m   | SP-42; UK-07                            |
| Policy stamps apart from entitlement events; `syncOnForeground()` in the headless quickstart.                                                                                             | m   | SP-35, SP-33a                           |
| Retire or fix the legacy `UpdateClient.check()`.                                                                                                                                          | m   | SP-35                                   |
| Update not-configured copy is not licensing copy.                                                                                                                                         | m   | SP-39; UK-49                            |
| Package footprint: 8.3 MB of tests in the archive, duplicate fonts, packs linked for `decide()`, zstd cloned at resolve.                                                                  | m   | SP-52                                   |
| `doctor()` reports a credential issued for another origin.                                                                                                                                | m   | SP-32b; SP-41                           |
| `JSONValue` reads cleanly in logs.                                                                                                                                                        | m   | UK-49                                   |
| Slim the README to install, start and links.                                                                                                                                              | m   | SP-37                                   |

| Declined                                                             | Why                                                                                                       |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Fonts into an optional branding product.                             | The Polaris look is the default (owner, 2026-10-04); SP-52 removes the duplicates.                        |
| Namespace every store key by base URL, or move the macOS config dir. | Partly overruled: only non-default hosts are namespaced (SP-41), so no production activation is orphaned. |
| `pkey sdk --name`.                                                   | The per-language modules are replaced by `polaris-key.json`.                                              |
| Client-side key validation in the SDK.                               | The kit already guards it; a new result kind is a six-SDK change.                                         |
| Restyle the current gate now.                                        | Kit rule 3: correctness only on old components; UK-07 replaces the screen.                                |
| Make the internal preview surfaces public.                           | API that 0.9 removes; UK-07's preview states and SP-42 cover it.                                          |
| Sub-second `issuedAt` or a sequence number.                          | A signed-shape change across six SDKs; SP-43 fixes the failure without one.                               |
| Keep the 401 for expired keys, soften copy only.                     | The key already matched; LX-18's reason leaks nothing.                                                    |
| A separate package for Swift headless models now.                    | Would build the state machines twice; UK-07 builds the presentation core first.                           |

### 7.5 Kotlin (Android and JVM, 0.8.33)

| Accepted change                                                                                                                                                           | Sev | Covered by                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | ------------------------------------------- |
| Choose the Ed25519 backend by an RFC 8032 known-answer test (Tink on Android); an instrumented test on the newest API level and minSdk.                                   | B   | SP-50                                       |
| Every public suspend function main-safe; a StrictMode `penaltyDeath` test with a split-write server.                                                                      | B   | SP-50                                       |
| `PolarisKeyAndroid.client()` returns a usable client; a suspend `create()`; the kit starts the client; a clear error instead of a `FileStore` under an empty `user.home`. | B   | SP-50; SP-32b keeps the guarantee           |
| The documented artifact set resolves with no excludes (variant for zstd-jni, packs optional); a consumer app in CI on documented and latest toolchains.                   | B   | SP-50                                       |
| Consumer R8 rules, or the RAM probe behind a JVM-only port.                                                                                                               | B   | SP-50                                       |
| Hand-written docs fixed now (quickstart by host, current version, `isLicensed()`); the console's Kotlin snippet; generated and compiled later.                            | B   | P0-48, P0-47; SP-33a/b, SP-37               |
| `licenseChanges` and `events` emit on every status transition; content-hash fallback; the gate reloads after each sync; a licence `StateFlow`.                            | M   | SP-51; SP-35 (name)                         |
| Gate `entitlementValue()` now; in 0.9, `entitlements.has/value/grants` gated in every SDK, `licenseInfo` stays a diagnostic.                                              | M   | SP-51; SP-35 (semantics plus a corpus case) |
| Boot retry with backoff and a cap; a 401 on `/license/token` is final for the pass.                                                                                       | M   | SP-51                                       |
| Error reporting: `update.check()` keeps server codes; one network code; `SyncResult` offline flag and typed reasons; `Unchanged`; a sealed error kind.                    | M   | SP-51; SP-43; SP-35                         |
| Native sign-in on phones (Custom Tabs); `Ready` carries the identity; `subject()` and `signOut()`; sign-in inside the gate.                                               | M   | I-15, I-10b, UK-09                          |
| The kit to spec: look, presentation, settings editors, catalog labels, locales; the docs mark Compose cells planned until then.                                           | M   | UK-09, HA-13, UK-10; SP-45b                 |
| The headless layer as a JVM and Android artifact without Compose, as UK-09's first deliverable.                                                                           | M   | UK-09 (amend)                               |
| Copy fixes: `Copy.forActivation/forStatus/forException`; malformed key and 5xx copy; `{product}` not "Polaris Key"; renew on expiry.                                      | M   | SP-39; LX-18, LX-19                         |
| Desktop secure defaults: `PolarisKeyDesktop` is the JVM start; the keyring through a desktop artifact; a warning when the store degrades; a focus-sync helper.            | M   | SP-32b (amend), SP-50, P0-48, UK-10         |
| Present the paths: per-host tabs; drop-in in the console only after SP-50 and SP-51; Android and Desktop examples in CI.                                                  | M   | SP-33a/b, SP-37, SP-36, ST-41, SP-45b       |
| A local backend and a Kotlin testing artifact (`TestSigner`, `ScriptedTransport`).                                                                                        | M   | SP-41, SP-42                                |
| Lifecycle: `close()` releases resources (a JVM exits); de-duplicated syncs; `listDevices()` reports offline; Play Billing `connect()` timeout.                            | M   | SP-51; LX-20                                |
| `pkey sdk` names a missing product; release pins from `polaris-key.json`.                                                                                                 | m   | SP-33a, SP-32a/b                            |
| API shape: typed `config.get`, one `isUsable`, `config` not both a function and a sub-client.                                                                             | m   | SP-35                                       |
| `OkHttpTransport()` compiles for consumers.                                                                                                                               | m   | SP-50                                       |
| Hosted device-code and sign-in pages show the product's name, icon and accent.                                                                                            | m   | I-08 (acceptance), HA-13                    |

| Declined                                                   | Why                                                                                              |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| AppAuth for phone sign-in.                                 | I-15 specifies Custom Tabs over I-08's routes; a second flow model.                              |
| Interfaces for every client, for mocking.                  | Doubles the surface `api.json` must test; SP-42's transport doubles are the seam.                |
| Rename `entitlements()` to `lastVerifiedEntitlements()`.   | Gate it instead (SP-35); no new vocabulary.                                                      |
| A default refresh interval.                                | Battery and rate-limit cost; foreground sync exists on Android, a focus helper comes on desktop. |
| Plain HTTP to `10.0.2.2` in `pkey sdk`.                    | Loopback-only HTTP is a security rule; document `adb reverse`.                                   |
| `java-keyring` in `polaris-key-sdk`.                       | Pulls JNA into every APK; ship it in a desktop artifact.                                         |
| One casing for error codes.                                | Snake_case codes are wire codes; only SDK-local duplicates are merged.                           |
| Origin in the default store path.                          | Partly overruled: only non-default hosts are namespaced (SP-41); production paths stay.          |
| Keep `PolarisKeyClient.create` as the JVM start (audit 5). | Stores the token in plaintext and skips the desktop driver.                                      |

### 7.6 Godot (`addons/polaris_key` 0.8.33, Godot 4.7)

| Accepted change                                                                                                                                                                | Sev | Covered by                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --- | -------------------------------------------- |
| `await PolarisKey.boot()` waits through Retry to READY by default (`resolve_on_stop` opts out); the quickstart, README and golden fixed.                                       | B   | UK-50; SP-33a                                |
| `PKeyUiView.sdk` re-renders nested views: offline activation shows its request code; re-gating after sign-out shows key entry.                                                 | M   | UK-50                                        |
| Re-gating after READY: re-entrant `boot()`, a persistent gate mode, an expired banner.                                                                                         | M   | UK-50; UK-11                                 |
| Starting focus on every interactive kit screen; accessibility names.                                                                                                           | M   | UK-50; UK-11                                 |
| The product is the hero (name, icon, monogram; never the Pinned K); register `fix/godot-ui-responsive`.                                                                        | M   | UK-50; HA-14, UK-11                          |
| Strings keyed on catalog ids with runtime translations; docs say the `.po` files do not apply yet.                                                                             | M   | UK-11, SP-39; SP-45b                         |
| One activation copy path; `for_result` on ok is empty; `{product}` in network copy.                                                                                            | M   | UK-50; SP-39                                 |
| Expired distinguishable for the key holder; the README stops listing it as reachable.                                                                                          | M   | LX-18, LX-19; SP-45b                         |
| One update prompt at a time, themed, with an action (https fallback).                                                                                                          | M   | UK-50                                        |
| Explain why no update is offered: `doctor()`, a debug warning, `pkey sdk` warns without release keys, release pins in `polaris-key.json`.                                      | M   | SP-32b, SP-33a/b; SP-45b                     |
| Never report "Activated." until the gate is usable; `doctor()` on a verify failure.                                                                                            | M   | UK-50; SP-32a/b                              |
| Show who signed in before handing back; `confirm_identity` on `boot()`.                                                                                                        | M   | I-10b, UK-11, UK-43; UK-50                   |
| The branded sign-in card fits 1280×720 and 1280×800.                                                                                                                           | M   | UK-50; UK-11                                 |
| Correct the Godot UI docs; a framework page; Godot tabs generated from `class_name` with a drift check.                                                                        | M   | SP-45b; UK-11, SP-37                         |
| In-app: Godot's default is the drop-in (`polaris-key.json` via the dock plus `boot()`), with links to the scenes and the controllers.                                          | M   | SP-33a, ST-41, SP-32b, SP-33b, SP-37, SP-45b |
| Document the own-UI path: the four controllers, a status → screen → copy-key table, signals, `discover()` in the manual start.                                                 | M   | SP-45b; UK-11; SP-33a                        |
| A local backend and test seams (`PKeyFakeBackend` over a transport seam).                                                                                                      | M   | SP-41, SP-42                                 |
| `sync()`'s `ok` follows `classify()`.                                                                                                                                          | M   | SP-43 (with SP-35); SP-45b (document now)    |
| `identity.subject()` is null on a key-only device.                                                                                                                             | m   | I-10b, SP-35                                 |
| `KIND_KEY_ENTRY_LIMIT` with its manage URL.                                                                                                                                    | m   | I-10b; SP-45b (note)                         |
| Small kit fixes: the settings panel fetches its schema, key entry follows `effective_capabilities`, no leaks at exit, friendly device name, `invalid-options` names the field. | m   | UK-50                                        |
| README fixes: a space-indented snippet, the privacy sentence, when config changes arrive, `fetch_schema`, export filters, programme ids.                                       | m   | SP-45b; SP-37                                |
| AssetLib metadata (4.4, MIT, icon, description).                                                                                                                               | m   | SP-45b                                       |
| The activation form to spec (live key verdict, fixed-width busy button, offline cue).                                                                                          | m   | UK-11                                        |
| Generated `STATUS_*`/`ACTION_*` constants; internal classes drop `class_name`.                                                                                                 | m   | SP-35                                        |

| Declined                                             | Why                                                                                      |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Treat editor runs as the `direct` outlet.            | An unknown outlet is never offered anything; `doctor()` and `update_outlet` help safely. |
| A new `outlet-unknown` decide reason.                | A corpus change for a debug concern; `doctor()` explains it.                             |
| `start()` runs discovery.                            | `start()` is the documented offline load; `boot()` and `fromConfig()` discover.          |
| Typed result classes beside the Dictionaries.        | A parallel surface; generated constants give autocompletion.                             |
| More status signals.                                 | One `event(kind, data)` signal (U-21).                                                   |
| UI kit and fonts as a separate addon.                | The kit ships inside the addon; an export filter suffices.                               |
| The plugin writes `.po` paths into project settings. | Intrusive; the kit loads its own translations (UK-11).                                   |
| A public hosted sandbox with shared keys.            | Shared mutable state on production; `pkey dev` covers local work.                        |
| A Godot-only device-report opt-out.                  | An all-SDK decision; the README lists what is sent.                                      |
| A non-zero default refresh interval.                 | A server-cost decision; document sync on focus.                                          |

## 8. Cross-SDK API consistency

The plan's diagnosis holds on main: option names, config verbs and activation verbs differ by more
than casing. The larger risk is one SP-35 as scoped will not catch: **the same name behaves
differently**. A registry of names checked by name-existence tests would pass every row below.

| Finding                                                                                                                                                                                                                                                                   | Sev    | Fix                                                                                                                                                      | Covered by                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Kotlin's `entitlementValue` ignores the licence gate; the other four gate it. No corpus case covers it.                                                                                                                                                                   | high   | Gate it now; a corpus case (revoked → `isEntitled` false, value null); `SDK-PARITY-PASS §3.3` states gating for every licence read.                      | SP-51; SP-35                                 |
| Licence events fire under different conditions per SDK and per entry point (Python and Swift: root only; Kotlin: never on deactivate, but on config-only changes).                                                                                                        | high   | Emit from the core state change; a transcript case (activate → deactivate = two events); triggers in `api.json`.                                         | SP-48, UK-49, SP-51; SP-35                   |
| `boot()` enrols in Node only (Python with a flag; Swift, Kotlin never); different result types.                                                                                                                                                                           | high   | One default (spec §3.4: register, then enrol), one option name, a `boot-cold-enroll` transcript, one result shape.                                       | SP-35; SP-32a/b                              |
| `api.json` as planned records names only.                                                                                                                                                                                                                                 | high   | Rows gain result types with field names, option units, a `semantics` note with a corpus or transcript id, and the error type and code.                   | SP-35 (amend, plan mode)                     |
| Time fields mix units (`lastVerifiedAt` ms in five SDKs, documented as seconds).                                                                                                                                                                                          | high   | Epoch seconds or a `…Ms` name; units in `api.json`.                                                                                                      | SP-35; UK-45, UK-47 now                      |
| The plan's records contradict: SP-35's brief keeps "deprecated aliases for the window" against the owner's no-aliases rule; C-25's "the name most SDKs ship" is false for `config.get` (0 of 5), `license.activate` (2 of 5), `entitlements.*` and `identity.signIn` (0). | medium | Fix the brief; restate C-25 as a decision; mark audit §5.2 superseded; re-estimate SP-35 (the whole read API in six SDKs).                               | SP-35 (brief)                                |
| The planned events list omits `entitlement`, which Python and Swift ship; payloads differ; no `eventKind` enum.                                                                                                                                                           | medium | An `eventKind` enum with payload fields in `enums.json`; Godot's `config_changed` carries values.                                                        | SP-35                                        |
| Swift's `licenseInfo().expiresAt` is the document's expiry; elsewhere it is the licence's.                                                                                                                                                                                | medium | `documentExpiresAt`; keep `expiresAt` for LX-18's licence term.                                                                                          | SP-35; LX-19                                 |
| No single catch-all error: Node and Python base-URL and device errors are not `PolarisError`; Kotlin's `UnsupportedException` has no code; React's `PolarisError.code` means something else than Node's.                                                                  | medium | One error type per language with a registry `code`; React adopts client-core's; React activation kinds in kebab case; 4 snake_case client codes renamed. | SP-46, SP-48 (subclassing now); SP-34, SP-35 |
| Sign-in: Kotlin has no `signOut` or current identity; `identity.current()` shapes and sources differ; Godot's `sign_in_with_browser` returns a prompt, the others a result.                                                                                               | medium | Feature ids `identity.signout`, `identity.current`; one shape from the signed profile; Godot awaits or is renamed.                                       | I-10a/b; SP-35                               |
| `setting(key)` members spelled five ways; `isLocked`, `clearAll` missing in places; `fetchSchema` parsed vs bytes.                                                                                                                                                        | medium | Member set in `api.json`; close the gaps; parsed catalog everywhere.                                                                                     | SP-35; U-06                                  |
| Godot cannot use `config.get`/`set` (`RefCounted` inherits `Object.get/set`).                                                                                                                                                                                             | medium | Record `get_value`/`set_value` as an accepted exception.                                                                                                 | SP-35                                        |
| Options: request timeout in ms (Node) vs seconds; `default_channel`, `fingerprint_enabled`, `send_device_name`; `version` required in three SDKs; UI options inside Godot's client options.                                                                               | medium | Every option in `api.json` with a unit-suffix rule; `version` auto-detected everywhere; Godot `ui_*` to the kit.                                         | SP-35; SP-32a/b                              |
| Python dataclasses mix camelCase and snake_case in one class; Godot dictionaries differ by service.                                                                                                                                                                       | medium | One casing rule for wire-mirroring data, applied by the generator.                                                                                       | SP-35; SP-49                                 |
| Root-client shortcuts differ per SDK and call different paths.                                                                                                                                                                                                            | medium | One home per concept plus an identical shortcut list that calls the same code.                                                                           | SP-35                                        |
| Docs name drop-ins that do not ship; quickstarts pick a different layer per SDK.                                                                                                                                                                                          | medium | A `layer` field in `api.json`; quickstarts regenerated with the same lanes in the same order.                                                            | SP-45a/b; SP-33b; SP-35                      |
| Type names reused for different concepts (`BootOutcome`, `ActivationOutcome`, `PKeyGate`).                                                                                                                                                                                | low    | Reserve each type name for one concept.                                                                                                                  | SP-35                                        |
| `get` prefixes, `URL`/`Url`, lifecycle verbs, offline-bundle constructors.                                                                                                                                                                                                | low    | Naming rules, applied by the generator.                                                                                                                  | SP-35                                        |
| Un-started clients answer "needs activation" silently (Kotlin's Android factory).                                                                                                                                                                                         | low    | Factories return started clients, or reads raise `not-started`.                                                                                          | SP-50; SP-32a/b; SP-35                       |
| Missing registry rows: `update.channel`, `identity.signout`, `identity.current`; `configSource` and `eventKind` enums.                                                                                                                                                    | low    | Add before SP-35 so `parity:check` reports the gaps as planned work.                                                                                     | SP-35                                        |

## 9. UI-kit findings

| Kit               | Look shipped                 | Product identity                              | Locales               | Missing or broken                                                                                   | Fix now      | Rebuild |
| ----------------- | ---------------------------- | --------------------------------------------- | --------------------- | --------------------------------------------------------------------------------------------------- | ------------ | ------- |
| Terminal (Node)   | modern (UK-14)               | `package.json` name, ink chip; accent ignored | 9                     | all verbs or none; collisions; `login` before discovery; secrets printed; raw codes                 | UK-45, UK-46 | (done)  |
| Terminal (Python) | modern (UK-13)               | the raw slug                                  | 9                     | `--product` on every verb; tracebacks offline; degraded-store notice to end users                   | UK-48        | (done)  |
| React             | 2019 (forbidden by the spec) | none; Polaris mark under `branding`           | en, fr (core only)    | sign-in, refusals, revoked; parts break a light host (`PolarisLogout` white on white); no baselines | UK-47        | UK-05   |
| SwiftUI           | native by default            | "Welcome to this app"                         | 9 shipped, unread     | terminal states; five screens; contrast; announcements                                              | UK-49        | UK-07   |
| Compose           | neutral, spec names differ   | "this app"                                    | 9 folders, unwired    | inherits Android blockers; revoked shown valid; settings editors                                    | SP-50, SP-51 | UK-09   |
| Godot             | neutral                      | the Pinned K mark                             | `.po` shipped, unused | Retry; offline activation; re-gate; focus; duplicate prompts; 720 px overflow                       | UK-50        | UK-11   |

Findings that cut across kits:

- **Two terminal kits built to one spec draw different screens for the same state** (status rows,
  refusal fix lines, key echo, locked-setting copy, `doctor` output, the `--json` envelope), and
  Node prints `secret` values and minted tokens that Python refuses to print. _Fix:_ UK-02b's state
  fixtures cover the terminal kits too, with expected rows, fix lines and copy keys, run as goldens
  in both suites; developer verbs opt-in (UK-46) and never printed without `--reveal` (UK-45).
- **Holder and account are confused in every status screen.** Python says "Signed in as Ada" for
  a key nobody signed in with; after a real sign-in it says "Activated with a license key". _Fix:_
  separate holder and account fields in the view model (I-10a/b, UK-43); interim in UK-45, UK-48.
- **Raw values reach end users:** `macos arm64`, `pro license` (the slug), `render.quality`,
  `Product: tidewater`. _Fix:_ catalog labels and tier labels in UK-45, UK-48, UK-47.
- **The terminal drop-in is all or nothing**, and "check the licence before my tool runs" takes a
  12-line verb object. _Fix:_ UK-46's `polarisGate()` and `withLicense()`; a preview entry point to
  render any state from SP-42's scenarios, so developers see grace, revoked and device-limit
  screens without a backend.
- **Visual QA does not cover the shipped web kit.** `kit-rules.json` lints six kits but not React;
  React, SwiftUI and Qt have no baselines; Godot's baselines are text dumps. _Fix:_ React into
  kit-lint with its debt recorded and Playwright baselines of today's kit (UK-47), so UK-05 has a
  before and after.
- **UI-KITS §4.2 and the mockups still promise `publishableKey` and a `product` prop**, which the
  plan replaces with `polaris-key.json`. Audit quick win 9 has no owner. _Fix:_ SP-45a amends §4.2
  and the UK briefs to the `fromConfig()` shape before the rebuilds start.
- Every kit fix package carries a `pkey-ux-reviewer` pass on the changed screens, in a real
  terminal, browser, simulator or emulator, at the committed resolution matrix.

## 10. Backlog changes

### 10.1 Existing packages that absorb changes

| Package                               | Absorbs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P0-47**                             | React snippet also shows `<LicenseGate>` and declares the version; the Kotlin snippet uses `PolarisKeyAndroid.client`; the two docs links per SDK in today's quick start, through `DOCS_LINKS`.                                                                                                                                                                                                                                                                                                           |
| **P0-48**                             | Docs safety fixes (following the docs does harm today): the Node kit factory (writes to production), the Electron `whenReady` snippet, strict-index Python installs, the Swift quickstart's `print(result)`, the Kotlin quickstart and version, React's stale bearer note (audit quick win 2, unowned today), the Swift `init(options:)` comment (quick win 4); `pkey` CLI install line, missing-`--product` message, `--version`, smol-toml; example version stamping; `theme.product` note until HA-13. |
| **SP-32a / SP-32b**                   | Kit adapters accept the config object; `doctor()` runs on a document verify failure and reports an origin mismatch; the outlet and release pins in `polaris-key.json`; Python's version from `importlib.metadata`; Swift's gate owns boot; Kotlin's JVM start is `PolarisKeyDesktop`; `PolarisKeyAndroid.client` always returns a started client.                                                                                                                                                         |
| **SP-33a**                            | `sdkFit` host types; console start = the drop-in only; headless and direct blocks rendered as docs goldens with link targets; strict-index `renderFeedSetup` with an Xcode tab; warnings for Update without release keys; `pkey sdk add` names missing flags.                                                                                                                                                                                                                                             |
| **SP-33b**                            | Writes both lanes' snippets into SP-45's page skeleton.                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **SP-35**                             | Widened rows (result shapes, units, semantics with corpus ids, errors, event triggers, `layer`); the brief's alias contradiction fixed; C-25 restated; `entitlement` event kind; gated `entitlements.*`; `boot()` enrolment; Godot `get_value` exception; option units; casing rule; root shortcuts; Swift `documentExpiresAt`; `init(options:)` not public; registry rows before the pass. Re-estimate.                                                                                                  |
| **SP-36**                             | CI examples run against `pkey dev` (no separate replay server); each sample runs its advertised commands; the Electron example launches; Compose Android and Desktop examples.                                                                                                                                                                                                                                                                                                                            |
| **SP-37**                             | The one start path forks into two lanes; `your-own-ui` pages survive the reference trim.                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **SP-39**                             | Swift core copy in a `PolarisKeyCore` bundle; vendor-neutral network copy; an update-not-configured key; activation copy routed by result kind.                                                                                                                                                                                                                                                                                                                                                           |
| **ST-41**                             | Renders §4.1–4.2: one drop-in per host, two links, the preconditions.                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **ST-29**                             | Docs access per the owner decision in §12 (developer sections reachable by integrators).                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **HA-13 / HA-14**                     | Land before ST-41 shows kit snippets.                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **I-08**                              | Acceptance covers the device-code approval page: product name, icon and accent, never the slug.                                                                                                                                                                                                                                                                                                                                                                                                           |
| **I-10a / I-10b**                     | `identity.subject()` survives a restart and is null for key-only devices; confirm-and-attach in every kit; `Ready` carries the identity (Kotlin); typed sign-in errors (Swift); an `identity` event kind; `KIND_KEY_ENTRY_LIMIT` (Godot).                                                                                                                                                                                                                                                                 |
| **LX-18 / LX-19**                     | Acceptance: `activate-refusals` step 3 carries the expired reason, sync 401s carry it for authenticated tokens, every kit renders renew copy.                                                                                                                                                                                                                                                                                                                                                             |
| **UK-02b**                            | Terminal-kit state fixtures (rows, fix lines, copy keys) and the kit-verb contract.                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **UK-03**                             | Also serves a Node main process with a plain renderer (snapshot, subscribe, `{key, args}` views).                                                                                                                                                                                                                                                                                                                                                                                                         |
| **UK-07**                             | The presentation core ships as a SwiftUI-free product first, with public preview states.                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **UK-08**                             | The Sparkle user driver is injectable.                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **UK-09**                             | First deliverable: a Compose-free headless artifact.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **UK-05, UK-06, UK-10, UK-11, UK-12** | Their framework pages replace SP-45's interim pages in place; UK-12 adds the Python own-UI depth for Qt.                                                                                                                                                                                                                                                                                                                                                                                                  |
| **U-06**                              | `config.set` validates against the cached catalog (Python).                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **P2-12**                             | Unblocks Python's `update.check()` against the real Worker and SP-44.                                                                                                                                                                                                                                                                                                                                                                                                                                     |

### 10.2 New packages

Twenty new packages, about **19–28 engineer-weeks**. Sixteen (about 15–22 weeks) can start now on
today's names; SP-42, SP-43, SP-44 and SP-49 wait for SP-35's names (and SP-44 for P2-12). New ids
take the next free number in an existing phase, per `check.mjs`'s `ID_RE`.

| Id         | Title                                                                  | Phase | Weeks   | Depends on            | Plan mode    | Role                |
| ---------- | ---------------------------------------------------------------------- | ----- | ------- | --------------------- | ------------ | ------------------- |
| **P0-52**  | Feed coherence: atomic lockstep publishing and a closure check         | P0    | 0.6–1.0 | none                  | no           | pkey-implementer    |
| **SP-41**  | `pkey dev`: a local Polaris Key for integrators                        | SP    | 1.5–2.2 | none                  | no           | pkey-implementer    |
| **SP-42**  | Test doubles on the real client, in every SDK                          | SP    | 1.2–1.8 | SP-41; SP-35 (names)  | no           | pkey-sdk-porter     |
| **SP-43**  | Sync outcomes: reasons, same-second documents, a sync status           | SP    | 1.5–2.0 | SP-35                 | yes (corpus) | pkey-sdk-porter     |
| **SP-44**  | Updates for package-manager installs                                   | SP    | 0.8–1.2 | P2-12, SP-35          | yes (corpus) | pkey-sdk-porter     |
| **SP-45a** | Developer docs, two lanes per SDK on today's API: Node, React, Python  | SP    | 1.0–1.4 | none                  | no           | pkey-implementer    |
| **SP-45b** | Developer docs, two lanes per SDK on today's API: Swift, Kotlin, Godot | SP    | 1.2–1.6 | SP-45a (snippet lane) | no           | pkey-implementer    |
| **SP-46**  | Node library 0.8.x: one error taxonomy, redaction                      | SP    | 0.6–1.0 | none                  | no           | pkey-sdk-porter     |
| **SP-47**  | React bundle diet and size budget                                      | SP    | 0.4–0.6 | none                  | no           | pkey-implementer    |
| **SP-48**  | Python 0.8.x patch: fail-open, leak and error-model fixes              | SP    | 0.8–1.2 | none                  | no           | pkey-sdk-porter     |
| **SP-49**  | Python typed surface for 0.9                                           | SP    | 0.8–1.2 | SP-35                 | yes          | pkey-sdk-porter     |
| **SP-50**  | Kotlin 0.8.x hotfix: Android runtime, packaging, desktop store         | SP    | 1.5–2.0 | none                  | no           | pkey-sdk-porter     |
| **SP-51**  | Kotlin live state and lifecycle                                        | SP    | 0.8–1.2 | none                  | no           | pkey-sdk-porter     |
| **SP-52**  | Swift package footprint                                                | SP    | 0.5–0.8 | none                  | no           | pkey-sdk-porter     |
| **UK-45**  | Node terminal kit 0.8.x fixes                                          | UK    | 0.8–1.2 | none                  | no           | pkey-implementer    |
| **UK-46**  | Node terminal kit for existing CLIs                                    | UK    | 0.8–1.2 | none                  | no           | pkey-implementer    |
| **UK-47**  | React kit and gate fixes before UK-05                                  | UK    | 1.2–1.6 | none                  | no           | pkey-implementer    |
| **UK-48**  | Python terminal kit as a mountable drop-in                             | UK    | 0.8–1.2 | none                  | no           | pkey-implementer    |
| **UK-49**  | SwiftUI kit and Swift SDK 0.8.x correctness pass                       | UK    | 1.0–1.5 | none                  | no           | pkey-sdk-porter     |
| **UK-50**  | Godot drop-in fixes ahead of UK-11                                     | UK    | 1.5–2.0 | none                  | no           | pkey-godot-engineer |

Every package's acceptance also includes the green gate; the kit packages add a `pkey-ux-reviewer`
pass on every changed screen.

**P0-52 Feed coherence: atomic lockstep publishing and a closure check.**
_Scope:_ `publish-sdks.yml` publishes npm legs in dependency tiers (jws, protocol, catalog,
zstd-wasm → client-core, brand, manifest → node, react, cli), and a leg publishes only when every
leg it depends on succeeded. A job after each publish resolves every exact `@polaris-key/*` pin of
every new version on `pkg.plrs.im` and fails before channel tags move; a failed set is yanked. A
scheduled check covers every version on the npm feed, plus the PyPI equivalent. Repair the 9 broken
versions (publish `jws@0.8.28` and `protocol@0.8.29` from their tags, or deprecate the dependents;
owner step). `install-from-feeds.md`: the pnpm (10.16+, 11), npm and Bun age gates beside Yarn's,
with `minimumReleaseAgeExclude: ["@polaris-key/*"]` as an opt-in; correct "beta = newest
pre-release"; stale version snippets.
_Acceptance:_ the full-feed check finds no unresolvable sibling pin; after every publish, `pnpm add
@polaris-key/node` (pnpm 11 defaults) and `npm install @polaris-key/react react react-dom` succeed
in an empty directory in CI; a simulated stuck leg leaves no dependent published at that version.

**SP-41 `pkey dev`: a local Polaris Key for integrators.**
_Scope:_ `pkey dev` in `@polaris-key/cli` runs the real Worker router in-process on Node ≥22.13's
built-in SQLite with in-memory KV and Durable Object mocks: no wrangler, no Cloudflare account, no
secrets, no migrations step. It seeds from the repo's `.pkey/` or the built-in Tidewater product
(which SP-36 then reuses), with throwaway signing and release keys; test keys for ok, expired,
disabled, revoked, device-limit-full, key-entry-limit and floating; a fake IdP approval page; a
signed release on stable and beta; `web.origins` for localhost; control commands (expire, disable,
revoke, fill seats, set a config value, publish a release, go offline). It writes `polaris-key.json`
(until SP-32b, `pkey sdk --dev` writes today's per-SDK config) and prints the pins. Loopback only.
Every SDK namespaces its store by host for a non-default base URL, so a dev run never touches
production state on the same machine (production names unchanged). Also published as an OCI image
for developers without Node. A "Run Polaris Key locally" page (emulator and simulator notes such as
`adb reverse`) is linked from step 1 of every quickstart.
_Acceptance:_ starts in under 10 s from a clean machine with no account; in CI, each SDK's quickstart
reaches first activation, every refusal kind exactly as the deployed Worker answers it, a config
change event, device-code sign-in and an update decision; it never contacts `key.plrs.im` (test);
the dev routes and fake IdP are absent from the production Worker bundle (build test); a dev run
leaves production store entries untouched (Node and Python tests, parity rows for the rest).

**SP-42 Test doubles on the real client, in every SDK.**
_Scope:_ each SDK publishes a testing entry point that drives the **real** client over a scripted
transport and a throwaway signer, never a second client: Node `@polaris-key/node/testing`, React
`@polaris-key/react/testing` (a test Provider over the real browser adapter), Python
`polaris_key.testing` (a mock control plane on httpx `MockTransport`), Swift `PolarisKeyTesting`,
Kotlin `polaris-key-testing` (`TestSigner`, `ScriptedTransport`), Godot an optional
`polaris_key_testing` folder over a transport seam on `PKeyOptions`. Scenarios match SP-41's keys
plus offline. Sample fixtures (`fixtures.ts`, `tidewater_fixtures.py`) move onto it; each terminal
kit gets a documented preview entry point that renders any scenario.
_Acceptance:_ in each SDK a host test of an activation screen needs 15 lines or fewer and no
hand-written claims; samples import only public modules; `api.json` lists the surface.

**SP-43 Sync outcomes: reasons, same-second documents, a sync status (plan mode).**
_Scope:_ every SDK's sync result gives each document a reason (network, server with status,
rejected with the verify step, replay) and an `offline` flag; Godot's `ok` follows `classify()`;
React's `refresh()` returns the outcome and the hooks expose the last sync. A re-served document
with identical bytes counts as unchanged. The Worker issues documents of one type to one device with
a strictly increasing `iat`. Every client exposes a sync status (last attempt, last success, last
error code, offline) and emits one `sync` event when that status changes. The plan names the corpus
cases and every SDK that follows; no signed-shape change; `PROTOCOL_VERSION` unchanged.
_Acceptance:_ an identical document served twice reports unchanged in all six SDKs; a config change
in the same second as the last issue arrives and emits its event; offline reports `network` and
`offline`; a tampered document reports `rejected`; names in `api.json`; THREAT-MODEL records that
the anti-replay floor is unchanged for differing payloads.

**SP-44 Updates for package-manager installs (plan mode, corpus lane).**
_Scope:_ an outlet-matrix subkind for package-manager installs detected positively (pip, pipx, uv
tool; npm, pnpm and yarn global; Homebrew formula), with an instructions-only update method the
kits render as the exact upgrade command. An unknown outlet still gets nothing (no new decide
reason); `doctor()` and a once-per-run debug line explain why. `polaris-key.json` can set the
outlet for direct-download products.
_Acceptance:_ the new rows replay green in six SDKs; a pipx-installed sample is offered 1.3.0 with
`pipx upgrade` in the Python kit and an npm-global CLI with its command in the Node kit; an unknown
outlet's `doctor()` line names the cause.

**SP-45a / SP-45b Developer docs: two lanes per SDK on today's API.**
_Scope (shared, in a):_ the lane skeleton of §4.1; a doc-snippet extractor (fenced blocks in every
SDK README and docs page, by language, with an opt-out marker) and compile lanes; status badges on
`build/ui/index.mdx`, framework pages and component tabs; shipped names in the layer table, spec
names labelled; terminal and Electron rows; UI-KITS §4.2 amended to the `polaris-key.json` shape;
`DOCS_LINKS` entries for every console link in §4.2. _(a)_ Node, React and Python: the pages and
fixes in §4.2. _(b)_ Swift, Kotlin and Godot: the pages and fixes in §4.2, the Xcode install tab,
the Compose Desktop recipe, the Godot class-name drift check and AssetLib metadata.
_Acceptance:_ for each SDK, both lanes reach the eight checkpoints; every code block on the new and
changed pages compiles in its lane, and a deliberately broken block fails CI; a check fails when a
page names a symbol the SDK does not export; docs-links and the slug manifest pass; a newcomer dry
run per SDK is recorded in the PR.

**SP-46 Node library 0.8.x: one error taxonomy, redaction.**
_Scope:_ every fetch wrapped (no raw `TypeError`); one network code; 5xx → server or unavailable,
429 → `rate_limited` with `retryAfterSeconds`, only a real 404 → `not_found` in update, release and
identity; `PolarisError` keeps the server's message; `beginSignIn` refuses locally when discovery
says identity is off; `InsecureBaseUrlError` and `DeviceManagementUnsupportedError` extend
`PolarisError`; `ActivationResult.ok` redacts its token in `inspect` and `toJSON`; client-core's
`lastVerifiedAt` comment corrected; the code list handed to SP-35.
_Acceptance:_ an offline matrix asserts one code across activate, sync, `update.check`, release and
identity; a 404/429/500/503 matrix covers each call; no public result type's `console.log` or JSON
contains `pkeyt_`; `instanceof PolarisError` catches every SDK error.

**SP-47 React bundle diet and size budget.**
_Scope:_ packs, zstd-wasm and hash-wasm reached only through dynamic import; the Provider path
imports no update or packs module statically; the root barrel stops re-exporting packs (they stay on
`/packs`); size-limit in CI for Provider + `LicenseGate` and Provider + `useLicense`, published on the
SDK page.
_Acceptance:_ a Vite build of Provider + `useLicense` emits no `.wasm` and inlines none; gzip JS over
bare React stays under the budget measured in the package (today +77 KB); CI fails over budget.

**SP-48 Python 0.8.x patch: fail-open, leak and error-model fixes.**
_Scope:_ `CoreContext.request` maps transport errors to `network-error` (cause chained) and 5xx to
`server-error`; `update.check` and `release` stop collapsing to `not_found`; `create()` rejects
unknown `expected_services`; `repr=False` on every token field; `AsyncClient` gate coroutines
refuse truthiness; `client.license.deactivate()` emits the licence event like the root;
`InsecureBaseUrlError` and `DeviceManagementUnsupportedError` subclass `PolarisError`; an empty key
refused locally; sign-in errors carry the server message; listener exceptions logged; lazy imports.
_Acceptance:_ every public network method, patched to raise `ConnectError` and then return 503,
gives `network-error` or `server-error` and leaks no httpx exception;
`create(expected_services=['licence'])` raises; no public result's repr contains `pkeyt_`;
`if aclient.is_licensed():` raises instead of passing; one licence event per deactivate from either
entry point.

**SP-49 Python typed surface for 0.9 (plan mode, after SP-35).**
_Scope:_ `Literal` discriminators on every result kind and status; generic
`get_config(key, fallback: T) -> T`; typed keywords on `create()` and `from_config()`; a typed
`AsyncClient` with cache-only reads synchronous; a client `Protocol` for the kit; snake*case public
fields with one time unit, landing with SP-35's renames (no aliases).
\_Acceptance:* mypy `--strict` and pyright pass on the README's patterns, including
`if r.kind == "device-limit": r.manage_url`; a misspelt `AsyncClient` method fails type-checking; the
`api.json` surface test covers both clients; the release notes list every rename.

**SP-50 Kotlin 0.8.x hotfix: Android runtime, packaging, desktop store.**
_Scope:_ Ed25519 backend chosen by an RFC 8032 known-answer test, Tink preferred on Android; every
public suspend function main-safe (body read and store, keyring and cache I/O off the caller's
dispatcher); `PolarisKeyAndroid.client()` returns a usable client, a suspend `create()`, the kit
starts it, `CoreOptions` without a store fails clearly on Android; `OkHttpTransport()` compiles for
consumers; Gradle variants so `sdk`, `ui`, `billing` and `android-*` resolve zstd-jni's AAR with no
excludes; packs optional; consumer R8 rules or a JVM-only RAM probe; `java-keyring` through a desktop
artifact with a once-per-run warning when the store degrades; an emulator lane (minSdk, 34, newest)
and a consumer app on documented and latest toolchains.
_Acceptance:_ on an API 36 emulator, `client(context)` → `activate()` → `sync()` launched from
`Dispatchers.Main` against a server that splits headers and body gives `Ok` and an applied licence,
with no workaround in app code; StrictMode `penaltyDeath` covers every public suspend function;
`sdk` + `android-direct` + `ui` + `billing` build `assembleDebug` and minified `assembleRelease` on
compileSdk 36 and 37 with no app rules; an APK without packs has no `libzstd-jni`.

**SP-51 Kotlin live state and lifecycle.**
_Scope:_ `licenseChanges` and `events` emit on every status transition (deactivate, wipe,
401/revoked, blocked, grace and expiry as the floor moves), with a content-hash fallback;
`PolarisGateState` reloads after every sync; `entitlementValue()` gated; boot retries with
exponential backoff and a cap, a 401 on `/license/token` final for the pass; de-duplicated syncs;
`close()` cancels the scope and releases OkHttp resources; `update.check()` keeps server codes;
`listDevices()` reports offline; Play Billing `connect()` with a timeout and disconnect handling.
_Acceptance:_ deactivate and a server revoke followed by `sync()` each emit within one tick; a Compose
test of a licence revoked in the foreground shows the revoked screen; a boot with a revoked token
makes at most 5 token requests a minute; a JVM `main` exits within 1 s of `close()`; `purchase()`
without Play returns `BillingFailed(unsupported)` within 10 s.

**SP-52 Swift package footprint.**
_Scope:_ the registry archive drops tests and tools; one Rubik variant, JetBrains Mono only if
used; iOS hosts link `decide()` without packs and libzstd; zstd vendored as a C target.
_Acceptance:_ the published archive is under 6 MB with no Tests directory; a Release arm64 iOS app
with the kit and `decide()` is at least 25% smaller than at 0.8.33 (measured in CI); `swift package
resolve` clones nothing.

**UK-45 Node terminal kit 0.8.x fixes.**
_Scope:_ devices "last seen" from the roster in seconds; status holder is name or email (empty
counts as absent) and signed-in comes from `identity.current()`; login ends "Signed in as <name>" and
confirms before attaching when a key licence is held (`waitForSignIn({confirm})`, default No); every
flow ensures discovery before deciding a capability is off; `update apply` names the reason and next
step (the upgrade command for package-manager installs, a download link otherwise; update copy for
not-configured); interim refusal copy covering expiry with the portal link; `core.gate.revoked` not
titled "Signed out" for key-only devices; product-first strings; one spelling of licence; `secret`
and `mint` never print values without `--reveal`; catalog labels for tiers, platforms and settings;
OSC 11 skipped when the theme is already decided.
_Acceptance:_ goldens with a real client's status (ms `lastVerifiedAt`) and an empty-email profile;
a key-held login prompts, defaults to No and keeps the key licence; `login` works from the
documented factory without a manual `discover()`; `update apply` goldens for npm, pnpm, brew, npx,
no driver and not-configured each end in an actionable line; a lint finds no kit string naming
Polaris Key where the product fits.

**UK-46 Node terminal kit for existing CLIs.**
_Scope:_ `registerPolarisCommands` and the yargs adapter take `verbs` (ids or groups; default the
config's services plus core verbs; developer verbs opt-in) and `config` (today's `polarisConfig`;
`polaris-key.json` after SP-32a); a documented commander `mount`; a collision gives a clear error
naming the fix, or skips with a warning on opt-in; grouped help lists the host's commands first;
`polarisGate()` and `withLicense(handler)`; yargs on its own subpath.
_Acceptance:_ a host CLI with its own `config`, `update` and `status` registers without throwing;
`--help` lists the host's commands first; gating a host command takes 3 lines or fewer; `tsc` with
`skipLibCheck: false` passes in a commander-only project; the SP-33a Node CLI golden is 8 lines or
fewer and compiles.

**UK-47 React kit and gate fixes before UK-05.**
_Scope:_ no wire change, no new names (additive fields only once SP-35 names them). The bearer
device-code hand-off from the `signInWithOidc` handle (code, open, copy, QR, expiry, cancel) with
every rejection in the card; refusals stay on login with the typed key, the custom slot and "Replace
a device"; refreshes never clear an activation refusal; revoked gets three actions and 401 backoff;
typed update codes, never "up to date" after a failure, one shared check; a StrictMode-safe Provider;
a development-only error for missing pins or an origin missing from `web.origins`; `React.JSX.Element`
and a React 18 and 19 consumer typecheck; `lastVerifiedAt` in seconds; one discovery fetch per load;
hard-coded strings into `theme.copy`; copy helpers re-exported from the root; `PolarisLogout` visible
on a light host; React added to kit-lint with its debt recorded, and Playwright baselines of today's
kit.
_Acceptance:_ jsdom tests over transcripts: bearer sign-in shows the code and URL and Cancel stops
polling; a refused key keeps the screen, the key and the message across a refresh; device-limit shows
"Replace a device" with a `manageUrl`; revoked has at least two actions and backs off; a 404 on
`/update/version` never shows "up to date"; `onConfigChange` fires under StrictMode; the corpus and
transcripts are unchanged.

**UK-48 Python terminal kit as a mountable drop-in.**
_Scope:_ `register_argparse`, `polaris_click_group` and `polaris_typer_app` take `client=` or
`config=` with `version=`; once bound, `--product`, `--trust`, `--base-url`, `--service`,
`--config-dir` and the per-verb `--version` are hidden; `verbs=` with `END_USER` as the default;
per-verb help; `require_license()` and `require_entitlement()`; the update available state without
signed decisions; signed-in only from identity; the bundle name from package metadata until HA-13;
no degraded-store line in end-user status; `<Product> sign-in` copy; kebab-case `--json` enums;
locale dates and platform names; no private client attributes; the Textual Updates pane wired or
removed; `mytool.py` and `tidewater.py` with no argv hack.
_Acceptance:_ `python mytool.py sign-in` and `status` work unchanged; a host's `--help` lists only the
chosen verbs without integration flags; every verb has offline and update-unconfigured goldens in
both themes; the `require_*` snippets are tested files; the SP-33a Python CLI golden compiles.

**UK-49 SwiftUI kit and Swift SDK 0.8.x correctness pass.**
_Scope:_ terminal gate states get actions (use a different key, sign in, renew or manage, a host
slot) with matching copy; `.polarisKey(client, theme:, options: GateOptions)` keeps the device-limit
manage URL and return URL, key entry and offline activation (off on iOS); `ActivationResult` redacts
its token; `StoreError` is a `LocalizedError`; the accent through `PolarisAccent.resolve`; Return
submits and refusals are announced; the default name from `CFBundleDisplayName`; no activation card
before the first reload; "Signed in as" with "Not you?" on ready; the
`WebAuthenticationSignInBrowser` isolation fix; no `try?` in `client.update`; update-not-configured
copy; `LicenseClient.deactivate()` emits the licence event; `JSONValue` descriptions; the five
README snippets, `platforms:` and `from:`.
_Acceptance:_ UI tests drive a licence to expired and to revoked and reach the activation form
through "Use a different key" and through Sign in without relaunching; a device-limit refusal shows
a working "Replace a device"; no `pkeyt_` in `String(describing:)`, `String(reflecting:)` or
`dump`; contrast at least 4.5:1 on `#FF6A3D` in both schemes; a licensed cold launch never renders
the activation card (first-frame snapshot); the README blocks compile in SP-45b's lane.

**UK-50 Godot drop-in fixes ahead of UK-11.**
_Scope:_ `boot()` resolves at READY through Retry (`resolve_on_stop` opts out); `PKeyUiView.sdk` as a
setter that re-renders nested views; re-entrant `boot()` and a persistent gate mode; the banner's
expired state; starting focus and accessibility names on every interactive screen; one update prompt
(a game-placed one replaces the kept one), themed, always with an action; activation not reported ok
until documents verify, with verify-failure copy and a developer `push_error`; `for_result` through
`message_for`; `confirm_identity` on `boot()`; the settings panel fetches its schema; key entry
follows `effective_capabilities`; resources freed at exit; a friendly device name; register and
finish the uncommitted `fix/godot-ui-responsive` worktree (product header, landscape sign-in,
1280×720 matrix).
_Acceptance:_ OFFLINE → Try again → READY resolves the awaited `boot()` and changes the scene; every
dialog opened from a live gate renders its content; a re-boot after `sign_out()` shows key entry and
Sign in; from a cold boot with no pointer, focus lands on the first control and `ui_down` walks the
chain; the branded and neutral sign-in cards fit 1280×720 and 1280×800; a wrong pin and a +2-day
clock never show "Activated."; no product screen shows the Pinned K; no leak warning at exit.

### 10.3 Ids proposed by the SDK leads, reconciled

The six leads proposed overlapping and colliding ids (two `UK-45`s, two `SP-41`s, `PY-*`, `KT-*`,
`SW-*`, which `ID_RE` rejects). Cross-SDK work is merged into one package each (tracks rule 4: one
mechanism).

| Proposed                                                                                                                                                                         | Final                      |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| Node P0-52; React "Feed release integrity"                                                                                                                                       | P0-52                      |
| Node SP-41; React "@polaris-key/testing and pkey dev" (server half); Python PK-DEV; Swift "pkey dev"; Kotlin "Integrator local backend" (server half); Godot SP-42 (server half) | SP-41                      |
| React test adapter; Python PY-04; Kotlin testing artifact; Swift `PolarisKeyTesting`; Godot `PKeyFakeBackend`                                                                    | SP-42                      |
| Swift "Sync outcomes"                                                                                                                                                            | SP-43                      |
| Python PY-03                                                                                                                                                                     | SP-44                      |
| React "Integration paths" (docs half); Swift SW-DOC; Godot SP-41 (docs)                                                                                                          | SP-45a, SP-45b             |
| Node SP-42 (error taxonomy)                                                                                                                                                      | SP-46                      |
| React "bundle diet"                                                                                                                                                              | SP-47                      |
| Python PY-01                                                                                                                                                                     | SP-48                      |
| Python PY-02                                                                                                                                                                     | SP-49                      |
| Kotlin KT-01 and KT-02                                                                                                                                                           | SP-50                      |
| Kotlin KT-03                                                                                                                                                                     | SP-51                      |
| Swift "package footprint"                                                                                                                                                        | SP-52                      |
| Node UK-45                                                                                                                                                                       | UK-45                      |
| Node UK-46                                                                                                                                                                       | UK-46                      |
| React "kit and gate fixes"                                                                                                                                                       | UK-47                      |
| Python UK-13b                                                                                                                                                                    | UK-48                      |
| Swift SW-FIX                                                                                                                                                                     | UK-49                      |
| Godot UK-45                                                                                                                                                                      | UK-50                      |
| React "Integration paths" (console half)                                                                                                                                         | P0-47 (edit), ST-41 (edit) |

### 10.4 Disagreements between the leads, settled

| Question                              | Positions                                                                             | Decision                                                                                                                                                                                 |
| ------------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What `pkey dev` runs                  | Real Worker router (Node, Swift, Godot) vs transcript replay (React, Python, Kotlin)  | The real router, in-process. Refusals must match production; replay needs state for revoke and config changes, so it becomes a second server; the repo is public MIT. SP-36 uses it too. |
| Test doubles                          | Fake clients and adapters (Python, React) vs none (Node)                              | Doubles drive the real client over a scripted transport and a test signer; no second client.                                                                                             |
| Sync as events                        | No `sync` kind (Node) vs a `sync` kind (Swift, Python)                                | Sync status is state; one `sync` event fires when it changes.                                                                                                                            |
| Namespacing local state               | By host (Python) vs never (Swift, Kotlin, Node)                                       | Only non-default hosts are namespaced; production names unchanged, nothing orphaned.                                                                                                     |
| Unknown update outlet                 | A new decide reason (Python) vs none (Godot)                                          | Positive package-manager detection (SP-44); unknown explained by `doctor()`; no new reason.                                                                                              |
| Which entitlement reads are gated     | All (Kotlin lead) vs value only (API review)                                          | 0.8.x: Kotlin gates `entitlementValue` (matching the others). 0.9: `entitlements.has/value/grants` gated everywhere; `licenseInfo` stays a diagnostic.                                   |
| Expired keys                          | Anti-enumeration 401 vs a distinct reason                                             | A reason only for a key that matched or an authenticated token (LX-18).                                                                                                                  |
| Brand in generated config or snippets | Yes (UI review) vs no (Node, Python)                                                  | No. HA-13 lands before ST-41 shows kit snippets.                                                                                                                                         |
| Console shape                         | Headless tab (plan) vs three-tab chooser (UI review) vs one snippet and links (owner) | The owner's.                                                                                                                                                                             |
| Python's truthy coroutine             | 0.9 reshape only                                                                      | Both: a truthiness guard now (SP-48), the reshape in 0.9 (SP-49).                                                                                                                        |

## 11. Against the consolidation plan

**Confirms.** One config file and one start call (SP-32a/b): every trial hit option drift and the
factory-versus-config gap. One name per concept (SP-35); one generator with compiled goldens
(SP-33a/b); examples built in CI (SP-36); reference-only READMEs and the programme-id lint (SP-37);
one copy pipeline (SP-39); presentation in the SDKs (HA-13/14); shared UI fixtures (UK-02b); the kit
rebuilds (UK-03, UK-05, UK-07, UK-09, UK-11, UK-12); expired reasons (LX-18/19); identity v2 with
confirm-and-attach (I-10a/b); native redirect sign-in (I-15); the audit's P1 (React pins), P7 (docs
shape) and §7 item 9 (kit-first start).

**Contradicts or corrects.**

- SP-33a's "kit-first start with a headless tab": the console shows the drop-in only and links to
  docs; the blocks become docs goldens (owner, 2026-10-08).
- Audit §7 item 6, "lead every quick start with `boot()`": copies Godot's Retry trap into every
  quickstart until UK-50 lands, and `boot()` enrols differently per SDK until SP-35 settles it.
- Audit quick win 5, "keep `PolarisKeyClient.create` for the JVM": it stores the token in
  plaintext; the JVM start is `PolarisKeyDesktop`.
- Audit quick win 7 (`expectedServices` alias) and SP-35's brief ("deprecated aliases kept for the
  window") contradict README §2.10 and the owner's no-aliases rule.
- C-25 "the canonical name is the one most SDKs ship" is false for `config.get`, `license.activate`,
  `entitlements.*` and `identity.signIn`; audit §5.2's events list omits `entitlement`.
- SP-36's separate transcript replay server becomes `pkey dev` (one mechanism).
- Audit §5.1, "Python keeps a required version": `importlib.metadata` knows it.
- ST-29 gates `/docs` on `platform.docs` (Superadmin and Platform admin) while audit §5.8 says
  developer sections need any console role. With the Integration page linking into the docs, that
  gate decides whether the owner's model works at all (§12).
- Audit quick wins 2, 4, 5, 8 and 9 have no owning package: P0-48's scope lists none of them. They
  go to P0-48 (edit) and SP-45a.

**Goes beyond.** Feed coherence (P0-52); `pkey dev` (SP-41) and test doubles (SP-42); sync outcomes
(SP-43); package-manager outlets (SP-44); docs on today's API now (SP-45a/b); 0.8.x fix packages per
SDK, because the rebuilds are 5–16 weeks out (SP-46 to SP-52, UK-45 to UK-50); the Kotlin Android
runtime blockers, which the plan does not mention; main-thread safety; a React bundle budget; the
terminal kit inside an existing CLI; `api.json` recording semantics, units, shapes, errors and event
triggers; the hosted device-code page's branding (I-08); time-unit normalisation; docs access.

## 12. Owner decisions and steps

1. **Developer docs reachable by integrators.** Recommendation: make the developer sections
   (`start/`, `build/`, `services/`, `reference/`) public and keep operator sections (`admin/`,
   `contribute/`, the runbook) behind the platform-admin gate. The source of every page is already
   public in `vladzaharia/polaris-key` (MIT), so the gate hides nothing from a reader; it only stops
   integrators following the console's links. Today every console user is a platform admin, so the
   links work; after ST-28/ST-30, Product admins exist and ST-29 as written locks them out. This
   amends docs plan N7 and ST-29. The minimum alternative is audit §5.8's "any console role".
2. **Approve the repair of the 9 broken npm versions** (P0-52; the `package-registry`
   environment): publish `jws@0.8.28` and `protocol@0.8.29` from their tags, or deprecate the nine
   dependents.
3. **Re-ask on unclaimed public names.** Owner decision 3 rules out placeholders. P0-48 removes
   every bare command from the docs, so the residual risk is a developer typing `npx pkey` or
   `pip install polaris-key` from memory, which reaches a squattable name. Recommendation: claim
   `pkey` on npmjs and `polaris-key` on PyPI as inert names that install nothing and point to the
   feed. If yes, add both to `~/Downloads/polaris-key-owner-steps.md`.
