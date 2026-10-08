# SP-66 Plan developer webhooks: Standard Webhooks signing, the event catalogue, delivery

| Field       | Value                                                                                   |
| ----------- | --------------------------------------------------------------------------------------- |
| Phase       | SP: SDK parity pass (notes/SDK-PARITY-PASS.md) (framework drop-ins (2026-10-08))        |
| Size        | 0.4–0.6 engineer-weeks                                                                  |
| Depends on  | none                                                                                    |
| Unblocks    | [SP-67](SP-67-developer-webhooks-delivery-and-adapters.md)                              |
| Role        | `pkey-wire-planner` (planning only)                                                     |
| Plan mode   | yes: a `pkey-wire-planner` writes `plans/SP-66.md` first; no code before it is approved |
| Gates       | `plan-mode`, `human-approval`                                                           |
| Human input | the owner's go on push webhooks                                                         |
| Repo        | `vladzaharia/polaris-key`                                                               |

## Goal

Plan developer webhooks: Standard Webhooks signing, the event catalogue, delivery, as the [framework drop-ins plan](../../../2026-10-08-framework-drop-ins/README.md) §12.1 scopes it. Done when every acceptance criterion holds and the green gate passes.

## Why

The owner asked for drop-ins that gate a server route or a CLI command with the app's signed licence document, verified offline ([plan](../../../2026-10-08-framework-drop-ins/README.md) §1, §4). The owner approved the plan and decided its eleven questions on 2026-10-08. This is its package SP-66 (optional, deferred).

## Read first

- `AGENTS.md` (always), and `CLAUDE.md` (plan mode).
- [The framework drop-ins plan](../../../2026-10-08-framework-drop-ins/README.md): §1, §4, §5–§7 and §9 as they bear on this package, and §12.1 (row SP-66).

## Scope

**In:** Write `plans/SP-66.md`: Standard Webhooks headers (`webhook-id`, `-timestamp`, `-signature`); `v1a` Ed25519 under a per-product webhook key sealed under the KEK and never a document key; an optional `v1` HMAC per endpoint; 300 s tolerance, dedupe on `webhook-id`, at-least-once delivery with retries on the Worker queue; events `subject.merged`, `subject.deleted`, `entitlements.changed`, `purchase.refunded`, `license.revoked`, `device.deauthorized`; a console endpoints page with a test event; `pkey webhooks listen`. Stop for approval.

**Out** (and where it belongs instead):

- Delivery and the adapters (→ SP-67); CM-22, LX-13 and ST-27 adopt the format once this is approved.

## Design notes

- Deferred until the owner's go on push webhooks (decision 11). It fixes the format before CM-22, LX-13 or ST-27 invent one.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Write the plan and stop for approval.

## Acceptance criteria

- [ ] `plans/SP-66.md` names the headers, the signature scheme, the event catalogue and delivery, and is set `awaiting-approval`.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate in the header.

## Verify

Each acceptance item's test in its lane, then the full green gate in `AGENTS.md`.

## Hand-off

The role agent sets `--set SP-66 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set SP-66 done`.
