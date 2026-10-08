# I-24b Named-user seats in the SDKs: Node, React, Python, Swift, Godot and Kotlin read the user claim and policy keys, `device_limit` `scope: "user"` and `account_required` copy, plus the React, SwiftUI, Godot and Compose kits

| Field       | Value                                                                                                                                                                            |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | I: Identity: one Polaris Key account, then per-app identity (S-16) (later)                                                                                                       |
| Size        | 1–1.4 engineer-weeks                                                                                                                                                             |
| Depends on  | [I-24](I-24-named-user-seats.md), [I-24a](I-24a-named-user-seats-server.md), [I-10a](I-10a-sdk-identity-node-react-python.md), [I-10b](I-10b-sdk-identity-swift-kotlin-godot.md) |
| Unblocks    | none                                                                                                                                                                             |
| Role        | `pkey-sdk-porter` (the plan is written first by `pkey-wire-planner`)                                                                                                             |
| Plan mode   | yes: executes the approved [`plans/I-24.md`](../plans/I-24.md) §5 (SDKs and UI kits)                                                                                             |
| Gates       | plan mode; all six SDKs (`parity:check`, `gen:constants -- --check`); transcripts replayed; UI-kit snapshots; macOS and Android CI                                               |
| Human input | none                                                                                                                                                                             |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                        |

## Consolidation 2026-10-07

> **Parked 2026-10-07 (DX consolidation).** Optional and `deferred`, so `--ready` and `--critical`
> skip it. Revive condition (the note): Parked with I-24a; kit screens would render in the rebuilt kits only. Re-read this brief against the code before reviving it.

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **parked** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> Parked with I-24a; kit screens would render in the rebuilt kits only.

## Goal

Node, React, Python, Swift, Godot and Kotlin expose the named-user seat claim and the policy keys,
show `device_limit` with `scope: "user"` and `account_required` with the right copy, and the React,
SwiftUI, Godot and Compose kits render them, each proven by I-24a's transcripts.

## Why

[`plans/I-24.md`](../plans/I-24.md) Q8 (approved 2026-10-05) splits the SDK half out of I-24, following
the I-10a and I-10b precedent.

## Read first

- `AGENTS.md` (always); [`plans/I-24.md`](../plans/I-24.md) §5 and its owner-decisions header.
- I-24a's PR (the readers, codes and transcripts); I-10a and I-10b (the identity surface this builds on).

## Scope

**In:** plans/I-24.md §5 for the six SDKs and four UI kits, in the plan's order.

**Out:** the server, corpus and client-core (→ I-24a).

## Steps

1. Node over client-core, then React, Python, Swift, Godot and Kotlin.
2. The UI kits with their SDKs.

## Acceptance criteria

- [ ] Each SDK replays I-24a's transcripts and passes `parity:check`.
- [ ] UI-kit snapshots for the per-user refusal.
- [ ] The green gate passes (`AGENTS.md`).

## Verify

```sh
mise exec node@22 -- pnpm parity:check
mise exec node@22 -- pnpm gen:constants -- --check
```

## Hand-off

- LX-24 builds per-seat features on top.

The role agent sets `--set I-24b in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set I-24b done`.
