# SP-65 End-to-end CI: client SDK → example backend → `pkey dev`

| Field       | Value                                                                                                                                                                                                                                                               |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | SP: SDK parity pass (notes/SDK-PARITY-PASS.md) (framework drop-ins (2026-10-08))                                                                                                                                                                                    |
| Size        | 0.6–0.9 engineer-weeks                                                                                                                                                                                                                                              |
| Depends on  | [SP-41](SP-41-pkey-dev-a-local-polaris-key-for-integrators.md), [SP-55](SP-55-polaris-key-server-express-hono-next.md), [SP-56](SP-56-python-server-drop-ins.md), [SP-57](SP-57-kotlin-server-drop-ins-ktor.md), [SP-58](SP-58-client-backend-node-react-python.md) |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md)                                                                                                                                                                                                                              |
| Role        | `pkey-implementer`                                                                                                                                                                                                                                                  |
| Plan mode   | no                                                                                                                                                                                                                                                                  |
| Gates       | `ci`                                                                                                                                                                                                                                                                |
| Human input | none                                                                                                                                                                                                                                                                |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                           |

## Goal

End-to-end CI: client SDK → example backend → `pkey dev`, as the [framework drop-ins plan](../../../2026-10-08-framework-drop-ins/README.md) §12.1 scopes it. Done when every acceptance criterion holds and the green gate passes.

## Why

The owner asked for drop-ins that gate a server route or a CLI command with the app's signed licence document, verified offline ([plan](../../../2026-10-08-framework-drop-ins/README.md) §1, §4). The owner approved the plan and decided its eleven questions on 2026-10-08. This is its package SP-65.

## Read first

- `AGENTS.md` (always).
- [The framework drop-ins plan](../../../2026-10-08-framework-drop-ins/README.md): §1, §4, §5–§7 and §9 as they bear on this package, and §12.1 (row SP-65).

## Scope

**In:** A CI lane that runs a client SDK against an example backend against `pkey dev`: activate, a valid gated call, a stale document (refresh then succeed), a failed re-sync, a `not_entitled` call, and the client's own gate state, across the must-tier server frameworks.

**Out** (and where it belongs instead):

- Pages and parts other framework packages own (§12.1); anything the plan gives an existing package (§12.2).

## Design notes

- No new copies (tracks.md rule 4): build on the one mechanism the plan names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] The end-to-end lane is green against `pkey dev` for every must-tier server framework.
- [ ] A stale document triggers a refresh and then succeeds (test).
- [ ] The green gate passes (`AGENTS.md`), including every drift gate in the header.

## Verify

Each acceptance item's test in its lane, then the full green gate in `AGENTS.md`.

## Hand-off

The role agent sets `--set SP-65 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set SP-65 done`.
