# UK-21 Tauri v2 bridge: `tauri-plugin-polaris-key`, a thin Rust plugin running a `@polaris-key/node` sidecar and forwarding the bridge over `invoke`/events, so the web kits render unchanged

| Field       | Value                                                                                                                                       |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | UK: UI kits: one design system for every SDK (docs/design/UI-KITS.md) (should)                                                              |
| Size        | 1.5–2.5 engineer-weeks                                                                                                                      |
| Depends on  | [UK-04](UK-04-web-components.md), [UK-06](UK-06-electron-kit.md), [UK-16](UK-16-ui-docs-scaffold.md), [UK-56](UK-56-kit-mockups-refresh.md) |
| Unblocks    | none                                                                                                                                        |
| Role        | `pkey-sdk-porter`                                                                                                                           |
| Plan mode   | no                                                                                                                                          |
| Gates       | screenshots of the Tauri sample on Windows, macOS and Linux; `cargo test` for the plugin                                                    |
| Human input | none                                                                                                                                        |
| Repo        | `vladzaharia/polaris-key`                                                                                                                   |

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

- **The one sign-in form** (SIGN-IN.md §3.17, UI-KITS §1.3): the sidecar holds the grant and calls `choice.*`; the webview's form gets view data only (SIGN-IN.md D-91). Steps morph in place; nothing stacks on the form except the system confirm for Replace where the platform expects one (D-80).

## Consolidation 2026-10-07

> **Parked 2026-10-07 (DX consolidation).** Optional and `deferred`, so `--ready` and `--critical`
> skip it. Revive when the recipe proves insufficient for an adopter. Re-read this brief against the code before reviving it.

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **parked** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> Tauri bridge package (absorbs X-02). Tauri ships as a UK-31 recipe; revive when the recipe proves insufficient for an adopter.

- Optional now (was required).
- Absorbs X-02: One Tauri path; UK-21 is parked and the Tauri recipe ships in UK-31.

## Owner direction (2026-10-08)

- **Two implementation paths.** An integrator drops in the kit or builds their own UI on the SDK. The in-app experience leads with the drop-in kit and links to the docs for integrating directly with your own UI. The docs present both paths.

## Design language v2 (2026-10-08)

This package follows the [design language](../../../../design/UI-KITS.md#design-language-v2-2026-10-08) (rules DL1–DL18). Its row of the [application matrix](../../../../design/UI-KITS-LANGUAGE-MATRIX.md):

- **Rules:** DL1–DL18 (DL14: links only).
- **In this kit:** As UK-06, in the system webview: WebView2 on Windows, WKWebView on macOS and WebKitGTK on Linux. Evaluate WebKitGTK's support for `@starting-style`, View Transitions and container-query units; where one is missing the step is instant, as under reduced motion, and the layout still holds. Links open through the plugin's opener, behind its https check.
- **Minimum check:** The sample's screenshots on the three OSes at the phone, desktop and wide rows as window sizes, both schemes.
- **Acceptance:** the matrix rows above pass, and a UX review (`pkey-ux-reviewer`) of the built screens gives each a quality verdict of good or better.

## Goal

A Tauri v2 app uses the elements or the React kit unchanged, backed by the same bridge contract as Electron.

## Why

The owner kept UK-21 as a should and X-02 (the native Rust plugin) optional (2026-10-05), so this bridge is deliberately thin: a sidecar, not a Rust SDK. The spec is [`docs/design/UI-KITS.md`](../../../../design/UI-KITS.md); its "Owner decisions (2026-10-05)" header wins over the sections below it.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [UI-KITS.md](../../../../design/UI-KITS.md) §5.1 Tauri row, the Electron bridge contract (UK-06)
- X-02 brief (what is out of scope here)

## Scope

**In:**

- The Rust plugin: spawn and supervise the `@polaris-key/node` sidecar, forward the bridge over `invoke`/events.
- Bearer mode for the webview (notes/SDK-PARITY-PASS.md Q1).
- Tauri v2 sample with the elements.

**Out** (and where it belongs instead):

- A native Rust SDK or plugin without the sidecar (→ X-02, optional).

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
- [ ] Screenshot baselines exist for every fixture component × state (UK-02b) in **both dark and light**, at the sizes and variants of §7.1 for this kit, committed lossless under `examples/ui/tauri/test/snapshots/`; a changed baseline fails CI until re-recorded with the reason in the commit.
- [ ] The §7.3 modernity lint passes on this kit, including the RTL-safe layout rule (no physical left/right; no RTL baselines are required).
- [ ] The §4.4 accessibility checks pass on the same renders.
- [ ] The sample `examples/ui/tauri/` runs against the fixture adapters with no live Worker and with `--live` (§6.1).
- [ ] The kit's framework page and its tab on each component page exist in the docs `build/ui/` section (UK-16 scaffold); the kit README is install + one-line flow + link.
- [ ] A design review against the mockups (`windows.html`, `linux.html`, `desktop.html`) is recorded in the PR (§7.4); any disagreement between mockup and spec is fixed first.
- [ ] `parity.json` for this SDK records the `ui.*` rows this kit proves (UK-02b ids), with snapshot plus fixture-run proofs.
- [ ] The acceptance in "Design language v2 (2026-10-08)" above holds.
- [ ] The green gate passes (AGENTS.md), including every drift gate listed in the header.

## Verify

```sh
( cd packages/tauri-plugin-polaris-key && cargo test )
```

## Hand-off

None. X-02 may later replace the sidecar behind the same bridge.

The role agent sets `--set UK-21 in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set UK-21 done`.
