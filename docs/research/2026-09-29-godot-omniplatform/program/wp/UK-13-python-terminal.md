# UK-13 Python terminal kit: CLI restyled with rich (ANSI-16 roles, truecolor product chip, 80→60 columns, rails, braille spinner, half-block QR, OSC 8/52), `--json` everywhere, optional Textual app

| Field       | Value                                                                                                                                             |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | UK: UI kits: one design system for every SDK (docs/design/UI-KITS.md) (must)                                                                      |
| Size        | 1.5–2.5 engineer-weeks                                                                                                                            |
| Depends on  | [UK-01](UK-01-brand-kit-tokens.md), [UK-02a](UK-02a-kit-copy-catalog.md), [UK-15](UK-15-visual-qa-harness.md), [UK-16](UK-16-ui-docs-scaffold.md) |
| Unblocks    | [UK-41](UK-41-must-tier-closeout.md)                                                                                                              |
| Role        | `pkey-sdk-porter`                                                                                                                                 |
| Plan mode   | no                                                                                                                                                |
| Gates       | golden ANSI text plus an SVG drawn from it (truecolor, ANSI-16, `NO_COLOR`, ascii; 80 and 60 columns); the string lint                            |
| Human input | none                                                                                                                                              |
| Repo        | `vladzaharia/polaris-key`                                                                                                                         |

## Corrections (2026-10-07, review fix round)

- **`polaris_key.ui.core` pre-empts part of UK-12.** UK-12 had not started, so this package created
  the shared headless layer: the copy lookup and its ICU subset, `ProductIdentity` and the
  presentation-source seam, `Theme`, and the models (SDK result in, component and state out). UK-12
  extends it with the Qt view models rather than writing a second one.
- **The SVG baselines are drawn from the golden ANSI, not by VHS.** VHS is not installed on the build
  machines and writes no SVG; the kit's cell-grid renderer (`tests/cli/svg.py`, 14 px JetBrains
  Mono at line-height 1.2) draws each default render, and the SVGs are byte-compared like the text.
  The Gates line above says so.
- **The UK-02b rows are still open.** `ui-matrix.json` and the `ui.gate` … `ui.i18n` parity rows do
  not exist yet: kit-local fixtures (`tests/cli/fixtures.py`) stand in, and the proofs are recorded
  on `ui.cli`. The criterion on `parity.json` stays open until UK-02b lands.

## Sign-in alignment (2026-10-05): SIGN-IN.md

[`docs/design/SIGN-IN.md`](../../../../design/SIGN-IN.md) is the canonical sign-in experience, and `plans/I-04.md`
§F (the reconciliation, with delegated decisions 16–24) is its wire counterpart. Where this brief
differs from either, they win. Copy comes from SIGN-IN.md §5.2 (`signin.*`, US "license").
**No device-wire change** (`PROTOCOL_VERSION` 4, `corpusVersion` 2). For this package:

- Kit screens per SIGN-IN.md §5.1: the logo-only SignIn row with native auth behind the logos (D-21); the device-code hand-off URL `key.plrs.im/device` (`/tv` on TV and console; a product `deviceCodeUrl` wins, D-16); the code as two groups of four joined by a hyphen (D-17); the footnote `signin.footer` (D-15); tier and terms only after the server (D-20); LicenseChoice and ReplaceDevice screens with the row anatomy of §3.6 (tier pill with "{n} of {limit} devices" for every license, then "{origin} · {term}" with the origin in plain words, never a license type: "From signing in", "Steam key ending 3WPLDA", "From Steam"; owner decision 2026-10-05, **Lifetime**); DeviceLimit titled **Replace a device**.

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

- **The one sign-in form** (SIGN-IN.md §3.17, UI-KITS §1.3): the browser presentation only: `login` opens the card, which chooses the license; never license rows (SIGN-IN.md D-93). Steps morph in place; nothing stacks on the form except the system confirm for Replace where the platform expects one (D-80).

## Goal

The Python CLI reads like a 2026 CLI (gh, uv, clack): every verb has the terminal look, `--json`, and golden tests in both terminal themes.

## Why

Python's only UI today is plain-text CLI verbs (§0, GA); `ui.cli` (SP-00) needs a real proof. The spec is [`docs/design/UI-KITS.md`](../../../../design/UI-KITS.md); its "Owner decisions (2026-10-05)" header wins over the sections below it.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [UI-KITS.md](../../../../design/UI-KITS.md) §1.4 Terminal row, §1.5 rule 13, §4.8 Terminal column, §7.1 Terminal row
- `sdks/python/src/polaris_key/cli*`
- Mockups: [terminal-sign-in-dark](../../../../design/ui-kits/shots/terminal-sign-in-dark.png), [terminal-sign-in-light](../../../../design/ui-kits/shots/terminal-sign-in-light.png), [terminal-activate-dark](../../../../design/ui-kits/shots/terminal-activate-dark.png), [terminal-activate-light](../../../../design/ui-kits/shots/terminal-activate-light.png), [terminal-device-limit-dark](../../../../design/ui-kits/shots/terminal-device-limit-dark.png), [terminal-device-limit-light](../../../../design/ui-kits/shots/terminal-device-limit-light.png), [terminal-update-dark](../../../../design/ui-kits/shots/terminal-update-dark.png), [terminal-update-light](../../../../design/ui-kits/shots/terminal-update-light.png), [terminal-status-error-dark](../../../../design/ui-kits/shots/terminal-status-error-dark.png), [terminal-status-error-light](../../../../design/ui-kits/shots/terminal-status-error-light.png), [terminal-help-dark](../../../../design/ui-kits/shots/terminal-help-dark.png), [terminal-help-light](../../../../design/ui-kits/shots/terminal-help-light.png), [terminal-fallbacks-dark](../../../../design/ui-kits/shots/terminal-fallbacks-dark.png), [terminal-fallbacks-light](../../../../design/ui-kits/shots/terminal-fallbacks-light.png), [terminal-narrow-dark](../../../../design/ui-kits/shots/terminal-narrow-dark.png), [terminal-narrow-light](../../../../design/ui-kits/shots/terminal-narrow-light.png), [terminal-textual-dark](../../../../design/ui-kits/shots/terminal-textual-dark.png), [terminal-textual-light](../../../../design/ui-kits/shots/terminal-textual-light.png)

## Scope

**In:**

- rich palette from the UK-01 ANSI tables, rails, braille spinner, progress, half-block QR for `begin_sign_in`, masked key entry, device-limit picker, OSC 8 links and OSC 52 copy, light-background detection.
- Error code → catalog copy mapping; `--json` on every verb; `NO_COLOR` and ascii fallbacks.
- Optional Textual app (`[tui]`), buttons as one shape (§8 terminal).

**Out** (and where it belongs instead):

- The Qt kit (→ UK-12).

## Design notes

- Presentation comes only through the core's `ProductIdentity` seam from the SDK (HA-13, HA-14). This package does not depend on them: it tests the default with a fake source, and the real accessor plugs in without a kit change (UK-41 verifies it).
- Launch locales are English plus `de`, `fr`, `es`, `pt-BR`, `it`, `ja`, `ko`, `zh-Hans`; there is no RTL locale, so no RTL baselines, but layouts stay RTL-safe.

## Steps

1. Headless layer first: the models or controllers, running the UK-02b fixtures.
2. Styled parts, then the drop-in flow, against the mockups.
3. Baselines in both themes, the lint, the sample and the docs pages.
4. Design review against the mockups; record it in the PR.

## Acceptance criteria

- [x] Every §4.1 component in scope ships in all three layers of §1.3: (a) the drop-in flow, (b) styled parts with the kit's restyle hooks (§3.2), and (c) the headless model. (Fifteen components: the CLI verbs over `polaris_key.ui.terminal.flows`, `Kit` and `screens`, and `polaris_key.ui.core.models`; Welcome, LicenseChoice, Paywall, EntitlementGate, Toast and the should tier are out of scope for a terminal, each with its reason in `tests/cli/fixtures.py`.)
- [x] With an empty theme the kit renders the Polaris Key look (§1.1) in the product's accent; `preset: "native"` restyles it to the host (§3.4); every §3.1 theme field is honoured. (The fields with no meaning in a cell grid, `radius`, `typography`, `density`, `ambient`, `service_cues` and `platform`, are documented as such on the kit's page.)
- [x] Product identity resolves integrator → SDK presentation source → bundle → derived accent → ink (§1.2). A test with a fake presentation source (accent, `accentDark`, verified icon) renders the product accent and icon with **zero integrator code**; the kit has no discovery fetch or icon cache of its own (owner decision: one path, via HA-13/HA-14). (A terminal draws no icon; the seam reads `client.presentation()` or a `current()` source.)
- [x] Every visible string is a catalog key from UK-02a in the launch locales; the cross-kit string lint (UK-15) passes. (The kit's own lint holds every render's spans to the catalog list of its component and state; `doctor`, `secret`, `mint` and usage lines are developer diagnostics, marked as such. No catalog key was added.)
- [x] Screenshot baselines exist for every fixture component × state (UK-02b) in **both dark and light**, at the sizes and variants of §7.1 for this kit, committed lossless under `sdks/python/tests/cli/golden/`; a changed baseline fails CI until re-recorded with the reason in the commit. (UK-02b's fixtures do not exist yet: 70 kit-local fixture states; golden ANSI in every variant plus an SVG drawn from it, not VHS.)
- [x] The §7.3 modernity lint passes on this kit (the string lint and the 80/60-column checks), including the RTL-safe layout rule (no physical left/right; no RTL baselines are required). (`tests/cli/test_lint.py` and the new `terminal-python` rules in `packages/ui-qa/rules/kit-rules.json`.)
- [x] The §4.4 accessibility checks pass on the same renders (screen-reader-safe output when not a TTY).
- [x] The sample `the `tidewater` demo CLI (Python)` runs against the fixture adapters with no live Worker and with `--live` (§6.1).
- [x] The kit's framework page and its tab on each component page exist in the docs `build/ui/` section (UK-16 scaffold); the kit README is install + one-line flow + link.
- [x] A design review against the mockups (`terminal.html`) is recorded in the PR (§7.4); any disagreement between mockup and spec is fixed first. (The board's sign-in, device-limit, fallbacks and 60-column shots now follow SIGN-IN.md D-67/D-68 and UI-KITS §4.3's browser mode.)
- [ ] `parity.json` for this SDK records the `ui.*` rows this kit proves (UK-02b ids), with snapshot plus fixture-run proofs. (The `ui.*` rows are UK-02b's and do not exist yet; the proofs are recorded on `ui.cli`.)
- [x] The green gate passes (AGENTS.md), including every drift gate listed in the header.

## Verify

```sh
( cd sdks/python && .venv/bin/python -m pytest -q tests/cli )
```

## Hand-off

`ui.cli` for Python is proven by these goldens.

The role agent sets `--set UK-13 in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set UK-13 done`.
