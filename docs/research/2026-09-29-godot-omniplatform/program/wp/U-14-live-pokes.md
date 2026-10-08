# U-14 Live pokes over hibernating WebSockets in all six SDKs (Godot `WebSocketPeer`)

| Field       | Value                                                                                                                                                                             |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | U: Cloud Sync (S-17) (U4 later)                                                                                                                                                   |
| Size        | 0.8–1.1 engineer-weeks                                                                                                                                                            |
| Depends on  | [U-05](U-05-cloud-sync-do.md), [U-07](U-07-sdk-settings-swift-kotlin.md), [U-21](U-21-sdk-settings-godot.md)                                                                      |
| Unblocks    | none                                                                                                                                                                              |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                                                                                                             |
| Plan mode   | yes: `pkey-wire-planner` writes `plans/U-14.md` first; it needs human approval before code                                                                                        |
| Gates       | plan mode; `errors.json` (rule 3), transcripts (rule 1), `gen:constants -- --check`; rule 10 (OpenAPI + `routeCoverage`); all six SDKs (`parity:check`); reconnect-on-deploy test |
| Human input | none                                                                                                                                                                              |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                         |

## Consolidation 2026-10-07

> **Parked 2026-10-07 (DX consolidation).** Optional and `deferred`, so `--ready` and `--critical`
> skip it. Revive after launch if sync latency is a measured complaint. Re-read this brief against the code before reviving it.

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **parked** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> Live pokes. Pull on foreground, online and visibility covers 'restore from any instance'. Revive after launch if sync latency is a measured complaint.

## Goal

Clients learn about changes immediately through a hibernating WebSocket "poke", in all six SDKs (Godot `WebSocketPeer`), with pull still the source of truth.

## Why

Pull is the baseline; pokes are later and optional ([S-17 §5.4](../../notes/S-17-user-data-sync.md#54-sync-protocol)).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode); `plans/U-14.md` once approved; [S-17 §6](../../notes/S-17-user-data-sync.md#6-phases-and-work-packages) row U-14.

## Scope

**In:** the plan, the WebSocket route, SDK clients, transcripts.

**Out** (and where it belongs instead):

- None.

## Design notes

- Optional; a poke carries no data, only "pull now".

## Steps

1. Plan, approved. 2. Route. 3. SDKs.

## Acceptance criteria

- [ ] Clients reconnect after a deploy (test); all six SDKs updated.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm parity:check
```

## Hand-off

- None.

The role agent sets `--set U-14 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set U-14 done`.
