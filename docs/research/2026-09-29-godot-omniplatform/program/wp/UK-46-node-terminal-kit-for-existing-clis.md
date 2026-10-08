# UK-46 Node terminal kit for existing CLIs

| Field       | Value                                                                                                                                   |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | UK: UI kits: one design system for every SDK (docs/design/UI-KITS.md) (SDK usability review (2026-10-08))                               |
| Size        | 0.8–1.2 engineer-weeks                                                                                                                  |
| Depends on  | none                                                                                                                                    |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [SP-64](SP-64-framework-drop-ins-integration-and-docs.md), [UK-52](UK-52-node-cli-oclif-ink.md) |
| Role        | `pkey-implementer`                                                                                                                      |
| Plan mode   | no                                                                                                                                      |
| Gates       | `ui-snapshots`                                                                                                                          |
| Human input | none                                                                                                                                    |
| Repo        | `vladzaharia/polaris-key`                                                                                                               |

## Framework drop-ins (2026-10-08)

The [framework drop-ins plan](../../../2026-10-08-framework-drop-ins/README.md) §12.2 changes this package. Where it differs from the text below, it wins.

- `withLicense` becomes `requireLicense` (one name for servers and CLIs); adds `namespace`, `onCollision` and `frame: false`; yargs moves to `./cli/yargs`. Follows UK-51's `cli` rows and exit 4.

## Goal

Node terminal kit for existing CLIs, as the [SDK usability review](../../../2026-10-08-sdk-usability/README.md) §10.2 scopes it. Done when every acceptance criterion holds and the green gate passes.

## Why

Eighteen hands-on trials across Node, React, Python, Swift, Kotlin and Godot (the drop-in kit, your own UI, and a newcomer) averaged 5.3/10. This package fixes what they found; the evidence is in [`findings.json`](../../../2026-10-08-sdk-usability/findings.json) and the review's §5 and §7.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [The SDK usability review](../../../2026-10-08-sdk-usability/README.md): §1, §5, the SDK's part of §7, §10.2 (UK-46) and §10.4.

## Scope

**In:** `registerPolarisCommands` and the yargs adapter take `verbs` (ids or groups; default the config's services plus core verbs; developer verbs opt-in) and `config` (today's `polarisConfig`; `polaris-key.json` after SP-32a); a documented commander `mount`; a collision gives a clear error naming the fix, or skips with a warning on opt-in; grouped help lists the host's commands first; `polarisGate()` and `withLicense(handler)`; yargs on its own subpath.

**Out** (and where it belongs instead):

- The 0.9 rebuilds and renames (→ SP-35, SP-35b and the UK kit packages); anything §10.1 gives an existing package.

## Design notes

- No new copies (tracks.md rule 4): build on the one mechanism this package names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] A host CLI with its own `config`, `update` and `status` registers without throwing.
- [ ] `--help` lists the host's commands first.
- [ ] Gating a host command takes 3 lines or fewer.
- [ ] `tsc` with `skipLibCheck: false` passes in a commander-only project.
- [ ] The SP-33a Node CLI golden is 8 lines or fewer and compiles.
- [ ] `pkey-ux-reviewer` passes every changed screen.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate in the header.

## Verify

Each acceptance item's test in its SDK lane, then the full green gate in `AGENTS.md`.

## Hand-off

The role agent sets `--set UK-46 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set UK-46 done`.
