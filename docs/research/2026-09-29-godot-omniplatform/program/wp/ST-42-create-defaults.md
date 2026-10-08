# ST-42 Create with defaults

| Field       | Value                                                                                                                                                                                |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase       | ST: Settings, access control and console shell (DX consolidation C: Products, onboarding and Integration)                                                                            |
| Size        | 0.6–0.9 engineer-weeks                                                                                                                                                               |
| Depends on  | [LX-08](LX-08-licensing-expand.md), [HA-12](HA-12-presentation-discovery.md), [ST-38](ST-38-service-table-five-features-one-service.md)                                              |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [U-28](U-28-one-config-chain-default-profile-one.md), [A-20](A-20-product-facts-channel-read-model.md), [ST-43](ST-43-new-product-wizard.md) |
| Role        | `pkey-implementer`                                                                                                                                                                   |
| Plan mode   | no                                                                                                                                                                                   |
| Gates       | `rule-10`                                                                                                                                                                            |
| Human input | none                                                                                                                                                                                 |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                            |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **OB-06** in [Track C, Products, onboarding and Integration](../../../2026-10-07-dx-consolidation/tracks.md#c-products-onboarding-and-integration).

## Goal

Create with defaults, as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **OB-06** in [Track C, Products, onboarding and Integration](../../../2026-10-07-dx-consolidation/tracks.md#c-products-onboarding-and-integration). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§3.2, §4.2, §4.3); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/products-onboarding.md`](../../../2026-10-07-dx-consolidation/audits/products-onboarding.md).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [Track C, Products, onboarding and Integration](../../../2026-10-07-dx-consolidation/tracks.md#c-products-onboarding-and-integration): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §3.2, §4.2, §4.3, for **OB-06**.
- [`audits/products-onboarding.md`](../../../2026-10-07-dx-consolidation/audits/products-onboarding.md), for file and line evidence.

## Scope

**In:**

- POST /manage/api/products and .../link-repo accept features or services, intendedPlatforms, a starter Free tier and trustReleaseWorkflow, and create in one batch: signing key, Default profile, catalog v1, Free tier, services, the release-workflow trust policy and planned platforms. Owns the reserved 'default' profile id and the distribution.intendedPlatforms registry key (U-28 and A-20 build on them); licence defaults and compatMin/compatMax dropped from manual create (admin/handlers/products.ts:597-598); OpenAPI.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track C (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **OB-06**; DX consolidation C: Products, onboarding and Integration.
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] One D1 batch, rolled back whole on failure (test)
- [ ] A created product is ready for an SDK in one call
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm gen:transcripts -- --check
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- registry routeCoverage
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set ST-42 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set ST-42 done`.
