# ST-40 Integration facts and SDK sightings

| Field       | Value                                                                                                                                                                                           |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | ST: Settings, access control and console shell (DX consolidation C: Products, onboarding and Integration)                                                                                       |
| Size        | 1–1.5 engineer-weeks                                                                                                                                                                            |
| Depends on  | [P0-19](P0-19-descriptor-contributions-services-slug.md), [ST-38](ST-38-service-table-five-features-one-service.md), [ST-39](ST-39-wizard-kit.md)                                               |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [ST-41](ST-41-integration-page-overview-card.md), [ST-47](ST-47-legacy-setup-retirement.md), [LX-39](LX-39-licences-in-account-need-sign-in-product.md) |
| Role        | `pkey-implementer`                                                                                                                                                                              |
| Plan mode   | no                                                                                                                                                                                              |
| Gates       | `migration`, `table-owners`, `rule-10`                                                                                                                                                          |
| Human input | none                                                                                                                                                                                            |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                       |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **OB-04** in [Track C, Products, onboarding and Integration](../../../2026-10-07-dx-consolidation/tracks.md#c-products-onboarding-and-integration).

## Goal

Integration facts and SDK sightings, as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **OB-04** in [Track C, Products, onboarding and Integration](../../../2026-10-07-dx-consolidation/tracks.md#c-products-onboarding-and-integration). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§3.2, §4.2, §4.3, §4.4); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/products-onboarding.md`](../../../2026-10-07-dx-consolidation/audits/products-onboarding.md), [`audits/sdk-uikits-dx.md`](../../../2026-10-07-dx-consolidation/audits/sdk-uikits-dx.md).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [Track C, Products, onboarding and Integration](../../../2026-10-07-dx-consolidation/tracks.md#c-products-onboarding-and-integration): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §3.2, §4.2, §4.3, §4.4, for **OB-04**.
- [`audits/products-onboarding.md`](../../../2026-10-07-dx-consolidation/audits/products-onboarding.md), for file and line evidence.
- [`audits/sdk-uikits-dx.md`](../../../2026-10-07-dx-consolidation/audits/sdk-uikits-dx.md), for file and line evidence.

## Scope

**In:**

- sdk_sightings, one row per (product, sdk, platform, arch): first and last seen, last SDK version, services_ok bitmask (one bit per feature route namespace; commerce has its own bit for /distribution/commerce/\*) and last_ok_at, upserted through waitUntil at most once per key per isolate every 5 minutes from the X-PKey-SDK headers every SDK already sends (WIRE-CONTRACT-V4:649,740) on a 2xx; 90-day prune on the existing cron; GET /manage/api/products/<slug>/integration composing, per enabled feature, console prerequisites (from P0-19's integration contributor), snippet context and Verified per platform. Verified is the feature's services_ok bit, shown once its console prerequisites are met; the only domain facts are where no SDK request exists (a first package publish from CI; an updater feed fetch, which sends no X-PKey-SDK: P2-11's Wired). A one-time backfill seeds sightings from devices.sdk_name, platform, arch and sdk_version, so mature products are offered Hide Integration at once and the Overview card may start collapsed; the backfill writes no setup choice. OpenAPI, routeCoverage, data-model regen, THREAT-MODEL and PRIVACY rows (no IP, device or licence data).

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track C (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **OB-04**; DX consolidation C: Products, onboarding and Integration.
- D1 migration (`mig`): name the file `00XX_<name>.sql`; the lead assigns the number at merge. Contracts take two releases (tracks.md rule 5): replay-safe, safe for the Worker still serving during the deploy, with a down script in `scripts/rollback/`.
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] No wire field added (transcripts unchanged)
- [ ] Writes at most once per key per isolate per 5 minutes (test)
- [ ] Verified flips per feature and platform in a fixture
- [ ] No product is hidden without an operator setup choice (test over the backfill)
- [ ] Docs, in this PR ([docs plan](../../../2026-10-08-docs/README.md) §10): its part of `build/integration`; Verified in every **Check it works**; "Not seen yet" links `build/troubleshooting`.
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm gen:transcripts -- --check
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- registry routeCoverage
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set ST-40 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set ST-40 done`.
