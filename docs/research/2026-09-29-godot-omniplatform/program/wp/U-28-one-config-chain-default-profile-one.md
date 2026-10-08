# U-28 One config chain: Default profile, one profile per tier, no device layer

| Field       | Value                                                                                                                                                                                                |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | U: Cloud Sync (S-17) (DX consolidation E: Licensing model)                                                                                                                                           |
| Size        | 1–1.4 engineer-weeks                                                                                                                                                                                 |
| Depends on  | [U-27](U-27-keep-licence-config-layer-delete.md), [LX-34](LX-34-entitlement-catalog-in-licensing-tier.md), [ST-42](ST-42-create-defaults.md), [P0-49](P0-49-data-migration-runner-dry-run-report.md) |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [U-29](U-29-effective-config-provenance.md), [LX-16](LX-16-licensing-contract.md)                                                                            |
| Role        | `pkey-implementer`                                                                                                                                                                                   |
| Plan mode   | no                                                                                                                                                                                                   |
| Gates       | `migration`, `table-owners`                                                                                                                                                                          |
| Human input | none                                                                                                                                                                                                 |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                            |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **CFG-02** in [Track E, Licensing model](../../../2026-10-07-dx-consolidation/tracks.md#e-licensing-model).

## Goal

One config chain: Default profile, one profile per tier, no device layer, as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **CFG-02** in [Track E, Licensing model](../../../2026-10-07-dx-consolidation/tracks.md#e-licensing-model). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§3.1, §4.2, §6); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/config-cloudsync.md`](../../../2026-10-07-dx-consolidation/audits/config-cloudsync.md).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [Track E, Licensing model](../../../2026-10-07-dx-consolidation/tracks.md#e-licensing-model): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §3.1, §4.2, §6, for **CFG-02**.
- [`audits/config-cloudsync.md`](../../../2026-10-07-dx-consolidation/audits/config-cloudsync.md), for file and line evidence.

## Scope

**In:**

- The reserved 'default' profile (ST-42 reserves the id; backfilled empty for existing products) as the base layer for every device, licence-less included; licence profile stacks (license_profiles, M/0004) materialised through a P0-49 job with a report, into licence overrides if owner decision 1 cancels the U-03 run, or into account overrides for licences that have an owner if it does not; CreateLicenseDialog and LicenseTerms profile lists removed; devices.overrides_json no longer read (production check first; the column stays dormant); docs (profiles.md, concepts.md, management-states.md); the LX-09 seam test.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track E (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **CFG-02**; DX consolidation E: Licensing model.
- D1 migration (`mig`): name the file `00XX_<name>.sql`; the lead assigns the number at merge. Contracts take two releases (tracks.md rule 5): replay-safe, safe for the Worker still serving during the deploy, with a down script in `scripts/rollback/`.
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] Chain is catalog -> Default -> tier profile -> licence -> account (test matrix)
- [ ] Materialisation report shows identical payloads
- [ ] Docs, in this PR ([docs plan](../../../2026-10-08-docs/README.md) §10): its part of `features/managed-config/{catalog, visibility, minted-tokens, profiles}`; `reference/config-entry`.
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm gen:transcripts -- --check
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set U-28 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set U-28 done`.
