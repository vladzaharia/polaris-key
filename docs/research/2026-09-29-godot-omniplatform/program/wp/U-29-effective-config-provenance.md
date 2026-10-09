# U-29 Effective config with provenance

| Field       | Value                                                                           |
| ----------- | ------------------------------------------------------------------------------- |
| Phase       | U: Cloud Sync (S-17) (DX consolidation G: Managed config and Cloud Sync)        |
| Size        | 0.5–0.7 engineer-weeks                                                          |
| Depends on  | [U-28](U-28-one-config-chain-default-profile-one.md)                            |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [U-11a](U-11a-console-data-settings.md) |
| Role        | `pkey-implementer`                                                              |
| Plan mode   | no                                                                              |
| Gates       | `rule-10`                                                                       |
| Human input | none                                                                            |
| Repo        | `vladzaharia/polaris-key`                                                       |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **CFG-03** in [Track G, Managed config and Cloud Sync](../../../2026-10-07-dx-consolidation/tracks.md#g-managed-config-and-cloud-sync).

## Goal

Effective config with provenance, as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **CFG-03** in [Track G, Managed config and Cloud Sync](../../../2026-10-07-dx-consolidation/tracks.md#g-managed-config-and-cloud-sync). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/config-cloudsync.md`](../../../2026-10-07-dx-consolidation/audits/config-cloudsync.md).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [Track G, Managed config and Cloud Sync](../../../2026-10-07-dx-consolidation/tracks.md#g-managed-config-and-cloud-sync): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md), for **CFG-03**.
- [`audits/config-cloudsync.md`](../../../2026-10-07-dx-consolidation/audits/config-cloudsync.md), for file and line evidence.

## Scope

**In:**

- GET /manage/api/products/<p>/config/effective?license=&subject=&tier=: per key the value (secrets show 'configured'), state, source layer and locking layer, computed by Core's resolveMergedPayload; replaces resolveInherited in LicenseConfig.tsx; feeds U-11a, profile Used-by, the catalog key drawer and a Preview as... picker; rule 10.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track G (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **CFG-03**; DX consolidation G: Managed config and Cloud Sync.
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## UX coverage (2026-10-09)

Generated from `ux-coverage.json` (read `ux-coverage.md` for the whole map). Do not edit this section by hand; change the coverage file.

- **Builds or backs 8 mockup item(s):** `config.catalog-invalid`, `config.catalog-review-states`, `config.catalog-review`, `config.effective`, `config.entry-draft-stale`, `config.entry-setting-remove-value`, `config.entry-setting`, `config.profile`.
- `config.catalog-invalid`, `config.catalog-review`: C-24 in the mockup json is the console catalog page (not a work package): the review step, Copy the diff, the invalid state and per-entry changed-since-open merge belong to U-29 and U-31.

## Acceptance criteria

- [ ] The console never re-merges (resolveInherited deleted)
- [ ] Provenance matches the server merge (property test)
- [ ] Docs, in this PR ([docs plan](../../../2026-10-08-docs/README.md) §10): its part of `features/managed-config/{catalog, visibility, minted-tokens, profiles}`; `reference/config-entry`.
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm gen:transcripts -- --check
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- registry routeCoverage
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set U-29 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set U-29 done`.
