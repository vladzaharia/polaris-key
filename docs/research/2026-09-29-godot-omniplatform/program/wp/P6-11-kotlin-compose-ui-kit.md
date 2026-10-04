# P6-11 Kotlin SDK Jetpack Compose UI kit

| Field       | Value                                                                                                                                                      |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | P6: Commerce, ops, web                                                                                                                                     |
| Size        | 2–3 engineer-weeks                                                                                                                                         |
| Depends on  | [P6-07](P6-07-kotlin-license-config-identity.md), [P6-08](P6-08-kotlin-update-packs.md)                                                                    |
| Unblocks    | [P6-05](P6-05-kotlin-sdk.md)                                                                                                                               |
| Role        | `pkey-implementer`                                                                                                                                         |
| Plan mode   | no                                                                                                                                                         |
| Gates       | `gen:brand -- --check` (Kotlin token emitter), Compose snapshot tests, accessibility checks, `parity:check` (`ui.kit`), the `kotlin` and `android` CI jobs |
| Human input | none (screenshots for review are taken by the agent from the snapshot run)                                                                                 |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                  |

Slice f of [P6-05](P6-05-kotlin-sdk.md).

## Goal

`:ui`, an Android library of Jetpack Compose screens over the Kotlin SDK's services, modelled on
the SwiftUI kit (`sdks/swift/Sources/PolarisKeyUI`) and the registry's `ui.kit` row: gate,
activation, sign-in with QR, settings, devices, update banner and pack progress. Owner decision 2
sets the look:

- every screen is **centred and polished** (consistent column, spacing, type scale, empty, loading
  and error states, landscape and large-screen layouts);
- the **default theme is neutral and inherits the host app's look** (`MaterialTheme` colours,
  typography and shapes; no Polaris Key colours, fonts or logo unless asked);
- **Polaris Key branding is optional, behind one opt-in switch** (`PolarisBranding.PolarisKey`
  versus `PolarisBranding.None`, default `None`) that swaps in the brand tokens, wordmark glyph and
  service accents;
- a **"Powered by Polaris Key" badge is optional and off by default** (`showPoweredBy = false`).

A reviewer can tell it happened when a host with a stock Material 3 theme renders every screen with
no Polaris Key colours, and flipping the single switch produces the branded variant.

## Why

- `ui.kit` is `planned` for every SDK that is not React or Godot; the Kotlin SDK is the second
  native SDK to ship one, and native Android apps otherwise rebuild the gate by hand.
- The owner wants every SDK UI kit neutral by default, with Polaris Key branding opt-in. The React,
  SwiftUI and Godot kits on main already are: Swift's `PolarisLoginView` defaults to
  `PolarisBranding.native` (system fonts, the app's tint) behind `.polarisKeyBranding(.polarisKey)`,
  and `PolarisTheme.brandAccent` survives only as a deprecated accessor. The Kotlin kit matches
  that contract. The Swift kit's missing screens are a separate package, not this one.

## Read first

- `AGENTS.md`; the hand-offs of [P6-07](P6-07-kotlin-license-config-identity.md) and
  [P6-08](P6-08-kotlin-update-packs.md); [P6-06](P6-06-kotlin-core-runner.md) for the stage machine.
- `sdks/swift/Sources/PolarisKeyUI/` (`PolarisLoginView.swift`, `PolarisTheme.swift`, the copy block
  and the state-to-copy mapping that is unit-tested without rendering) and
  [P1-10](P1-10-godot-ui-kit.md) (the Godot kit: the screen list and the `PKeyBoot` shell).
- `packages/brand/` (`README.md`, `scripts/gen.ts`, `tokens.json`, the Launch Kit; the Swift output
  is `BrandTokens.generated.swift`) and the brand rules for the "Powered by" phrase and clear space.
- `conformance/corpus/v2/stage-matrix.json` and PARITY §5.7 (`ui.stages`, `ui.kit`).

## Scope

**In:**

- `:ui` module, Android only (Jetpack Compose with Material 3; Compose Multiplatform and a JVM
  desktop kit are out). Coordinates `im.plrs.key:polaris-key-ui`, `maven-publish` to a local
  `build/repo` only.
- A `PolarisBoot` composable driving the shared stage machine from `:core` and rendering the screens
  below without cutting to another screen, plus each screen as its own composable and a
  state-holder (`PolarisGateState`, ... as `StateFlow`) so hosts can compose their own flow.
- Screens: gate (all terminal states: revoked, expired, version too old or new, channel not
  entitled, grace banner), activation (sign-in button and licence-key field), sign-in with QR
  (RFC 8628 device code with the code, QR and countdown), settings (config values and entitlement
  badge), devices (list, rename, deauthorise), update banner and update prompt, pack progress.
- Theme: `PolarisTheme(branding = PolarisBranding.None, showPoweredBy = false, copy = PolarisCopy(),
logo = null)`. With `None` every colour, shape and text style reads from the host's
  `MaterialTheme`; the logo slot is empty unless the host supplies one. With `PolarisKey` it applies
  the generated brand tokens (dark first, light supported, per-service accents) and the glyph.
- Copy: every string lives in `PolarisCopy` (and Android string resources with the English default
  and a hook for host translations), including chrome; the state-to-copy mapping is a pure function
  with unit tests, as in Swift.
- A Kotlin emitter in `packages/brand/scripts/gen.ts` writing `PolarisBrandTokens.generated.kt`
  into `:ui`, covered by `pnpm gen:brand -- --check`.
- Quality bar, checked not claimed: snapshot tests (Paparazzi or Roborazzi; the PR names the choice)
  of every screen in light, dark, large font scale, a phone and a tablet, branded and neutral;
  TalkBack semantics (headers, roles, content descriptions, focus order) asserted with Compose
  accessibility tests; minimum 48 dp touch targets; contrast checks on the branded palette.
- `ui.kit` flipped to `implemented` in `sdks/kotlin/parity.json` (proof: the snapshots); docs page.

**Out** (and where it belongs instead):

- Changing the Swift kit's default theme or adding the missing Swift screens (a follow-up package).
- Compose Multiplatform, Wear or TV layouts.
- Any service logic: the kit renders state from `:sdk` and never calls the network itself.

## Design notes

- **Neutral means inherited.** No hard-coded colour, font or shape in a screen; they come from
  `PolarisTheme`, which resolves to `MaterialTheme` when branding is `None`. A lint-style test
  scans `:ui` for colour literals outside the generated token file.
- **One switch.** Branding is a single parameter on `PolarisTheme`, not a set of flags; the badge is
  separate by owner decision and is off even when branding is on.
- **Centred.** Screens share one `PolarisScreen` scaffold (centred column, max content width,
  safe-area and IME insets), so a screen cannot drift out of alignment.
- **Brand rules.** Optical size cuts, clear space and the glyph colour rules come from
  `@polaris-key/brand`; do not re-derive them.
- **Dependencies.** `:ui` depends on `:sdk`, `:update` and `:packs` (state types) and on Compose; it
  must not depend on `:platform` or `:android`.

## Steps

1. Scaffold `:ui`, the theme, `PolarisScreen` and the Kotlin brand emitter.
2. Gate and activation with their state holders and snapshots.
3. Sign-in with QR, settings, devices.
4. Update banner, prompt and pack progress; `PolarisBoot`.
5. Accessibility and contrast pass; docs; `parity.json`.

## Acceptance criteria

- [ ] With a stock Material 3 theme and defaults, no screen renders a Polaris Key colour, font,
      logo or the badge (a snapshot and a test prove it).
- [ ] Setting `PolarisBranding.PolarisKey` is the only change needed to get the branded variant;
      `showPoweredBy = true` adds the badge and is independent of branding.
- [ ] Every screen listed has snapshots (light, dark, large font, phone, tablet; neutral and
      branded) and passes the accessibility tests.
- [ ] Every string is in `PolarisCopy` or string resources; the state-to-copy mapping has unit tests.
- [ ] `pnpm gen:brand -- --check` covers the Kotlin token file; `ui.kit` is `implemented` and
      `parity:check` is green.
- [ ] The green gate passes (`AGENTS.md`) and the CI jobs are green.

## Verify

```sh
( cd sdks/kotlin && ./gradlew :ui:verifyRoborazziDebug )   # every :ui unit test, with the snapshots verified (Roborazzi)
mise exec node@22 -- pnpm gen:brand -- --check
mise exec node@22 -- pnpm parity:check -- --check
```

## Hand-off

- `PolarisBoot`, the screens and `PolarisTheme` as the Kotlin SDK's UI surface; the docs page for
  adopters.
- The role agent sets `--set P6-11 in-review` when it hands off. After review, the lead adds the last
  commit of the PR:
  `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P6-11 done`.

## Corrections from implementation

Recorded by the implementer on 2026-10-04. The code is the fact where this brief and the code
disagree.

- **Snapshot tool: Roborazzi.** Robolectric (4.14.1) is already the Android modules' unit-test
  runtime, so the snapshots use Roborazzi 1.43 over Robolectric's native graphics rather than
  Paparazzi. The verify task is `:ui:verifyRoborazziDebug`, and recording is `:ui:recordRoborazziDebug`.
  The references are mdpi (one pixel per dp), so the 136 committed PNGs stay at about 2.7 MB. They
  cover 19 screen states in 7 variants (phone neutral and branded in light and dark, phone at a
  200 % font scale, tablet neutral and branded) and the badge in 3. Comparison allows a 1 % pixel
  change for font hinting across hosts. Robolectric's 200 % is Android 14's nonlinear font scaling.
  The accessibility suite also checks a linear 2x on a 360 x 640 dp phone.
- **Versions.** Kotlin is pinned at 2.1.21 by Godot's Android template, so the kit uses the Compose
  BOM 2025.05.01 (Compose 1.8, Material 3 1.3) and the Compose compiler plugin at the Kotlin
  version. New dependencies:
  - `material-icons-core`;
  - ZXing `core` 3.5.3, the QR encoder: pure Java, no camera;
  - `activity-compose`, for tests only.
- **Dependencies.** `:ui` depends on `:sdk` only, which carries `:core`, `:update` and `:packs`
  through `api`. `checkModuleBoundaries` now also fails when `:ui` reaches `:platform`, `:android`,
  `:godot`, `:boundary` or `:conformance`.
- **Brand artwork as vectors.** Swift bundles kit PNGs. Here the generator reduces the kit SVGs (the
  bit-less display-cut Pinned K and the compact transparent badge) to groups and filled paths
  (`svgTree`) and emits them in `PolarisBrandTokens.generated.kt`, so `gen:brand --check` covers the
  marks as well as the tokens. The Rubik TTFs are binary copies into `res/font`, through a new
  `COPIES` list that `--check` compares byte for byte. The OFL and the kit notice are in
  `assets/polaris-key/fonts/`.
- **Theme surface.** `PolarisTheme(branding, showPoweredBy, copy, logo)` as specified, plus
  `darkTheme`, which follows the system. Neutral, the kit sets no `MaterialTheme` of its own. Material
  3 has no role for warning and success, so those colours come from `PolarisStatusColors`: the
  host's tertiary and primary roles when neutral, brand tokens when branded. Service accents (license,
  update, release) colour only the small indicators when branded, and fall back to the host's
  primary when neutral. The QR code is always dark on light, in both modes, so every scanner reads it.
- **Copy.** `PolarisCopy` has 147 fields. `res/values/strings.xml` holds a resource for each, named
  `pkey_ui_<snake_case>`. `PolarisCopy.localized()` reads them by field name, so a consumer R8 rule
  keeps the field names. A debug-only `values-fr` stands in for an app's translation in the tests.
- **Scope details.**
  - Settings is read-only: it shows the licence summary and the resolved user-facing config values.
  - Devices renames and signs out (deauthorises) through confirmation dialogs.
  - The update prompt is a card, which `PolarisUpdatePromptDialog` wraps in a dialog. The snapshots
    show the card, not the dialog windows.
  - `PolarisKeyClient.bootHost()` treats a sync where every enabled document failed, or the call
    threw, as `offline`.
- **Docs.** The Kotlin SDK's own docs page is still P6-05's. This package adds
  `build/sdks/kotlin-ui.mdx`, which renders `sdks/kotlin/ui/README.md`, and links it from the SDK
  index.
- **CI.** The `android` job runs `:ui:verifyRoborazziDebug`, `:ui:lintRelease`,
  `:ui:assembleRelease` and `:ui:publishUiPublicationToLocalRepository`. The `kotlin` job
  (`-Ppkey.jvmOnly`) leaves `:ui` out, like every Android module.
