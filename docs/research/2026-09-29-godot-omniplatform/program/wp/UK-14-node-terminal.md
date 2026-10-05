# UK-14 Node terminal kit: sdk-node CLI and `pkey` restyled (clack-style prompts, masked key entry, spinners and progress, half-block QR, OSC 8/52, `--json`, grouped help, completion)

| Field       | Value                                                                                                                                             |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | UK: UI kits: one design system for every SDK (docs/design/UI-KITS.md) (must)                                                                      |
| Size        | 1.5–2.5 engineer-weeks                                                                                                                            |
| Depends on  | [UK-01](UK-01-brand-kit-tokens.md), [UK-02a](UK-02a-kit-copy-catalog.md), [UK-15](UK-15-visual-qa-harness.md), [UK-16](UK-16-ui-docs-scaffold.md) |
| Unblocks    | [UK-32](UK-32-node-ink.md), [UK-41](UK-41-must-tier-closeout.md)                                                                                  |
| Role        | `pkey-sdk-porter`                                                                                                                                 |
| Plan mode   | no                                                                                                                                                |
| Gates       | golden ANSI text plus VHS SVG; the CLI reference docs freshness; the Action bundle drift gate if `packages/cli` output changes                    |
| Human input | none                                                                                                                                              |
| Repo        | `vladzaharia/polaris-key`                                                                                                                         |

## Goal

The Node SDK CLI and `pkey` share the terminal look of UK-13, never echo a license key, and pass golden tests in both themes and every fallback.

## Why

The positional `activate <key>` leaks the key into shell history, and the CLIs are plain text (§0, GA). The spec is [`docs/design/UI-KITS.md`](../../../../design/UI-KITS.md); its "Owner decisions (2026-10-05)" header wins over the sections below it.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [UI-KITS.md](../../../../design/UI-KITS.md) §1.4 Terminal row, §5.1 Node rows, §7.1 Terminal row
- `packages/sdk-node/src/cli/`, `packages/cli/`
- Mockups: [terminal-sign-in-dark](../../../../design/ui-kits/shots/terminal-sign-in-dark.png), [terminal-sign-in-light](../../../../design/ui-kits/shots/terminal-sign-in-light.png), [terminal-activate-dark](../../../../design/ui-kits/shots/terminal-activate-dark.png), [terminal-activate-light](../../../../design/ui-kits/shots/terminal-activate-light.png), [terminal-device-limit-dark](../../../../design/ui-kits/shots/terminal-device-limit-dark.png), [terminal-device-limit-light](../../../../design/ui-kits/shots/terminal-device-limit-light.png), [terminal-help-dark](../../../../design/ui-kits/shots/terminal-help-dark.png), [terminal-help-light](../../../../design/ui-kits/shots/terminal-help-light.png), [terminal-fallbacks-dark](../../../../design/ui-kits/shots/terminal-fallbacks-dark.png), [terminal-fallbacks-light](../../../../design/ui-kits/shots/terminal-fallbacks-light.png)

## Scope

**In:**

- `util.styleText` with the UK-01 ANSI tables, `NO_COLOR`, isatty; clack-style prompts with masked key entry (fixing the positional leak).
- Spinners and progress for sync, packs and publish; terminal QR; `--json`; grouped help; shell completion.
- `pkey init --help` and `validate <path>` fixes.

**Out** (and where it belongs instead):

- Ink components (→ UK-32).

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
- [ ] Screenshot baselines exist for every fixture component × state (UK-02b) in **both dark and light**, at the sizes and variants of §7.1 for this kit, committed lossless under `packages/sdk-node/test/cli/golden/`; a changed baseline fails CI until re-recorded with the reason in the commit.
- [ ] The §7.3 modernity lint passes on this kit (the string lint and the 80/60-column checks), including the RTL-safe layout rule (no physical left/right; no RTL baselines are required).
- [ ] The §4.4 accessibility checks pass on the same renders.
- [ ] The sample `the `tidewater` demo CLI (Node)` runs against the fixture adapters with no live Worker and with `--live` (§6.1).
- [ ] The kit's framework page and its tab on each component page exist in the docs `build/ui/` section (UK-16 scaffold); the kit README is install + one-line flow + link.
- [ ] A design review against the mockups (`terminal.html`) is recorded in the PR (§7.4); any disagreement between mockup and spec is fixed first.
- [ ] `parity.json` for this SDK records the `ui.*` rows this kit proves (UK-02b ids), with snapshot plus fixture-run proofs.
- [ ] The green gate passes (AGENTS.md), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/node test
mise exec node@22 -- pnpm --filter @polaris-key/cli test
```

## Hand-off

`ui.cli` for Node is proven by these goldens; UK-32 reuses the commands.

The role agent sets `--set UK-14 in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set UK-14 done`.
