# ST-13 Storefront listing in the settings hub: A-18j's Listing editor hosted in the product hub, with console or manifest provenance

| Field       | Value                                                              |
| ----------- | ------------------------------------------------------------------ |
| Phase       | ST: Settings, access control and console shell (phase 3: coverage) |
| Size        | 0.3–0.4 engineer-weeks                                             |
| Depends on  | none                                                               |
| Unblocks    | none                                                               |
| Role        | `pkey-implementer`                                                 |
| Plan mode   | no                                                                 |
| Gates       | console CSP parity; docsLinks                                      |
| Human input | none                                                               |
| Repo        | `vladzaharia/polaris-key`                                          |

## Consolidation 2026-10-07

> **Closed 2026-10-07 (DX consolidation): merged into [A-27](A-27-one-listing-truth-absorbs-st-13.md).** The id stays in the graph as `dropped` so it
> is not reused; do not build this package. Its scope moves to [A-27](A-27-one-listing-truth-absorbs-st-13.md).

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **merge** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> Listing has one home (Core -> Presentation plus per-channel Listing tab); a hub copy would be a third.

- Dependencies cleared on closing (they were ST-08 and A-18j), so nothing in the graph waits on or through a closed package.

## Goal

A-18j's storefront Listing editor is hosted in the product settings hub, with console or manifest provenance shown per field.

## Why

D11 chose a console editor for listings, coordinated with A-18 ([S-18 §7.3](../../notes/S-18-settings-architecture.md#73-owner-decisions-recommended-defaults-in-bold)).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [S-18 owner decisions](../../notes/S-18-settings-architecture.md) (the 2026-10-04 header block; it wins over the sections below it).
- [S-18 §5.2](../../notes/S-18-settings-architecture.md#52-s-15-storefront-provisioning-and-the-a-18-packages), [S-18 §6.2](../../notes/S-18-settings-architecture.md#62-work-packages) row ST-13, [S-18 §7.3](../../notes/S-18-settings-architecture.md#73-owner-decisions-recommended-defaults-in-bold) D11.
- A-18j's brief.

## Scope

**In:**

- Mount A-18j's editor in the hub; provenance badges.

**Out** (and where it belongs instead):

- The editor itself (→ A-18j).

## PENDING entries to remove

ST-06 left a shrinking allow-list in `packages/worker/scripts/settings-coverage.ts`. Its "PENDING owners" decision ([ST-06](ST-06-settings-docs-coverage.md#design-notes)) assigns this package the 7 entries below. Register each one in the settings registry (the note names the intended key, where there is one), then delete it from `PENDING` and lower `PENDING_CEILING` by the same count. `checkCoverage` refuses an entry that is both pending and registered, so the two edits land together.

- `table:dist_listings`
- `column:dist_listings.source`
- `column:dist_listing_assets.source`
- `column:dist_listing_locales.source`
- `column:dist_listing_overrides.source`
- `column:dist_listing_release_notes.source`
- `manifest:distribution:listing`

## Design notes

- `dist_listings.source` is mapped by its adapter (`admin → console`).

## Steps

1. Mount.
2. e2e.

## Acceptance criteria

- [ ] Every `PENDING` entry listed under "PENDING entries to remove" is registered and gone from `settings-coverage.ts`, `PENDING_CEILING` is 7 lower, and `settings-coverage.test.ts` passes.
- [ ] The Listing area renders in the hub with provenance (e2e).
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin test
```

## Hand-off

- None.

The role agent sets `--set ST-13 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set ST-13 done`.
