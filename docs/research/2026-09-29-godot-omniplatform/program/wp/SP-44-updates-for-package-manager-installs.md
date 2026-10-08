# SP-44 Updates for package-manager installs

| Field       | Value                                                                                                |
| ----------- | ---------------------------------------------------------------------------------------------------- |
| Phase       | SP: SDK parity pass (notes/SDK-PARITY-PASS.md) (SDK usability review (2026-10-08))                   |
| Size        | 0.8–1.2 engineer-weeks                                                                               |
| Depends on  | [P2-12](P2-12-one-update-resolver-retire-github.md), [SP-35](SP-35-sdk-api-registry-api-json-0-9.md) |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md)                                                               |
| Role        | `pkey-sdk-porter` (the plan is written first by `pkey-wire-planner`)                                 |
| Plan mode   | yes: `pkey-wire-planner` writes `plans/SP-44.md` first; no code before it is approved                |
| Gates       | `plan-mode`, `corpus`, `all-sdks`                                                                    |
| Human input | none                                                                                                 |
| Repo        | `vladzaharia/polaris-key`                                                                            |

## Goal

Updates for package-manager installs, as the [SDK usability review](../../../2026-10-08-sdk-usability/README.md) §10.2 scopes it. Done when every acceptance criterion holds and the green gate passes.

## Why

Eighteen hands-on trials across Node, React, Python, Swift, Kotlin and Godot (the drop-in kit, your own UI, and a newcomer) averaged 5.3/10. This package fixes what they found; the evidence is in [`findings.json`](../../../2026-10-08-sdk-usability/findings.json) and the review's §5 and §7.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [The SDK usability review](../../../2026-10-08-sdk-usability/README.md): §1, §5, the SDK's part of §7, §10.2 (SP-44) and §10.4.

## Scope

**In:** an outlet-matrix subkind for package-manager installs detected positively (pip, pipx, uv tool; npm, pnpm and yarn global; Homebrew formula), with an instructions-only update method the kits render as the exact upgrade command. An unknown outlet still gets nothing (no new decide reason); `doctor()` and a once-per-run debug line explain why. `polaris-key.json` can set the outlet for direct-download products.

**Out** (and where it belongs instead):

- The 0.9 rebuilds and renames (→ SP-35, SP-35b and the UK kit packages); anything §10.1 gives an existing package.

## Design notes

- Positive package-manager detection; an unknown outlet is explained by `doctor()`, with no new decide reason (§10.4). Plan mode: `plans/SP-44.md` first; it holds the corpus lane.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] The new rows replay green in six SDKs.
- [ ] A pipx-installed sample is offered 1.3.0 with `pipx upgrade` in the Python kit and an npm-global CLI with its command in the Node kit.
- [ ] An unknown outlet's `doctor()` line names the cause.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate in the header.

## Verify

Each acceptance item's test in its SDK lane, then the full green gate in `AGENTS.md`.

## Hand-off

The role agent sets `--set SP-44 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set SP-44 done`.
