# SP-53 Backend credential contract: `X-PKey-License`, the verdict, `backend` codes and copy, `backend-matrix.json`, client-core `backend`

| Field       | Value                                                                                                                                                                                                                                                                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase       | SP: SDK parity pass (notes/SDK-PARITY-PASS.md) (framework drop-ins (2026-10-08))                                                                                                                                                                                                                                                           |
| Size        | 1–1.4 engineer-weeks                                                                                                                                                                                                                                                                                                                       |
| Depends on  | [UK-03](UK-03-ui-core.md)                                                                                                                                                                                                                                                                                                                  |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [SP-54](SP-54-signed-in-subject-in-licence-document.md), [SP-55](SP-55-polaris-key-server-express-hono-next.md), [SP-56](SP-56-python-server-drop-ins.md), [SP-57](SP-57-kotlin-server-drop-ins-ktor.md), [SP-58](SP-58-client-backend-node-react-python.md), [SP-62](SP-62-swift-server-vapor.md) |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                                                                                                                                                                                                                                                                      |
| Plan mode   | yes: executes the approved [`plans/SP-53.md`](../plans/SP-53.md) (2026-10-09), which executes the [framework drop-ins plan](../../../2026-10-08-framework-drop-ins/README.md) §9.1                                                                                                                                                         |
| Gates       | `plan-mode`, `corpus`, `threat-model`, `drift-gate`                                                                                                                                                                                                                                                                                        |
| Human input | none                                                                                                                                                                                                                                                                                                                                       |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                                                                                                  |

## Plan follow-through (2026-10-09)

[`plans/SP-53.md`](../plans/SP-53.md) is approved (2026-10-09, every recommendation accepted; `copyVersion` stays 1). Where it differs from the text below, it wins. Corrections to this brief:

- The privacy file is `docs/PRIVACY.md`, not `docs/security/PRIVACY.md`.
- The repo has eight `copy.<locale>.json` files, not nine; `errors.json` goes from 154 to 158 codes.
- `ErrorKind` is hard-coded in `tools/gen-sdk-constants.ts` and `errors.schema.json`, and `gen-sdk-constants.test.ts` pins the `sdkId` list: all three change.
- Sequencing: it starts **after UK-03** (so `ui-matrix.json` is not regenerated twice). **SP-53 merges first**; [SP-54](SP-54-signed-in-subject-in-licence-document.md) then rebases onto it, swaps this package's private total decoder of `profile.user.subject` for `licenseUserOf` in one line, and runs the **single batched `pnpm gen corpus`** (and `node tools/gen-transcripts.mjs`) over both sets of files. Each builder runs the scoped drift gate on its own branch and never re-commits the other's generated files.
- SP-53 does not wait for I-05: its subject-bearing `verdict` rows build `profile.user` inline in the generator.

## Corrections found at implementation (2026-10-10)

The code is the fact; these override the plan and the text below.

- **The section is §14, not §13.** WIRE-CONTRACT-V4 §13 is already "Cloud Sync (HTTP, additive)". "Product backends" is §14, and its subsections are §14.1 to §14.6.
- **`errors.json` goes from 156 to 160 codes**, not 154 to 158 (two codes landed between the plan and this branch).
- **The `type` URI is `https://key.plrs.im/docs/reference/error-codes/#<code>`.** The page is `reference/error-codes` (gen-reference); there is no `reference/errors`. The generated page gains a "Backend codes" section whose headings give each of the five codes its anchor.
- **The four new copy keys do not change `ui-matrix.json`** (it reads the kit tables, which carry core copy, but no row names a backend code), so it is not regenerated.
- **The generator's agreement check with client-core runs in the runners.** `tools/corpus/backend.ts` recomputes every row with its own reference and throws on a hand-written expectation that disagrees; the Node and browser runners then replay every row through client-core. The generator does not import client-core, so it stays independent of what it checks (the rule for `tools/corpus/`).
- **`ui.cli.mount` mirrors `ui.cli`'s typed N/As** (React, Swift and Godot record N/A `runtime`; Node, Python and Kotlin are planned in UK-46, UK-48 and UK-54). Kotlin's and Swift's `server.*` rows are planned with an `except` for `android` and `ios`, which are not servers.

## Goal

Backend credential contract: `X-PKey-License`, the verdict, `backend` codes and copy, `backend-matrix.json`, client-core `backend`, as the [framework drop-ins plan](../../../2026-10-08-framework-drop-ins/README.md) §12.1 scopes it. Done when every acceptance criterion holds and the green gate passes.

## Why

The owner asked for drop-ins that gate a server route or a CLI command with the app's signed licence document, verified offline ([plan](../../../2026-10-08-framework-drop-ins/README.md) §1, §4). The owner approved the plan and decided its eleven questions on 2026-10-08. This is its package SP-53.

## Read first

- `AGENTS.md` (always), and `CLAUDE.md` (plan mode).
- [The framework drop-ins plan](../../../2026-10-08-framework-drop-ins/README.md): §1, §4, §5–§7 and §9 as they bear on this package, and §12.1 (row SP-53).

## Scope

**In:** Execute §9.1 of the approved plan: WIRE-CONTRACT-V4's new §13 "Product backends" (the §5.1 headers, the verdict order **[C]**, the problem body and `PKey-License` challenge **[C]**, and the client refresh and retry rule **[C]**); `shared-protocol/src/core.ts` constants (`HEADER_LICENSE`, `BACKEND_AUTH_SCHEME`, `BACKEND_LICENSE_MAX_BYTES`, `BACKEND_TRUST_REFRESH_SECONDS`, `POLARIS_REQUEST_HEADERS`); a new `errors.json` `kind: "backend"` (exempt from the "the Worker must emit it" check) with `license_required`, `license_invalid`, `license_stale` and `sign_in_required`, and copy in all eight `copy.<locale>.json` (`en`, `de`, `es`, `it`, `ja`, `ko`, `pt-BR`, `zh-Hans`); `enums.json` `sdkId` gains `node-server`, `python-server`, `swift-server`, `kotlin-server` (and `tools/gen-sdk-constants.test.ts` pins the `sdkId` list, so the test changes with it; `ErrorKind` is hard-coded in `tools/gen-sdk-constants.ts` and `errors.schema.json`, so both gain `backend`); `features.json` family `server` (`server.license`, `server.signin`, `server.config`, `server.webhooks`), `core.backend` and `ui.cli.mount`, `planned` in every `parity.json` (React and Godot N/A `runtime` for `server.*`); `conformance/corpus/v2/backend-matrix.json` (`backendMatrixVersion: 1`) generated by `tools/corpus/backend.ts` from `tools/corpus/reference/backend.ts` (new: only `b64url.ts` exists there today; it must not import `client-core`), with the Godot mirror and the AGENTS.md rule 1 entry; client-core `src/backend.ts` (`backendVerdict()`, `clientBackendAction()`) replayed by the Node and browser runners; a `docs/PRIVACY.md` row (the holder's name and email are sent to the developer's backend with the document) and a `docs/security/THREAT-MODEL.md` row (the one-hour replay window and the ~65-minute revocation bound).

**Out** (and where it belongs instead):

- The server adapters (→ SP-55 to SP-57, SP-62); the client halves (→ SP-58, SP-59); the signed-in subject (→ SP-54).

## Design notes

- This is the backend half of the wire; the planner turns the research README §9.1 into a short `plans/SP-53.md` for owner approval before any code.
- No Worker code changes: the new codes come from the SDK server cores.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [x] WIRE-CONTRACT-V4 §13 is written and the verdict order, problem body and client rule are marked [C]. (It is §14: §13 is Cloud Sync. §14.1 headers, §14.2 verdict, §14.3 problem and §14.5 client rule are [C].)
- [x] `gen corpus`, `gen constants --check` and `parity:check` pass with the new file and codes.
- [x] `PROTOCOL_VERSION` 4, `corpusVersion` 2, `DISCOVERY_VERSION` 2 and `CACHE_VERSION` 3 are unchanged.
- [x] The `backend` kind is exempt from the generator's Worker-emits-it check (test: `tools/gen-sdk-constants.test.ts`, which also refuses a backend code the Worker emits).
- [x] The green gate passes (`AGENTS.md`), including every drift gate in the header (the lead gate, full scope; Kotlin `:core:test :conformance:test` and the browser runner's backend suites in Chromium run separately).

## Verify

Each acceptance item's test in its lane, then the full green gate in `AGENTS.md`.

## Hand-off

The role agent sets `--set SP-53 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set SP-53 done`.
