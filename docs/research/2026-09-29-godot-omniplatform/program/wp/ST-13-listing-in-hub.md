# ST-13 Storefront listing in the settings hub: A-18j's Listing editor hosted in the product hub, with console or manifest provenance

| Field       | Value                                                                         |
| ----------- | ----------------------------------------------------------------------------- |
| Phase       | ST: Settings architecture (S-18) (phase 3: coverage)                          |
| Size        | 0.3–0.4 engineer-weeks                                                        |
| Depends on  | [ST-08](ST-08-product-settings-hub.md), [A-18j](A-18j-console-storefronts.md) |
| Unblocks    | none                                                                          |
| Role        | `pkey-implementer`                                                            |
| Plan mode   | no                                                                            |
| Gates       | console CSP parity; docsLinks                                                 |
| Human input | none                                                                          |
| Repo        | `vladzaharia/polaris-key`                                                     |

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
