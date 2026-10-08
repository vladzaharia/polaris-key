# SP-67 Developer webhooks: delivery, console endpoints, `verifyWebhook()` and `polarisWebhook()` in every server drop-in

| Field       | Value                                                                                                                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase       | SP: SDK parity pass (notes/SDK-PARITY-PASS.md) (framework drop-ins (2026-10-08))                                                                                                           |
| Size        | 1.8–2.5 engineer-weeks                                                                                                                                                                     |
| Depends on  | [SP-66](SP-66-plan-developer-webhooks.md), [SP-55](SP-55-polaris-key-server-express-hono-next.md), [SP-56](SP-56-python-server-drop-ins.md), [SP-57](SP-57-kotlin-server-drop-ins-ktor.md) |
| Unblocks    | none                                                                                                                                                                                       |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                                                                                                                      |
| Plan mode   | yes: executes `plans/SP-66.md` (`planRef` SP-66)                                                                                                                                           |
| Gates       | `plan-mode`, `drift-gate`                                                                                                                                                                  |
| Human input | the owner's go on push webhooks                                                                                                                                                            |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                  |

## Goal

Developer webhooks: delivery, console endpoints, `verifyWebhook()` and `polarisWebhook()` in every server drop-in, as the [framework drop-ins plan](../../../2026-10-08-framework-drop-ins/README.md) §12.1 scopes it. Done when every acceptance criterion holds and the green gate passes.

## Why

The owner asked for drop-ins that gate a server route or a CLI command with the app's signed licence document, verified offline ([plan](../../../2026-10-08-framework-drop-ins/README.md) §1, §4). The owner approved the plan and decided its eleven questions on 2026-10-08. This is its package SP-67 (optional, deferred).

## Read first

- `AGENTS.md` (always), and `CLAUDE.md` (plan mode).
- [The framework drop-ins plan](../../../2026-10-08-framework-drop-ins/README.md): §1, §4, §5–§7 and §9 as they bear on this package, and §12.1 (row SP-67).

## Scope

**In:** Execute `plans/SP-66.md`: Worker delivery with retries; the console endpoints page and test event; `verifyWebhook(rawBody, headers, {keys})` in each core and `polarisWebhook({ on })` in each adapter, with the raw-body recipe per framework.

**Out** (and where it belongs instead):

- Pages and parts other framework packages own (§12.1); anything the plan gives an existing package (§12.2).

## Design notes

- Deferred until the owner's go on push webhooks (decision 11).

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] A signed event verifies in every server drop-in and a tampered one is refused.
- [ ] The console sends a test event and `pkey webhooks listen` forwards it to localhost.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate in the header.

## Verify

Each acceptance item's test in its lane, then the full green gate in `AGENTS.md`.

## Hand-off

The role agent sets `--set SP-67 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set SP-67 done`.
