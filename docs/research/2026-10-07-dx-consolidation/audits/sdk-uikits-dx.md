# Audit: SDK and UI-kit developer experience, examples and docs, remaining UI-kit work

**Domain.** How a developer integrates Polaris Key: the six SDKs' public APIs and their
consistency (`client-core`, `sdk-node`, `sdk-react`, `sdks/python`, `sdks/swift`, `sdks/kotlin`,
`sdks/godot`), the UI kits (UI-KITS.md, the UK phase, UK-13/UK-14 in flight), `examples/`, the
docs site's developer guides and quick starts, and the source of truth for the console's in-app
Integration content. Owner-brief items covered: General Concepts (onboarding, example code,
auto-configuration), Products → Integration section (content side), Cloud Sync SDK ergonomics, and
the SDK-facing edges of Licenses, Managed Config, Feeds/Access tokens and Identity.

**Tree read.** `/Users/vlad/Repos/pk-wt/dx-plan` (v0.8.31 + batch 5), plus the in-flight branches
UK-13 (`/Users/vlad/Repos/pk-wt/UK-13`), UK-14 (`/Users/vlad/Repos/pk-wt/UK-14`, fix round), HA-12
(`/Users/vlad/Repos/pk-wt/HA-12`) and LX-08 (`/Users/vlad/Repos/pk-wt/LX-08`). Paths below are
repo-relative to the dx-plan tree unless a branch is named. `program/` means
`docs/research/2026-09-29-godot-omniplatform/program/`; `notes/` means
`docs/research/2026-09-29-godot-omniplatform/notes/`.

---

## 1. Summary

The wire side of the SDKs is in very good shape. 84 parity features are tracked, and every SDK
implements 66 to 76 of them (`conformance/parity/features.json`, each `parity.json`). The corpus,
transcripts and `parity:check` keep the six languages honest. **The friction is entirely in the
layer a developer touches first**:

1. **Getting started has five sources of truth, and they disagree.** The console quick start
   (`packages/admin/src/console/pages/core/sdkQuickStart.ts`), `pkey sdk --lang`
   (`packages/cli/src/sdkConfig.ts`), `pkey sdk` without `--lang` and `pkey trust`
   (`packages/cli/src/manifest.ts:272`), the hand-written docs quick starts
   (`packages/docs/src/content/docs/build/quickstart/*.md`) and the SDK READMEs all describe the
   first lines of code differently. The design docs then propose four more constructor shapes
   that do not exist. Two of the current snippets are broken for the most common case: a React
   app on its own domain gets no trust pins.
2. **The same concept has a different name in each SDK.** Constructors, option names, config
   reads, entitlement checks, events and sign-in all differ beyond casing. Planned work (U-06,
   S-17 §5.11) is about to add a second set of names beside the ones that already shipped.
3. **The UI-kit programme is far larger than the developer need.** It has 46 UK ids and about 86
   engineer-weeks still open. It promises roughly 20 framework packages and 20 samples, and a
   dozen cross-cutting feature packages (I-10a/b, PX-W9b, LX-19, CM-15, I-24b, U-08, U-13/25,
   HA-13/14) each also edit the four *old* kits that the UK programme is rebuilding.
4. **In-app integration content does not exist yet**, beyond a 550 px "Trust & SDK" panel. The
   designed fix, SETUP.md §3 (UX-60 `renderSdkSetup`, UX-61 Connect your app), is not in the
   program graph (`workpackages.json` has no UX-60 or UX-61). It also covers install and
   connection only, not per-service usage.

**The single most important change is to make one SDK config file and one start call the only
way in.** A `polaris-key.json` file (product, base URL, trust pins, release pins, services) would
be downloaded from the console or written by `pkey sdk add`, and every SDK would read it through
`fromConfig()` and then call `boot()`. One shared generator would render every install, start
and per-service snippet from that file. The console's Integration section, the CLI, the docs
quick starts and the READMEs would all be views of that generator, and each SDK's CI would
compile its goldens. This removes five generators and four constructor dialects, and it gives
the console a verifiable "integration done" moment to hang the owner's dismiss button on. It
needs no wire change.

---

## 2. Current state

### 2.1 The six client surfaces

| SDK            | Package / entry                                                                      | Start today                                                                                                                                                                                                                                                                                              | Config written by `pkey sdk`                                         | One-call boot                                                                      |
| -------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Node           | `@polaris-key/node`, 23 subpath exports (`packages/sdk-node/package.json`)           | `PolarisKeyClient.create({productSlug, version?, trust:{pinnedKeys}, expectedServices, update:{pinnedReleaseKeys}})` (`packages/sdk-node/src/client.ts:313`); `discover()` is explicit, never automatic (`client.ts:336-345`)                                                                             | `polaris.config.ts` (`packages/cli/src/sdkConfig.ts:47`)             | `client.boot()` ✓                                                                  |
| React          | `@polaris-key/react`, 10 subpaths                                                    | `<PolarisKeyProvider productSlug mode expectServices trust theme branding colorScheme …>` (`packages/sdk-react/src/react/Provider.tsx:41-96`); bearer mode (the default on a foreign origin) requires `trust.pinnedKeys` (`packages/sdk-react/README.md:28-34`)                                            | `polaris.config.ts` **without pins in the props** (`sdkConfig.ts:343-385`) | `boot()` in SP-12 (in review)                                                      |
| Python         | `polaris-key`                                                                        | `PolarisKeyClient.create(product_slug=, version=, trust={…}, expected_services=)`; auto-discovers **only when `expected_services` is absent** (`sdks/python/src/polaris_key/client.py:318-333`), and the generated config sets it                                                                         | `polaris_config.py`                                                  | `client.boot()` ✓                                                                  |
| Swift          | `polaris-key.PolarisKey` (10 SwiftPM products)                                       | `PolarisKeyClient.create(options:)` (`PolarisKeyClient.swift:320`), `init(options:)` (`:198`, no `start()`), `fromBundle()` reading `PolarisKey.plist` (`ClientBundle.swift:122`), and `createFromBundle` (an **offline** bundle, `:759`)                                                              | `PolarisConfig.swift` (`sdkConfig.ts:50`); the README says it writes `PolarisKey.plist` (`sdks/swift/README.md:76`) | `boot()` ✓                                                                         |
| Kotlin         | `im.plrs.key:polaris-key-*` (12 artifacts)                                           | `PolarisKeyClient.create(PolarisKeyClientOptions(core = CoreOptions(productSlug, version, pinnedKeys, …), update = …))` (`sdk/…/PolarisKeyClient.kt:631`), `PolarisKeyAndroid.client(context, …)` (`android/…/PolarisKeyAndroid.kt:73`), `PolarisKeyDesktop.client(…)` (`sdk/…/PolarisKeyDesktop.kt:72`) | `PolarisConfig.kt`                                                   | `ui.boot` moves into `:sdk` in SP-20 (in review)                                   |
| Godot          | addon `polaris_key` (autoload `PolarisKey`)                                          | `PolarisKey.configure(res)` / `await PolarisKey.boot()` from `res://polaris_key.tres` (`sdks/godot/README.md:82-112`); the dock's **Generate config** shells out to `pkey` (needs Node, `README.md:55-66`)                                                                                                | `polaris_key_config.gd`; the console gives a `.tres`; the dock edits the `.tres` | `PolarisKey.boot()` ✓                                                              |

**Cross-SDK naming drift on the calls every app makes:**

| Concept            | Node                                         | React                       | Python                        | Swift                                          | Kotlin                                           | Godot                                               |
| ------------------ | -------------------------------------------- | --------------------------- | ----------------------------- | ---------------------------------------------- | ------------------------------------------------ | --------------------------------------------------- |
| Product option     | `productSlug`                                | `productSlug`               | `product_slug`                | `productSlug`                                  | `CoreOptions.productSlug`                        | `product`                                           |
| Trust pins         | `trust.pinnedKeys`                           | `trust.pinnedKeys`          | `trust` (a bare dict)         | `pinnedKeys`                                   | `CoreOptions.pinnedKeys`                         | `pinned_trust_keys`                                 |
| Release pins       | `update.pinnedReleaseKeys`                   | —                           | `update=UpdateClientOptions(…)` | `pinnedReleaseKeys` (top level)              | `UpdateClientOptions(pinnedReleaseKeys)`         | `pinned_release_keys`                               |
| Services fallback  | `expectedServices`                           | **`expectServices`**        | `expected_services`           | `expectedServices`                             | `expectedServices`                               | `expected_services`                                 |
| Activate a key     | `license.activateWithKey`                    | (hook)                      | `license.activate_with_key`   | `activate(key:)`                               | `activate(key)`                                  | `license.activate_with_key` (`services/license.gd:149`) |
| Read config        | `config.getConfig(k, d)`                     | `useManagedConfig().get`    | `config.get_config`           | `config.config(k, default: .int(4))` + typed   | `config.config(k, JsonElement)` (`ConfigClient.kt:270`) | `config.get_value(k, d)` (`services/config.gd:134`) |
| Secret             | `config.getSecret`                           | unsupported                 | `config.get_secret`           | `config.secret`                                | `config.secret`                                  | `config.get_secret`                                 |
| Entitlement        | `license.isEntitled`, `entitlementValue`     | `useEntitlement`            | `is_entitled`                 | `license.isEntitled` **and** `isEnabled(flag:)` (`PolarisKeyClient.swift:602`) | `isEntitled`, `entitlementValue` | `is_entitled`, `get_entitlements`, `commerce.is_unlocked` |
| Change events      | `client.events` (EventEmitter)               | hooks                       | `on_change` callback          | `events` (`changes` deprecated)                | `events` + `licenseChanges`                      | signals `state_changed`, `config_changed`, …        |

`notes/SDK-PARITY-PASS.md` §3 states the rule ("one name per concept, camelCase in TS, Swift and
Kotlin, snake_case in Python and GDScript"), and `sdks/swift/README.md:87` claims "Names match the
other SDKs up to casing". **Nothing enforces it.** `parity.json` tracks features, not symbols.
`packages/sdk-node/test/examples.test.ts` only checks that names imported by the Node samples
exist.

### 2.2 Getting started: five generators and four proposed dialects

| Source                                                                    | What it emits                                                                                                                                                       | State                                                                                                                                                                          |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Console `sdkQuickStart.ts` (UX-59), shown in Overview's 550 px "Trust & SDK" panel (`Overview.tsx:1224-1300`) | Install snippets from `renderFeedSetup`, plus a per-SDK init with pins from the admin API (D16)                                                                     | Self-described as "Interim until UX-60's `renderSdkSetup` and UX-61's Connect your app replace it" (`sdkQuickStart.ts:15`). The React init (`:172-193`) **has no `trust`**, so an app on its own origin reports `invalid-options` |
| `pkey sdk --lang` (`packages/cli/src/sdkConfig.ts`)                       | A typed module per language from discovery (TOFU, with printed fingerprints)                                                                                        | The React module puts the pins in separate exports "for the desktop host" (`:349-356`), **not in the provider props**. The Swift module's doc comment uses `PolarisKeyClient(options:)`, which skips `start()` (`:434`) |
| `pkey sdk` without `--lang`, and `pkey trust` (`packages/cli/src/manifest.ts:272-294`, `index.ts:843-858`) | A Node snippet and a five-language pin block                                                                                                                       | The default base URL is `https://key.example.com` (`index.ts:849`), not production                                                                                             |
| Docs quick starts (`packages/docs/src/content/docs/build/quickstart/*.md`) | Hand-written, seven pages                                                                                                                                            | React: "browser on another origin … waits on bearer mode" (`react.md:36-41`), but bearer mode shipped; "neutral by default" (`:32`), but UI-KITS made the Polaris look the default. Kotlin: `PolarisKeyClient.create` on Android, skipping `PolarisKeyAndroid.client` and its Keystore store |
| SDK READMEs (703 / 540 / 875 / 877 / 545 / 1488 lines), rendered whole as the docs SDK pages (`build/sdks/*.mdx`) | Each has its own quick start, plus release notes ("Changes in the SDK parity pass", `sdk-react/README.md:19`) and internal programme ids (Godot 67, Kotlin 46, Swift 30 references such as "(P1-11)", "(SP-25)", "S-19 G11") | Swift claims `pkey sdk --lang swift --write` writes `PolarisKey.plist` (`sdks/swift/README.md:74-84`); the CLI writes `PolarisConfig.swift`                                     |

The designs then add four constructor shapes, none of which exists:

- `createClient(config)`, `PolarisKey.create(context, PolarisConfig)` (from a Gradle plugin, SP-K10, which is not a WP) and `polaris_key.create(...)`: `notes/SDK-PARITY-PASS.md:137-233`.
- `PolarisKey.client(product: "tidewater")`, `PolarisKey.client(context, product = …)`, `Client(product=…)` and `publishableKey`: `docs/design/UI-KITS.md:617-680`.
- `new PolarisKeyClient({ product: "diceroll" })`: `notes/S-17-user-data-sync.md:1415,1820`.
- `<PolarisKeyGate config={polarisKey}>`: `docs/design/SETUP.md` §3.5.

SETUP.md already found and fixed part of this on paper: D15 (one generator), D18 (`publishableKey`
does not exist, `SETUP.md:110`) and D30 (`pkey sdk add --expect`, no TOFU). **But the amendments
were never applied to UI-KITS §4.2, and UX-60/UX-61 are tracked only in
`docs/design/EXPERIENCE.md:1517-1521`, not in `workpackages.json`.** The config file name differs
three ways for the same file: SETUP §3.4 says `polaris-key.config.ts` and `polaris_key_config.py`,
the CLI writes `polaris.config.ts` and `polaris_config.py`, and Godot has `.tres`, `.gd` and the
console's `.tres`.

Discovery behaviour also differs. Node never discovers inside `create()`. Python discovers only
when `expected_services` is absent, which the generated config never leaves absent. The console
snippets call `discover()` explicitly, and the docs quick starts never do. `boot()` hides all of
this, and it exists, or is in review, in all six SDKs. **None of the five sources leads with it.**

### 2.3 In-app integration content

- **Console.** Overview's Trust & SDK panel is the only integration content
  (`console/pages/core/Overview.tsx:16,1224-1300`). No other page shows how to *use* what it
  configures. The Catalog page shows an entry's JSON schema (`pages/config/CatalogPage.tsx:453`)
  but not "read this key from your app". Edge-mint, tiers/entitlements, packs and identity show
  no SDK call. `CodeBlock` occurs in 12 files, and only `sdkQuickStart.ts` holds SDK code.
- **SETUP.md §3** (`docs/design/SETUP.md:1153-1290`) designs **Connect your app** at
  `#/p/<slug>/connect`. It has two steps for the developer, detects the SDK from builds and the
  repository (D45), offers the one command `pkey sdk add`, a pull request and a by-hand path,
  creates the test license automatically, and completes on the first **SDK sighting** (W15: a
  Core table `sdk_sightings` written from public requests carrying the SDK headers, D28). The
  design is sound. It stops at "connected", though: there is no per-service usage content and no
  dismiss.
- **The docs site is gated on the platform-admin session** (`packages/worker/src/docs.ts:1-25`,
  AGENTS rule 11). With per-product roles coming (owner brief RBAC), a product developer who is
  not a platform admin could not read the integration guides. The customer-facing `users/`
  section (`packages/docs/src/content/docs/users/index.md`) is unreachable for customers.

### 2.4 Docs site (developer side)

- Four overlapping "start" paths:
  - `start/quickstart.md` ("Quickstart by goal", 308 lines of manifests);
  - `build/quickstart/*` (seven SDK pages);
  - `build/onboarding.md` (401 lines, djdl as the worked example, 32 mentions; §5 "Engine + app changes (in the djdl repo)");
  - `start/index.md`.
- Service guides (`services/*`, 66 pages, about 135 code fences) are wire-oriented. **No guide has
  per-SDK tabs.** SP-D04 (`notes/SDK-PARITY-PASS.md:980`) was never made a WP. The "SP-D0x"
  items have no ids in `workpackages.json`.
- `build/ui/` has 24 component pages and a framework template (UK-16, done). Each page says "No
  kit documents X here yet" (for example `components/paywall.mdx`). `uiKits.ts` lists every must
  and should kit, including Vue, Svelte, Angular, React Native, Tauri, UIKit, AppKit, Android
  Views and Godot C#.
- Six example product names compete: djdl (42 files), acme (17), diceroll (15), tidewater (2),
  tonebox (1) and driftkart. The UI kits and baselines settled on **Tidewater**.
- No code block in the docs is compiled or type-checked. Only Godot has a CHANGELOG
  (`sdks/godot/CHANGELOG.md`). The others carry migration notes inside their READMEs.

### 2.5 Examples

- `examples/` holds five samples: `node-cli`, `node-express`, `node-electron`, `python-cli` and
  `python-renpy`. `examples/README.md` lists only the three Node ones and `ui/`. Two more samples
  live elsewhere: `sdks/godot/examples/minimal` and `sdks/kotlin/samples/cli`.
- Swift, React-web, Android/Compose and Godot (in `examples/`) have no sample. SDK-PARITY-PASS §4
  rates "Runnable sample app" ✗ for all six.
- `examples/ui/README.md` lists 15 kit samples. All are "Not yet", and UK-13/UK-14 add the first
  two (`terminal-python`, `terminal-node`).
- The samples use djdl with `REPLACE_WITH_…` keys (`examples/node-cli/polaris.config.ts`).
  `node-cli/cli.ts:13-27` wires the product facts in twice: once for `create()` and once for
  `registerPolarisCommands`. CI checks only Node import names and Python parse/compile
  (`sdks/python/tests/test_samples.py`). Nothing builds Swift, Kotlin, Godot or React samples.

### 2.6 UI kits

**Spec stack.** UI-KITS.md (1602 lines) is canonical but is amended by SIGN-IN.md (2147 lines:
§3.17 the one form, D-78–D-93), SETUP.md (D18), EXPERIENCE, BRAND and PORTAL. The UK briefs carry
three stacked amendment blocks each (for example `program/wp/UK-03-ui-core.md`: "Owner decision",
"Sign-in alignment", "One sign-in form").

**Status** (`program/workpackages.json`):

- **Done:** UK-01, UK-02, UK-02a, UK-15, UK-16, UK-40, and UK-30 (dropped).
- **In flight:** UK-13 and UK-14. Both branches are in review, though the dx-plan
  `workpackages.json` still lists them as `todo`.
- **Todo:** 37 ids, about 86 engineer-weeks at the midpoint:
  - must: UK-02b, UK-03 to UK-12, UK-41;
  - should: UK-17 to UK-29;
  - could: UK-31 to UK-39;
  - follow-ups: UK-42, UK-43, UK-44.
- The §5.1 matrix promises separate packages or products for elements, React, Electron, Vue,
  Svelte, Angular, React Native, Tauri, UIKit, AppKit, StoreKit paywall, visionOS, tvOS, Compose
  Android and Desktop, Android Views, Godot, Godot C#, Qt (Quick *and* QWidget), the terminal ×2,
  Ink, wx, Kivy, NiceGUI, Gradio, Flet, Tailwind, shadcn, MUI, Mantine and Chakra. §6.1 promises
  a sample per must and should kit, about 20.

**What the in-flight branches add:**

- **UK-14** (`/Users/vlad/Repos/pk-wt/UK-14`) restyles the sdk-node CLI and `pkey`. It adds a
  terminal stack under `packages/sdk-node/src/cli/term/*`, which `pkey` reuses through
  `@polaris-key/node/terminal` (`packages/cli/src/terminal.ts:14-30`), a shared `--json`
  envelope, and a **headless view-model layer inside sdk-node**,
  `packages/sdk-node/src/cli/models.ts` (693 lines, "the terminal kit's headless layer"). That
  layer is the same state machines UK-03's `@polaris-key/ui-core` is specified to own.
- **UK-13** (`/Users/vlad/Repos/pk-wt/UK-13`) seeds the Python ui-core where UK-12 expects it
  (`sdks/python/src/polaris_key/ui/core/{models,copy,identity,theme}.py`) and adds
  `ui/terminal/*` and an optional Textual app. This is the right shape.
- **HA-12** (`/Users/vlad/Repos/pk-wt/HA-12`) adds `core.presentation` to discovery and
  `@polaris-key/client-core/presentation`, with a presentation-matrix corpus. It is wire-touching
  and its plan is approved. HA-13 and HA-14 port it into every SDK. The kits read it through one
  `PresentationSource` seam.
- **LX-08** is server-only (the licensing expand). Its SDK impact arrives later through LX-18 and
  LX-19 (the licence document v2).

**Kit-touching feature packages outside the UK phase** each edit today's four kits, the same kits
UK-05, UK-07, UK-09 and UK-11 rebuild:

- I-10a ("plus the React activation component") and I-10b ("plus `PolarisKeyUI`, the Kotlin
  activation component and the Godot UI", `program/wp/I-10b-…md:1`);
- PX-W9b ("the four UI kits' entries line and refusal screen");
- LX-19 ("six SDKs and four UI kits");
- CM-15, I-24b, U-08 ("merge prompt components in the four UI kits"), and U-13/U-25 (conflict views);
- HA-13 and HA-14 (kit defaults).

UK-06 (a new `@polaris-key/electron` package with `registerPolarisKey` and `exposePolarisKey`)
duplicates what `@polaris-key/node/electron` already ships (`exposePolarisBridge`, the preload
import and `SafeStorageStore`, `packages/sdk-node/README.md:121-157`), and SP-31 (bridge v4 in
the same module).

### 2.7 Cloud Sync from the SDK's side

- The settings sync state machine lives in client-core (`packages/client-core/src/cloud-sync.ts`,
  1347 lines). `sync-scenarios.json` pins it (U-18, done). Four SDKs (Python, Swift, Kotlin,
  Godot) must port it: U-06, U-07 and U-21. React and Node share client-core.
- **Shipped names**, from SP-13, SP-18 and SP-24 (`config.local`):
  - `config.set`, `config.clear`, `config.setting(key)` and `onConfigChange` (Node
    `packages/sdk-node/README.md:88`, Swift, Godot, Kotlin);
  - React `useConfigSetting(key)`.
- **Planned names** collide with those:
  - U-06's title and goal use `setConfig`, `clearConfig`, `settingState` and `onChange`
    (`program/wp/U-06-sdk-settings-node-python.md:1,24`);
  - S-17 §5.11 sketches `setConfig` for Node and Python but `config.set` for Swift and Kotlin,
    `set_value` for Godot, `useSetting` for React, a new `cloudSync.status()`, and Godot's
    `settings_changed` and `status_changed` signals (`notes/S-17-user-data-sync.md:1397-1500`).
- Three data models are planned, each in six SDKs and with its own docs half:
  - settings (U-06, U-07, U-20, U-21; docs U-15a);
  - saves (U-13, U-25; docs U-15b);
  - collections (U-22, U-23; docs U-15c);
  - plus live pokes (U-14) and the merge prompt (U-08).

---

## 3. Problems (ranked)

| #   | Problem                                                                                                                                                                                                                                                                                                                                                                                                                         | Evidence                                                                                                                                                                                                                                                                                                                                                                 | Impact |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| P1  | **First-run snippets are wrong for the common web case.** Neither generator gives a React app on its own domain (bearer mode, the default) its trust pins, so the Provider reports `invalid-options` and makes no request. The docs quick start says that case is not supported.                                                                                                                                                  | `sdkQuickStart.ts:172-193` (no `trust`); `sdkConfig.ts:343-385` (pins exported separately "for the desktop host"); `sdk-react/README.md:28-34` (bearer needs `trust.pinnedKeys`); `build/quickstart/react.md:36-41` (stale)                                                                                                                                                  | high   |
| P2  | **Five generators, four proposed dialects, three file names for one config.** No single source of truth for "how do I start". Every service WP that adds an SDK call has nowhere to put its snippet once.                                                                                                                                                                                                                        | §2.2; `SETUP.md:107` (D15 says one generator), never built (UX-60 absent from `workpackages.json`)                                                                                                                                                                                                                                                                         | high   |
| P3  | **API vocabulary drift across SDKs, and new forks planned.** `getConfig`, `config`, `get_value`; `isEntitled`, `isEnabled(flag:)`, `is_unlocked`; `expectServices` and `expectedServices`; `trust`, `pinnedKeys`, `pinned_trust_keys`. U-06, U-20 and S-17 add `setConfig`, `settingState`, `onChange` and `useSetting` beside the shipped `config.set`, `setting` and `onConfigChange`, and `useConfigSetting`.                   | §2.1 table; `U-06…md:1`; `S-17…md:1397-1500`; `sdk-node/README.md:88`                                                                                                                                                                                                                                                                                                         | high   |
| P4  | **The UI-kit matrix far exceeds demand and doubles work with feature WPs.** Of 37 open UK ids (about 86 engineer-weeks), about 21 are should or could framework packages (about 40 engineer-weeks) whose value is speculative. A dozen feature WPs build UI into the old kits that UK-05, UK-07, UK-09 and UK-11 rebuild, so every screen is built twice. UK-06 duplicates `@polaris-key/node/electron` and SP-31.                         | `workpackages.json` estimates; `I-10b…md:1`; `PX-W9b`, `LX-19`, `U-08` titles; `UK-06…md` vs `SP-31…md` and `sdk-node/README.md:121-157`                                                                                                                                                                                                                                       | high   |
| P5  | **The in-app Integration content is missing and its WPs are untracked.** There is nothing per service in the console, and UX-60/UX-61 (Connect your app) live only in EXPERIENCE.md's table. The owner's Integration section and dismiss-after-handshake have no owner WP and no data source beyond W15 sightings.                                                                                                                | `Overview.tsx:1224-1300`; `EXPERIENCE.md:1517-1521`; `grep UX-6[01] workpackages.json` → 0                                                                                                                                                                                                                                                                                  | high   |
| P6  | **Too many option knobs to start.** Every SDK needs product, base URL, version, trust pins, release pins and expected services. Kotlin nests them two deep and Python's discovery default flips on one of them. All of them are derivable facts.                                                                                                                                                                                  | §2.1; `client.py:318-333`; `PolarisKeyClient.kt:631`                                                                                                                                                                                                                                                                                                                       | medium |
| P7  | **Docs are not developer-shaped.** Four start paths, one of them product-specific (djdl). READMEs of up to 1488 lines carry internal WP ids and release notes. No per-SDK tabs exist in the service guides. Code blocks are not compiled. Customer docs are behind the admin gate, and developer docs will become unreachable for product-scoped roles.                                                                            | §2.4; `docs.ts:1-25`                                                                                                                                                                                                                                                                                                                                                       | medium |
| P8  | **Examples are thin, scattered and unbuilt.** Only Node and Python samples exist under `examples/`, with Godot and Kotlin samples elsewhere. They use the djdl product with placeholder keys. Nothing builds them beyond import-name checks. The `examples/ui` hub is all "Not yet".                                                                                                                                                | §2.5                                                                                                                                                                                                                                                                                                                                                                       | medium |
| P9  | **Duplicate headless layers in flight.** UK-14 puts the terminal view models in `sdk-node/src/cli/models.ts`, while UK-03 specifies `@polaris-key/ui-core` for the same state machines, so the JS side will have two keyVerdict/DeviceLimit/Update models. UK-13 put Python's under `polaris_key.ui.core` correctly. React's `core` subpath is a third JS headless layer.                                                                | UK-14 `models.ts:1-8`; `UK-03…md` ("grows from `@polaris-key/react/core`")                                                                                                                                                                                                                                                                                                  | medium |
| P10 | **Cloud Sync SDK surface is too wide for a first ship.** Three data models × six SDKs × docs, plus a merge-prompt framework and live pokes, all plan-mode. Collections (U-09, U-22, U-23, U-11c, U-15c, U-24b, U-16, U-17) add a third client API before settings or saves have users.                                                                                                                                              | §2.7                                                                                                                                                                                                                                                                                                                                                                       | medium |
| P11 | **Spec stacking makes the kit contract hard to read.** Kit behaviour is defined across UI-KITS, SIGN-IN, SETUP, EXPERIENCE and PORTAL, and each UK brief carries 2 to 3 superseding blocks. The data (components.json, the copy catalog, the fixtures) is the real contract but is not presented as one.                                                                                                                            | `UK-03…md`; `packages/brand/kit-copy/components.json`                                                                                                                                                                                                                                                                                                                      | low    |
| P12 | **Small correctness and copy defects.** `pkey sdk` defaults to `https://key.example.com` (`index.ts:849`). The Swift README misstates the generated file (`README.md:76`). The Kotlin Android quick start skips `PolarisKeyAndroid`. "Bundle" means two things in Swift (`fromBundle` for the app bundle, `createFromBundle` for an offline bundle). `PKeyBrand.generated.cs` is generated with no consumer until UK-29.               | as cited                                                                                                                                                                                                                                                                                                                                                                   | low    |

---

## 4. Owner brief: item-by-item stance

| Brief item                                                                                                     | Stance       | Rationale and what it means here                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| General: consolidate similar features                                                                          | **adopt**    | One config file, one start call, one snippet generator, one API vocabulary, one examples tree. Fold the Vue, Svelte, Angular and Tauri packages into recipes over the elements, and UIKit, AppKit and Android Views into hosting recipes.                                                                                                                                                                                                                                                  |
| General: flexibility, to an extent                                                                             | **adopt**    | Keep the kits' three layers (drop-in, styled parts, headless) and the low-level `create(options)`. Remove the *required* knobs: version, pins and services come from the config file and the platform.                                                                                                                                                                                                                                                                                       |
| General: reduce configuration surface area                                                                     | **adopt**    | Zero required options in the common path (`fromConfig()` + `boot()`). The React provider collapses `theme`, `branding` and `colorScheme` into `theme`. Drop the Gradle-plugin idea (SP-K10), because a resource file needs none.                                                                                                                                                                                                                                                            |
| General: onboarding with wizards, example code and automatic configuration                                    | **adopt**    | Connect your app (UX-61) plus a per-service Integration section rendered from one generator with the product's **real** keys (catalog keys, entitlement names, pack ids, mint names). Each SDK CI compiles the goldens. A test license is made automatically (SETUP §3.6). `client.doctor()` prints actionable fixes with console deep links.                                                                                                                                                |
| General: automate without the user's intervention                                                              | **adopt**    | Version is auto-detected (bundle, `package.json`, project setting, `versionName`). The SDK, its platform kit and the feed are detected from builds and the repository (D45). `pkey sdk add` writes the registry line, the dependency and the config file. The pull-request path commits them. The test license is created. The Godot dock gets the JSON from the console without Node.                                                                                                        |
| General: degrade gracefully when a service is off                                                              | **adopt**    | The SDKs already return typed `service-unavailable` and `unsupported(product)` and fail closed on capabilities. Extend this to content: Integration shows only enabled services (disabled ones get "Turn on …"). Kits render only what discovery advertises (already the rule, I-10a "Identity off"). `doctor()` explains why a call is refused.                                                                                                                                             |
| Products: Integration section with code samples, per-service instructions, in-app docs                         | **adapt**    | Build it as the console's Connect your app page plus per-service panels, rendered from `renderSdkSetup` + `renderUsage` in `@polaris-key/manifest` (SDX-02). The docs site becomes the generated *secondary* view of the same content. In-app is primary (the docs gate cannot reach every developer, §2.3).                                                                                                                                                                                  |
| Products: dismiss the section after a handshake and data exchange end to end; user choice                      | **adapt**    | Offer **Hide integration** only after an *end-to-end* exchange is verified: an SDK sighting **and** a signed document served to that SDK (licence, config or feed), from W15 sightings extended with `servicesSeen` (SDX-03). Store the dismissal per product in `setup_state` (UX-51). Never auto-hide. The section collapses to one "Connected · Swift 2.1, Node 1.8 · Connect another app" line, and planned platforms not yet seen stay as a quiet hint, which covers "they might release multiple platforms". |
| Licenses: bound vs floating, auto-minting at sign-in                                                           | **adopt** (client side) | No new SDK API. The kits' one sign-in form (LicenseChoice and Done, UK-42/43) renders both cases. Minted-at-login needs no key on the device, which `boot()` already handles.                                                                                                                                                                                                                                                                                                                |
| Licenses: entitlements explicit, sub-licences, multiples, redemption status                                    | **adapt**    | Give the SDKs **one `entitlements` namespace**: `has`, `value`, `quantity` (once LX-18 serves it) and `grants`. Deprecate `isEnabled(flag:)`, `commerce.is_unlocked` and the `entitlementValue` spellings. **Consumable redemption** (`consume(name, n)`) is a wire change (a new route and a signed field). Defer it to the licensing domain as plan-mode; the SDK name is reserved now.                                                                                                     |
| Licenses: subscriptions (lifetime, expiry, version-bound, renewable, perpetual fallback)                       | **adopt** (client side) | The SDK reads only what the licence document says: `licenseExpiresAt()` and status reasons (LX-19), plus `offers()` and `purchase()` (CM-15). Version-bound and perpetual-fallback eligibility is decided server-side in the signed feed, so no SDK logic. One Paywall component (must, §4.1) covers it.                                                                                                                                                                                       |
| Managed Config: regular, secret, edge-minted types                                                             | **adapt**    | Canonical SDK verbs: `config.get(key, fallback)`, `config.secret(key)`, `config.mint(name)`. Keep `getConfig`, `get_config`, `get_value`, `getSecret` and `mintToken` as deprecated aliases for one minor version. The types stay separate in the API because their security differs (secrets are refused on web, mint is a network call).                                                                                                                                                     |
| Managed Config: visible changeable, visible read-only, invisible                                               | **adopt**    | `config.setting(key)` exposes `locked` and `visible`. The Settings kit component renders only visible keys and greys out locked ones. This depends on the config domain's state names. The SDK only reads the flags the document or catalog already carry.                                                                                                                                                                                                                                  |
| Managed Config: all entries syncable                                                                           | **adapt**    | Admin-managed values are already consistent everywhere because they are server-sourced. "Syncable" applies to user-writable keys, which sync through the same `config.set` once signed in. No second API.                                                                                                                                                                                                                                                                                       |
| Cloud Sync: config entries, assets and session state, conflict handling                                        | **adapt**    | Ship **settings** (on `config.*`) and **saves** (blob slots on `cloudSync.saves`, downloaded through the existing verified-fetch engine) first. Use one `MergeRequest` type for conflicts. **Defer collections** (U-22, U-23 and their backend and docs halves) until settings and saves have adopters. Collections are a third data model in six SDKs that the brief's list does not need.                                                                                                    |
| Cloud Sync: easy SDK access to sync info and assets, reuse managed-config conventions, no duplicated logic     | **adopt (strongly)** | No `setConfig`, `clearConfig`, `settingState`, `onChange`, `useSetting` or `status_changed`. Settings use the shipped `config.set/clear/setting`. Sync state lives on the setting handle (`setting.sync: {pending, lastSynced, conflict}`). Status is one more `events` kind (`cloudSync`). Saves reuse `release.fetch`'s Range, If-Range and SHA-256 machinery.                                                                                                                            |
| Release/Updates: Sparkle and friends, stable/beta/dev channels                                                 | **adopt** (client side) | The drivers exist (Node `update/drivers/*`, Swift `PolarisSparkle`, Godot outlets). ChannelPicker stays **should**, and `channelChoices()` and `setChannel()` (Kotlin) become the canonical cross-SDK names in SDX-04.                                                                                                                                                                                                                                                                         |
| Feeds: protect Polaris Key feeds behind tokens; developers see SDKs, customers don't                           | **push back** (for the SDK namespace) | Gating the `polaris-key` SDK packages adds a credential to every app build: CI, Docker, Xcode Cloud, Gradle offline, and fresh machines. The Godot AssetLib and Asset Store clients cannot send credentials at all. Recommend making SDKs **unlisted for customer tokens but anonymously fetchable by exact name**, which meets "customers don't see our SDKs" without breaking installs. If the owner still wants hard gating, SDX-07 automates it: `pkey sdk add` mints a read-only developer token and writes it to *user-level* config, never the project, CI uses `pkeyci_` tokens, and the Godot dock installs the addon itself. This is a feeds-domain decision. |
| Identity: sign in from games, TV, CLI, TUIs                                                                    | **adopt**    | Device code with QR (TV, console), the terminal kits (UK-13/UK-14, in flight), loopback for CLIs (I-15), and one sign-in form in every kit (SIGN-IN §3.17). Consent with partial data sharing belongs to the identity domain; it lands as one step state in `SignInModel`.                                                                                                                                                                                                                   |
| RBAC: per-product roles                                                                                        | **adopt** (dependency) | The docs gate must follow RBAC. Developer sections (`start/`, `build/`, `services/`, `reference/`) are readable by any console role. Operator sections (`admin/kek`, `deploy`, the runbook) stay platform-admin only. The customer `users/` pages move into the portal.                                                                                                                                                                                                                       |
| Code-quality audits: duplication, smells, consistency                                                          | **adopt**    | Duplicates in this domain: five snippet generators; three JS headless layers (react/core, sdk-node/cli/models.ts, the planned ui-core); `@polaris-key/electron` vs `node/electron`; README vs docs vs generator content; a six-name example-product zoo.                                                                                                                                                                                                                                    |

---

## 5. Target design

### 5.1 One config file, one start call

**`polaris-key.json`** is the single, language-neutral product-facts file:

```json
{
  "$schema": "https://key.plrs.im/schemas/v1/sdk-config.schema.json",
  "configVersion": 1,
  "product": "tidewater",
  "baseUrl": "https://key.plrs.im",
  "pins": {
    "trust": { "tidewater-2026-a": "…", "tidewater-2026-b": "…" },
    "release": { "tidewater-rk-2026": "…" }
  },
  "services": ["license", "config", "identity", "update"]
}
```

- **Where it comes from.**
  - The console's Connect your app offers **Download** (the authenticated admin API is the
    source, D16; active and staged pins).
  - The console's pull request writes it (UX-70).
  - `pkey sdk add <lang> --expect …` writes it (D30, no TOFU).
  - The Godot dock offers **Import file…**, so it no longer needs Node.
- **Who reads it.** Every SDK reads it at runtime from a **local packaged resource only**, never
  the network:

  | SDK    | Where it reads the file                                  |
  | ------ | -------------------------------------------------------- |
  | Node   | beside `package.json`, or a passed import                |
  | React  | JSON import bundled at build time                        |
  | Python | path or package data                                     |
  | Swift  | bundle resource; `PolarisKey.plist` still read as legacy |
  | Kotlin | Android `assets/`, JVM classpath                         |
  | Godot  | `res://polaris-key.json`; the export plugin adds it to the filter, as it does `pkey_packs/*` |

- **Schema and fixtures.** The JSON Schema lives in
  `packages/shared-manifest/schemas/v1/sdk-config.schema.json`. A shared fixture set at
  `conformance/sdk-config/` (valid, unknown service, bad pin and similar) is replayed by each
  SDK's loader test. This is **not wire**: it is not a signed document, not the corpus and not
  `PROTOCOL_VERSION`.
- **Canonical start in every SDK.**

  | SDK    | Start                                                                                     |
  | ------ | ----------------------------------------------------------------------------------------- |
  | Node   | `const pk = await PolarisKeyClient.fromConfig(); await pk.boot();`                        |
  | React  | `<PolarisKeyProvider config={polarisKey}>` (the kit: `<PolarisKeyGate config={polarisKey}>`) |
  | Python | `pk = PolarisKeyClient.from_config(); pk.boot()`                                          |
  | Swift  | `let pk = try await PolarisKeyClient.fromConfig(); await pk.boot()`, or `.polarisKeyGate(pk)` |
  | Kotlin | `PolarisKeyAndroid.client(context)` / `PolarisKeyDesktop.client()` (reads the file), `boot()` |
  | Godot  | `await PolarisKey.boot()` (reads the file when no `.tres` overrides it)                   |

- **Version** is auto-detected wherever the platform knows it: Node (`package.json` or Electron),
  Swift (`CFBundleShortVersionString`), Godot (the project setting) and Android (`versionName`).
  Python and the plain JVM keep a required `version`.
- **`boot()` is the documented first call everywhere.** It already composes discovery, guard,
  sync, register or enrol, gate, decide and packs, so the Node/Python discovery split disappears.
  `create(options)`, `discover()` and `sync()` stay as the advanced, low-level path.
- **`client.doctor()`** (a new parity id `core.doctor`, a client-only proof) returns typed checks
  with console deep links. It reuses `pkey doctor`'s checks and prints once in debug builds on
  the first refusal:
  - pins vs discovery fingerprints;
  - services expected vs advertised;
  - semver version;
  - store status;
  - clock;
  - web origin not in `web.origins`.

### 5.2 One API vocabulary

A registry, `conformance/parity/api.json` (generated docs page `reference/api-names.mdx`, rule 3
family), lists each canonical concept with its spelling per SDK. Each SDK's test asserts that the
symbols exist, and deprecated aliases carry a `deprecated` row with a removal version. The
canonical set:

| Concept              | Canonical (camel / snake)                                                                                     | Deprecated aliases (kept one minor)                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Start                | `PolarisKeyClient.fromConfig()` / `from_config()`; `boot()`                                                   | Swift `fromBundle()` (alias); `createFromBundle` → `createFromOfflineBundle`            |
| Options              | `product`, `baseUrl`, `pins.trust`, `pins.release`, `services`                                                | `productSlug`, `trust.pinnedKeys`, `pinnedKeys`, `pinned_trust_keys`, `expectServices`, `expectedServices` (accepted, mapped) |
| Gate                 | `isLicensed()`, `status()`                                                                                    | Kotlin `isUsable(status())` stays as a helper                                           |
| Activate             | `license.activate(key)`                                                                                       | `activateWithKey`, `activate_with_key`                                                  |
| Config               | `config.get(key, fallback)`, `config.secret(key)`, `config.mint(name)`, `config.set/clear/setting(key)`       | `getConfig`, `get_config`, `get_value`, `config.config`, `getSecret`, `get_secret`, `mintToken`, `mint_token` |
| Entitlements         | `entitlements.has(name)`, `.value(name)`, `.quantity(name)` (LX-18), `.grants()`                              | `license.isEntitled`, `isEnabled(flag:)`, `entitlementValue`, `commerce.is_unlocked`    |
| Sign-in              | `identity.signIn(...)` (I-10a/b `signIn.start` and `session.*`), `identity.subject()`, `identity.signOut()`  | `signInWithBrowser`, `beginSignIn/pollSignIn/waitForSignIn` (internal)                  |
| Events               | `events` (one stream, kinds `license`, `config`, `updateAvailable`, `packs`, `store`, `cloudSync`)            | Swift `changes`; Kotlin `licenseChanges`; Godot keeps signals but adds `event(kind, data)` |
| Cloud Sync           | settings on `config.*`; `cloudSync.saves.*`; `cloudSync.flush()`; `cloudSync` events                          | never ship `setConfig`, `settingState`, `onChange`, `useSetting` or `status_changed`    |

React hooks follow the same nouns. `useConfig(key)` is the one-key hook, with `useConfigSetting`
kept as an alias. `useEntitlement(name)` stays.

### 5.3 One integration content source

**`packages/shared-manifest/src/integration/`** (SDX-02, absorbing UX-60):

- **`renderSdkSetup(lang, ctx)`**: install from `renderFeedSetup` (the registry line first), the
  `polaris-key.json` body, and the start snippet. The start snippet is the kit drop-in for UI
  SDKs, with a headless tab.
- **`renderUsage(service, lang, ctx)`**: one short block per enabled service, built from the
  product's real facts in `ctx`:
  - **License**: gate, `entitlements.has("<real entitlement from tiers>")`, the test-licence
    activation;
  - **Config**: `config.get("<real catalog key>", <catalog default>)` typed by the catalog
    schema, `config.secret`, `config.mint("<real mint name>")`, the Settings drop-in;
  - **Identity**: the sign-in drop-in, `identity.subject()`;
  - **Update**: the outlet-appropriate driver for the product's platforms (Sparkle on macOS,
    Velopack or electron-updater on Windows, store on mobile);
  - **Packs**: `packs.ensure("<real pack id>")`;
  - **Cloud Sync**: the `user.sync` catalog line plus `config.set`, and saves;
  - **Commerce**: `commerce.purchase("<real offer>")` and the Paywall drop-in.
- **`sdkFit(platforms, repoSignals)`**: platform → recommended SDK and kit (macOS → SwiftUI,
  Electron or Godot; Windows → Electron, Compose Desktop, Godot or Qt; Android → Compose or
  Godot; web → React or the elements; CLI → Node or the Python terminal kit), feeding D45.
- **Goldens** live in `packages/shared-manifest/test/fixtures/integration/<lang>/…` and are
  **compiled in each SDK's CI** (`tsc`, `python -m py_compile` plus an import check,
  `swiftc -parse`, `kotlinc`, the Godot loader), as SETUP §3.4 already specified for setup.

**Consumers, each a view of the generator:**

| Consumer                               | How it uses the generator                                                                                     |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Console Integration / Connect your app | real `ctx` from the admin API                                                                                 |
| `pkey sdk add` and `pkey sdk --lang`   | prints and writes the file                                                                                    |
| Docs                                   | `gen:integration` renders `build/quickstart/<sdk>.md` and the per-SDK tabs in each `services/*` guide from a Tidewater fixture `ctx`, as a new GENERATED family under rule 3 with `--check` |
| READMEs                                | shrink to install + start (the golden) + a link                                                               |

Deleted:

- `Overview.tsx`'s snippet code and `sdkQuickStart.ts` `sdkInit`;
- `cli/src/manifest.ts` `sdkSnippet` and `trustSnippet`;
- the six renderers in `cli/src/sdkConfig.ts`, which collapse to one JSON writer;
- the hand-written quick starts.

### 5.4 The Integration section (content and state; the console layout is the console domain's)

- **Connected** means a W15 sighting from the product (any SDK header-bearing request). This is
  the existing D28 rule.
- **End-to-end** means a sighting whose row also records that a signed document was served
  (`servicesSeen` includes `license`, `config` or `update`). SDX-03 adds `services_seen`, a small
  bitmask on `sdk_sightings`, set by the same `waitUntil` upsert. It has no IP, device or licence,
  and is not wire.
- **Per-service checks** come from the same `servicesSeen`, plus facts the console already reads:
  first activation for License, first app sign-in for Identity, first Cloud Sync push, and first
  store claim. Each Use-it panel shows ✓ with "seen from Swift 2.1 · iOS arm64 · 3 min ago".
- **Dismiss.** Once end-to-end holds, the section shows **Hide integration**. The choice is
  stored in `setup_state` (UX-51), per product. The page becomes one line in Overview plus a nav
  entry "Integration" that reopens it. Platforms in `distribution.intendedPlatforms` without a
  sighting stay as a quiet "Not seen yet: Android" row, never a nag. Turning on a new service
  later re-surfaces that service's panel, which is not a regression of the dismissal.

### 5.5 Cloud Sync ergonomics

- **Settings** extend the shipped surface:
  - `config.set`, `clear` and `get` are unchanged;
  - `config.setting(key)` gains `.sync` (`pending`, `lastSynced`, `scope`, `conflict`);
  - `events` gains `cloudSync` (`state`, `pending`);
  - the existing config-change event gains `origin` (`local`, `remote`, `merge`, `migration`,
    `admin`).
- **Saves** live under `cloudSync.saves.{list, read, write, revisions}`. Read downloads through
  each SDK's existing verified-fetch transport (`release.fetch`'s Range, If-Range, size and
  SHA-256, already in six SDKs: SP-19, SP-25, Node and Kotlin), not a new downloader.
- **Conflicts.** One `MergeRequest` type with `keep("local" | "remote" | "both")` in every SDK.
  Kits render it through ui-core and the native cores (the rebuilt kits only).
- **Collections are deferred.** U-22, U-23 and the U-09 backend (cross-domain) wait for adopter
  demand after settings and saves.

### 5.6 UI kits: a reduced matrix, and one rule against double work

**Must** (unchanged intent, trimmed scope):

| Kit                            | Ids                  | Change                                                                                                     |
| ------------------------------ | -------------------- | ---------------------------------------------------------------------------------------------------------- |
| ui-core                        | UK-03                | also absorbs UK-14's `sdk-node/src/cli/models.ts` and `@polaris-key/react/core`'s state                    |
| Elements                       | UK-04                | gains UK-22's Tailwind v4 preset and CSS-variable recipe                                                   |
| React                          | UK-05                | takes `config`; one `theme` prop                                                                           |
| Electron                       | UK-06                | **inside `@polaris-key/node/electron`**: bridge v4 = SP-31, plus menus, notifications and updater progress; **no new package** |
| SwiftUI                        | UK-07, UK-08         | include UIKit and AppKit hosting recipes and the Paywall over StoreKit 2, which absorbs UK-23, UK-24 and UK-25 |
| Compose Android                | UK-09                | includes the `ComposeView`/Activity recipe, absorbing UK-28                                                |
| Compose Desktop                | UK-10                | owner decision; unchanged                                                                                  |
| Godot                          | UK-11                | unchanged                                                                                                  |
| Qt                             | UK-12                | **Qt Quick drop-in plus the Python ui-core only**; drop the QWidget layer (b), with a `QQuickWidget` embedding recipe |
| Terminals                      | UK-13, UK-14         | in flight                                                                                                  |
| Close-out and follow-ups       | UK-41, UK-42, UK-43, UK-44 | UK-41 scope shrinks to the reduced matrix                                                            |

**Recipes, not packages:** UK-31 absorbs UK-17, UK-18 and UK-19 (Vue, Svelte, Angular over
`<pk-*>`: custom elements work natively there) and UK-21 (Tauri: React bearer mode or the
elements in the webview; no Rust plugin).

**Deferred to an icebox list**, with no WP ids active and reopened on a product's demand:

| Id                     | Area                                                    |
| ---------------------- | ------------------------------------------------------- |
| UK-20                  | React Native                                            |
| UK-26                  | visionOS                                                |
| UK-27                  | tvOS                                                    |
| UK-29                  | Godot C#, with X-01                                     |
| UK-32                  | Ink                                                     |
| UK-33                  | watchOS                                                 |
| UK-34                  | WidgetKit                                               |
| UK-35                  | Android TV and Glance                                   |
| UK-36                  | editor dock restyle                                     |
| UK-37                  | Godot web overlay                                       |
| UK-38, UK-39           | wx, Kivy and Python web UIs                             |
| UK-22's other parts    | the shadcn registry route, the MUI, Mantine and Chakra objects |

This is about 40 of about 86 open engineer-weeks moved out of the active plan.

**The kit rule** (process, recorded in UI-KITS.md and the program README):

1. Feature WPs deliver SDK calls plus **layer (c)** only: a view-model state in ui-core or the
   native presentation cores, copy keys, and UK-02b fixtures.
2. The **rendering** of a new state lands in the rebuilt kit (UK-05, UK-07, UK-09, UK-11, UK-12
   and the terminals), by whoever owns that kit, or as a small "kit delta" checklist the feature
   WP hands to the kit owner.
3. Until a kit's rebuild merges, **nobody edits that kit's old components** except for
   correctness fixes.

This removes the second build of every activation, entries, refusal, merge and conflict screen.

### 5.7 Examples: one tree, one product, built in CI

`examples/<sdk>-<host>/` is the single samples tree (the `examples/ui/` hub merges in):

| Folder                   | Contents                                                       |
| ------------------------ | -------------------------------------------------------------- |
| `node-cli`               | the terminal kit; replaces `ui/terminal-node`                  |
| `node-server`            | Express middleware                                             |
| `electron`               |                                                                |
| `react-web`              | Vite; Next.js as a recipe page                                 |
| `elements-html`          |                                                                |
| `python-cli`             | the terminal kit                                               |
| `python-qt`              |                                                                |
| `python-renpy`           |                                                                |
| `swiftui`                | one multiplatform project                                      |
| `compose-android`        |                                                                |
| `compose-desktop`        |                                                                |
| `kotlin-cli`             | moved from `sdks/kotlin/samples/cli`                           |
| `godot`                  | moved from `sdks/godot/examples/minimal`                       |

Every sample:

- uses the **Tidewater** fixture product and a checked-in fixture `polaris-key.json`;
- runs offline on the SDK's fixture adapters, with `--live` for a real Worker;
- is built in CI on its SDK's lane: typecheck for TS, `py_compile` for Python, `swift build` on
  the macOS lane, Gradle on the Kotlin lane, and the Godot headless import.

Docs never paste sample code. Long samples are linked, and short snippets come from the
generator.

### 5.8 Docs, reshaped for developers

| Section               | Content                                                                                                                                                                                                                                                              |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Start**             | `start/index.md` (concepts) plus **one** "Your first product" path that mirrors the console: create, Connect your app, the Integration panels. `start/quickstart.md` (goal manifests) becomes a section of `build/manifest/`. `build/onboarding.md` (djdl) moves to `admin/` as a migration case study or is retired. |
| **Build**             | Generated `quickstart/<sdk>.md` (§5.3); `sdks/<sdk>` pages that are **reference only** (the README minus quick start and release notes); `ui/` scoped to the reduced matrix; one **Developer changelog** page per lockstep version replacing in-README "Changes in …" sections. |
| **Services**          | Every guide gets a generated "In your app" block with per-SDK tabs (`syncKey: "sdk"`), which closes SP-D04.                                                                                                                                                           |
| **Hygiene**           | Programme ids (`P1-11`, `SP-25`, `S-19 G11`, `D-21`) are removed from READMEs and docs prose and stay only in `docs/research`. A lint (`check:links` or the ui-qa string lint) flags `\b(SP|UK|P\d|LX|PX|HA|U|I)-\d+` in developer pages. |
| **Audience gate** (with RBAC) | `docs.ts` maps path prefix to capability: developer sections need any console role, operator sections need platform-admin. Customer `users/*` content moves into the portal (in-app help), which follows the owner's in-app principle.                         |

### 5.9 Graceful degradation, end to end

| Surface     | Behaviour                                                                                                                                                              |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SDK         | already typed: `service-unavailable` before any request, and `supports()` with the reason `product`, `runtime`, `version` or `dependency`. `doctor()` now explains it in words and links to the console toggle. |
| Kits        | render only advertised services (I-10a "Identity off", Paywall hidden without Commerce or a store outlet). This is a rule for the kit fixtures (UK-02b adds service-off fixture rows). |
| Integration | renders only enabled services. Disabled ones get one "Turn on <Service>" row with its chain (SETUP §4.1 rule 1).                                                         |
| Docs        | generated SDK tabs say "not available on <runtime>" from `parity.json` instead of hiding a tab silently.                                                               |

---

## 6. Surface-area reduction

**Generators and config:**

- **Five snippet generators collapse into one.** The console `sdkQuickStart.ts sdkInit`, CLI
  `sdkConfig.ts` (6 renderers), `manifest.ts sdkSnippet`/`trustSnippet`, the hand-written quick
  starts and the README quick starts are replaced by `renderSdkSetup` + `renderUsage`.
- **Six per-language config modules become one `polaris-key.json`.** Removed:
  `polaris.config.ts`, `polaris_config.py`, `PolarisConfig.swift`, `PolarisConfig.kt`,
  `polaris_key_config.gd` and the console `.tres`. `PolarisKey.plist` and `.tres` stay readable
  as legacy.
- **Four proposed constructor dialects are dropped** (`createClient`, `PolarisKey.client(...)`,
  `new PolarisKeyClient({product})`, `publishableKey`), along with the SP-K10 Gradle plugin idea.
- **About 15 option names become 5** (`product`, `baseUrl`, `pins.trust`, `pins.release`,
  `services`), with the old names accepted as aliases.

**APIs and kits:**

- **About 20 duplicate verb spellings** become one canonical set with deprecations (§5.2).
- **Cloud Sync names.** No new settings verbs (four planned names removed), no `useSetting` and
  no `cloudSync.status()`; status is one `events` kind.
- **Kit packages:**
  - **dropped:** `@polaris-key/electron`, `@polaris-key/vue`, `/svelte`, `/angular`,
    `/react-native`, `tauri-plugin-polaris-key`, `PolarisKeyUIKit`, `PolarisKeyAppKit`,
    `polaris-key-ui-views`, and the Godot C# facade (for now);
  - **reduced:** UK-22 shrinks to a Tailwind preset; Qt drops its QWidget layer.
- **Kit routes:** the shadcn registry route `key.plrs.im/r/<name>.json` is not built, so there is
  one fewer rule-10 route. The elements CDN route stays.
- **JS headless layers:** three become one. `@polaris-key/ui-core` replaces `react/core` state
  and `sdk-node/cli/models.ts`.

**Backlog, samples and docs:**

- **UK ids:** 37 open become 18 active plus an icebox list.
- **Samples:** about 20 promised kit samples plus 5 SDK samples become 13 in one tree.
- **Docs:** four start paths become one; per-kit framework pages shrink by 9; the three Cloud
  Sync docs halves (U-15a/b/c) become one (U-15).
- **Example product names:** six become one (Tidewater) in developer-facing material.

---

## 7. Automation and onboarding

1. **Download or PR the config.** The console's Connect your app produces `polaris-key.json`
   from the admin API (pins active and staged, release pins, services) as a download, as a pull
   request (UX-70), or as the `pkey sdk add` command line with `--expect` fingerprints. No
   pasting keys.
2. **`pkey sdk add <lang>`** does five things:
   - routes the registry (always first, D17);
   - installs the lockstep version;
   - writes `polaris-key.json`, refusing on any `--expect` mismatch;
   - for kits, adds the kit dependency;
   - prints the two-line start from the generator.
3. **The SDK is chosen for you** from builds and the repository (D45), from `sdkFit(platforms)`
   and the product's intended platforms. Only SDKs for those platforms are shown first, which
   follows the owner's "gate by platform".
4. **A test license is made automatically** when License is on (SETUP §3.6) and shown once. The
   Integration License panel waits for that license's activation.
5. **Version and outlet are auto-detected.** No version option exists on Node, React-in-Electron,
   Swift, Android or Godot.
6. **`doctor()` runs on the first failure in debug builds.** It prints one actionable line with a
   console deep link, for example "Config is off for tidewater: turn it on at …/p/tidewater/services",
   or "Origin http://localhost:5173 is not in web.origins: add it at …".
7. **Pin rotation is surfaced automatically.**
   - When a signing key is staged, Integration shows "Refresh polaris-key.json before activating
     the new key". The pins are in the file, the console knows which are staged, and the CI
     action can rewrite the file in the same pull request.
   - `pkey sdk add --refresh` updates only the file.
8. **Godot needs no Node.** The dock's **Import polaris-key.json** replaces "Generate config"
   shelling out to `pkey`. Mirror generation stays a CLI convenience.
9. **Kit-first start for apps with UI.** The Integration start snippet is the drop-in gate for the
   detected kit (`<PolarisKeyGate config>`, `.polarisKeyGate`, `PolarisKeyGate { }`,
   `PolarisKey.boot()`, `run_gate`). Headless is the second tab.
10. **Per-service panels use the product's real names.** Catalog keys, entitlements, pack ids,
    mint names and offers each come with a one-line "seen ✓" from `servicesSeen`.

---

## 8. Migration, data and risk

**Compatibility:**

- **No wire change.** `polaris-key.json` is a client-side config file. The API normalisation adds
  aliases. `servicesSeen` is an admin-side Core column, and the migration number is assigned by
  the lead. `PROTOCOL_VERSION` stays 4, the corpus is untouched and transcripts are unchanged.
  The only wire-adjacent items are deferred to other domains: consumable entitlements
  (`entitlements.consume`) and `quantity` (LX-18). Both are plan-mode there.
- **SDK API compatibility.** Every renamed verb and option keeps its old name as a deprecated
  alias for one lockstep minor (0.9 → 0.10). The language-native mechanisms are:

  | SDK    | Deprecation mechanism                           |
  | ------ | ----------------------------------------------- |
  | TS     | `@deprecated` JSDoc                             |
  | Python | `warnings.warn(DeprecationWarning)`             |
  | Swift  | `@available(*, deprecated, renamed:)`           |
  | Kotlin | `@Deprecated(replaceWith=)`                     |
  | Godot  | `push_warning` once per call site               |

  `api.json` records the removal version. Kits and samples move first, so nothing in the repo
  uses an alias by removal time.
- **Config file migration.** SDKs read `polaris-key.json` first and fall back to the legacy forms
  (`PolarisKey.plist`, `res://polaris_key.tres` product fields, the typed modules passed to
  `create`). `pkey sdk --lang` keeps working for one minor and prints "`pkey sdk add` writes
  `polaris-key.json` now".

**Data and security:**

- **`sdk_sightings.services_seen`.** One INTEGER column with default 0. The upsert ORs in the
  service bit, off the response path (`waitUntil`) and at most once per key per 5 minutes, as W15
  specifies. No personal data. The THREAT-MODEL data inventory row is updated with the column.
- **Trust model.** Pins in a packaged JSON resource are as "compiled in" as pins in source. The
  SDK must never fetch the file or learn pins from discovery at runtime, and loaders refuse a URL
  or a remote path. That is a test per SDK, and THREAT-MODEL gains a row: "SDK config file is a
  packaged resource; substitution requires modifying the app bundle". D16 (console pins from the
  admin API) and D30 (CLI `--expect`) are unchanged.
- **Docs audience gate.** Opening developer pages to product-scoped roles must keep operator
  material (KEK, deploy, runbook) and the Pagefind index of those pages away from them. That
  needs two Pagefind indexes, or the operator pages built into a separate collection served only
  on platform-admin. It is security-reviewed with the RBAC work, and until then the gate stays
  platform-admin.

**Delivery risks:**

- **In-flight work.** UK-13 and UK-14 merge as they are. A follow-up inside UK-03 moves
  `sdk-node/src/cli/models.ts` onto `@polaris-key/ui-core`, and UK-14's goldens must stay
  byte-identical, which is the acceptance test of the move. HA-12 merges as planned. HA-13 and
  HA-14 implement the seam that ui-core and the native cores consume. LX-08 is unaffected.
- **Sequencing risk: kits vs feature WPs.** I-10a and I-10b wait on I-08 and I-09 (server, todo),
  so the rebuilt kits (UK-03, 05, 07, 09, 11, 12) can and should land first. They depend only on
  UK-02b, and HA-13/14 are behind a seam. If a feature WP must ship before its kit, it ships
  layer (c) plus a fixture and the old kit is left alone.
- **Scope-cut risk.** Moving 21 kit ids to an icebox may disappoint the "all major frameworks"
  owner line in UI-KITS. Mitigation: every iceboxed framework gets a recipe page, either over the
  elements (web) or over the native kit through a host view (UIKit, AppKit, Android Views), so
  "supported" stays true at a lower cost. It is reopened as a WP when a product ships on it.
- **Generator-in-CI risk.** Compiling goldens per SDK adds CI time. Goldens are small (one start
  file and up to 8 service snippets per SDK), and they run in each SDK's own lane, scoped like
  the gate's SDK suites.
- **Feeds gating (if the owner keeps it).** It breaks anonymous installs everywhere. SDX-07 must
  land in the same release as the gate, and the Godot path needs the dock installer.

---

## 9. Backlog changes

| id     | action  | target                         | note                                                                                                                                                                                                                                      |
| ------ | ------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UK-02b | keep    |                                | Add service-off and presentation-absent fixture rows for every component, so kits degrade identically.                                                                                                                                      |
| UK-03  | edit    |                                | Also absorbs UK-14's `sdk-node/src/cli/models.ts` (the Node terminal kit consumes ui-core; goldens unchanged) and `@polaris-key/react/core`'s state. ui-core is the only JS headless layer. Add a `SignInModel` hook point I-10a fills. |
| UK-04  | edit    |                                | Absorbs UK-22's Tailwind v4 preset and the CSS-variable "bring your own design system" recipe. `<pk-gate>` takes `product` + `config` (SETUP D18).                                                                                         |
| UK-05  | edit    |                                | `<PolarisKeyProvider config={polarisKey}>` and `<PolarisKeyGate config>`. `theme`, `branding` and `colorScheme` collapse to `theme`. `expectServices` is accepted as an alias.                                                             |
| UK-06  | edit    | SP-31                          | No new `@polaris-key/electron` package. The Electron kit lives in `@polaris-key/node/electron` (`exposePolarisBridge` keeps its name): bridge v4 (from SP-31), menu items, notifications and updater progress into UpdateProgress.        |
| SP-31  | merge   | UK-06                          | Bridge v4 is the first half of UK-06.                                                                                                                                                                                                       |
| UK-07  | edit    |                                | Adds the UIKit hosting recipe (UIHostingController) and the Paywall over StoreKit 2 views (from UK-23 and UK-25). Reads `polaris-key.json` via `fromConfig()`.                                                                             |
| UK-08  | edit    |                                | Adds the AppKit hosting recipe and the Sparkle bridge (from UK-24).                                                                                                                                                                         |
| UK-09  | edit    |                                | Adds the `ComposeView` and Activity-result recipe for Views apps (from UK-28). `PolarisKeyAndroid.client(context)` reads `assets/polaris-key.json`.                                                                                       |
| UK-10  | keep    |                                | Owner decision (JVM desktop parity).                                                                                                                                                                                                        |
| UK-11  | edit    |                                | Godot reads `res://polaris-key.json`. The dock gains **Import polaris-key.json** and drops the `pkey` shell-out as the default path.                                                                                                       |
| UK-12  | edit    |                                | Qt Quick drop-in + `polaris_key.ui.core` only. Drop the QWidget layer (b) and document `QQuickWidget` embedding. Builds on UK-13's `ui/core` seed.                                                                                          |
| UK-13  | keep    |                                | In flight, correct shape. Set `in-review` in dx-plan's `workpackages.json` to match the branch.                                                                                                                                            |
| UK-14  | keep    |                                | In flight. After merge, its models move under ui-core in UK-03 (above). Set `in-review`.                                                                                                                                                    |
| UK-17  | merge   | UK-31                          | Vue over `<pk-*>`: a recipe page plus the shared sample, not a package.                                                                                                                                                                     |
| UK-18  | merge   | UK-31                          | Svelte: the same.                                                                                                                                                                                                                           |
| UK-19  | merge   | UK-31                          | Angular: the same.                                                                                                                                                                                                                          |
| UK-20  | drop    |                                | React Native goes to the icebox. It needs a native module over two SDKs. Reopen when a product ships RN.                                                                                                                                   |
| UK-21  | merge   | UK-31                          | Tauri: a recipe (React bearer mode or elements in the webview). No Rust plugin, and X-02 stays optional.                                                                                                                                   |
| UK-22  | split   | UK-04, UK-31                   | The Tailwind preset goes to UK-04. The shadcn registry route and the MUI, Mantine and Chakra theme objects are dropped (icebox). The CSS-variable recipe goes to UK-31.                                                                    |
| UK-23  | merge   | UK-07                          | A UIKit hosting recipe, not a product.                                                                                                                                                                                                      |
| UK-24  | merge   | UK-08                          | An AppKit hosting recipe, not a product.                                                                                                                                                                                                    |
| UK-25  | merge   | UK-07                          | Paywall is a must component (§4.1) and belongs in the SwiftUI kit, with CM-15's purchase API.                                                                                                                                             |
| UK-26  | drop    |                                | visionOS goes to the icebox.                                                                                                                                                                                                                |
| UK-27  | drop    |                                | tvOS goes to the icebox, reopened if Diceroll or another product targets Apple TV. Device-code-first already works in the iOS kit.                                                                                                        |
| UK-28  | merge   | UK-09                          | A Views interop recipe.                                                                                                                                                                                                                     |
| UK-29  | drop    |                                | Godot C# goes to the icebox with X-01. Stop emitting `PKeyBrand.generated.cs` until it is reopened (or keep it if it is free).                                                                                                             |
| UK-31  | edit    |                                | Becomes the single "Recipes" WP: Vue, Svelte, Angular, Solid, Preact, htmx, Tauri, bring-your-own design system. Non-optional, 1–1.5 engineer-weeks.                                                                                       |
| UK-32  | drop    |                                | Ink goes to the icebox.                                                                                                                                                                                                                     |
| UK-33  | drop    |                                | watchOS goes to the icebox.                                                                                                                                                                                                                 |
| UK-34  | drop    |                                | WidgetKit goes to the icebox.                                                                                                                                                                                                               |
| UK-35  | drop    |                                | Android TV and Glance go to the icebox.                                                                                                                                                                                                     |
| UK-36  | drop    |                                | The Godot editor dock restyle goes to the icebox. UK-11's dock import is the only dock change.                                                                                                                                             |
| UK-37  | drop    |                                | The Godot web overlay goes to the icebox.                                                                                                                                                                                                   |
| UK-38  | drop    |                                | wx and Kivy go to the icebox.                                                                                                                                                                                                               |
| UK-39  | drop    |                                | Python web UIs go to the icebox. The elements already embed.                                                                                                                                                                               |
| UK-41  | edit    |                                | Scope becomes the reduced must matrix. It also verifies that the Integration start snippets (SDX-02 goldens) render each kit's drop-in.                                                                                                     |
| UK-42  | keep    |                                | Lands in ui-core and React (rebuilt kits only).                                                                                                                                                                                             |
| UK-43  | keep    |                                | Native kits (rebuilt kits only).                                                                                                                                                                                                            |
| UK-44  | merge   | I-10a, I-10b                   | Hints are an argument of the same `signIn.start` call I-10a/b introduce. Add PX-W18 to I-10a/b's deps for that part.                                                                                                                      |
| I-10a  | edit    |                                | UI scope becomes layer (c) only (`SignInModel` states, copy, fixtures). The React activation component is rendered by UK-05, not today's kit. Canonical names are `identity.signIn`, `subject` and `signOut` (SDX-04).                    |
| I-10b  | edit    |                                | The same: `PolarisKeyUI`, Kotlin and Godot screens come from UK-07, UK-09 and UK-11. This WP ships the SDK primitives and native presentation-core states only.                                                                          |
| PX-W9b | edit    |                                | Ships SDK reads and ui-core/native-core states. The "four UI kits' entries line and refusal screen" render in the rebuilt kits, so do not touch the old kits.                                                                             |
| LX-19  | edit    |                                | Uses SDX-04's `entitlements.*` namespace (`has`, `value`, `grants`, and `quantity` when LX-18 serves it). The kit badge renders in the rebuilt kits.                                                                                       |
| CM-15  | edit    |                                | `commerce.offers()` and `purchase()` names come from `api.json`. The Paywall renders in the rebuilt kits (UK-05, UK-07 with UK-25's scope, UK-09, UK-11).                                                                                 |
| I-24b  | edit    |                                | Kit screens render in the rebuilt kits only.                                                                                                                                                                                                |
| HA-13  | keep    |                                | Implements the `PresentationSource` seam the kits consume (unchanged).                                                                                                                                                                      |
| HA-14  | keep    |                                | Godot side of HA-13.                                                                                                                                                                                                                        |
| U-06   | edit    |                                | Retitle: extend the shipped `config.set/clear/setting` and the config-change event with sync state and origin. **No** `setConfig`, `clearConfig`, `settingState` or `onChange`. Status is a `cloudSync` events kind.                     |
| U-07   | edit    |                                | Same naming rule. `@PolarisSetting` and `rememberSetting` wrap `config.setting(key)`.                                                                                                                                                       |
| U-20   | edit    |                                | React keeps `useConfigSetting` (and adds `useConfig`). No `useSetting`.                                                                                                                                                                     |
| U-21   | edit    |                                | Godot uses `config.set` and `config.setting` (SP-24's names). No `settings_changed` or `status_changed` signals; one `event(kind, data)` signal.                                                                                          |
| U-08   | edit    |                                | One `MergeRequest` type with `keep(...)` across the six SDKs. Prompt rendering only in the rebuilt kits.                                                                                                                                    |
| U-13   | edit    |                                | Saves read through the SDK's existing verified-fetch transport (Range, If-Range, SHA-256). `<SaveConflict/>` renders in UK-05.                                                                                                            |
| U-25   | edit    |                                | Same transport reuse. Conflict views in the rebuilt kits.                                                                                                                                                                                   |
| U-22   | drop    |                                | Collections SDK (JS/Python) is deferred with the U-09 backend until settings and saves have adopters (cross-domain: Cloud Sync).                                                                                                          |
| U-23   | drop    |                                | Collections SDK (native) is deferred, as above.                                                                                                                                                                                             |
| U-15a  | merge   | U-15                           | One Cloud Sync developer guide (settings and saves), with per-SDK tabs from SDX-02.                                                                                                                                                        |
| U-15b  | merge   | U-15                           | As above.                                                                                                                                                                                                                                   |
| U-15c  | drop    |                                | Goes with the collections deferral.                                                                                                                                                                                                         |
| MO-13  | edit    |                                | The "Adding motion" contributor page also covers the kits' motion mapping (UI-KITS §4.8), so there is one motion page.                                                                                                                     |
| I-19   | edit    |                                | Developer snippets come from SDX-02's `renderUsage("identity", …)`, not hand-written code.                                                                                                                                                  |
| PX-19  | edit    |                                | Portal docs move toward in-portal help. The developer-guidance part uses generated snippets.                                                                                                                                                |
| HA-15  | edit    |                                | Its docs page uses generated SDK tabs for presentation access.                                                                                                                                                                             |
| LX-22  | edit    |                                | Developer pages use generated SDK tabs (entitlements namespace).                                                                                                                                                                            |
| CM-17  | edit    |                                | Developer pages use generated SDK tabs (`offers` and `purchase`).                                                                                                                                                                           |
| SP-12  | keep    |                                | React `boot()`: a prerequisite for the canonical `boot()` start.                                                                                                                                                                            |
| SP-20  | keep    |                                | Kotlin `boot()` in `:sdk`: a prerequisite for the canonical start.                                                                                                                                                                          |
| P1-12  | edit    |                                | The Godot docs page and README quick start become generator output (SDX-02). The README sheds programme ids.                                                                                                                               |
| UX-60  | merge   | SDX-02                         | Not in `workpackages.json` today. Its `renderSdkSetup` becomes SDX-02, which also adds `renderUsage`, `sdkFit` and the JSON writer.                                                                                                        |
| UX-61  | edit    | (console domain; import)       | Import into `workpackages.json`. Split its server half (W15 sightings, W7 read, W8 release-keys read) into SDX-03. The console page renders SDX-02 content, with per-service panels and the dismiss (§5.4).                                |

---

## 10. New work packages

| proposedId | title                                                                                                                                       | scope                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | deps                                    | planMode |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | -------- |
| SDX-01     | One SDK config file and one start call: `polaris-key.json`, `fromConfig()`, auto-version, `doctor()` in six SDKs                            | JSON Schema `shared-manifest/schemas/v1/sdk-config.schema.json`; fixtures `conformance/sdk-config/*` replayed by each SDK's loader test; `fromConfig()` / `from_config()` in Node, React (`config` prop), Python, Swift (`fromBundle` as alias), Kotlin (`PolarisKeyAndroid.client(context)`, `PolarisKeyDesktop.client()`, JVM `fromConfig()`), Godot (`res://polaris-key.json` in `PolarisKey.boot()`, export filter); legacy fallbacks (plist, `.tres`, typed modules); the version auto-detected where the platform has it; `client.doctor()` (`core.doctor` parity id, client-only proof) with console deep links and a once-per-run debug print; "no remote config" tests; THREAT-MODEL row. No wire change; plan written first because it is an all-SDK public-API contract. 1.5–2 engineer-weeks. | SP-12, SP-20                            | true     |
| SDX-02     | Integration content generator: `renderSdkSetup`, `renderUsage`, `sdkFit` and goldens compiled in every SDK's CI (absorbs UX-60)              | `packages/shared-manifest/src/integration/`: setup (install via `renderFeedSetup`, the JSON file, kit-first start with a headless tab) and per-service usage for license, config, identity, update, packs, cloud sync and commerce from a real product context (catalog keys and defaults, entitlement names, pack ids, mint names, offers); `sdkFit(platforms, repoSignals)`; goldens under `test/fixtures/integration/<lang>/` compiled in each SDK lane; `pkey sdk add <lang> --expect` (D30) and `pkey sdk --lang` rewired to it; delete `sdkQuickStart.ts sdkInit`, `manifest.ts sdkSnippet`/`trustSnippet` and the six `sdkConfig.ts` renderers; `gen:integration` writes `build/quickstart/*.md` and the per-SDK tabs in `services/*` (a new GENERATED family with `--check`, AGENTS rule 3 table entry). 2–2.5 engineer-weeks. | SDX-01, SDX-04, F-10                    | false    |
| SDX-03     | SDK sightings and integration state: W15 `sdk_sightings` with `services_seen`, the sightings and integration reads, and dismissal in `setup_state` | Core table `sdk_sightings` (W15) plus a `services_seen` bitmask set by the public request path per service (discovery, licence or config document, update feed, Cloud Sync push, claim) via `waitUntil`, at most once per key per 5 min; 90-day prune on the existing cron; admin reads `GET …/sdk-sightings` (W7) and `GET …/integration` (per-service seen, end-to-end flag, intended platforms not seen) and the release-keys read (W8); dismissal stored as a `setup_state` choice (UX-51); OpenAPI and `routeCoverage` (rule 10); data-model regen; THREAT-MODEL inventory row; migration `00XX_sdk_sightings.sql` (lead numbers it). Server half split out of UX-61. 1–1.5 engineer-weeks. | UX-51                                   | false    |
| SDX-04     | One API vocabulary: `conformance/parity/api.json`, canonical names and deprecated aliases in six SDKs, generated name table                  | Registry of canonical concepts → per-SDK symbol, with `deprecated` rows and removal version (§5.2): options (`product`, `pins`, `services`), `license.activate`, `config.get/secret/mint/set/clear/setting`, `entitlements.has/value/grants` (`quantity` reserved for LX-18), `identity.signIn/subject/signOut`, one `events` stream with a `cloudSync` kind, Swift `createFromOfflineBundle`; aliases with language-native deprecation; per-SDK test asserting every canonical symbol exists; generated `reference/api-names.mdx`; kits, samples and docs moved to canonical names. Client-only, no corpus change. 1–1.5 engineer-weeks. | SP-12, SP-20                            | true     |
| SDX-05     | Examples in one tree: Tidewater fixture, one sample per SDK and host, built in CI                                                            | Merge `examples/ui/` into `examples/<sdk>-<host>/` (§5.7); move `sdks/godot/examples/minimal` and `sdks/kotlin/samples/cli`; replace djdl placeholders with the Tidewater fixture `polaris-key.json` and fixture adapters plus `--live`; CI lanes: TS typecheck, `py_compile`, `swift build` (macOS lane), Gradle (Kotlin lane), Godot headless import; one `examples/README.md`; kit samples are filled in by their UK WPs against this layout. 1–1.5 engineer-weeks. | SDX-01                                  | false    |
| SDX-06     | Developer docs reshape: one start path, generated quick starts and service tabs, slim READMEs, developer changelog, no programme ids         | Merge `start/quickstart.md`, `build/quickstart/index.md` and `build/onboarding.md` into one "Your first product" path mirroring the console (move the djdl walkthrough to `admin/` as a case study or retire it); `build/sdks/*` becomes reference-only (READMEs: install + golden start + link; release notes into a generated per-version Developer changelog page); remove `P1-11`/`SP-25`/`S-19 G11`-style ids from READMEs and developer pages, with a lint; one example product (Tidewater); trim `uiKits.ts` and `build/ui/frameworks` to the reduced matrix; remove "No kit documents X yet" placeholders; console `docsLinks` and `nav.ts` tables updated (slug-manifest gate). 1–1.5 engineer-weeks. | SDX-02                                  | false    |
| SDX-07     | (Conditional, if the owner keeps SDK feeds gated) Token provisioning for SDK installs                                                         | `pkey sdk add` and the Connect page mint a read-only developer token (device-code login) and write it to **user-level** config (`~/.npmrc`, pip keyring or `pip.conf`, `swift package-registry login`, `~/.gradle/gradle.properties`), never the project; CI guidance with `pkeyci_` read scope; the Godot dock downloads the addon itself (AssetLib cannot authenticate); install-from-feeds page rewritten. Only if Feeds keeps `polaris-key` SDKs gated; otherwise the SDKs stay anonymous and unlisted (§4). 1 engineer-week. | SDX-02; feeds-domain token WPs          | false    |

---

## 11. Quick wins

1. **Fix the React snippets** (P1). Put `trust: { pinnedKeys }` into the Provider props in
   `sdkQuickStart.ts:172-193` and in `sdkConfig.ts` `renderReact` (`:343-385`), so bearer mode,
   the default on any foreign origin, works.
2. **Fix `docs/build/quickstart/react.md:32-41`.** Bearer mode shipped, so delete the
   "waits on bearer mode" note. Reword "neutral by default" to today's actual default, with a
   pointer to UK-05.
3. **Fix the `pkey sdk` default base URL**: `https://key.example.com` → `https://key.plrs.im`
   (`packages/cli/src/index.ts:849`).
4. **Correct `sdks/swift/README.md:74-84`.** `pkey sdk --lang swift` writes
   `PolarisConfig.swift`, not `PolarisKey.plist`. Also make `sdkConfig.ts:434`'s doc comment use
   `create(options:)`, which starts the client, instead of `init(options:)`.
5. **Fix `docs/build/quickstart/kotlin.md`**: use `PolarisKeyAndroid.client(context, …)` on
   Android, so the Keystore store and device inputs are wired. Keep `PolarisKeyClient.create` for
   the JVM.
6. **Lead every quick start with `boot()`** (where it is shipped: Node, Python, Swift, Godot),
   which removes the explicit and implicit `discover()` inconsistency.
7. **Accept `expectedServices` as an alias** of React's `expectServices`
   (`Provider.tsx:67`).
8. **Complete `examples/README.md`.** List `python-cli` and `python-renpy`, and point to
   `sdks/godot/examples/minimal` and `sdks/kotlin/samples/cli`.
9. **Amend UI-KITS.md §4.2** (`:617-680`) per SETUP D18. Remove `publishableKey` and the
   nonexistent `PolarisKey.client(...)` and `Client(product=…)` constructors, and point to SDX-01.
10. **Amend the U-06, U-07, U-20 and U-21 titles and briefs, and S-17 §5.11, now**, to the shipped
    `config.set/clear/setting` names, before any porter starts on them.
11. **Set UK-13 and UK-14 to `in-review`** in dx-plan's `workpackages.json`, to match their
    branches.
12. **Import UX-60 and UX-61 into `workpackages.json`** (as SDX-02 and SDX-03 plus UX-61), so the
    Integration section has an owner in the graph.

---

## 12. Cross-domain dependencies

| Domain                         | Dependency or conflict                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Products / console setup**   | The console renders the Integration section (UX-61, the layout, the nav item, dismiss UI, Overview's one-line status) from SDX-02 content and SDX-03 state. The New Product wizard (UX-74) must capture intended platforms, because `sdkFit` and "Not seen yet" read them. UX-51 `setup_state` stores the dismissal.                                                                                                             |
| **Feeds and access tokens**    | The gating of the `polaris-key` SDK namespace decides whether SDX-07 is needed. This audit recommends unlisted plus anonymous-by-name. F-10 must publish every artifact the snippets name: `@polaris-key/node` and `/react`, `polaris-key` (PyPI), `polaris-key.PolarisKey` (Swift), `im.plrs.key:polaris-key-sdk`, `-android-*`, `-ui` and `-billing` (Maven), and the Godot addon. `renderFeedSetup` stays the install source. |
| **Licensing**                  | LX-18 (licence document v2: `quantity`, `licenseExpiresAt`, grants) feeds `entitlements.*`. Consumable redemption (`entitlements.consume`) is a new wire route and signed field, so it is plan-mode there. The tier→profile→entitlement cleanup changes which names `renderUsage("license")` shows (it reads tiers).                                                                                                             |
| **Managed config**             | The final names of the config types and visibility states (regular, secret or edge-minted; changeable, read-only or invisible) map onto `config.get`, `secret`, `mint` and `setting(key).locked/visible`. The Settings kit component follows them.                                                                                                                                                                             |
| **Cloud Sync**                 | The collections deferral (U-09, U-22, U-23, U-11c, U-15c, U-24b, U-16, U-17) needs that domain's agreement. The settings and saves naming rule (§5.5) binds U-05's server error and status names only through `events`. Saves reuse each SDK's verified-fetch path.                                                                                                                                                            |
| **Identity**                   | I-10a and I-10b deliver SDK primitives and layer (c) only. I-15 (native redirect) and I-13 (exchange) add `identity.signIn` options, not new verbs. Consent with partial data sharing becomes a `SignInModel` step. UK-44 folds into I-10a/b.                                                                                                                                                                                   |
| **Commerce**                   | CM-15's `offers()` and `purchase()` names come from `api.json`. The Paywall is one must component rendered by the rebuilt kits (UK-25's StoreKit view folds into UK-07).                                                                                                                                                                                                                                                      |
| **Release, distribution and updates** | `renderUsage("update")` picks drivers by the product's platforms and outlets (Sparkle, Velopack, electron-updater, store). It depends on the platform-gating model (intended platforms, outlet capabilities) that domain owns.                                                                                                                                                                                         |
| **RBAC / administration**      | The docs audience gate (developer vs operator sections) and the Integration page's visibility to product-scoped roles depend on the RBAC capability model (`can()`, ST-21/ST-22). Until then the docs stay platform-admin.                                                                                                                                                                                                   |
| **Customer portal**            | `users/*` docs move into portal help (PX-19 is amended). The portal's Library and Discover are unaffected.                                                                                                                                                                                                                                                                                                                   |
| **Hosted assets**              | HA-12 (in flight) and HA-13/HA-14 provide `core.presentation` behind the `PresentationSource` seam. The kits never fetch it, and the Tidewater fixture carries presentation for samples and baselines.                                                                                                                                                                                                                        |
| **Code quality**               | Duplicate generators, duplicate headless layers, a duplicate Electron surface and README/docs duplication are listed in §6 for the code-quality audit to track.                                                                                                                                                                                                                                                               |
