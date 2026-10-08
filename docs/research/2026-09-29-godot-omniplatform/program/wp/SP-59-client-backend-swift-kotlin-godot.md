# SP-59 The client half in Swift, Kotlin and Godot

| Field       | Value                                                                            |
| ----------- | -------------------------------------------------------------------------------- |
| Phase       | SP: SDK parity pass (notes/SDK-PARITY-PASS.md) (framework drop-ins (2026-10-08)) |
| Size        | 1.1–1.5 engineer-weeks                                                           |
| Depends on  | [SP-58](SP-58-client-backend-node-react-python.md)                               |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md)                                           |
| Role        | `pkey-sdk-porter`                                                                |
| Plan mode   | no                                                                               |
| Gates       | `all-sdks`, `drift-gate`, `ci:macos`, `ci:android`                               |
| Human input | none                                                                             |
| Repo        | `vladzaharia/polaris-key`                                                        |

## Goal

The client half in Swift, Kotlin and Godot, as the [framework drop-ins plan](../../../2026-10-08-framework-drop-ins/README.md) §12.1 scopes it. Done when every acceptance criterion holds and the green gate passes.

## Why

The owner asked for drop-ins that gate a server route or a CLI command with the app's signed licence document, verified offline ([plan](../../../2026-10-08-framework-drop-ins/README.md) §1, §4). The owner approved the plan and decided its eleven questions on 2026-10-08. This is its package SP-59.

## Read first

- `AGENTS.md` (always).
- [The framework drop-ins plan](../../../2026-10-08-framework-drop-ins/README.md): §1, §4, §5–§7 and §9 as they bear on this package, and §12.1 (row SP-59).

## Scope

**In:** `client.backend` per §6 in Swift (`data(for:)`, `headers()`), Kotlin (an OkHttp `interceptor()`, `headers()`) and Godot (`await PolarisKey.backend.headers()`). Same origins, freshness, retry and error rules as SP-58; replays `backend-matrix.json` `client`.

**Out** (and where it belongs instead):

- Pages and parts other framework packages own (§12.1); anything the plan gives an existing package (§12.2).

## Design notes

- No new copies (tracks.md rule 4): build on the one mechanism the plan names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] The three SDKs send the right headers and refuse a non-allowed origin.
- [ ] The `client` section replays green in Swift, Kotlin and Godot.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate in the header.

## Verify

Each acceptance item's test in its lane, then the full green gate in `AGENTS.md`.

## Hand-off

The role agent sets `--set SP-59 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set SP-59 done`.
