# ST-43 New Product wizard

| Field       | Value                                                                                                            |
| ----------- | ---------------------------------------------------------------------------------------------------------------- |
| Phase       | ST: Settings, access control and console shell (DX consolidation C: Products, onboarding and Integration)        |
| Size        | 1–1.5 engineer-weeks                                                                                             |
| Depends on  | [ST-39](ST-39-wizard-kit.md), [ST-42](ST-42-create-defaults.md), [P0-26](P0-26-core-manifest-ingest-pipeline.md) |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [D-02](D-02-diceroll-after-p1.md)                                        |
| Role        | `pkey-implementer`                                                                                               |
| Plan mode   | no                                                                                                               |
| Gates       | `console-csp-parity`                                                                                             |
| Human input | none                                                                                                             |
| Repo        | `vladzaharia/polaris-key`                                                                                        |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **OB-07** in [Track C, Products, onboarding and Integration](../../../2026-10-07-dx-consolidation/tracks.md#c-products-onboarding-and-integration).

- UX rows absorbed (`uxRows` in `backlog-changes.json`): UX-73, UX-74, UX-76.

## Approved plans (2026-10-08)

These approved plans change this package. Where they differ from the text below, they win.

- [`plans/CM-29.md`](../plans/CM-29.md) §10: six features; Commerce is a service.

## Goal

New Product wizard, as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **OB-07** in [Track C, Products, onboarding and Integration](../../../2026-10-07-dx-consolidation/tracks.md#c-products-onboarding-and-integration). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§3.2, §4.2, §4.3); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/backlog-sweep.md`](../../../2026-10-07-dx-consolidation/audits/backlog-sweep.md), [`audits/products-onboarding.md`](../../../2026-10-07-dx-consolidation/audits/products-onboarding.md).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [Track C, Products, onboarding and Integration](../../../2026-10-07-dx-consolidation/tracks.md#c-products-onboarding-and-integration): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §3.2, §4.2, §4.3, for **OB-07**.
- [`audits/backlog-sweep.md`](../../../2026-10-07-dx-consolidation/audits/backlog-sweep.md), for file and line evidence.
- [`audits/products-onboarding.md`](../../../2026-10-07-dx-consolidation/audits/products-onboarding.md), for file and line evidence.

## Scope

**In:**

- ProductNew.tsx rebuilt on ui/wizard: repository -> Check (W22, W23, problems and re-check), or Name (W24) -> What it's for (the same five features as the Services page, platforms, Free tier) -> Create -> land on Integration with MO-11's moment; licence defaults removed; Home, Products and Cmd-K open it; repo-less ingest through P0-26. Absorbs UX-73, UX-74 and UX-76.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track C (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **OB-07**; DX consolidation C: Products, onboarding and Integration.
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] Two or three steps from Home to a created product
- [ ] Lands on Integration
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin test
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set ST-43 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set ST-43 done`.
