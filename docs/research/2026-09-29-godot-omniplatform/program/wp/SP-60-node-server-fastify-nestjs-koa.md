# SP-60 Node server drop-ins, should tier: Fastify, NestJS, Koa

| Field       | Value                                                                            |
| ----------- | -------------------------------------------------------------------------------- |
| Phase       | SP: SDK parity pass (notes/SDK-PARITY-PASS.md) (framework drop-ins (2026-10-08)) |
| Size        | 0.8–1.1 engineer-weeks                                                           |
| Depends on  | [SP-55](SP-55-polaris-key-server-express-hono-next.md)                           |
| Unblocks    | none                                                                             |
| Role        | `pkey-implementer`                                                               |
| Plan mode   | no                                                                               |
| Gates       | `drift-gate`                                                                     |
| Human input | none                                                                             |
| Repo        | `vladzaharia/polaris-key`                                                        |

## Goal

Node server drop-ins, should tier: Fastify, NestJS, Koa, as the [framework drop-ins plan](../../../2026-10-08-framework-drop-ins/README.md) §12.1 scopes it. Done when every acceptance criterion holds and the green gate passes.

## Why

The owner asked for drop-ins that gate a server route or a CLI command with the app's signed licence document, verified offline ([plan](../../../2026-10-08-framework-drop-ins/README.md) §1, §4). The owner approved the plan and decided its eleven questions on 2026-10-08. This is its package SP-60 (optional).

## Read first

- `AGENTS.md` (always).
- [The framework drop-ins plan](../../../2026-10-08-framework-drop-ins/README.md): §1, §4, §5–§7 and §9 as they bear on this package, and §12.1 (row SP-60).

## Scope

**In:** The `./fastify`, `./nestjs` and `./koa` subpaths of `@polaris-key/server`, each a thin adapter over the Fetch core, with optional peers and example apps.

**Out** (and where it belongs instead):

- Pages and parts other framework packages own (§12.1); anything the plan gives an existing package (§12.2).

## Design notes

- No new copies (tracks.md rule 4): build on the one mechanism the plan names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] A gated Fastify, NestJS and Koa route answers each §5.2 verdict over the shared core.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate in the header.

## Verify

Each acceptance item's test in its lane, then the full green gate in `AGENTS.md`.

## Hand-off

The role agent sets `--set SP-60 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set SP-60 done`.
