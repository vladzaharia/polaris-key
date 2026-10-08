# SP-34 client-core takes the neutral TypeScript

| Field       | Value                                                                                                                                    |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | SP: SDK parity pass (notes/SDK-PARITY-PASS.md) (DX consolidation J: SDK and UI-kit consolidation)                                        |
| Size        | 1.5–2 engineer-weeks                                                                                                                     |
| Depends on  | [P0-44](P0-44-corpus-generator-split-corpus-lane-right.md), [SP-35](SP-35-sdk-api-registry-api-json-0-9.md)                              |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [SP-32a](SP-32a-polaris-key-json-plan-schema-fromconfig.md), [SP-39](SP-39-one-copy-pipeline.md) |
| Role        | `pkey-sdk-porter` (the plan is written first by `pkey-wire-planner`)                                                                     |
| Plan mode   | yes: `pkey-wire-planner` writes `plans/SP-34.md` first; no code before a human approves it                                               |
| Gates       | `plan-mode`                                                                                                                              |
| Human input | owner decision 8 (answered 2026-10-07, open to veto); plan approval (`plans/SP-34.md`)                                                   |
| Repo        | `vladzaharia/polaris-key`                                                                                                                |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **SDX-03** in [Track J, SDK and UI-kit consolidation](../../../2026-10-07-dx-consolidation/tracks.md#j-sdk-and-ui-kit-consolidation).

## Goal

client-core takes the neutral TypeScript, as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **SDX-03** in [Track J, SDK and UI-kit consolidation](../../../2026-10-07-dx-consolidation/tracks.md#j-sdk-and-ui-kit-consolidation). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§1.5, §3.2, §4.1, §4.2, §4.3, §6); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/cq-sdks-tools.md`](../../../2026-10-07-dx-consolidation/audits/cq-sdks-tools.md).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode), and the skill that applies, if any.
- [Track J, SDK and UI-kit consolidation](../../../2026-10-07-dx-consolidation/tracks.md#j-sdk-and-ui-kit-consolidation): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §1.5, §3.2, §4.1, §4.2, §4.3, §6, for **SDX-03**.
- [`audits/cq-sdks-tools.md`](../../../2026-10-07-dx-consolidation/audits/cq-sdks-tools.md), for file and line evidence.

## Scope

**In:**

- Constants and the copy runtime, the discovery parser and service map, the activation outcome (one kind spelling), the wire error reader, the boot loop over a BootDriver, the QR encoder (Worker, Node, React) and release-fetch range logic move into client-core once; Node and React re-export for one minor; proof: every transcript and the corpus replay unchanged; then CLAUDE.md, AGENTS.md and pkey-sdk-porter narrow client-core plan mode to its wire modules.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track J (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **SDX-03**; DX consolidation J: SDK and UI-kit consolidation.
- Gated on owner decision 8 ([README §8](../../../2026-10-07-dx-consolidation/README.md#8-owner-decisions)), answered on 2026-10-07 under delegated authority with the recommendation and open to the owner's veto; a veto takes that row's "If the answer is no" column.
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Wait for the approved `plans/SP-34.md` (written by `pkey-wire-planner`).
3. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] Transcripts and corpus replay unchanged
- [ ] Node/React duplicates deleted after one minor
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm parity:check
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set SP-34 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set SP-34 done`.
