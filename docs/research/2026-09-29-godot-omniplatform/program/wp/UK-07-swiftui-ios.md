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

## Acceptance criteria

- [ ] Every §4.1 component in scope ships in all three layers of §1.3: (a) the drop-in flow, (b) styled parts with the kit's restyle hooks (§3.2), and (c) the headless model.
- [ ] With an empty theme the kit renders the Polaris Key look (§1.1) in the product's accent; `preset: "native"` restyles it to the host (§3.4); every §3.1 theme field is honoured.
- [ ] Product identity resolves integrator → SDK presentation source → bundle → derived accent → ink (§1.2). A test with a fake presentation source (accent, `accentDark`, verified icon) renders the product accent and icon with **zero integrator code**; the kit has no discovery fetch or icon cache of its own (owner decision: one path, via HA-13/HA-14).
- [ ] Every visible string is a catalog key from UK-02a in the launch locales; the cross-kit string lint (UK-15) passes.
- [ ] Screenshot baselines exist for every fixture component × state (UK-02b) in **both dark and light**, at the sizes and variants of §7.1 for this kit, committed lossless under `sdks/swift/Tests/PolarisKeyUISnapshotTests/__Snapshots__/`; a changed baseline fails CI until re-recorded with the reason in the commit.
- [ ] The §7.3 modernity lint passes on this kit (SwiftUI equivalents: no `.buttonBorderShape(.roundedRectangle)` on 26, no filled secondary capsule), including the RTL-safe layout rule (no physical left/right; no RTL baselines are required).
- [ ] The §4.4 accessibility checks pass on the same renders (`performAccessibilityAudit`, AX3 Dynamic Type).
- [ ] The sample `examples/ui/swiftui/` runs against the fixture adapters with no live Worker and with `--live` (§6.1).
- [ ] The kit's framework page and its tab on each component page exist in the docs `build/ui/` section (UK-16 scaffold); the kit README is install + one-line flow + link.
- [ ] A design review against the mockups (`ios.html`) is recorded in the PR (§7.4); any disagreement between mockup and spec is fixed first.
- [ ] `parity.json` for this SDK records the `ui.*` rows this kit proves (UK-02b ids), with snapshot plus fixture-run proofs.
- [ ] Docs, in this PR ([docs plan](../../../2026-10-08-docs/README.md) §10): its part of `<StatesToHandle>` from the fixtures; a kit tab per component; a component page returns when a kit ships it; a recipes page at UK-31.
- [ ] The green gate passes (AGENTS.md), including every drift gate listed in the header.

## Verify

```sh
( cd sdks/swift && swift build && swift test )
```

## Hand-off

UK-08, UK-23, UK-25, UK-26, UK-27, UK-33 and UK-34 extend this kit; HA-13 plugs the Swift presentation accessor into its seam.

The role agent sets `--set UK-07 in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set UK-07 done`.
