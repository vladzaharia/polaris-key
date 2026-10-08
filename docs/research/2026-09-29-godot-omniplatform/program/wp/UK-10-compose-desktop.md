# UK-10 Compose Multiplatform kit for JVM desktop: `desktopMain` with the §1.4 desktop dialog model, Windows/macOS/Linux variants, focus rings, desktop density, UpdatePrompt over UK-40's updater

| Field       | Value                                                                                              |
| ----------- | -------------------------------------------------------------------------------------------------- |
| Phase       | UK: UI kits: one design system for every SDK (docs/design/UI-KITS.md) (must)                       |
| Size        | 2–3 engineer-weeks                                                                                 |
| Depends on  | [UK-09](UK-09-compose-android.md), [UK-40](UK-40-kotlin-jvm-desktop.md)                            |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [UK-41](UK-41-must-tier-closeout.md)                       |
| Role        | `pkey-sdk-porter`                                                                                  |
| Plan mode   | no                                                                                                 |
| Gates       | Compose Desktop screenshot tests for Windows, macOS and Linux chrome; the Compose lint equivalents |
| Human input | none                                                                                               |
| Repo        | `vladzaharia/polaris-key`                                                                          |

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

- **The one sign-in form** (SIGN-IN.md §3.17, UI-KITS §1.3): the Welcome pane as the inline form (frames 28, 29), one `ContentDialog` (frame 30) or `AdwDialog` (frame 40) for `sheet`, Replace's confirm per SIGN-IN.md D-80, and the Compose motion of §3.18. Steps morph in place; nothing stacks on the form except the system confirm for Replace where the platform expects one (D-80).

## Consolidation 2026-10-07

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **keep** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json) ([Track J, SDK and UI-kit consolidation](../../../2026-10-07-dx-consolidation/tracks.md#j-sdk-and-ui-kit-consolidation)); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> Owner decision (JVM desktop parity).

## Approved plans (2026-10-08)

These approved plans change this package. Where they differ from the text below, they win.

- [`plans/UK-02b.md`](../plans/UK-02b.md) §8: runs all ten families of `ui-matrix.json`. `hidden` rows assert that nothing renders. Baselines cover every `components.json` state, not `hidden`.

## Owner direction (2026-10-08)

- **Responsive.** Every kit screen adapts to its window, with landscape layouts where the window is landscape.
- **Resolution matrix.** Tested at every size in [UI-KITS.md](../../../../design/UI-KITS.md) §7.1, including 200% text or zoom.
- **Spacing and theming.** One spacing rhythm, and themable with `preset: "polaris-key" | "native"`, where `native` matches the platform.
- **Quality bar.** Meets the bar in `.claude/agents/pkey-ux-reviewer.md` ("a GOOD UI", good use of visual space), not just no overflow.
- **Review.** Several UX reviews (`pkey-ux-reviewer`), not one.
- **Two implementation paths.** An integrator drops in the kit or builds their own UI on the SDK. The in-app experience leads with the drop-in kit and links to the docs for integrating directly with your own UI. The docs present both paths.

## Goal

A Compose Desktop app gets the full kit with real desktop behaviour on all three OSes, at full parity with Android (owner, 2026-10-05).

## Why

Kotlin JVM desktop is second-class today; the owner asked for full parity: kit, keyring and updater. The spec is [`docs/design/UI-KITS.md`](../../../../design/UI-KITS.md); its "Owner decisions (2026-10-05)" header wins over the sections below it.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [UI-KITS.md](../../../../design/UI-KITS.md) §1.4 Windows, Linux and macOS rows, the desktop dialog model
- Mockups: [windows-gate-dark](../../../../design/ui-kits/shots/windows-gate-dark.png), [windows-gate-light](../../../../design/ui-kits/shots/windows-gate-light.png), [windows-activate-dark](../../../../design/ui-kits/shots/windows-activate-dark.png), [windows-activate-light](../../../../design/ui-kits/shots/windows-activate-light.png), [windows-update-dark](../../../../design/ui-kits/shots/windows-update-dark.png), [windows-update-light](../../../../design/ui-kits/shots/windows-update-light.png), [windows-settings-dark](../../../../design/ui-kits/shots/windows-settings-dark.png), [windows-settings-light](../../../../design/ui-kits/shots/windows-settings-light.png), [linux-gate-dark](../../../../design/ui-kits/shots/linux-gate-dark.png), [linux-gate-light](../../../../design/ui-kits/shots/linux-gate-light.png), [linux-activate-dark](../../../../design/ui-kits/shots/linux-activate-dark.png), [linux-activate-light](../../../../design/ui-kits/shots/linux-activate-light.png)

## Scope

**In:**

- `desktopMain`: sheets on macOS, `ContentDialog`-style dialogs on Windows, `AdwDialog`-style on Linux; update and settings as real windows.
- The `windows`/`linux`/`macos` platform variants, keyboard focus rings, desktop density, open-URL and theme `expect/actual`.
- UpdatePrompt and UpdateProgress driving UK-40's desktop updater; keyring-backed sign-in state.
- A Windows/macOS/Linux sample.

**Out** (and where it belongs instead):

- The keyring and updater themselves (→ UK-40).

## Design notes

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
- [ ] Screenshot baselines exist for every fixture component × state (UK-02b) in **both dark and light**, at the sizes and variants of §7.1 for this kit, committed lossless under `sdks/kotlin/ui/src/desktopTest/snapshots/`; a changed baseline fails CI until re-recorded with the reason in the commit.
- [ ] The §7.3 modernity lint passes on this kit, including the RTL-safe layout rule (no physical left/right; no RTL baselines are required).
- [ ] The §4.4 accessibility checks pass on the same renders.
- [ ] The sample `examples/ui/compose-desktop/` runs against the fixture adapters with no live Worker and with `--live` (§6.1).
- [ ] The kit's framework page and its tab on each component page exist in the docs `build/ui/` section (UK-16 scaffold); the kit README is install + one-line flow + link.
- [ ] A design review against the mockups (`windows.html`, `linux.html`, `desktop.html`) is recorded in the PR (§7.4); any disagreement between mockup and spec is fixed first.
- [ ] `parity.json` for this SDK records the `ui.*` rows this kit proves (UK-02b ids), with snapshot plus fixture-run proofs.
- [ ] Docs, in this PR ([docs plan](../../../2026-10-08-docs/README.md) §10): its part of `<StatesToHandle>` from the fixtures; a kit tab per component; a component page returns when a kit ships it; a recipes page at UK-31.
- [ ] The green gate passes (AGENTS.md), including every drift gate listed in the header.

## Verify

```sh
( cd sdks/kotlin && ./gradlew :ui:desktopTest )
```

## Hand-off

UK-41 checks it with the other must kits.

The role agent sets `--set UK-10 in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set UK-10 done`.
