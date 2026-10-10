# SP-54 Signed-in subject in the licence document (`profile.user` whenever `devices.subject` is set)

| Field       | Value                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | SP: SDK parity pass (notes/SDK-PARITY-PASS.md) (framework drop-ins (2026-10-08))                                                                                                                                                                                                                                                                                                                                      |
| Size        | 0.6–0.9 engineer-weeks                                                                                                                                                                                                                                                                                                                                                                                                |
| Depends on  | [I-05](I-05-accounts-core.md), [SP-53](SP-53-backend-credential-contract.md), [UK-03](UK-03-ui-core.md)                                                                                                                                                                                                                                                                                                               |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [I-24a](I-24a-named-user-seats-server.md), [SP-54b](SP-54b-native-signed-in-user-readers.md), [SP-55](SP-55-polaris-key-server-express-hono-next.md), [SP-56](SP-56-python-server-drop-ins.md), [SP-57](SP-57-kotlin-server-drop-ins-ktor.md), [SP-62](SP-62-swift-server-vapor.md), [SP-64](SP-64-framework-drop-ins-integration-and-docs.md), [DOC-09b](DOC-09b-sign-in.md) |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                                                                                                                                                                                                                                                                                                                                                 |
| Plan mode   | yes: executes the approved [`plans/SP-54.md`](../plans/SP-54.md) (2026-10-09), which amends the approved `plans/I-24.md`                                                                                                                                                                                                                                                                                              |
| Gates       | `plan-mode`, `corpus`, `threat-model`, `drift-gate`                                                                                                                                                                                                                                                                                                                                                                   |
| Human input | none                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                                                                                                                                                                             |

## Plan follow-through (2026-10-09)

[`plans/SP-54.md`](../plans/SP-54.md) is approved (2026-10-09, recommendation on decisions 1 to 6, including the new package SP-54b). Where it differs from the text below, it wins.

- **What moves here from I-24a.** The emission of `profile.user`, `DocProfile.user`, `SignedInUser`, `PAIRWISE_SUBJECT_PATTERN` in `shared-protocol/src/core.ts`, client-core `licenseUserOf`, the three `licenseDocCases` rows (25 to 28) and the new `licenseUserCases` section (14 rows, `expect.user` only). I-24a keeps the two policy keys, `licenseNamedUsersOf` and the `namedUsers` rows.
- **Corrections to this brief.** No Swift corpus mirror exists (only Godot has one). `identity-attach.json` does not exist yet: I-09 records it with `profile.user` from the start. The one existing transcript that changes is `devicecode-happy.json`. `profile.user` carries `subject` only, emitted only when `devices.subject` matches the pattern.
- **Native readers.** Python, Swift, Kotlin and Godot get their readers, the `licenseUserCases` replay and the parity row `license.signedInUser` in [SP-54b](SP-54b-native-signed-in-user-readers.md), which depends on this package and blocks UK-48. This package adds no `features.json` row.
- **Sequencing.** After UK-03, and after SP-53 merges: rebase onto SP-53, swap its private decoder for `licenseUserOf` (one line, no corpus effect), run the **one batched** `pnpm gen corpus && node tools/gen-transcripts.mjs` over both sets, commit once, then `pnpm gen --check` once. It lands before I-24a and before SP-55, SP-56, SP-57 and SP-62, which read the member.
- **Docs in this PR.** `docs/security/THREAT-MODEL.md` (the I-05 "device binding" bullet and the leaked-document and revocation-bound row), `docs/PRIVACY.md` (the signed-licence-documents line), `build/wire` and the generated corpus reference page.

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

- I-24a's policy keys (it adds only those); the Python, Swift, Kotlin and Godot client readers (→ [SP-54b](SP-54b-native-signed-in-user-readers.md)); `licenseNamedUsersOf` and the `namedUsers` section rows (→ I-24a).

## Design notes

- Plan mode: a `pkey-wire-planner` writes `plans/SP-54.md` first. It amends the approved `plans/I-24.md` §2.1 and §2.4 (the lead's decision, 2026-10-08).
- The four server cores read the member. This package makes no client SDK changes beyond the Node and React type, except SP-54b (the Python, Swift, Kotlin and Godot readers; blocks UK-48).

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. The approved `plans/SP-54.md` is merged; follow it.
3. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [x] A `pkey-wire-planner` has written and the lead has approved `plans/SP-54.md` (2026-10-09), amending `plans/I-24.md` §2.1, §2.2, §2.4 and §4.
- [ ] `profile.user` appears for every subject-bound device and for no other; a Worker property test shows every other document is byte-identical.
- [ ] Old v4 verifiers ignore the member (V4 §3.2); `PROTOCOL_VERSION` unchanged.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate in the header.

## Verify

Each acceptance item's test in its lane, then the full green gate in `AGENTS.md`.

## Hand-off

The role agent sets `--set SP-54 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set SP-54 done`.
