# UK-06 `@polaris-key/electron`: `registerPolarisKey` (main) and `exposePolarisKey` (preload) replacing the hand-written bridge, menu items, notifications, autoUpdater progress into UpdateProgress

| Field       | Value                                                                                              |
| ----------- | -------------------------------------------------------------------------------------------------- |
| Phase       | UK: UI kits: one design system for every SDK (docs/design/UI-KITS.md) (must)                       |
| Size        | 1.5–2 engineer-weeks                                                                               |
| Depends on  | [UK-03](UK-03-ui-core.md), [UK-05](UK-05-react-kit.md), [UK-16](UK-16-ui-docs-scaffold.md)         |
| Unblocks    | [UK-21](UK-21-tauri-bridge.md), [UK-41](UK-41-must-tier-closeout.md)                               |
| Role        | `pkey-sdk-porter`                                                                                  |
| Plan mode   | no                                                                                                 |
| Gates       | Playwright Electron screenshots on Windows, macOS and Linux chrome; `pnpm ui:lint` on the renderer |
| Human input | none                                                                                               |
| Repo        | `vladzaharia/polaris-key`                                                                          |

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
- [ ] The green gate passes (AGENTS.md), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/electron test
```

## Hand-off

UK-21 implements the same bridge contract over Tauri `invoke`.

The role agent sets `--set UK-06 in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set UK-06 done`.
