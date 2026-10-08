# UK-06 Electron kit inside @polaris-key/node/electron

| Field       | Value                                                                                                                                                               |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | UK: UI kits: one design system for every SDK (docs/design/UI-KITS.md) (must)                                                                                        |
| Size        | 1.5–2 engineer-weeks                                                                                                                                                |
| Depends on  | [UK-03](UK-03-ui-core.md), [UK-05](UK-05-react-kit.md), [UK-16](UK-16-ui-docs-scaffold.md), [SP-31](SP-31-node-bridge-v4.md), [UK-56](UK-56-kit-mockups-refresh.md) |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [UK-21](UK-21-tauri-bridge.md), [UK-41](UK-41-must-tier-closeout.md)                                                        |
| Role        | `pkey-sdk-porter`                                                                                                                                                   |
| Plan mode   | no                                                                                                                                                                  |
| Gates       | Playwright Electron screenshots on Windows, macOS and Linux chrome; `pnpm ui:lint` on the renderer                                                                  |
| Human input | none                                                                                                                                                                |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                           |

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

- **The one sign-in form** (SIGN-IN.md §3.17, UI-KITS §1.3): the main process holds the grant and calls `choice.*`; the renderer's form gets view data only and posts the pick through `exposePolarisKey()` (SIGN-IN.md D-91). Steps morph in place; nothing stacks on the form except the system confirm for Replace where the platform expects one (D-80).

## Consolidation 2026-10-07

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **edit** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json) ([Track J, SDK and UI-kit consolidation](../../../2026-10-07-dx-consolidation/tracks.md#j-sdk-and-ui-kit-consolidation)); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> Inside @polaris-key/node/electron on SP-31's bridge v4: menu items, notifications and updater progress into UpdateProgress. No new package.

- Title: was "`@polaris-key/electron`: `registerPolarisKey` (main) and `exposePolarisKey` (preload) replacing the hand-written bridge, menu items, notifications, autoUpdater progress into UpdateProgress".
- Depends on: added SP-31.

## Approved plans (2026-10-08)

These approved plans change this package. Where they differ from the text below, they win.

- [`plans/UK-02b.md`](../plans/UK-02b.md) §8: owns Node's ten `ui.*` rows. The family run is UK-03's ui-core runner under Node's `testRoots`; the render is a test under `packages/sdk-node/test/` that drives the main-process half of `@polaris-key/node/electron` and snapshots the view each family sends over the bridge (D9).

## SDK usability review (2026-10-08)

Accepted changes from the [SDK usability review](../../../2026-10-08-sdk-usability/README.md) §10.1. Where they differ from the text below, they win.

- Its framework pages replace SP-45a's interim pages in place.

## Owner direction (2026-10-08)

- **Responsive.** Every kit screen adapts to its window, with landscape layouts where the window is landscape.
- **Resolution matrix.** Tested at every size in [UI-KITS.md](../../../../design/UI-KITS.md) §7.1, including 200% text or zoom.
- **Spacing and theming.** One spacing rhythm, and themable with `preset: "polaris-key" | "native"`, where `native` matches the platform.
- **Quality bar.** Meets the bar in `.claude/agents/pkey-ux-reviewer.md` ("a GOOD UI", good use of visual space), not just no overflow.
- **Review.** Several UX reviews (`pkey-ux-reviewer`), not one.
- **Two implementation paths.** An integrator drops in the kit or builds their own UI on the SDK. The in-app experience leads with the drop-in kit and links to the docs for integrating directly with your own UI. The docs present both paths.

## Design language v2 (2026-10-08)

This package follows the [design language](../../../../design/UI-KITS.md#design-language-v2-2026-10-08) (rules DL1–DL18). Its row of the [application matrix](../../../../design/UI-KITS-LANGUAGE-MATRIX.md):

- **Rules:** DL1–DL18 (DL14: links only; desktops browse).
- **In this kit:** The renderer is the React kit in the [desktop chrome](../../../../design/UI-KITS-LANGUAGE-MATRIX.md#desktop-chrome) that `theme.platform: "auto"` picks. Windows resize, so DL1 applies at window sizes. Menu items use title case on macOS, notifications use catalog strings, and `shell.openExternal` runs only behind the main process's https check.
- **Minimum check:** Playwright Electron on the three chromes at the phone, tablet, desktop and wide rows as window sizes, both schemes and both presets, at 100 % and 200 % zoom.
- **Acceptance:** the matrix rows above pass, and a UX review (`pkey-ux-reviewer`) of the built screens gives each a quality verdict of good or better.

## Goal

An Electron app wires Polaris Key with two lines (main and preload) and the React kit renders the right platform variant (Fluent on Windows, the Mac sheet on macOS, libadwaita on Linux).

## Why

Node's largest UI gap (GA): every Electron integrator writes the IPC bridge by hand today. The spec is [`docs/design/UI-KITS.md`](../../../../design/UI-KITS.md); its "Owner decisions (2026-10-05)" header wins over the sections below it.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [UI-KITS.md](../../../../design/UI-KITS.md) §4.2 Electron snippet, §1.4 Windows and Linux rows, §5.1
- `packages/sdk-node/src/`
- Mockups: [windows-gate-dark](../../../../design/ui-kits/shots/windows-gate-dark.png), [windows-gate-light](../../../../design/ui-kits/shots/windows-gate-light.png), [windows-update-dark](../../../../design/ui-kits/shots/windows-update-dark.png), [windows-update-light](../../../../design/ui-kits/shots/windows-update-light.png), [linux-gate-dark](../../../../design/ui-kits/shots/linux-gate-dark.png), [linux-gate-light](../../../../design/ui-kits/shots/linux-gate-light.png), [desktop-update-dark](../../../../design/ui-kits/shots/desktop-update-dark.png), [desktop-update-light](../../../../design/ui-kits/shots/desktop-update-light.png)

## Scope

**In:**

- `registerPolarisKey({ ipcMain, client })` over `@polaris-key/node`; `exposePolarisKey()` over `contextBridge`; invoke routes for the bridge.
- Native menu items (Check for Updates…, Manage License…) and notifications.
- `autoUpdater` progress into UpdateProgress.
- Electron Forge sample.

**Out** (and where it belongs instead):

- Tauri (→ UK-21).

## Design notes

- Electron releases before 35 are out of scope (`engines >= 22.12`, owner, 2026-10-05).
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
- [ ] Screenshot baselines exist for every fixture component × state (UK-02b) in **both dark and light**, at the sizes and variants of §7.1 for this kit, committed lossless under `packages/electron/test/visual/__screenshots__/`; a changed baseline fails CI until re-recorded with the reason in the commit.
- [ ] The §7.3 modernity lint passes on this kit, including the RTL-safe layout rule (no physical left/right; no RTL baselines are required).
- [ ] The §4.4 accessibility checks pass on the same renders.
- [ ] The sample `examples/ui/electron/` runs against the fixture adapters with no live Worker and with `--live` (§6.1).
- [ ] The kit's framework page and its tab on each component page exist in the docs `build/ui/` section (UK-16 scaffold); the kit README is install + one-line flow + link.
- [ ] A design review against the mockups (`windows.html`, `linux.html`, `desktop.html`) is recorded in the PR (§7.4); any disagreement between mockup and spec is fixed first.
- [ ] `parity.json` for this SDK records the `ui.*` rows this kit proves (UK-02b ids), with snapshot plus fixture-run proofs.
- [ ] Docs, in this PR ([docs plan](../../../2026-10-08-docs/README.md) §10): its part of `<StatesToHandle>` from the fixtures; a kit tab per component; a component page returns when a kit ships it; a recipes page at UK-31.
- [ ] The acceptance in "Design language v2 (2026-10-08)" above holds.
- [ ] The green gate passes (AGENTS.md), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/electron test
```

## Hand-off

UK-21 implements the same bridge contract over Tauri `invoke`.

The role agent sets `--set UK-06 in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set UK-06 done`.
