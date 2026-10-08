# SP-54 Signed-in subject in the licence document (`profile.user` whenever `devices.subject` is set)

| Field       | Value                                                                                                                            |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | SP: SDK parity pass (notes/SDK-PARITY-PASS.md) (framework drop-ins (2026-10-08))                                                 |
| Size        | 0.6–0.9 engineer-weeks                                                                                                           |
| Depends on  | [I-05](I-05-accounts-core.md)                                                                                                    |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [SP-64](SP-64-framework-drop-ins-integration-and-docs.md), [DOC-09b](DOC-09b-sign-in.md) |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                                                            |
| Plan mode   | yes: a `pkey-wire-planner` writes `plans/SP-54.md` first (it amends the approved `plans/I-24.md`); no code before approval       |
| Gates       | `plan-mode`, `corpus`, `threat-model`, `drift-gate`                                                                              |
| Human input | none                                                                                                                             |
| Repo        | `vladzaharia/polaris-key`                                                                                                        |

## Goal

Signed-in subject in the licence document (`profile.user` whenever `devices.subject` is set), as the [framework drop-ins plan](../../../2026-10-08-framework-drop-ins/README.md) §12.1 scopes it. Done when every acceptance criterion holds and the green gate passes.

## Why

The owner asked for drop-ins that gate a server route or a CLI command with the app's signed licence document, verified offline ([plan](../../../2026-10-08-framework-drop-ins/README.md) §1, §4). The owner approved the plan and decided its eleven questions on 2026-10-08. This is its package SP-54.

## Read first

- `AGENTS.md` (always), and `CLAUDE.md` (plan mode).
- [The framework drop-ins plan](../../../2026-10-08-framework-drop-ins/README.md): §1, §4, §5–§7 and §9 as they bear on this package, and §12.1 (row SP-54).

## Scope

**In:** Pull `profile.user = {"subject": "ps_…"}` forward from `plans/I-24.md`: emit it whenever `devices.subject` is set, not only for named-user seats. Changes the Worker's licence document builder (`services/license/document.ts`, `docProfile`); client-core `licenseUserOf` (I-24's reader, moved forward); corpus `licenseDocCases` plus I-24's `licenseUserCases`; the transcripts whose devices are signed in (`identity-attach.json` and the device-code ones) re-recorded with the Swift and Godot mirrors; THREAT-MODEL and PRIVACY rows.

**Out** (and where it belongs instead):

- I-24a's policy keys (it adds only those); readers in client SDKs (I-24b, when revived).

## Design notes

- Plan mode: a `pkey-wire-planner` writes `plans/SP-54.md` first. It amends the approved `plans/I-24.md` §2.1 and §2.4 (the lead's decision, 2026-10-08).
- The four server cores read the member; no client SDK changes (they forward the JWS untouched).

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Wait for the approved `plans/SP-54.md`.
3. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] A `pkey-wire-planner` has written and the lead has approved `plans/SP-54.md`, amending `plans/I-24.md` §2.1 and §2.4.
- [ ] `profile.user` appears for every subject-bound device and for no other; a Worker property test shows every other document is byte-identical.
- [ ] Old v4 verifiers ignore the member (V4 §3.2); `PROTOCOL_VERSION` unchanged.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate in the header.

## Verify

Each acceptance item's test in its lane, then the full green gate in `AGENTS.md`.

## Hand-off

The role agent sets `--set SP-54 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set SP-54 done`.
