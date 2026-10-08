# UK-48 Python terminal kit as a mountable drop-in

| Field       | Value                                                                                                                                |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Phase       | UK: UI kits: one design system for every SDK (docs/design/UI-KITS.md) (SDK usability review (2026-10-08))                            |
| Size        | 0.8–1.2 engineer-weeks                                                                                                               |
| Depends on  | [UK-51](UK-51-terminal-drop-in-contract.md)                                                                                          |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [SP-64](SP-64-framework-drop-ins-integration-and-docs.md), [UK-53](UK-53-textual-screens.md) |
| Role        | `pkey-implementer`                                                                                                                   |
| Plan mode   | no                                                                                                                                   |
| Gates       | `ui-snapshots`                                                                                                                       |
| Human input | none                                                                                                                                 |
| Repo        | `vladzaharia/polaris-key`                                                                                                            |

## Framework drop-ins (2026-10-08)

The [framework drop-ins plan](../../../2026-10-08-framework-drop-ins/README.md) §12.2 changes this package. Where it differs from the text below, it wins.

- Adds `namespace` and `onCollision`, and accepts the host's `rich.Console`. Follows UK-51's `cli` rows and exit 4.

## Goal

Python terminal kit as a mountable drop-in, as the [SDK usability review](../../../2026-10-08-sdk-usability/README.md) §10.2 scopes it. Done when every acceptance criterion holds and the green gate passes.

## Why

Eighteen hands-on trials across Node, React, Python, Swift, Kotlin and Godot (the drop-in kit, your own UI, and a newcomer) averaged 5.3/10. This package fixes what they found; the evidence is in [`findings.json`](../../../2026-10-08-sdk-usability/findings.json) and the review's §5 and §7.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [The SDK usability review](../../../2026-10-08-sdk-usability/README.md): §1, §5, the SDK's part of §7, §10.2 (UK-48) and §10.4.

## Scope

**In:** `register_argparse`, `polaris_click_group` and `polaris_typer_app` take `client=` or `config=` with `version=`; once bound, `--product`, `--trust`, `--base-url`, `--service`, `--config-dir` and the per-verb `--version` are hidden; `verbs=` with `END_USER` as the default; per-verb help; `require_license()` and `require_entitlement()`; the update available state without signed decisions; signed-in only from identity; the bundle name from package metadata until HA-13; no degraded-store line in end-user status; `<Product> sign-in` copy; kebab-case `--json` enums; locale dates and platform names; no private client attributes; the Textual Updates pane wired or removed; `mytool.py` and `tidewater.py` with no argv hack.

**Out** (and where it belongs instead):

- The 0.9 rebuilds and renames (→ SP-35, SP-35b and the UK kit packages); anything §10.1 gives an existing package.

## Design notes

- No new copies (tracks.md rule 4): build on the one mechanism this package names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] `python mytool.py sign-in` and `status` work unchanged.
- [ ] A host's `--help` lists only the chosen verbs without integration flags.
- [ ] Every verb has offline and update-unconfigured goldens in both themes.
- [ ] The `require_*` snippets are tested files.
- [ ] The SP-33a Python CLI golden compiles.
- [ ] `pkey-ux-reviewer` passes every changed screen.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate in the header.

## Verify

Each acceptance item's test in its SDK lane, then the full green gate in `AGENTS.md`.

## Hand-off

The role agent sets `--set UK-48 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set UK-48 done`.
