# UK-21 Tauri v2 bridge: `tauri-plugin-polaris-key`, a thin Rust plugin running a `@polaris-key/node` sidecar and forwarding the bridge over `invoke`/events, so the web kits render unchanged

| Field       | Value                                                                                                |
| ----------- | ---------------------------------------------------------------------------------------------------- |
| Phase       | UK: UI kits: one design system for every SDK (docs/design/UI-KITS.md) (should)                       |
| Size        | 1.5–2.5 engineer-weeks                                                                               |
| Depends on  | [UK-04](UK-04-web-components.md), [UK-06](UK-06-electron-kit.md), [UK-16](UK-16-ui-docs-scaffold.md) |
| Unblocks    | none                                                                                                 |
| Role        | `pkey-sdk-porter`                                                                                    |
| Plan mode   | no                                                                                                   |
| Gates       | screenshots of the Tauri sample on Windows, macOS and Linux; `cargo test` for the plugin             |
| Human input | none                                                                                                 |
| Repo        | `vladzaharia/polaris-key`                                                                            |

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
- [ ] The green gate passes (AGENTS.md), including every drift gate listed in the header.

## Verify

```sh
( cd packages/tauri-plugin-polaris-key && cargo test )
```

## Hand-off

None. X-02 may later replace the sidecar behind the same bridge.

The role agent sets `--set UK-21 in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set UK-21 done`.
