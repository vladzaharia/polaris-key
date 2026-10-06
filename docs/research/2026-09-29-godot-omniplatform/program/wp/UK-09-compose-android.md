# UK-09 Compose Multiplatform kit for Android: `:ui` to KMP (`commonMain` + `androidMain`), Material 3 Expressive, `PolarisKeyGate` one-liner, missing screens, Roborazzi re-baselined

| Field       | Value                                                                                                                                                                                     |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | UK: UI kits: one design system for every SDK (docs/design/UI-KITS.md) (must)                                                                                                              |
| Size        | 4–5 engineer-weeks                                                                                                                                                                        |
| Depends on  | [UK-01](UK-01-brand-kit-tokens.md), [UK-02a](UK-02a-kit-copy-catalog.md), [UK-02b](UK-02b-ui-fixtures-parity.md), [UK-15](UK-15-visual-qa-harness.md), [UK-16](UK-16-ui-docs-scaffold.md) |
| Unblocks    | [UK-10](UK-10-compose-desktop.md), [UK-28](UK-28-android-views.md), [UK-35](UK-35-android-tv-glance.md), [UK-41](UK-41-must-tier-closeout.md)                                             |
| Role        | `pkey-sdk-porter`                                                                                                                                                                         |
| Plan mode   | no                                                                                                                                                                                        |
| Gates       | Roborazzi baselines; `AccessibilityTest`; `BrandRulesTest` and the Compose lint equivalents                                                                                               |
| Human input | none                                                                                                                                                                                      |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                 |

## Sign-in alignment (2026-10-05): SIGN-IN.md

[`docs/design/SIGN-IN.md`](../../../../design/SIGN-IN.md) is the canonical sign-in experience, and `plans/I-04.md`
§F (the reconciliation, with delegated decisions 16–24) is its wire counterpart. Where this brief
differs from either, they win. Copy comes from SIGN-IN.md §5.2 (`signin.*`, US "license").
**No device-wire change** (`PROTOCOL_VERSION` 4, `corpusVersion` 2). For this package:

- Kit screens per SIGN-IN.md §5.1: the logo-only SignIn row with native auth behind the logos (D-21); the device-code hand-off URL `key.plrs.im/device` (`/tv` on TV and console; a product `deviceCodeUrl` wins, D-16); the code as two groups of four joined by a hyphen (D-17); the footnote `signin.footer` (D-15); tier and terms only after the server (D-20); LicenseChoice and ReplaceDevice screens with the row anatomy of §3.6 (tier pill, "{n} of {limit} devices" or "Account-wide · {n} of {limit} devices", **Lifetime**); DeviceLimit titled **Replace a device**.
- Device-code copy → `signin.handoff.*`; Devices "Sign out this device?" → "Remove <device>" (SIGN-IN.md §10.5).

## Goal

An Android app gates itself with `PolarisKeyGate(client) { App() }`, the kit is Material 3 Expressive in the Polaris look, and its states live in `commonMain` so the desktop kit reuses them.

## Why

Today's Compose kit is Material 3 at its 2023 level, Android only, pinned to the Godot template toolchain (§0, KO). The spec is [`docs/design/UI-KITS.md`](../../../../design/UI-KITS.md); its "Owner decisions (2026-10-05)" header wins over the sections below it.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [UI-KITS.md](../../../../design/UI-KITS.md) §0 Compose row, §1.4 Android row, §1.5, §3.2 Compose row, §4, §4.8, §9 (Kotlin files)
- `sdks/kotlin/ui/`
- Mockups: [android-gate-dark](../../../../design/ui-kits/shots/android-gate-dark.png), [android-gate-light](../../../../design/ui-kits/shots/android-gate-light.png), [android-activate-dark](../../../../design/ui-kits/shots/android-activate-dark.png), [android-activate-light](../../../../design/ui-kits/shots/android-activate-light.png), [android-sign-in-dark](../../../../design/ui-kits/shots/android-sign-in-dark.png), [android-sign-in-light](../../../../design/ui-kits/shots/android-sign-in-light.png), [android-sign-in-handoff-dark](../../../../design/ui-kits/shots/android-sign-in-handoff-dark.png), [android-sign-in-handoff-light](../../../../design/ui-kits/shots/android-sign-in-handoff-light.png), [android-device-limit-dark](../../../../design/ui-kits/shots/android-device-limit-dark.png), [android-device-limit-light](../../../../design/ui-kits/shots/android-device-limit-light.png), [android-update-dark](../../../../design/ui-kits/shots/android-update-dark.png), [android-update-light](../../../../design/ui-kits/shots/android-update-light.png), [android-settings-dark](../../../../design/ui-kits/shots/android-settings-dark.png), [android-settings-light](../../../../design/ui-kits/shots/android-settings-light.png)

## Scope

**In:**

- `:ui` as a KMP module (`commonMain` composables and state holders running the UK-02b fixtures, `androidMain`), on a version line decoupled from the Godot template pins.
- Material 3 Expressive (MotionScheme, LoadingIndicator inline only, button groups, shapes, wavy progress), Material Symbols Rounded, filled fields, connected lists, adaptive layouts.
- `rememberPolaris*State`, ViewModel/SavedState, navigation graph and deep links, `PolarisKeyGate` that starts itself; Credential Manager first.
- Missing screens; Compose Resources strings from UK-02a; `polaris-key-ui-brand` split (ZXing, Rubik).
- `ProductIdentity` presentation seam, filled by HA-13's Kotlin accessor.

**Out** (and where it belongs instead):

- Desktop (→ UK-10).
- Android Views (→ UK-28), TV and Glance (→ UK-35).

## Design notes

- Dynamic colour only under `native`.
- No `OutlinedTextField`, no legacy `Icons.Filled`.
- Presentation comes only through the core's `ProductIdentity` seam from the SDK (HA-13, HA-14). This package does not depend on them: it tests the default with a fake source, and the real accessor plugs in without a kit change (UK-41 verifies it).
- Launch locales are English plus `de`, `fr`, `es`, `pt-BR`, `it`, `ja`, `ko`, `zh-Hans`; there is no RTL locale, so no RTL baselines, but layouts stay RTL-safe.

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
- [ ] Screenshot baselines exist for every fixture component × state (UK-02b) in **both dark and light**, at the sizes and variants of §7.1 for this kit, committed lossless under `sdks/kotlin/ui/src/test/snapshots/`; a changed baseline fails CI until re-recorded with the reason in the commit.
- [ ] The §7.3 modernity lint passes on this kit (Compose equivalents), including the RTL-safe layout rule (no physical left/right; no RTL baselines are required).
- [ ] The §4.4 accessibility checks pass on the same renders (`AccessibilityTest`, 200 % font).
- [ ] The sample `examples/ui/compose-android/` runs against the fixture adapters with no live Worker and with `--live` (§6.1).
- [ ] The kit's framework page and its tab on each component page exist in the docs `build/ui/` section (UK-16 scaffold); the kit README is install + one-line flow + link.
- [ ] A design review against the mockups (`android.html`) is recorded in the PR (§7.4); any disagreement between mockup and spec is fixed first.
- [ ] `parity.json` for this SDK records the `ui.*` rows this kit proves (UK-02b ids), with snapshot plus fixture-run proofs.
- [ ] The green gate passes (AGENTS.md), including every drift gate listed in the header.

## Verify

```sh
( cd sdks/kotlin && ./gradlew :ui:testDebugUnitTest :ui:verifyRoborazziDebug )
```

## Hand-off

UK-10 adds `desktopMain`; UK-28 and UK-35 wrap these states.

The role agent sets `--set UK-09 in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set UK-09 done`.
