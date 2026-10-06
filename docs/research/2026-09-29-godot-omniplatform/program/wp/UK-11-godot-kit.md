# UK-11 Godot UI kit modernised in place: brand default (dark), glass `PKeySheet`, wordmark and display face, input glyphs, console focus ring, themed engine icons, Tween motion, new scenes, POT export

| Field       | Value                                                                                                                                                                                     |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | UK: UI kits: one design system for every SDK (docs/design/UI-KITS.md) (must)                                                                                                              |
| Size        | 5–7 engineer-weeks                                                                                                                                                                        |
| Depends on  | [UK-01](UK-01-brand-kit-tokens.md), [UK-02a](UK-02a-kit-copy-catalog.md), [UK-02b](UK-02b-ui-fixtures-parity.md), [UK-15](UK-15-visual-qa-harness.md), [UK-16](UK-16-ui-docs-scaffold.md) |
| Unblocks    | [UK-29](UK-29-godot-dotnet-facade.md), [UK-36](UK-36-godot-editor-dock.md), [UK-37](UK-37-godot-web-overlay.md), [UK-41](UK-41-must-tier-closeout.md)                                     |
| Role        | `pkey-godot-engineer`                                                                                                                                                                     |
| Plan mode   | no                                                                                                                                                                                        |
| Gates       | `tools/ui_screenshots.gd` promoted to a compared suite; the Godot focus-chain tests; the Godot lint equivalent (every engine control icon themed); `sdks/godot/tools/run_tests.sh`        |
| Human input | none                                                                                                                                                                                      |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                 |

## Sign-in alignment (2026-10-05): SIGN-IN.md

[`docs/design/SIGN-IN.md`](../../../../design/SIGN-IN.md) is the canonical sign-in experience, and `plans/I-04.md`
§F (the reconciliation, with delegated decisions 16–24) is its wire counterpart. Where this brief
differs from either, they win. Copy comes from SIGN-IN.md §5.2 (`signin.*`, US "license").
**No device-wire change** (`PROTOCOL_VERSION` 4, `corpusVersion` 2). For this package:

- Kit screens per SIGN-IN.md §5.1: the logo-only SignIn row with native auth behind the logos (D-21); the device-code hand-off URL `key.plrs.im/device` (`/tv` on TV and console; a product `deviceCodeUrl` wins, D-16); the code as two groups of four joined by a hyphen (D-17); the footnote `signin.footer` (D-15); tier and terms only after the server (D-20); LicenseChoice and ReplaceDevice screens with the row anatomy of §3.6 (tier pill, "{n} of {limit} devices" or "Account-wide · {n} of {limit} devices", **Lifetime**); DeviceLimit titled **Replace a device**.
- "Is this you?" and the attach checkbox only after **Keep** (D-10); title "Activate" → "Welcome to <Product>" (SIGN-IN.md §10.5).

## Goal

A game gates itself with `await PolarisKey.boot()` and every screen looks like modern game UI: glass panels, the game's wordmark, a console focus ring, input glyphs, themed engine controls, at console and Steam Deck sizes.

## Why

The Godot kit has solid plumbing but dated pixels: about 4/10 for polish (§0, GO). Godot is the programme's primary engine. The spec is [`docs/design/UI-KITS.md`](../../../../design/UI-KITS.md); its "Owner decisions (2026-10-05)" header wins over the sections below it.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [UI-KITS.md](../../../../design/UI-KITS.md) §0 Godot row, §1.4 Godot row, §1.5 (rules 5, 6), §3.2 Godot row, §4, §4.3 (games never interrupt play), §4.8, §9 (Godot files)
- `sdks/godot/addons/polaris_key/ui/`, `tools/ui_screenshots.gd`
- Mockups: [godot-gate-dark](../../../../design/ui-kits/shots/godot-gate-dark.png), [godot-gate-light](../../../../design/ui-kits/shots/godot-gate-light.png), [godot-activate-dark](../../../../design/ui-kits/shots/godot-activate-dark.png), [godot-activate-light](../../../../design/ui-kits/shots/godot-activate-light.png), [godot-sign-in-dark](../../../../design/ui-kits/shots/godot-sign-in-dark.png), [godot-sign-in-light](../../../../design/ui-kits/shots/godot-sign-in-light.png), [godot-device-limit-dark](../../../../design/ui-kits/shots/godot-device-limit-dark.png), [godot-device-limit-light](../../../../design/ui-kits/shots/godot-device-limit-light.png), [godot-update-toast-dark](../../../../design/ui-kits/shots/godot-update-toast-dark.png), [godot-update-toast-light](../../../../design/ui-kits/shots/godot-update-toast-light.png), [godot-update-dark](../../../../design/ui-kits/shots/godot-update-dark.png), [godot-update-light](../../../../design/ui-kits/shots/godot-update-light.png), [godot-settings-dark](../../../../design/ui-kits/shots/godot-settings-dark.png), [godot-settings-light](../../../../design/ui-kits/shots/godot-settings-light.png), [godot-gate-deck-dark](../../../../design/ui-kits/shots/godot-gate-deck-dark.png), [godot-gate-deck-light](../../../../design/ui-kits/shots/godot-gate-deck-light.png)

## Scope

**In:**

- Brand default with `colorScheme` dark; glass panel and `PKeySheet` host with scrim, the opaque fallback (`gl_compatibility`, web, `ui_reduce_transparency`).
- `product.wordmark`, `typography.display`, `PKeyInputGlyphs` with the confirm swap, console focus ring with glow, the type floor, toast anchor, UI sound hooks, haptics.
- MSDF fonts and `ui_scale`; every engine control icon themed; 60 px controls; icon set; Tween motion with reduced motion; OS dark-mode follow; safe areas; AccessKit names and live regions.
- New scenes: DeviceLimit, Devices, Paywall, Account tab, CloudSyncStatus, About, Toast, UpdateProgress, ReleaseNotes; copy fixes (no raw codes or slugs); POT export from UK-02a.
- Controllers run the UK-02b fixtures; the presentation seam filled by HA-14.

**Out** (and where it belongs instead):

- The C# facade (→ UK-29); editor dock and web-export overlay (→ UK-36, UK-37).

## Design notes

- `options.gd` `ui_branding := "none"` and the neutral builder become the `native` preset (§3.4, §9).
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
- [ ] Screenshot baselines exist for every fixture component × state (UK-02b) in **both dark and light**, at the sizes and variants of §7.1 for this kit, committed lossless under `sdks/godot/tests/ui/snapshots/`; a changed baseline fails CI until re-recorded with the reason in the commit.
- [ ] The §7.3 modernity lint passes on this kit (every engine control icon set by the brand theme), including the RTL-safe layout rule (no physical left/right; no RTL baselines are required).
- [ ] The §4.4 accessibility checks pass on the same renders (gamepad focus chain, AccessKit live regions).
- [ ] The sample `the addon's demo project` runs against the fixture adapters with no live Worker and with `--live` (§6.1).
- [ ] The kit's framework page and its tab on each component page exist in the docs `build/ui/` section (UK-16 scaffold); the kit README is install + one-line flow + link.
- [ ] A design review against the mockups (`godot.html`) is recorded in the PR (§7.4); any disagreement between mockup and spec is fixed first.
- [ ] `parity.json` for this SDK records the `ui.*` rows this kit proves (UK-02b ids), with snapshot plus fixture-run proofs.
- [ ] The green gate passes (AGENTS.md), including every drift gate listed in the header.

## Verify

```sh
sdks/godot/tools/run_tests.sh
```

## Hand-off

UK-29, UK-36 and UK-37 extend the kit; HA-14 plugs the Godot presentation into `ui_accent` and the brand node through the same seam.

The role agent sets `--set UK-11 in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set UK-11 done`.
