# UK-07 SwiftUI kit for iOS and iPadOS 26: `PolarisKeyUI` rebuilt on a pure-Swift presentation core, `.polarisKeyGate`, Liquid Glass on 26 with a designed iOS 18 fallback, floors raised to iOS 18 / macOS 15

| Field       | Value                                                                                                                                                                                                                                                                                                                                                           |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | UK: UI kits: one design system for every SDK (docs/design/UI-KITS.md) (must)                                                                                                                                                                                                                                                                                    |
| Size        | 4–6 engineer-weeks                                                                                                                                                                                                                                                                                                                                              |
| Depends on  | [UK-01](UK-01-brand-kit-tokens.md), [UK-02a](UK-02a-kit-copy-catalog.md), [UK-02b](UK-02b-ui-fixtures-parity.md), [UK-15](UK-15-visual-qa-harness.md), [UK-16](UK-16-ui-docs-scaffold.md)                                                                                                                                                                       |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [UK-08](UK-08-swiftui-macos.md), [UK-23](UK-23-uikit-kit.md), [UK-25](UK-25-storekit-paywall.md), [UK-26](UK-26-visionos-kit.md), [UK-27](UK-27-tvos-kit.md), [UK-33](UK-33-watchos.md), [UK-34](UK-34-widgetkit-live-activities.md), [UK-41](UK-41-must-tier-closeout.md), [UK-43](UK-43-activation-holders-native.md) |
| Role        | `pkey-sdk-porter`                                                                                                                                                                                                                                                                                                                                               |
| Plan mode   | no                                                                                                                                                                                                                                                                                                                                                              |
| Gates       | swift-snapshot-testing baselines on iOS 26 and iOS 18 simulators; `performAccessibilityAudit`; the SwiftUI lint equivalents; `swift build && swift test`                                                                                                                                                                                                        |
| Human input | none                                                                                                                                                                                                                                                                                                                                                            |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                                                                                                                       |

## Sign-in alignment (2026-10-05): SIGN-IN.md

[`docs/design/SIGN-IN.md`](../../../../design/SIGN-IN.md) is the canonical sign-in experience, and `plans/I-04.md`
§F (the reconciliation, with delegated decisions 16–24) is its wire counterpart. Where this brief
differs from either, they win. Copy comes from SIGN-IN.md §5.2 (`signin.*`, US "license").
**No device-wire change** (`PROTOCOL_VERSION` 4, `corpusVersion` 2). For this package:

- Kit screens per SIGN-IN.md §5.1: the logo-only SignIn row with native auth behind the logos (D-21); the device-code hand-off URL `key.plrs.im/device` (`/tv` on TV and console; a product `deviceCodeUrl` wins, D-16); the code as two groups of four joined by a hyphen (D-17); the footnote `signin.footer` (D-15); tier and terms only after the server (D-20); LicenseChoice and ReplaceDevice screens with the row anatomy of §3.6 (tier pill with "{n} of {limit} devices" for every license, then "{origin} · {term}" with the origin in plain words, never a license type: "From signing in", "Steam key ending 3WPLDA", "From Steam"; owner decision 2026-10-05, **Lifetime**); DeviceLimit titled **Replace a device**.
- `PolarisLoginView.swift`'s single "Sign in" button and always-visible key field become Welcome / SignIn / Activate (SIGN-IN.md §10.5).

## One sign-in form (2026-10-05): `plans/I-04.md` §G and SIGN-IN.md §3.17

The owner decided on 2026-10-05 that every in-app sign-in step happens in **one form whose body
morphs in place** (no stacked sheets), that the license is chosen **inside the app** when it can
show it, that the presentation is configurable with native controls kept, that there are **two
equal ways to integrate** (the hosted card, and the kit form with headless primitives), and that
the web flow is one continuous, animated card. The wire is
[`plans/I-04.md`](../plans/I-04.md) §G (a pending sign-in grant, `licenseChoice: "app" | "card"`);
the experience is [`SIGN-IN.md`](../../../../design/SIGN-IN.md) §2.4, §3.17, §3.18, §4.16 and
D-78–D-93. Where this brief differs, they win. **No device-wire version change**
(`PROTOCOL_VERSION` 4, `DISCOVERY_VERSION` 2, `corpusVersion` 2; no corpus file). New UI copy uses
the owner's license vocabulary (SIGN-IN.md O-17: the tier pill and "{used} of {limit} devices" on
every row, no "Account-wide"). For this package:

- **The one sign-in form** (SIGN-IN.md §3.17, UI-KITS §1.3): `.polarisKeySignIn(client, presentation:)`, the gate's full-screen inline form, the `.sheet` presentation, `confirmationDialog` for Replace, and the SwiftUI motion of SIGN-IN.md §3.18. Steps morph in place; nothing stacks on the form except the system confirm for Replace where the platform expects one (D-80).

## Consolidation 2026-10-07

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **edit** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json) ([Track J, SDK and UI-kit consolidation](../../../2026-10-07-dx-consolidation/tracks.md#j-sdk-and-ui-kit-consolidation)); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> Adds the UIKit hosting recipe (from UK-23) and reads polaris-key.json via fromConfig() (SP-32b). The StoreKit Paywall step joins when LX-23 lands (UK-25 revives into it).

## Approved plans (2026-10-08)

These approved plans change this package. Where they differ from the text below, they win.

- [`plans/UK-02b.md`](../plans/UK-02b.md) §8: runs all ten families of `ui-matrix.json`. `hidden` rows assert that nothing renders. Baselines cover every `components.json` state, not `hidden`.

## SDK usability review (2026-10-08)

Accepted changes from the [SDK usability review](../../../2026-10-08-sdk-usability/README.md) §10.1. Where they differ from the text below, they win.

- The presentation core ships first as a SwiftUI-free product, with public preview states.

## Owner direction (2026-10-08)

- **Responsive.** Every kit screen adapts to its window, with landscape layouts where the window is landscape.
- **Resolution matrix.** Tested at every size in [UI-KITS.md](../../../../design/UI-KITS.md) §7.1, including 200% text or zoom.
- **Spacing and theming.** One spacing rhythm, and themable with `preset: "polaris-key" | "native"`, where `native` matches the platform.
- **Quality bar.** Meets the bar in `.claude/agents/pkey-ux-reviewer.md` ("a GOOD UI", good use of visual space), not just no overflow.
- **Review.** Several UX reviews (`pkey-ux-reviewer`), not one.
- **Two implementation paths.** An integrator drops in the kit or builds their own UI on the SDK. The in-app experience leads with the drop-in kit and links to the docs for integrating directly with your own UI. The docs present both paths.

## Design language v2 (2026-10-08)

This package follows the [design language](../../../../design/UI-KITS.md#design-language-v2-2026-10-08) (rules DL1–DL18). Its row of the [application matrix](../../../../design/UI-KITS-LANGUAGE-MATRIX.md):

- **Rules:** DL1–DL18 (DL14: links only; iPhone and iPad browse).
- **In this kit:** Liquid Glass on 26 (a `.glassProminent` capsule primary, `.glass` secondaries), the material fallback on 18. One scroll tree whose arrangement comes from the keyboard-independent size: the split only at width ≥ 1.15 × height and at least 760×520; the tall form with 1:2 spacers, the act 24 pt above the bottom safe area and the hero at 120 pt; iPad portrait a column of about 480 pt. One prominent button at a time, with `.keyboardShortcut(.defaultAction)` moving with it. The device-limit callout is neutral (DL6). `@AccessibilityFocusState` and announcements carry DL7 and DL9; a hardware keyboard gets `.defaultFocus` on the primary, and touch never raises the keyboard on appear. `native` uses the system fonts, the app's tint and the system grounds.
- **Minimum check:** iPhone 440×956 and 956×440, SE 375×667 and 667×375, and iPad in both orientations, at L, AX3 and AX5, on iOS 26 and 18, both schemes and both presets; `performAccessibilityAudit`. The UX review compares with the fix round's `swiftui.*` renders.
- **Acceptance:** the matrix rows above pass, and a UX review (`pkey-ux-reviewer`) of the built screens gives each a quality verdict of good or better.

## Screen acceptance (brand transition, 2026-10-09)

Done when every row holds for each screen and state this package ships, checked in the real runtime
(not mockups; native kits on device or simulator), with evidence paths in the PR. A row that cannot
apply says why in one line. One home: EXPERIENCE.md §7.3; kits also follow DL1–DL18.

- [ ] Keyboard: tab order follows reading order; focus always visible (DL9); no trap outside a modal;
      Escape or Cancel backs out of every overlay and step; focus returns to the opener (or the heading
      when it is gone); a route change changes the URL and moves focus to the h1, an inline mutation
      changes neither.
- [ ] Screen readers: landmarks and exactly one h1; every icon-only control named; help and errors
      linked (aria-describedby); one polite announcement per change, none while typing; tables use
      th with scope; status is a word and an icon, never colour alone.
- [ ] Sizing: this surface's UI-KITS §7.1 rows plus 200 % text and 400 % zoom (320 CSS px reflow) with
      no page-level sideways scroll; a dense table scrolls only inside a labelled, focusable region;
      targets ≥ 44 px on customer and touch surfaces, ≥ 24 px with separation in the console.
- [ ] Themes: dark and light; a custom product accent on a light and a dark ground (kits, hosted
      sign-in); forced-colors; prefers-contrast: more; reduced transparency; contrast measured on the render (text 4.5:1, UI 3:1) for every state colour in its service accent, both themes.
- [ ] States: loading (skeleton after the grace), first-run empty, filtered empty, permission refused,
      expired or stale, network and API error with Try again, partial failure, success; input survives a
      failed save; where the API sends expectedVersion, a changed-since-open conflict is named with
      Reload.
- [ ] Motion: tokens only; reduced motion is an instant swap and the outcome still reads; errors appear
      without moving content; progress is real (no invented percentage, nothing loops after a failure);
      no celebration on refunds, revocation, removal, deletion or consent.
- [ ] Hierarchy and copy: one filled primary per state (neutral action ink in console, portal and hosted
      sign-in; the product accent in kits); focus, selected, hover, checked and context
      borders take the accent of the service the element references (data-service; -fg for
      text and edges, base for fills; a non-colour cue stays); status colours (success,
      warning, danger, info, signed) never become a service accent; copy from the catalog, each fact once; no decorative numbers or
      taglines; no text drawn over customer art.
- [ ] Native (kits): Dynamic Type or font scale at the 200 % row, VoiceOver or TalkBack, gamepad and
      D-pad focus, TV and title-safe insets, terminal keys with NO_COLOR, ascii and --json paths.
- [ ] pkey-ux-reviewer passes the built screens (BUILT mode).

## Goal

An iOS app gates itself with `.polarisKeyGate(client)`, every §4.1 component exists as a public SwiftUI view in the Liquid Glass idiom on 26 and a polished material fallback on 18, and the package floor is iOS 18.

## Why

Today's Swift kit is one iOS 17-era screen with about 10 % of the catalogue (§0, SW). The owner raised the Apple floors to iOS 18 / macOS 15 (2026-10-05), which removes the iOS 17 fallback work. The spec is [`docs/design/UI-KITS.md`](../../../../design/UI-KITS.md); its "Owner decisions (2026-10-05)" header wins over the sections below it.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [UI-KITS.md](../../../../design/UI-KITS.md) §0 SwiftUI row, §1.4 iOS row, §1.5, §3.2 SwiftUI row, §4, §4.8, §5.1, §9 (Swift files)
- `sdks/swift/Package.swift`, `sdks/swift/Sources/PolarisKeyUI/`
- Mockups: [ios-gate-dark](../../../../design/ui-kits/shots/ios-gate-dark.png), [ios-gate-light](../../../../design/ui-kits/shots/ios-gate-light.png), [ios-activate-dark](../../../../design/ui-kits/shots/ios-activate-dark.png), [ios-activate-light](../../../../design/ui-kits/shots/ios-activate-light.png), [ios-sign-in-dark](../../../../design/ui-kits/shots/ios-sign-in-dark.png), [ios-sign-in-light](../../../../design/ui-kits/shots/ios-sign-in-light.png), [ios-device-limit-dark](../../../../design/ui-kits/shots/ios-device-limit-dark.png), [ios-device-limit-light](../../../../design/ui-kits/shots/ios-device-limit-light.png), [ios-update-dark](../../../../design/ui-kits/shots/ios-update-dark.png), [ios-update-light](../../../../design/ui-kits/shots/ios-update-light.png), [ios-update-required-dark](../../../../design/ui-kits/shots/ios-update-required-dark.png), [ios-update-required-light](../../../../design/ui-kits/shots/ios-update-required-light.png), [ios-settings-dark](../../../../design/ui-kits/shots/ios-settings-dark.png), [ios-settings-light](../../../../design/ui-kits/shots/ios-settings-light.png)

## Scope

**In:**

- `Package.swift` platforms raised to iOS 18, macOS 15, tvOS 18, visionOS 2 (watchOS 11 when UK-33 lands); `#available` guards below 18 removed; the Godot xcframework build (P5-05 `build.sh`) follows the new floor.
- A pure-Swift presentation core running the UK-02b fixtures; `@Observable` models with a status stream (no flash of the wrong state; live updates).
- Public components and styled parts with `PolarisKeyStyle` protocols; `.polarisKeyGate`; String Catalog from UK-02a; typed errors; public `PolarisKeyPreviewState`s.
- Glass on 26 (`.glassProminent` capsules, glass secondaries, concentric sheets); the designed `.regularMaterial` fallback on 18 with its own baselines.
- `ProductIdentity` presentation seam (Swift `PresentationSource`), filled by HA-13's Swift accessor.
- Fix the "this Mac" copy on iPhone.

**Out** (and where it belongs instead):

- macOS specifics (→ UK-08).
- UIKit, StoreKit paywall, visionOS, tvOS (→ UK-23, UK-25–UK-27).

## Design notes

- No iOS 17 / macOS 14 code paths (owner decision).
- Rubik scaled with `UIFontMetrics` (§11 Q6).
- Presentation comes only through the core's `ProductIdentity` seam from the SDK (HA-13, HA-14). This package does not depend on them: it tests the default with a fake source, and the real accessor plugs in without a kit change (UK-41 verifies it).
- Launch locales are English plus `de`, `fr`, `es`, `pt-BR`, `it`, `ja`, `ko`, `zh-Hans`; there is no RTL locale, so no RTL baselines, but layouts stay RTL-safe.

## Presentation seam ([`plans/HA-11.md`](../plans/HA-11.md), approved 2026-10-06)

- **Do not define a seam.** The kit's `ProductIdentity` resolver takes the Swift `PresentationSource` in `PolarisKeyCore` (HA-13).
- **Bidi-isolate presentation text** ([`plans/HA-12.md`](../plans/HA-12.md) Q5). The SDK keeps bidi controls in `PresentationSource` `name` and `developerName` (only C0 and C1 are dropped), so the kit renders both in an isolated run: wrapped in FSI…PDI (U+2068…U+2069).
- **Before that lands.** If the SDK type has not landed when this package starts, declare a
  structurally identical local type, `current()`, `icon(px, scale)` and change notification, and
  replace it with the SDK's type when it lands.
- **Fake sources.** Tests build fake sources from that type.

## Steps

1. Headless layer first: the models or controllers, running the UK-02b fixtures.
2. Styled parts, then the drop-in flow, against the mockups.
3. Baselines in both themes, the lint, the sample and the docs pages.
4. Design review against the mockups; record it in the PR.

## UX coverage (2026-10-09)

Generated from `ux-coverage.json` (read `ux-coverage.md` for the whole map). Do not edit this section by hand; change the coverage file.

- **Builds or backs 13 mockup item(s):** `kitboard:ios.html:gate`, `kitboard:ios.html:activate`, `kitboard:ios.html:sign-in`, `kitboard:ios.html:device-limit`, `kitboard:ios.html:update`, `kitboard:ios.html:update-required`, `kitboard:ios.html:settings`, `kitboard:ios.html:ios18`, `kitboard:ios.html:ax3`, `kitboard:ios.html:states`, `kitboard:apple.html:ipad`, `sdk.swiftui-sign-in`, `sdk.swiftui-activate`.

## Acceptance criteria

- [ ] Every §4.1 component in scope ships in all three layers of §1.3: (a) the drop-in flow, (b) styled parts with the kit's restyle hooks (§3.2), and (c) the headless model.
- [ ] With an empty theme the kit renders the Polaris Key look (§1.1) in the product's accent; `preset: "native"` restyles it to the host (§3.4); every §3.1 theme field is honoured.
- [x] Product identity resolves integrator → SDK presentation source → bundle → derived accent → ink (§1.2). A test with a fake presentation source (accent, `accentDark`, verified icon) renders the product accent and icon with **zero integrator code**; the kit has no discovery fetch or icon cache of its own (owner decision: one path, via HA-13/HA-14).
- [ ] Every visible string is a catalog key from UK-02a in the launch locales; the cross-kit string lint (UK-15) passes.
- [ ] Screenshot baselines exist for every fixture component × state (UK-02b) in **both dark and light**, at the sizes and variants of §7.1 for this kit, committed lossless under `sdks/swift/Tests/PolarisKeyUISnapshotTests/__Snapshots__/`; a changed baseline fails CI until re-recorded with the reason in the commit.
- [x] The §7.3 modernity lint passes on this kit (SwiftUI equivalents: no `.buttonBorderShape(.roundedRectangle)` on 26, no filled secondary capsule), including the RTL-safe layout rule (no physical left/right; no RTL baselines are required).
- [ ] The §4.4 accessibility checks pass on the same renders (`performAccessibilityAudit`, AX3 Dynamic Type).
- [ ] The sample `examples/ui/swiftui/` runs against the fixture adapters with no live Worker and with `--live` (§6.1).
- [ ] The kit's framework page and its tab on each component page exist in the docs `build/ui/` section (UK-16 scaffold); the kit README is install + one-line flow + link.
- [ ] A design review against the mockups (`ios.html`) is recorded in the PR (§7.4); any disagreement between mockup and spec is fixed first.
- [x] `parity.json` for this SDK records the `ui.*` rows this kit proves (UK-02b ids), with snapshot plus fixture-run proofs.
- [ ] Docs, in this PR ([docs plan](../../../2026-10-08-docs/README.md) §10): its part of `<StatesToHandle>` from the fixtures; a kit tab per component; a component page returns when a kit ships it; a recipes page at UK-31.
- [ ] The acceptance in "Design language v2 (2026-10-08)" above holds.
- [ ] The green gate passes (AGENTS.md), including every drift gate listed in the header.

## Verify

```sh
( cd sdks/swift && swift build && swift test )
```

## Hand-off

UK-08, UK-23, UK-25, UK-26, UK-27, UK-33 and UK-34 extend this kit; HA-13 plugs the Swift presentation accessor into its seam.

The role agent sets `--set UK-07 in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set UK-07 done`.

## Status after session 1 (2026-10-09)

Delivered on `wp/UK-07-swiftui-ios` (commits prefixed `UK-07:`); the rest of this package continues
from here.

**Done.**

- Floors: `Package.swift` declares iOS 18, macOS 15, tvOS 18 and visionOS 2; the sub-18
  `#available` guards in `PolarisKeyPlatform` are gone; the Godot Apple plugin builds and warns at
  iOS 18 / macOS 15.
- **`PolarisKeyUICore`** (new product, no SwiftUI): `KitInputs` (the matrix vocabulary, Codable),
  `KitStates` (one pure state machine per §4.1 component), `KitScreen` (state, copy lines with
  arguments, actions), `KitCopy` (the ICU tables of the nine locales, written by `gen:brand` to
  `Resources/kit-copy.json`, with per-locale overrides), `KitIdentity` (§1.2, §3.1, §3.4),
  `PolarisKeyPreviewState`s, `KitPresentationSource` (HA-11's seam, local until HA-13) and the live
  `@Observable PolarisKeyGateModel`. `UIMatrixTests` runs every row of all ten `ui-matrix.json`
  families; `Activate/parsed` is recorded as a corpus defect (its key has a 20-character secret;
  the vocabulary and `LICENSE_KEY_SHAPE` need 22): fix `KEY` in `tools/ui-matrix.ts` (plan mode).
- **`PolarisKeyUI/Kit`**: `.polarisKeyTheme` (every §3.1 field but `platform`), the resolved style,
  Liquid Glass buttons with the designed iOS 18 capsules, the styled parts, the DL1 scaffold, every
  must screen but OfflineActivation's view and Boot's non-progress stages, `PolarisKeyStyle`
  restyle hooks, `.polarisKeyGate(client)`, `.polarisKeySignIn` (sheet), announcements, previews.
- **`examples/ui/swiftui`**: the XcodeGen sample (gallery, `-pkeyState`, `--live`) and
  `KitRenderTests` (every state on the simulator, `performAccessibilityAudit` with contrast
  re-measured on the render, VoiceOver names, swift-snapshot-testing diffing against the
  baselines).
- Docs: the SwiftUI framework page, a SwiftUI tab on each component page and on Theming.
- `parity.json`: the ten `ui.*` rows implemented.
- Baselines: every drawn preview state at the default row (iPhone 17 Pro Max, 440 × 956 portrait,
  L, the Polaris Key preset) in dark and light, flat in `__Snapshots__/` (the docs and ui-qa
  subset), and the eight full-matrix states at AX3, AX5, landscape, `native` and the iOS 18
  `material` fallback in a folder each; `KitRulesTests` fails when a preview state has none.
- One BUILT-mode UX review (`_mockups/review/uk07-swiftui/`): its blocking finding and twenty of
  its major ones are fixed (banners, progress, paywall, sign-in error, alignment, the pinned
  header, button heights, the iOS 18 and `native` grounds and contrast, selection corners, key
  truncation, release notes, Activate done, device removal, browser-mode devices, the empty
  Updates group, CJK weights). After it: the `native` tint goes through the contrast resolver, the
  prominent glass is tinted 15 % darker under a white label (the glass lightens its tint), and
  banners inset the app's bottom safe area.
- Evidence (scratch, not committed): the iPhone matrix passes `performAccessibilityAudit` on every
  render (two Dynamic Type exemptions scoped to reflowing states, each with its reason; an
  element below the fold is noted, not judged); a compare run against the baselines passes. The
  iPad Air 11 (split in landscape) and iPhone SE runs of four states were clean but for the store
  banner and one split contrast, fixed after and not yet re-run there.

**Remaining** (continue in this order):

1. The rest of the UX review, then a second review: Settings' typed controls (toggle, stepper,
   picker from the schema) and its provenance groups; AccountAndLicense's Cloud Sync value, the
   Devices row pushing the Devices pane, Try again offline; 64 pt device rows; SignIn.choose's
   person row, "Use a license key instead" and Replace from a full row; LicenseChoice.none-keys'
   title and primary; SignIn.finishing keeping the hand-off's actions; Cancel and Back as glass
   secondaries docked with the primary (the Replace step's "Back"); a reserved verdict line so
   content never moves while typing; Welcome's extras in one quiet row and Welcome.busy keeping
   its byline; DeviceLimit's count kept on one line, its form-factor glyphs and its selected
   tint; the product name said once per focused step; one title-to-lede gap; the Drift Kart
   fixture's own icon; VoiceOver labels for symbols and the no-browser link.
2. Questions for the matrix and catalog owners (UK-02a/UK-02b), not kit work: the revoked title
   "Signed out" and its fixes (DL6 asks for the sign-in methods); a dismissal for the store
   banner; Restart now on iOS; a no-time `updateProgress.downloading` and a method-less
   `signIn.methodError`; the copy findings in the review's item 29; `Activate/parsed`'s 20-character
   key in `tools/ui-matrix.ts` (plan mode).
3. Re-run `examples/ui/swiftui/run.sh` on `uk07-ipad` and `uk07-se` (wrap it in
   `_lead/heavy.sh`) to confirm the glass and banner fixes there; the iPad's AX3/AX5 store banner
   had two "Text clipped" findings with no element to attribute. Then decide on their baselines:
   only the iPhone's are committed (about 21 MB; the same again per device).
4. iOS 18 renders on a real iOS 18 runtime (only the fallback forced on 26, `-pkeyMaterial`, so
   far), and their baselines.
5. Boot's consent, offline, blocked, declined, rolled-back and error screens as designed views;
   OfflineActivation's view (off on iOS by default; UK-08 for the Mac).
6. The in-app license choice and Replace a device on live data once the SDK carries I-04's grant
   (I-10a); native Apple sign-in behind the logo (`SignInWithAppleButton`, I-13); Google and Steam
   logos with their assets.
7. `.polarisKey(client)` (the 0.8 kit, `PolarisLoginView`) is untouched beside the new kit
   (UK-49's): retire or alias it in SP-35; the kit README (install, one line, link) on UK-49's
   README; `fromConfig()` (SP-32b) and the UIKit hosting recipe (UK-23).
8. The `--live` run against a local Worker; `pnpm ui:lint` (Chromium) and the docs build in the
   gate; `UI_MATRIX_VERSION` is a constant in the core until `gen:constants` emits it.
