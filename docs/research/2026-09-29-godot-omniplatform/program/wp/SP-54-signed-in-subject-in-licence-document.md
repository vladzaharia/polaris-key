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

## Corrections found while implementing (2026-10-10)

The code is the fact; these override the plan and the text above.

- **No transcript changes.** `devicecode-happy.json` does not hold a subject-bound device: the device-code sign-in is the product's own OIDC, and `authorizeAndMint` (`services/identity/oidc.ts`) binds no pairwise subject (plans/I-04.md §8 Q6). `identity-attach.json` now exists (I-09 recorded it) but fetches its document at activation, before the binding is seeded. Regenerating every transcript with the Worker change writes no difference. `test/licenseDocUser.test.ts` pins that no recorded document carries `user`; I-08's passthrough sign-in binds a subject, so its re-recorded transcripts are the first to carry the member and belong in that test's `SIGNED_IN` set.
- **`PAIRWISE_SUBJECT_PATTERN` already existed** in `shared-protocol/src/identity.ts` (I-09), as a string. It is now declared in `src/core.ts` and re-exported by `/identity`; the barrel exports neither. The Worker's `RegExp` (`core/accounts/accountSubjects.ts`) and `docProfile` compile it from that one declaration.
- **Paths after P0-17.** `docProfile` is `core/licensing/authz.ts`; the bundle mint is `console/handlers/bundles.ts` (it keeps `docProfile(license)`). The fused browser-session document (`services/identity/browserSession.ts`) is unsigned page JSON, not a licence document, and keeps `docProfile(license)` too.
- **`build/wire` does not exist.** The wire page is `packages/docs/src/content/docs/reference/protocol/license-document.md`. Docs pages may not name programme ids (`lint:docs`), so `contribute/corpus.md` describes the sections without them.
- **Two existing Worker tests pinned the old contract** ("the binding never changes the document"): `identityAccount.test.ts` (subject and sign-out) and `identityPerProduct.test.ts` (Identity off). They now pin that the binding adds exactly `profile.user` and that sign-out or Identity off removes it.
- **client-core** gains a `./license` subpath export beside the barrel export, like `./backend`.

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
- [x] `profile.user` appears for every subject-bound device and for no other; a Worker property test shows every other document is byte-identical. (`packages/worker/test/licenseDocUser.test.ts`: `docProfile` over a grid of licences and stored values, the route for a signed-in, key-entry, malformed and signed-out device, and every recorded transcript document; `pnpm gen transcripts` writes no difference.)
- [x] Old v4 verifiers ignore the member (V4 §3.2); `PROTOCOL_VERSION` unchanged. (`licenseDocCases` `license-profile-user-*`, accepted by every runner's existing licence-document replay; `PROTOCOL_VERSION` 4, `corpusVersion` 2.)
- [x] The green gate passes (`AGENTS.md`), including every drift gate in the header. (Lead gate, `GATE_SCOPE=full`, 2026-10-10: green but for two failures inherited from `main`, both because UK-04's public `packages/elements` is not yet counted: `tools/sdk-version.test.ts` (11 public packages) and `packages/cli/test/releaseWorkflows.test.ts` (`publish-sdks.yml`). The worker suite, 7 205 tests, passes on its own. Kotlin `:conformance:test` and the Chromium runner's licence sections pass too.)

## Verify

Each acceptance item's test in its lane, then the full green gate in `AGENTS.md`.

## Hand-off

The role agent sets `--set SP-54 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set SP-54 done`.
