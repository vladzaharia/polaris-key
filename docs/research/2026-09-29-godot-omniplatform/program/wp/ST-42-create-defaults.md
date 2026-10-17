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

## Approved plans (2026-10-08)

These approved plans change this package. Where they differ from the text below, they win.

- [`plans/CM-29.md`](../plans/CM-29.md) §10: six features; Commerce is a service.

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

## UX coverage (2026-10-09)

Generated from `ux-coverage.json` (read `ux-coverage.md` for the whole map). Do not edit this section by hand; change the coverage file.

- **Builds or backs 2 mockup item(s):** `products.new-product`, `config.catalog-empty`.

## Acceptance criteria

- [x] One D1 batch, rolled back whole on failure (test)
- [x] A created product is ready for an SDK in one call
- [x] Docs, in this PR ([docs plan](../../../2026-10-08-docs/README.md) §10): its part of `start/first-product` (the wizard steps); `operate/console/products`.
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm gen transcripts --check
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- registry routeCoverage
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set ST-42 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set ST-42 done`.

## Verification against the code (2026-10-17)

- The brief's `admin/handlers/products.ts` is `packages/worker/src/console/handlers/products.ts`.
- The Worker has no feature table (`features` is generated for the console and docs only), so
  the API takes `services` (slugs); the console resolves a feature to its slugs (ST-43). Adding a
  worker-side feature map would regenerate `@polaris-key/manifest` and the Action bundle for no gain.
- `accent` (FLOWS W25) is not taken: UX-76 deferred it until one presentation store exists.
- The `default` profile id is reserved by ownership, not by a manifest validator rule: a `.pkey/`
  that declares its own `default` keeps it and the console's is skipped (no rule 9 entry).
- `distribution.intendedPlatforms` is added to the Distribution settings slice (scalar,
  operator-owned, list of `RELEASE_PLATFORMS`); UX-53 reads it.
- Create rows are `source = 'console'`, so a resync never rewrites them. On link-repo a `services`
  list adds to the manifest's set and makes the enablement the operator's (`services_source = admin`).
- No UI or D1 migration in this package; the screens and self-look belong to ST-43.
