# UK-02b plan: the UI state matrix and the ten `ui.*` parity rows, for the must-tier kits

> **Approved (2026-10-08)** by the lead under delegated authority. This is the execution plan for [`plans/UK-02.md`](UK-02.md) §3.5 and §4
> (approved 2026-10-05), re-checked against `main` @`e4a527fee`. It is amended for four things:
> owner decision 6 of the DX consolidation (2026-10-07: the must-tier kits ship as packages, the
> framework kits become recipes and the long tail is parked); the one sign-in form
> ([`plans/I-04.md`](I-04.md) §G and `SIGN-IN.md` §3.17); I-27's D4 (a first automatic licence
> skips licence choice); and HA-12 and PX-W8, both now done. UK-02's decisions bind except where
> §0.2 and the decisions table amend them. Line references are to `e4a527fee`. After a rebase,
> find each place again by its quoted text.
>
> **Revised 2026-10-07 after review.** §4.5 ends the form the same way in every presentation and
> adds I-27 D4's row. §4.4 and §4.7 derive service-off coverage from one dependency map, with a
> `requires` closure check. D3, D5, D6, D9 and D10 are corrected. Q1 is decided (D12). Copy
> coupling is decided (D13) and named as a risk. P0-36 leaves the plan, and `UI_MATRIX_VERSION`
> becomes a generated constant.
>
> **Owner decisions of 2026-10-07 applied.** Commerce is a service (`commerce`, requires License;
> [`plans/CM-29.md`](CM-29.md)), so the Paywall and EntitlementGate service-off rows depend on
> `commerce`, not on Distribution. UK-02b authors the `license` pairs now, and CM-29 appends the
> `commerce` pairs when it adds the slug (§4.4, §4.8). The closure rule in D5 is ST-38's
> requirement rule. Nothing here is renamed, so the remove-don't-deprecate rule changes nothing.
> UK-02b deploys nothing; its constants ship in the next v0.9.x SDK releases, and 1.0 is the
> owner's later call (P0-51). D12, D13 and the other questions are recorded in
> [Owner decisions](#owner-decisions-delegated-to-claude-2026-10-08) at the end.

| Field       | Value                                                                                                                                                                                                                                                                                                                  |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Brief       | [`wp/UK-02b-ui-fixtures-parity.md`](../wp/UK-02b-ui-fixtures-parity.md). Executes UK-02 §3.5 and §4. Research: `docs/research/2026-10-07-dx-consolidation/` `README.md` §2.10 and §8 (decision 6, D4), `integration.md` §1.4, C-42 and §4.1 ("feature WPs ship layer (c) only"), `audits/sdk-uikits-dx.md` §5.6 and §9 |
| Implementer | **UK-02b** (`pkey-sdk-porter`), in one PR. Runners: UK-03, UK-07, UK-09, UK-11 and UK-12 (§5). Hosted card: PX-14                                                                                                                                                                                                      |
| Wire change | **None.** `PROTOCOL_VERSION` stays 4, `DISCOVERY_VERSION` 2, `corpusVersion` 2 and `transcriptVersion` 1. `shared-protocol`, `shared-jws`, `client-core` and `WIRE-CONTRACT-V4.md` are untouched. No route, error code, header or signed shape changes                                                                 |
| Corpus      | One new unsigned, generated file, `conformance/corpus/v2/ui-matrix.json` (`uiMatrixVersion: 1`), with its Godot mirror and, until P0-44 removes that mirror, its Swift mirror. Every existing corpus file and transcript stays byte-identical                                                                          |
| Registry    | Ten `ui.*` ids, `planned` in all six manifests. `registryVersion` stays 1. No new runtime, trait, reason or N/A. One new generated constant, `UI_MATRIX_VERSION`                                                                                                                                                       |
| Depends on  | UK-02 (done) and UK-02a (done). The edge to UK-02a that UK-02 D9 asks for is added. SP-00 is merged (`c515bf0e8`) and Track A stamps it done. UK-02b unblocks UK-03, UK-07, UK-09, UK-11, UK-12 and PX-14, and heads the longest chain (UK-02b → UK-03 → UK-04 → UK-05 → UK-06 → UK-41, about 16 weeks)                |
| Size        | 1–1.5 engineer-weeks, unchanged. The amendments add about 90 authored rows and a handful of generator checks                                                                                                                                                                                                           |

## 0. What binds, and what the base changed

### 0.1 Carried (not reopened)

- **UK-02's decisions.** D1: one generated corpus file built from `tools/ui-matrix.ts`. D5: the ICU
  subset. D7: `ui.kit` stays until UK-41. D9: UK-02b runs after UK-02a. D10: the id is
  `ui.devicelimit`. D11: the only N/A is `ui.activate` `outlet` on `ios` and `android`, so Node and
  Python get none. D12: a row exists only for an input that some package ships or an approved
  plan specifies. D13 is carried too.
- **Owner decision 6** (delegated, 2026-10-07):
  - the **must tier** is elements, React, Electron inside `@polaris-key/node/electron`, SwiftUI
    iOS and macOS, Compose Android and Desktop, Godot, Qt Quick and the two terminals;
  - Vue, Svelte, Angular, Solid, htmx, Tauri, UIKit, AppKit and Android Views become **recipes**;
  - React Native, visionOS, tvOS, watchOS, widgets and Godot C# are **parked**.
- **I-27 D4** (decided under the brief, README §8; [`plans/I-27.md`](I-27.md) §2.2). A first
  automatic licence skips licence choice and binds the device. In app mode no choice is due, so
  `token` answers the token response. It is called **I-27 D4** below, to keep it apart from this
  plan's D4.
- **The kit rule** (`integration.md` §4.1, `tracks.md` rule 4). A feature package delivers layer
  (c) only: a `components.json` state, its catalog keys and the matching `ui-matrix.json` rows.
  The rebuilt kit then renders the new state.
- **The one form** (`SIGN-IN.md:712-750`, `I-04.md:402-545`):
  - `presentation` is `inline`, `sheet` or `browser`, and `replace` is `inline` or `browser`;
  - the form shows Done "when a license was added or issued now; otherwise the app opens with the
    toast" (`SIGN-IN.md:730-731`);
  - a device-code sign-in always chooses its license on the card (`SIGN-IN.md:747-748`);
  - a device-code sign-in never issues a grant (`I-04.md:492`).

### 0.2 Where the base differs from UK-02's text

| #   | UK-02 says                                                  | The base has                                                                                                                                                                                                                                                                                                                                        | This plan                                                                                                                               |
| --- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | UK-14 owns Node's rows (D8)                                 | UK-14 is done, and parity rule 4 fails a `planned` entry whose package is done (`tools/parity-check.ts:704-714`)                                                                                                                                                                                                                                    | UK-06 owns Node's rows (D9)                                                                                                             |
| 2   | Input `product {name, shortName, accent, accentDark, icon}` | HA-12 shipped `ProductPresentation` (`shared-protocol/src/core.ts:449-457`) behind `PresentationSource` (`client-core/src/presentation.ts:90-97`). UK-13's Python seam resolves integrator → presentation → bundle → icon → ink, with accent sources `integrator`, `product`, `icon`, `core` and `ink` (`polaris_key/ui/core/identity.py:3-15, 60`) | The `product` input becomes three inputs: `integrator`, `presentation` and `bundle`. The theme's `accentSource` gains `integrator` (D6) |
| 3   | The `signIn` family is SignIn and SignInHandoff             | UK-02a's `components.json` added `LicenseChoice` with 14 states and `"family": null` (`packages/brand/kit-copy/components.json:400-402`)                                                                                                                                                                                                            | LicenseChoice joins `signIn` (§3), with D2's inputs                                                                                     |
| 4   | `manageUrl` rows wait for PX-W8 (D12)                       | PX-W8 is done. `client-core/src/manage.ts` reads the link, and Node's device-limit result carries it (`sdk-node/src/license/endpoints.ts:149-155`)                                                                                                                                                                                                  | DeviceLimit rows carry `activation.manageUrl` now                                                                                       |
| 5   | The kits run the matrix "as it lands"                       | UK-14 and UK-13 shipped kit-local fixtures as stand-ins (`sdk-node/src/cli/models.ts:1-6`, `sdks/python/parity.json:329`)                                                                                                                                                                                                                           | The stand-ins stay until UK-03 and UK-12 run the matrix. Those packages then delete the cases the matrix covers                         |
| 6   | `UI-KITS.md` §5.2 is amended after approval                 | `UI-KITS.md:1087-1102` still says `conformance/corpus/v2/ui/` and `ui.deviceLimit`, and still says the headless N/A is removed                                                                                                                                                                                                                      | UK-02b amends it (§7)                                                                                                                   |
| 7   | The file is added to `tools/sign-corpus.ts`                 | P0-44, the first corpus-lane item after HA-12, splits that file into `tools/corpus/` and removes the Swift mirror                                                                                                                                                                                                                                   | Either may land first (D11), sequenced by the lead (§8)                                                                                 |

## Decisions (the lead's, under delegated authority)

| #   | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Reason                                                                                                                                                                                                                                                                                                                                                                    |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **`ui.signin` covers the whole form**: SignIn, SignInHandoff and LicenseChoice. The `ui.kit.signin` row of I-04 §G.8 (`I-04.md:522`) is not added                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | One form gets one row. A second row would duplicate the proof and bring back the `headless` N/A that UK-02 D11 refused. The terminals offer only the `browser` presentation, which is a row input, not an N/A (§4.5)                                                                                                                                                      |
| D2  | **LicenseChoice rows take I-04's `LicenseChoiceView` and `ReplaceView` field for field** (`I-04.md:218-240`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | The card (path A) and the in-app form (path B) share these views (I-04 §G.1), so one set of rows pins both. The shape is approved, and I-08 makes it shared (§G.7)                                                                                                                                                                                                        |
| D3  | **The sign-in session input is a closed vocabulary, with one source per fact.** `signIn.outcome` holds the `session.wait()` outcomes of I-04 §G.9 (`pending`, `choose`, `signedIn`, `cancelled`, `expired`), and `signIn.event` a fixed set of kit events. A device-code poll's phases are not repeated there: UK-02's `deviceCode.phase` is authoritative on device-code rows (§4.5)                                                                                                                                                                                                                                                     | No SDK symbol enters the file, so SP-35's names and I-10a's per-language spellings never force a row to change. With one source per fact, a row cannot say `denied` twice in two ways, or contradict itself (§4.7)                                                                                                                                                        |
| D4  | **Inline rows are written once, and the generator emits a `sheet` twin of each.** `browser` rows are written separately. The generator refuses a row with `presentation: "browser"` or `channel: "device-code"` that reaches `choose`, `replace` or any LicenseChoice state                                                                                                                                                                                                                                                                                                                                                               | The sheet differs from the inline form only in layout (`SIGN-IN.md:741-742`), and runners still get flat rows. The refusal pins D-82 and the no-grant rule in all five runners                                                                                                                                                                                            |
| D5  | **Service-off rows come from one map.** A `services` input lists the enabled services, closed under `tools/services.json` `requires`: ST-38's requirement rule (owner, 2026-10-07), so turning a requirement off turns its dependents off. `tools/ui-matrix.ts` declares `SERVICE_DEPENDENCIES`: every must component maps to the services it depends on. Each (component, service) pair gets at least one row, and §4.4 fixes each pair's expectation. A reserved state, `hidden`, has `copy: []`                                                                                                                                        | This is the backlog's acceptance: "service-off ... rows for every component so kits degrade identically". A map makes coverage checkable, so a component that shows another service's keys cannot be missed. With `hidden`, a model can say "the drop-in skips me" without adding a fake state to `components.json`                                                       |
| D6  | **Presentation-absent rows.** Each must component gets one row with `presentation: null`, no integrator identity and `bundle {slug: "tidewater", name: "Tidewater Studio"}`. It expects its default row's component, state and actions, and its copy minus at most the **identity-only keys**, a closed list: `common.byDeveloper` drops out (there is no developer name without an integrator or a presentation, `UI-KITS.md:132`); `a11y.productIcon` stays (the monogram tile is still the product's icon, `UI-KITS.md:138-140`). The `theme` family pins the name, accent and icon fallbacks                                          | A component never changes its step, its actions or its other copy because presentation is missing. Only the hero degrades                                                                                                                                                                                                                                                 |
| D7  | **`expect.copy` lists the keys this input shows.** That is a subset of the state's `components.json` list, plus any `core.*` keys the input selects. Across all of a state's rows, the union must cover the state's list                                                                                                                                                                                                                                                                                                                                                                                                                  | UK-02 §4 asked each row to list every static key of its state. Every row would then equal `components.json`, and the matrix could not tell "identity off" from the default                                                                                                                                                                                                |
| D8  | **Must-tier values only.** `platform.os` is one of `macos`, `ios`, `android`, `windows`, `linux` and `web`. `formFactor: "tv"` appears only with `android` or `linux` (Godot's joypad, the Compose QR). The theme `kit` is one of `elements`, `react`, `swiftui`, `compose`, `godot`, `qt` and `terminal`. Parked kits get no rows. Recipes and hosting layers (UIKit, AppKit, Views, Electron, Tauri) get no runner of their own                                                                                                                                                                                                         | They reuse a core that already runs every row. A revived kit appends rows for the platform values it adds (`tvos`, `visionos`, `watchos`) and never adds a family                                                                                                                                                                                                         |
| D9  | **Owners**: React UK-05, Node UK-06, Python UK-12, Swift UK-07, Kotlin UK-09 and Godot UK-11. A row flips with two proofs: the family run and a render. **Node's proof, which UK-06 brings:** the family run is UK-03's ui-core runner under Node's `testRoots`; the render is a test under `packages/sdk-node/test/` that drives the main-process half of `@polaris-key/node/electron` and snapshots the view each family sends over the bridge, beside the terminal's text renders. An earlier package may flip a row it proves both ways: UK-03 can flip Node's `ui.devices` and `ui.devicelimit`, whose components the terminal draws | Rule 4 applies (§0.2 #1). Node's manifest is `runtimes: ["node"]` with the `headless` trait, and the Electron renderer is React's `desktop-bridge` runtime (`sdk-react/parity.json:4`), so the renderer's screenshots count for React. The terminal draws 10 of the 20 must components (D12), so Node's full render needs the bridge views. Python's full render needs Qt |
| D10 | **The fixture products are UI-KITS's** (`UI-KITS.md:1284-1288`). **Tidewater Studio** by Harbor Audio is the default: it sets no accent, so its teal (`#369186`) is derived from its icon and `accentSource` is `icon`. **Drift Kart** by Lanternworks (`#ff6a3d`) carries the explicit-accent `theme` rows (presentation and integrator accents) and the Godot rows. Keys, names and devices are synthetic                                                                                                                                                                                                                               | Rows, baselines and samples then share the same two products with the same accent sources                                                                                                                                                                                                                                                                                 |
| D11 | **UK-02b does not wait for P0-44.** It holds the corpus lane only from regeneration to merge. Whichever of the two lands second moves `tools/ui-matrix.ts`, with its one import and one map entry                                                                                                                                                                                                                                                                                                                                                                                                                                         | UK-02b heads the longest chain, and the output is byte-identical in either order                                                                                                                                                                                                                                                                                          |
| D12 | **The two terminal kits draw what their verbs reach**, not every must component (was Q1). UK-14's terminal draws 10 of the 20 (`sdk-node/src/cli/models.ts`). It does not draw Boot, Welcome, SignIn, OfflineActivation, LicenseChoice (card only, `SIGN-IN.md` §5.1), ReleaseNotes, Settings, Paywall, EntitlementGate or Toast                                                                                                                                                                                                                                                                                                          | Layer (c) parity is unaffected: ui-core and `polaris_key.ui.core` run every row for both languages, and Electron's bridge views and Qt render Node's and Python's rows (D9). UK-41 checks the terminals against `ui.cli` and the states their verbs reach. On a veto, UK-03 and UK-12 each gain about half a week of text renders                                         |
| D13 | **A copy-only regeneration does not hold the corpus lane.** A copy or translation edit that changes `ui-matrix.json` only through the computed i18n strings runs `pnpm gen corpus` and commits the result. A PR holds the lane only if it changes `tools/ui-matrix.ts`, an input member or a rule (§4.8)                                                                                                                                                                                                                                                                                                                                  | Rule 3 serialises signed files and transcripts, which cannot be merged by hand. `ui-matrix.json` is unsigned and fully derived from sources the branch carries, so a conflict on it is resolved by regenerating it. The lead adds it and its mirrors to `merge.sh`'s auto-resolved set, regenerated with `pnpm gen corpus` (§8)                                           |

## 1. Summary

- A new unsigned, generated corpus file, `ui-matrix.json`, with ten families: eight component
  families plus `theme` and `i18n`. It holds about 290 component rows, 20 theme rows and 70 i18n
  rows, and pins layer (c) of the 20 must components for every language.
- Beyond UK-02, the file covers:
  - the one sign-in form (SignIn, SignInHandoff and LicenseChoice, in the inline, sheet and browser
    presentations), with one ending rule and I-27 D4's row;
  - service-off rows for every (component, service) pair of one dependency map, with a reserved
    `hidden` state;
  - presentation-absent rows, on HA-12's shape;
  - `manageUrl` rows.
- Ten `ui.*` feature ids go into the registry, `planned` in six manifests with open owners.
  `gen constants` then regenerates the feature ids, the capability digests and the new
  `UI_MATRIX_VERSION`.
- Nothing changes on the wire, in the Worker, in the database or in a deploy.

## 2. Contract

There is no contract change. Every input is one of three things:

- a value an SDK already returns (`enums.json`, `errors.json`, `stage-matrix.json` outcomes,
  `update-matrix.json` actions, discovery's `services` and `registration`, PX-W8's `manageUrl`,
  HA-12's member);
- a shape an approved plan fixes (I-04's views, D2);
- a kit-side value (the integrator's identity, the platform, the kit events).

Deployed clients and Workers see no byte of difference. SDKs built after this change report ten
more `planned` features, so `supports("ui.gate")` answers `version` (`client-core/src/caps.ts:11`)
until a kit flips its row. `CAPABILITY_DIGEST` is not sent on the wire.

## 3. Catalog, components, registry and constants

- **No `shared-catalog` or `shared-manifest` change**, so AGENTS rule 9 is not involved.
- **`components.json`:** `LicenseChoice` changes from `"family": null` to `"signIn"` (`:402`). This
  is a hand-written source. `kit-copy.ts` already accepts the family (`:151-160`), and no generated
  output changes. `gen brand --check` proves both.
- **`features.json`:** the ten rows of UK-02 §3.5, with one change: `ui.signin` also lists
  LicenseChoice (D1).
  - Each row's proof is `[{kind: "corpus", file: "ui-matrix.json", family}, {kind: "snapshot"}]`.
    `ui.i18n` keeps UK-02 §3.5's third proof, `{kind: "generated", command: "pnpm gen brand --check"}`.
  - The corpus proof is active as soon as the file exists, so it needs no `wp`
    (`parity-check.ts:483-504`).
  - `ui.kit` gets UK-02's note. `ui.kit.manage` (`:1786`) and `ui.kit.keyentry` (`:1804`) are
    unchanged.
- **Manifests** (all six): each new id is `{"status": "planned", "wp": …}`, with these owners and
  notes (D9):

| SDK    | `wp`  | Note                                                                                                                    |
| ------ | ----- | ----------------------------------------------------------------------------------------------------------------------- |
| node   | UK-06 | "ui-core runner (UK-03) in testRoots; renders: the terminal (UK-14) and the bridge views of @polaris-key/node/electron" |
| react  | UK-05 | "Elements via UK-04; the Electron renderer (desktop-bridge) via UK-06"                                                  |
| python | UK-12 | "Qt kit; the terminal (UK-13) over polaris_key.ui.core"                                                                 |
| swift  | UK-07 | "iOS kit; macOS via UK-08; UIKit and AppKit are hosting recipes"                                                        |
| kotlin | UK-09 | "Android kit; desktop via UK-10; Android Views is a recipe"                                                             |
| godot  | UK-11 | (none)                                                                                                                  |

- **`tools/gen-sdk-constants.ts`** reads `uiMatrixVersion: corpus("ui-matrix.json", "uiMatrixVersion")`
  beside `presentationMatrixVersion` (`:644-647`), and emits `UI_MATRIX_VERSION` beside
  `PRESENTATION_MATRIX_VERSION` (`:1047-1051`). The type (`:168`), the header (`:33-37`) and the
  test fixture (`gen-sdk-constants.test.ts:216`) follow.

Then run `pnpm gen corpus` and, after it, `pnpm gen constants`, which reads the new file. It updates
the feature ids, `CAPABILITY_DIGEST` (parity rule 7) and `UI_MATRIX_VERSION` in the six constants
modules.

## 4. Corpus: `ui-matrix.json`

### 4.1 Generator and wiring

- **`tools/ui-matrix.ts`** holds the rows, `SERVICE_DEPENDENCIES`, `buildUiMatrix()` and the checks.
  - It reads, but does not import, these inputs: `components.json`, `kit-copy/*.json`,
    `conformance/parity/copy.*.json`, `enums.json` and `tools/services.json`.
  - Its i18n reference formatter is generator-local and imports nothing it checks: not
    `packages/brand/src`, not `sdk-node` and not ui-core. This follows the
    `tools/presentation-matrix.ts:13-23` precedent.
- **`tools/sign-corpus.ts`** gains three things:
  - one import;
  - `const v2UiMatrix = await format(asciiJson(buildUiMatrix()), {parser: "json"})`, placed
    beside `:20432`;
  - one entry in the `files` map (`:20439-20453`).

  The header count at `:18` ("Thirteen files and one directory") becomes fourteen files.

- **What the map gives for free:** the source, every mirror in `CORPUS_TARGETS` (`:289`) and the
  stray guard (`:20467`). `asciiJson` (`:5557`) escapes the ja, ko and zh strings, following the
  `device-label.json` precedent for Godot.
- **AGENTS rule 1's file list** (`AGENTS.md:161-164`) gains `ui-matrix.json`.

### 4.2 Shape and inputs

The file is
`{uiMatrixVersion: 1, description, vocabulary, gate, activate, signIn, deviceLimit, devices, update, settings, paywall, theme, i18n}`.
A component row is `{name, input, expect: {component, state, copy, actions?}}`. UK-02 §4's input
list stands, with these changes:

| Input                                  | Change            | Shape                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `integrator`, `presentation`, `bundle` | replace `product` | `integrator {name?, shortName?, developer?, accent?, accentDark?, icon?: bool, deviceCodeUrl?}`. `presentation` is `null` or HA-12's member as `{name, developerName?, accent?, accentDark?, icon: bool}`, where `icon` means `PresentationSource.icon()` returned verified bytes. `bundle {slug, name?}`                                                                                                                                            |
| `services`                             | new               | The enabled opt-in slugs from `tools/services.json`: `license`, `config`, `release`, `distribution`, `update`, `identity` and `sync`, and `commerce` once CM-29 adds it, closed under `requires` (`update` needs `distribution`, which needs `release`; `sync` needs `config` and `identity`; `commerce` needs `license`). An absent list means all are on. This is the SDK's capability view (`caps.ts:80-85`; Node's map at `discovery.ts:97-108`) |
| `registration`                         | new               | Discovery's `core.registration`: `open`, `requires-identity` or `requires-license` (`discovery.ts:82`)                                                                                                                                                                                                                                                                                                                                               |
| `signIn`                               | new               | `{presentation: inline \| sheet \| browser, replace: inline \| browser, channel: browser \| device-code, outcome?: pending \| choose \| signedIn \| cancelled \| expired, browserOpened?, event?: use-code \| copy-link \| have-key \| open-replace \| confirm-replace \| reopen, issuedNow?, raced?, grantExpired?}`. `issuedNow` is true when this sign-in added a licence (a key) or issued one (`new`, `create`, I-27 D4)                        |
| `choices`, `replaceView`               | new               | I-04's `LicenseChoiceView` and `ReplaceView` (D2)                                                                                                                                                                                                                                                                                                                                                                                                    |
| `activation.manageUrl`                 | new member        | PX-W8's refusal link                                                                                                                                                                                                                                                                                                                                                                                                                                 |

`deviceCode {phase, secondsLeft?}` stays as UK-02 defined it, and is authoritative on device-code
rows (D3, §4.5).

### 4.3 Expectations

- **`state`** is either a `components.json` state of the named component or the reserved
  **`hidden`**, which has `copy: []`. With `hidden`, the drop-in renders nothing and a styled part
  renders empty. The generator refuses any `components.json` state named `hidden`.
- **`copy`** follows D7. The generator sorts it, and runners compare it as a sorted list.
- **`actions`** come from a closed list in the file's `vocabulary`: `open-browser`, `open-card`,
  `replace-in-browser`, `open-manage-url`, `copy-link`, `retry` and `cancel`.

### 4.4 Service-off rows (D5)

This table is `SERVICE_DEPENDENCIES` and each pair's expectation. A row turns one service off and,
by the closure rule, every service that requires it: `release` off also turns off `distribution`
and `update`, and from CM-29 `license` off also turns off `commerce`.

| Must component                                                               | Depends on                            | Expected with that service off                                                                                                                                                                                                                                           |
| ---------------------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| PolarisKeyGate                                                               | `license`                             | `licensed`, with `gate.status: "not-applicable"`; the app renders                                                                                                                                                                                                        |
| Boot                                                                         | (none)                                | Exempt. `stage-matrix.json` (`ui.stages`) already pins the service-off outcomes, and Boot's rows map every outcome to a state                                                                                                                                            |
| Welcome                                                                      | `identity`                            | `capability-limited`, with `welcome.title` and `welcome.ledeKeyOnly`; no Sign in (`SIGN-IN.md` §5.1 "Identity off")                                                                                                                                                      |
|                                                                              | `license`                             | `capability-limited` with `welcome.ledeSignInOnly` when `registration` is `requires-identity`; `hidden` when it is `open`                                                                                                                                                |
| SignIn                                                                       | `identity`                            | `hidden`                                                                                                                                                                                                                                                                 |
|                                                                              | `license`                             | No key path: `methods` without `signin.choice.keyInstead`, and the `key` state and the `have-key` event are refused. `signedIn` ends on `done` with `signin.return.signedInShort` alone: there is no licence, so no `{tier}` to name (§4.5)                              |
| SignInHandoff                                                                | `identity`                            | `hidden`                                                                                                                                                                                                                                                                 |
| LicenseChoice                                                                | `identity`, `license`                 | `hidden`                                                                                                                                                                                                                                                                 |
| Activate, OfflineActivation, DeviceLimit, Devices, StatusScreen, GraceBanner | `license`                             | `hidden`                                                                                                                                                                                                                                                                 |
| AccountAndLicense                                                            | `identity`                            | `key-only`                                                                                                                                                                                                                                                               |
|                                                                              | `license`                             | `signed-in`, without `account.tier` and `account.devices`                                                                                                                                                                                                                |
|                                                                              | `config`                              | `signed-in`, without `account.managedSettings`                                                                                                                                                                                                                           |
|                                                                              | `update`                              | `signed-in`, without `account.updates`, `account.autoUpdate`, `account.channel` and `update.checkNow`                                                                                                                                                                    |
|                                                                              | `sync`                                | `signed-in`, without `account.cloudSync`                                                                                                                                                                                                                                 |
| Settings                                                                     | `config`                              | `hidden`                                                                                                                                                                                                                                                                 |
| UpdatePrompt, UpdateProgress                                                 | `update`                              | `hidden`, for an app update and for content alike: the content decision is the `update`-service feature `update.content`                                                                                                                                                 |
| ReleaseNotes                                                                 | `release`                             | `hidden` (`release.changelog` is a `release` feature)                                                                                                                                                                                                                    |
| Paywall                                                                      | `license`                             | `hidden`. Commerce requires License (CM-29), so License off turns Commerce off by the closure rule. Before CM-29, no store grant can land with License off either (`worker/src/core/storeGrants.ts:21-24`). The row holds in both cases                                  |
|                                                                              | `commerce` (CM-29 appends)            | `hidden`. CM-29 adds this pair to `SERVICE_DEPENDENCIES` and appends its row when it adds the slug. There is no Distribution pair: Commerce works with Distribution off, and a store storefront needing its channel is readiness, not a service requirement (CM-29 §3.3) |
| EntitlementGate                                                              | `license`; `commerce` (CM-29 appends) | `not-entitled`, with `entitlement.locked` only: no unlock, because the Paywall is hidden. With License off there is no licence document, so the entitlement is false (`sdk-node/src/license/client.ts:130-134`)                                                          |
| Toast                                                                        | `update`                              | The update toast (`info` with `toast.updateAvailable`) is `hidden`. Other toasts do not change                                                                                                                                                                           |

### 4.5 The sign-in form rows (the brief's `signin-form` fixtures)

- **Coverage.** Every SignIn state (10), SignInHandoff state (9) and LicenseChoice state (14) has an
  inline row, and each inline row gets a sheet twin.
- **How the form ends, in every presentation and on both channels** (`SIGN-IN.md:730-731`).
  `outcome: "signedIn"` expects SignIn/`done`, with:
  - `issuedNow: true`: `[signin.done.start, signin.return.signedInShort]`;
  - `issuedNow: false`: `[signin.desktop.toast]`. The form closes and the app opens with the toast;
  - `license` off: `[signin.return.signedInShort]` (§4.4).

  `Toast`/`success` is for copy confirmations only (`common.copied`). The inline, sheet and browser
  presentations and the device-code channel each have a row for both `issuedNow` values.

- **I-27 D4, as a named row.** `first-automatic-license` is an inline row (with its sheet twin)
  with no `choices`, `outcome: "signedIn"` and `issuedNow: true`, and it expects SignIn/`done`. The
  form never shows `choose` for a first automatic licence, because in app mode `token` answers
  directly (`I-27.md` §2.2). LicenseChoice `new` keeps its view row (a `LicenseChoiceView` with
  `state: "autoIssue"`): `components.json` still lists the state, and the wire still answers
  `autoIssue` (I-27 §2.2, "Wire: none"). If I-08 retires the state, it removes its rows (§4.8).
- **SIGN-IN.md §6.2's extra cases.** Its `sign-in` and `none-replaceable` cases are named rows under
  `many` and `all-full`, the way UK-02a mapped them to keys (`signin.choice.origin.signIn`,
  `signin.choice.noneReplaceable`). The `sign-in` row is a choice with `access: "account"`; the
  `none-replaceable` row has every choice's `replace` set to `null`.
- **`browser` rows** run `methods` → `handoff` → `done`, and end as above. The terminals run this
  presentation only.
- **`device-code` rows.** `deviceCode.phase` alone selects SignInHandoff's state: `starting` →
  `starting`; `waiting` and `slow-down` → `code`; `ok` → `finishing`; `denied`, `expired` and
  `cancelled` → the state of the same name. The `signIn` input carries `presentation` and
  `channel`. Only the closing row adds `outcome: "signedIn"`, with phase `ok` and `issuedNow`: the
  card may mint under I-27 D4 (`devicecode-autoissue.json`, `I-04.md:264`). These rows never reach
  `choose`, `replace` or a LicenseChoice state (D4).
- **`replace: "browser"` rows.** A full row's Replace expects the `replace-in-browser` action and
  never reaches `replace-open`.

### 4.6 `theme` and `i18n`

Both stay as UK-02 §4 wrote them, with D6's identity inputs, D8's kits and D10's products.

- The `theme` expectation is
  `{name, accentSource: integrator | product | icon | core | ink, colorScheme, icon: image | monogram | none}`.
- The `theme` rows cover:
  - the integrator winning (Drift Kart's accent set through the theme);
  - the presentation accent (Drift Kart);
  - no accent, falling to the icon (Tidewater, the default) and then to ink;
  - `accent: "core"` only when the integrator asks for it;
  - Godot and `tv` dark by default (`UI-KITS.md:29`);
  - the terminal's `icon: "none"`.

### 4.7 Generator checks

UK-02 §4's checks stay, with the copy check replaced by D7's. These checks are added, and each one
fails the build:

- **Coverage:**
  - every must state has a row, and D7's union covers its list;
  - every must component has a presentation-absent row (D6);
  - `SERVICE_DEPENDENCIES`' keys are exactly the must components, every service it names is a
    slug in `tools/services.json`, and every (component, service) pair in it has a row that turns
    that service off;
  - each presentation and the device-code channel has both `issuedNow` ending rows, and the
    `first-automatic-license` row exists (§4.5).
- **Input consistency:**
  - `services` is closed under `tools/services.json` `requires`;
  - with `license` off: `gate.status` is absent or `not-applicable`, `registration` is not
    `requires-license`, and there is no `choices`, `replaceView`, `activation` or `issuedNow`;
  - with `identity` off: there is no `signIn` or `deviceCode` input, `capabilities.signIn` is not
    `true`, and `registration` is not `requires-identity`;
  - a `deviceCode` input appears exactly on rows with `signIn.channel: "device-code"`. On those
    rows `signIn.outcome` is absent or `signedIn`, and `signedIn` only with phase `ok`;
  - `issuedNow` appears only with `outcome: "signedIn"`.
- **Expectation consistency:**
  - a SignIn `done` row's copy is exactly the §4.5 ending set for its inputs;
  - a presentation-absent row equals its default row, less a subset of the identity-only keys (D6);
  - D4's refusal, and `hidden` only on a row that turns a service off.
- **Valid values:**
  - every enum value exists in `enums.json`, and `platform.os` is not `tvos`, `visionos` or
    `watchos` (D8);
  - every action is in `vocabulary`.
- **ASCII-only output.**

### 4.8 Versioning, and how other packages change the file

The file is append-only within `uiMatrixVersion: 1`.

- **Version rule.** A new row keeps the version. A changed row, input member or rule bumps it, and
  each runner checks the generated `UI_MATRIX_VERSION` it implements.
- **A feature package** (I-10a, I-10b, LX-19, CM-15, UK-42, UK-43, U-06, U-20) adds, in one PR:
  - its state to `components.json`;
  - its keys to the catalog;
  - its rows here.

  The PR holds the corpus lane while it regenerates (`tracks.md` rule 3).

- **CM-29** adds `commerce` to Paywall's and EntitlementGate's entries in `SERVICE_DEPENDENCIES`
  and appends their two rows (§4.4), in the PR that adds the slug to `tools/services.json`. That
  PR holds the corpus lane anyway (CM-29 Q2). New rows keep `uiMatrixVersion` 1. An existing row
  whose explicit `services` list omits `commerce` keeps its expectation, because only Paywall and
  EntitlementGate depend on Commerce.
- **A copy-only package** (P0-36, P0-38, SP-39, a pack review) that rewords or translates a key
  runs `pnpm gen corpus` and commits the regenerated file without the lane (D13). Removing a key
  that a row names, or adding one to a `components.json` state, makes it a feature package.
- **If I-27 or I-08 changes D2's views**, or retires LicenseChoice `new`, it changes the `signIn`
  rows in its own PR, with a version bump.

## 5. Runners, kits and the card, in order

**The runner contract.** Each core:

- reads the file from the checkout (Godot from its `res://` mirror);
- checks `uiMatrixVersion` against its generated `UI_MATRIX_VERSION`;
- runs **every** row of all ten families, never skipping one;
- compares `component`, `state`, sorted `copy` and sorted `actions`;
- tags its tests `@pkey-feature ui.<x>`, and those tests name `"ui-matrix.json"` in a string
  literal along with the family (parity rule 2, `parity-check.ts:296-305`).

A row that a natural model fails goes back as a bug against the row or the model. The runner is
never weakened (AGENTS rule 1).

1. **UK-02b:** the file, the rows, the registry, the constant and the manifests. No runner is added,
   and every SDK suite stays green with unchanged verdicts.
2. **UK-03 (ui-core):**
   - adds the JS runner;
   - adds `packages/ui-core/test` to the React and Node manifests' `testRoots`;
   - runs the `signIn` family through `SignInModel`;
   - moves UK-14's `models.ts` onto ui-core with byte-identical goldens, and deletes the
     `test/cli/scenarios.ts` cases that the matrix now covers.

   After UK-03: UK-04 (elements), then UK-05 (React, owner), then UK-06 (Electron, Node's owner,
   with the render of D9).

3. **UK-07, then UK-08:** the Swift presentation core.
4. **UK-09, then UK-10:** Kotlin `commonMain`.
5. **UK-11:** the Godot controllers.
6. **UK-12:** `polaris_key.ui.core` and Qt. It deletes the `tests/cli/fixtures.py` cases that the
   matrix covers.
7. **The hosted card.** PX-14 builds the card's LicenseChoiceStep, which replaces the I-26 page
   (`identity/licenseChoice.ts:32`). It runs the LicenseChoice rows against `portal/model` in an
   admin unit test, so it gains a dependency on UK-02b. The card is not a parity SDK, so it gets no
   manifest row.
8. **Packages that append rows** (§4.8; UK-02 §5, item 8):
   - I-10a and I-10b: they map session outcomes into D3's vocabulary, add UK-02 D7's `account`
     family, and add key-entry success rows (they absorbed PX-W9b).
   - HA-13 and HA-14 fill `presentation` from their accessor, with no row change.

**Typed N/As:** only `ui.activate` `outlet` on `ios` and `android`.

## 6. Worker, data, security and privacy

- **Worker and data.**
  - No route, so rule 10 is not involved.
  - No table, no `TABLE_OWNERS` entry and no migration (no `00XX` file).
  - No value change, so P0-49 is not involved.
  - No service boundary edge.
- **THREAT-MODEL: no new row.** The file is display-state data that no gate and no trust decision
  reads. Three existing rules gain cross-language pins:
  - device code never issues a grant (`I-04.md:492`, D4);
  - `license_owned` copy never names the holder (S-16): the `key` rows use only
    `core.codes.license_owned`;
  - the holder is the account signed in on the device (S-19), carried by the `account` input.
- **PRIVACY: no row.** The data is synthetic (D10), with no real email, device or key.

## 7. Docs and drift gates

| Change                                                                                                                                                                                                                                                                         | Gate                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `AGENTS.md` rule 1 list (`:161-164`); the `sign-corpus.ts` header (`:18`)                                                                                                                                                                                                      | `pnpm gen corpus --check`                                                                       |
| `contribute/corpus.md`: a table row (`:72-90`), the never-hand-edit list (`:162-167`), and an "Adding a case" paragraph after presentation-matrix's (`:254`) that states D13                                                                                                   | `pnpm format`                                                                                   |
| `packages/docs/scripts/gen-reference.mjs`: read the file (beside `:639`) and add a "UI state matrix" section (after `:723`) to `reference/corpus.mdx`. `reference/parity.mdx` picks up the ten rows                                                                            | `pnpm --filter @polaris-key/docs gen:check`, then `check:links`                                 |
| `UI-KITS.md` §5.2 (`:1087`): the path, `ui.devicelimit`, D1 and the kit rule. `SIGN-IN.md:1377` and `:1745` point at the `signIn` family; `:1805` says `ui.signin` instead of `ui.kit.signin` (D1). `SIGN-IN.md` §3.17 item 4 (`:730-731`) gains the License-off ending (§4.4) | `pnpm format`                                                                                   |
| `tools/gen-sdk-constants.ts` and its test; feature ids, digests and `UI_MATRIX_VERSION`                                                                                                                                                                                        | `pnpm gen constants --check`, `pnpm parity:check`, `vitest run tools/gen-sdk-constants.test.ts` |
| `components.json`                                                                                                                                                                                                                                                              | `pnpm gen brand --check`                                                                        |

AGENTS rule 3 adds no generated family: the file belongs to rule 1. Rules 9 and 10 are not involved.

## 8. Rollout and rollback

- **What deploys.** Nothing: there is no flag and no owner step, and old clients and Workers are
  unaffected.
- **How it lands.** One PR. The build runs beside the corpus lane, and UK-02b takes the lane only to
  regenerate. It can land before or after P0-44 (D11). **For the lead:** P0-44 freezes
  `sign-corpus.ts` briefly, and `merge.sh` does not auto-resolve that file, so UK-02b's three-line
  edit lands before the freeze or after P0-44 merges, never across it.
- **Brief changes the lead applies after approval:**
  - **UK-02b:** deps on UK-02a. Gates `gen corpus --check` and `gen brand --check`. Node's
    owner is UK-06. Its "One sign-in form" section drops `ui.kit.signin` and its
    `allowedNa headless` (D1).
  - **UK-03:** the runner and `testRoots` from §5; the stand-ins retire.
  - **UK-06:** owns Node's ten rows, with D9's bridge-view render under `packages/sdk-node/test/`.
  - **UK-04, UK-05, UK-07, UK-08, UK-09, UK-10, UK-11 and UK-12:** run all families. `hidden` rows
    assert that nothing renders. Baselines cover every `components.json` state, not `hidden`.
  - **UK-41:** retires `ui.kit`, `ui.kit.manage` and `ui.kit.keyentry` once the ten rows are
    implemented, on the reduced matrix; checks the terminals per D12.
  - **I-08:** adds no `ui.kit.signin` row (amends I-04 §G.8). If the views change or I-27 D4
    retires LicenseChoice `new`, it updates the rows (§4.8).
  - **I-10a and I-10b:** the D3 mapping and the `account` family.
  - **PX-14:** the card (§5, item 7); its deps gain UK-02b.
  - **P0-36, P0-38, SP-39 and the pack reviews:** regenerate after a copy edit, without the lane
    (D13).
  - **P0-44:** moves `tools/ui-matrix.ts` if UK-02b lands first.
  - **LX-19, CM-15, UK-42, UK-43, U-06 and U-20:** append rows (§4.8).
  - **CM-29:** appends the Paywall × `commerce` and EntitlementGate × `commerce` rows and their
    `SERVICE_DEPENDENCIES` entries, in the PR that adds the slug (§4.8).
- **Lead tooling:** `merge.sh` gains `ui-matrix.json` and its mirrors in its auto-resolved set,
  regenerated with `pnpm gen corpus` (D13).
- **Rollback.** Revert the PR; no runner reads the file until UK-03 merges. Once a runner has landed,
  fix forward with a version bump instead.
- **If owner decision 6 is vetoed**, no row changes. A revived kit appends platform rows or reuses
  a core (D8).

## 9. Test strategy

- **`tools/ui-matrix.test.ts`:**
  - one failing input per generator refusal (§4.7 and UK-02 §4), including an unclosed `services`
    list, a device-code row with a contradicting `outcome`, and a missing (component, service) pair;
  - reference-formatter vectors for every locale's plural categories
    (`Intl.PluralRules(locale).resolvedOptions()`) and every `formFactor` case;
  - a check that `ui-matrix.ts` imports nothing from `packages/brand/src`, `sdk-node` or ui-core.
- **`pnpm gen corpus --check`:** `ui-matrix.json` and its mirrors are written, and every other
  file stays byte-identical. `git diff --stat conformance/` shows only the new file and its
  mirrors.
- **`pnpm parity:check`:** ten rows `planned` in six manifests, each with an open owner. The SDK
  suites keep their verdicts with the new constants.
- **Out of scope:** model behaviour is proven by the five runners (§5), not here.

## 10. Left out on purpose

- Runners, kit code and snapshots: those belong to UK-03 and the kit packages.
- A reference state machine in the generator. Rows are authored and checked for structure; the
  five runners are the independent implementations.
- Rows for the should components (CloudSyncStatus, About, ChannelPicker), for parked kits and for
  `tvos`, `visionos` and `watchos`.
- `ui.kit.signin`, any new N/A, runtime or trait, and the `account` family (I-10a).
- Inputs that no package ships yet: I-24b's `scope: "user"`, LX-19's grants and expiry, CM-15's
  offers and I-13's exchange channel. Each producer appends its own rows.
- Moving the matrix out of the corpus (UK-02 D1 holds), and waiting for P0-44.

## 11. Risks

- **I-27 or I-08 reshapes `LicenseChoiceView`.** UK-03 will very likely land before I-08 (wave 7
  against about week 5), so a late change would touch every runner that has landed by then.
  Mitigation: I-27's plan, written in week 0 alongside this one, keeps the views and the wire
  (§2.2, "Wire: none"); its D4 is taken here (§4.5). Any change after that follows §4.8.
- **Copy coupling.** The i18n rows' strings are computed from `kit-copy/*.json` and `copy.*.json`,
  and every row's `copy` is checked against `en.json` and `components.json`. `gen corpus --check`
  runs on every PR (`ci.yml:44`, the lead gate), so every copy or translation edit (P0-36, P0-38,
  SP-39, pack reviews) can fail it until it regenerates. Mitigation: D13 (regenerate without the
  lane; `merge.sh` resolves the file by regenerating), and §8's brief notes.
- **A wrong authored expectation copied by all five runners.** Mitigation: rows are reviewed
  against the `SIGN-IN.md` and `UI-KITS.md` sections this plan cites, and §4.7's expectation checks
  pin the ending and presentation-absent rules. Five independent implementations also surface any
  disagreement, which then goes back as a bug against the row.
- **The critical path.** Mitigation: the lane is held only for regeneration (D11), and the lead
  dispatches the build as soon as this plan is approved.
- **Node's rows stay `planned` until UK-06** (D9). Accepted: UK-03 flips `ui.devices` and
  `ui.devicelimit` early with the terminal render.
- **Carried from UK-02:** generic family names weaken parity rule 2's whole-word check. The
  required `"ui-matrix.json"` literal carries the real check.

## 12. Open questions for the owner

None remain open. Q1 of the first draft is D12, and the plan's other questions are recorded in
[Owner decisions](#owner-decisions-delegated-to-claude-2026-10-08) at the end, each open to the
owner's veto.

## 13. Acceptance

```sh
N="mise exec node@22 --"
$N pnpm build && $N pnpm typecheck
$N pnpm gen brand --check            # components.json family edit; no output diff
$N pnpm gen corpus --check           # ui-matrix.json + Godot (and Swift) mirrors; nothing else
$N pnpm gen constants --check        # ten feature ids; six CAPABILITY_DIGESTs; UI_MATRIX_VERSION
$N pnpm parity:check                    # ten ui.* ids planned in six manifests, owners open
$N pnpm --filter @polaris-key/tools test ui-matrix gen-sdk-constants
$N pnpm --filter @polaris-key/docs gen:check && $N pnpm --filter @polaris-key/docs check:links
$N pnpm test && $N pnpm lint && $N pnpm format
# Unchanged verdicts: sdks/python pytest; swift test; sdks/godot/tools/run_tests.sh;
# sdks/kotlin ./gradlew -Ppkey.jvmOnly=true :conformance:test
node docs/research/2026-09-29-godot-omniplatform/program/check.mjs
```

## Owner decisions (delegated to Claude, 2026-10-08)

The owner delegated program questions to the lead on 2026-10-05, and the lead takes the plan's
recommended option. None of these involves money, an external account, legal terms or brand, or
reverses an owner statement, so none waits for the owner. D12 does sit beside owner decision 6
(framework kits become recipes), which is itself flagged for the owner's veto first; D12 does not
depend on it.

- **D12 (was Q1). Must the two terminal kits draw every must component, or only what their verbs
  reach?**
  - **Decision:** only what their verbs reach. The terminal does not draw Boot, Welcome, SignIn,
    OfflineActivation, LicenseChoice, ReleaseNotes, Settings, Paywall, EntitlementGate or Toast.
  - **Reason:** layer (c) parity is unaffected. ui-core and `polaris_key.ui.core` run every row,
    and Electron's bridge views and Qt render Node's and Python's rows (D9).
  - **If vetoed:** UK-03 and UK-12 each gain about half a week of text renders.
  - Open to the owner's veto.
- **D13. May a copy-only edit regenerate `ui-matrix.json` without holding the serial corpus
  lane?**
  - **Decision:** yes. Only changes to rows, inputs or rules hold the lane. The lead adds
    `ui-matrix.json` and its mirrors to `merge.sh`'s auto-resolved files, regenerated with
    `pnpm gen corpus`.
  - **Reason:** the file is unsigned and fully derived from the copy sources, so whoever merges
    second just regenerates it.
  - **If vetoed:** every copy or translation edit (P0-36, P0-38, SP-39, pack reviews) holds the
    corpus lane while it regenerates.
  - Open to the owner's veto.
- **Q2. How does the sign-in form end when License is off?** `signin.desktop.toast` names a
  `{tier}`, and with License off there is none. `SIGN-IN.md` does not cover the case.
  - **Decision:** end on SignIn/`done` with `signin.return.signedInShort` alone. UK-02b's PR adds
    the case to `SIGN-IN.md` §3.17 item 4 (§4.4, §4.5, §7).
  - **Reason:** it is the existing short return line, and it names nothing that does not exist.
  - **If vetoed:** a new copy key for the License-off ending, added to `en.json` and every
    translation by UK-02b.
  - Open to the owner's veto.
- **Q3. How does UK-02b land around P0-44, which briefly freezes `tools/sign-corpus.ts`?**
  - **Decision:** the lead lands UK-02b's three-line `sign-corpus.ts` edit before P0-44's freeze
    or after P0-44 merges, never across it. Whichever lands second moves `tools/ui-matrix.ts`
    (§8). P0-44 is built and merges in batch 7 (v0.9.0), so UK-02b most likely lands after it.
  - **Reason:** `merge.sh` does not auto-resolve `sign-corpus.ts`.
  - **If vetoed:** UK-02b waits for P0-44 to merge.
  - Open to the owner's veto.
- **Q4 (new, from the owner's 2026-10-07 commerce decision). Which service do Paywall and
  EntitlementGate depend on?**
  - **Decision:** `license` now, plus `commerce` from CM-29, which appends those two rows. The
    Distribution pairs of the reviewed draft are dropped.
  - **Reason:** Commerce is a service that requires License and works with Distribution off
    (CM-29 §3.3). Authoring a Distribution row now would ship a row that is wrong once CM-29
    lands, and changing it then would bump `uiMatrixVersion` for every runner.
  - **If vetoed:** not applicable while the owner's commerce decision stands. If that decision is
    reversed, the Distribution pairs come back as appended rows.
  - Open to the owner's veto.
