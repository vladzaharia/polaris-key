# UK-08 SwiftUI kit for macOS 26: Settings scene pane, `CommandGroup`s, inset sheets, a SwiftUI Sparkle `SPUUserDriver`, the inactive-window button fix, macOS 15 fallback

| Field       | Value                                                                        |
| ----------- | ---------------------------------------------------------------------------- |
| Phase       | UK: UI kits: one design system for every SDK (docs/design/UI-KITS.md) (must) |
| Size        | 2–3 engineer-weeks                                                           |
| Depends on  | [UK-07](UK-07-swiftui-ios.md)                                                |
| Unblocks    | [UK-24](UK-24-appkit-kit.md), [UK-41](UK-41-must-tier-closeout.md)           |
| Role        | `pkey-sdk-porter`                                                            |
| Plan mode   | no                                                                           |
| Gates       | Mac snapshot baselines on macOS 26 and 15; the SwiftUI lint equivalents      |
| Human input | none                                                                         |
| Repo        | `vladzaharia/polaris-key`                                                    |

## Sign-in alignment (2026-10-05): SIGN-IN.md

[`docs/design/SIGN-IN.md`](../../../../design/SIGN-IN.md) is the canonical sign-in experience, and `plans/I-04.md`
§F (the reconciliation, with delegated decisions 16–24) is its wire counterpart. Where this brief
differs from either, they win. Copy comes from SIGN-IN.md §5.2 (`signin.*`, US "license").
**No device-wire change** (`PROTOCOL_VERSION` 4, `corpusVersion` 2). For this package:

- Kit screens per SIGN-IN.md §5.1: the logo-only SignIn row with native auth behind the logos (D-21); the device-code hand-off URL `key.plrs.im/device` (`/tv` on TV and console; a product `deviceCodeUrl` wins, D-16); the code as two groups of four joined by a hyphen (D-17); the footnote `signin.footer` (D-15); tier and terms only after the server (D-20); LicenseChoice and ReplaceDevice screens with the row anatomy of §3.6 (tier pill, "{n} of {limit} devices" or "Account-wide · {n} of {limit} devices", **Lifetime**); DeviceLimit titled **Replace a device**.

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

- **The one sign-in form** (SIGN-IN.md §3.17, UI-KITS §1.3): the Welcome pane as the inline form (frames 23, 24, 35, 36, 37, 41), one inset sheet for `presentation: .sheet` (frames 38, 18), **Sign In…** in the account menu opening the sheet, `confirmationDialog` for Replace, and the SwiftUI motion of SIGN-IN.md §3.18. Steps morph in place; nothing stacks on the form except the system confirm for Replace where the platform expects one (D-80).

## Goal

A Mac app gets the Mac-scale kit: sheets below the title bar, a Settings pane, menu commands and a Sparkle update window drawn by the kit, at 13 pt body and 28 pt controls.

## Why

The iOS layout at Mac scale reads as a phone app; macOS needs its own sizes, windows and verbs (§1.4). The spec is [`docs/design/UI-KITS.md`](../../../../design/UI-KITS.md); its "Owner decisions (2026-10-05)" header wins over the sections below it.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [UI-KITS.md](../../../../design/UI-KITS.md) §1.4 macOS row and the desktop dialog model, §4.3 UpdatePrompt, §1.5 rule 11 (title case)
- `sdks/swift/Sources/PolarisKeyUpdate/`
- Mockups: [desktop-gate-dark](../../../../design/ui-kits/shots/desktop-gate-dark.png), [desktop-gate-light](../../../../design/ui-kits/shots/desktop-gate-light.png), [desktop-activate-dark](../../../../design/ui-kits/shots/desktop-activate-dark.png), [desktop-activate-light](../../../../design/ui-kits/shots/desktop-activate-light.png), [desktop-sign-in-dark](../../../../design/ui-kits/shots/desktop-sign-in-dark.png), [desktop-sign-in-light](../../../../design/ui-kits/shots/desktop-sign-in-light.png), [desktop-device-limit-dark](../../../../design/ui-kits/shots/desktop-device-limit-dark.png), [desktop-device-limit-light](../../../../design/ui-kits/shots/desktop-device-limit-light.png), [desktop-update-dark](../../../../design/ui-kits/shots/desktop-update-dark.png), [desktop-update-light](../../../../design/ui-kits/shots/desktop-update-light.png), [desktop-settings-dark](../../../../design/ui-kits/shots/desktop-settings-dark.png), [desktop-settings-light](../../../../design/ui-kits/shots/desktop-settings-light.png)

## Scope

**In:**

- Settings scene pane, `CommandGroup`s (Check for Updates…, Manage License…, About).
- Inset sheets (radius about 24, about 440 pt) instead of window takeovers; the split Welcome window with product art.
- A SwiftUI `SPUUserDriver` for Sparkle (single-column update window).
- The inactive-window prominent-button fix; macOS 15 material fallback baselines.

**Out** (and where it belongs instead):

- AppKit presenters (→ UK-24).

## Design notes

- Title-case buttons and menu items on macOS only; the catalog carries them as documented platform variants.
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
- [ ] Screenshot baselines exist for every fixture component × state (UK-02b) in **both dark and light**, at the sizes and variants of §7.1 for this kit, committed lossless under `sdks/swift/Tests/PolarisKeyUISnapshotTests/__Snapshots__/`; a changed baseline fails CI until re-recorded with the reason in the commit.
- [ ] The §7.3 modernity lint passes on this kit, including the RTL-safe layout rule (no physical left/right; no RTL baselines are required).
- [ ] The §4.4 accessibility checks pass on the same renders.
- [ ] The sample `examples/ui/swiftui/ (macOS target)` runs against the fixture adapters with no live Worker and with `--live` (§6.1).
- [ ] The kit's framework page and its tab on each component page exist in the docs `build/ui/` section (UK-16 scaffold); the kit README is install + one-line flow + link.
- [ ] A design review against the mockups (`desktop.html`) is recorded in the PR (§7.4); any disagreement between mockup and spec is fixed first.
- [ ] `parity.json` for this SDK records the `ui.*` rows this kit proves (UK-02b ids), with snapshot plus fixture-run proofs.
- [ ] The green gate passes (AGENTS.md), including every drift gate listed in the header.

## Verify

```sh
( cd sdks/swift && swift build && swift test )
```

## Hand-off

UK-24 wraps these views for AppKit hosts.

The role agent sets `--set UK-08 in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set UK-08 done`.
