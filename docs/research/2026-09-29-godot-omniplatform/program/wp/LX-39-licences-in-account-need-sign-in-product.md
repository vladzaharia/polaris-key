# LX-39 Licences in an account need sign-in, per product once its SDKs support it

| Field       | Value                                                                                                                                                                                                                                                                                     |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | LX: Licensing model: licences, grants, entitlements (S-19) (DX consolidation E: Licensing model)                                                                                                                                                                                          |
| Size        | 0.4–0.6 engineer-weeks                                                                                                                                                                                                                                                                    |
| Depends on  | [I-09](I-09-key-entry-attach.md), [I-10a](I-10a-sdk-identity-node-react-python.md), [I-10b](I-10b-sdk-identity-swift-kotlin-godot.md), [ST-40](ST-40-integration-facts-sdk-sightings.md), [LX-27](LX-27-create-limit-delivery.md), [P0-49](P0-49-data-migration-runner-dry-run-report.md) |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [LX-31](LX-31-holders-closeout.md)                                                                                                                                                                                                                |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                                                                                                                                                                                                                     |
| Plan mode   | yes: `pkey-wire-planner` writes `plans/LX-39.md` first; no code before a human approves it                                                                                                                                                                                                |
| Gates       | `plan-mode`, `corpus`, `drift-gate`                                                                                                                                                                                                                                                       |
| Human input | plan approval (`plans/LX-39.md`)                                                                                                                                                                                                                                                          |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                                                 |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **LX-39** in [Track E, Licensing model](../../../2026-10-07-dx-consolidation/tracks.md#e-licensing-model).

## Goal

Licences in an account need sign-in, per product once its SDKs support it, as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **LX-39** in [Track E, Licensing model](../../../2026-10-07-dx-consolidation/tracks.md#e-licensing-model). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§1.5, §3.2, §4.2, §4.4, §6); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/licensing-core.md`](../../../2026-10-07-dx-consolidation/audits/licensing-core.md).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode), and the skill that applies, if any.
- [Track E, Licensing model](../../../2026-10-07-dx-consolidation/tracks.md#e-licensing-model): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §1.5, §3.2, §4.2, §4.4, §6, for **LX-39**.
- [`audits/licensing-core.md`](../../../2026-10-07-dx-consolidation/audits/licensing-core.md), for file and line evidence.

## Scope

**In:**

- license_owned refusal on, product by product, for licences in an account on Sign-in products, once every SDK and kit version sighted for that product in sdk_sightings (ST-40) supports the sign-in path, after a P0-49 dry-run report of affected devices that the operator sees first; identity.keyEntryRefusals deleted (identity.keyEntry.limit becomes an Advanced platform default); WIRE-CONTRACT-V4 §12.2's text and the keyentry-refusals-off transcript change in its corpus-lane slot after I-10b; invitation copy in the kits; docs. The global default for new products is LX-31's, after UK-43. Floating licences and Sign-in-off products keep key use.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track E (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **LX-39**; DX consolidation E: Licensing model.
- Plan mode (contract text): the plan is approved before any code.
- Holds the serial corpus lane (tracks.md rule 3) from the moment it regenerates the corpus or re-records transcripts until it merges.
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Wait for the approved `plans/LX-39.md` (written by `pkey-wire-planner`).
3. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] A product flips only when all its sighted SDK versions support sign-in (test)
- [ ] Report lists affected devices before each flip
- [ ] Floating keys still activate (test)
- [ ] Plan approved: contract text and transcript named
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm gen:transcripts -- --check
mise exec node@22 -- pnpm gen:corpus -- --check
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set LX-39 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set LX-39 done`.
