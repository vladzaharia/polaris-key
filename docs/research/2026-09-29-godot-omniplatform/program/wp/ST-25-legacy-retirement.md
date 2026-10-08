# ST-25 Legacy settings retirement (widened)

| Field       | Value                                                                                                                                           |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | ST: Settings, access control and console shell (phase 5: governance and environments)                                                           |
| Size        | 0.4–0.55 engineer-weeks                                                                                                                         |
| Depends on  | [ST-11](ST-11-sql-only-settings.md), [ST-14](ST-14-portal-settings.md), [ST-17](ST-17-resync-dry-run.md), [ST-19b](ST-19b-manifest-settings.md) |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [ST-25b](ST-25b-drop-products-admin-group.md)                                                           |
| Role        | `pkey-implementer`                                                                                                                              |
| Plan mode   | no                                                                                                                                              |
| Gates       | D1 migration (replayable, scratch-SQLite rehearsal); `TABLE_OWNERS`; rule 10 (OpenAPI + `routeCoverage`)                                        |
| Human input | none                                                                                                                                            |
| Repo        | `vladzaharia/polaris-key`                                                                                                                       |

## Consolidation 2026-10-07

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **edit** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json) ([Track D, Administration, access control and console identity](../../../2026-10-07-dx-consolidation/tracks.md#d-administration-access-control-and-console-identity)); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> Widened, driven by P0-24's migration ledger: also products.admin_group, core.adminGroup and manifest product.adminGroup (after ST-32's conversion), legacyDefault (after LX-16), the \*\_source markers, the retired licensing keys (LX-40), products.branding_json and the portal tintColor read, and the bespoke aliases ST-05b made adapters; PENDING emptied; each removal follows its P0-24 calendar window.

- Title: was "Legacy settings retirement: `artifacts_access`, `products.branding_json`, bespoke route aliases, access-mode copy; coverage allow-list empty".
- Owner 2026-10-07: no compatibility window. What this package replaces (a route, mode, shape, Action input or CLI form) is removed in the same release; the one exception is a path that native app binaries already on end-user machines call (DJDL's desktop builds, the permanent alias routes), removed once DJDL has shipped a build on 0.9 (`tracks.md` rule 6).
- Owner 2026-10-07: manifest fields are removed, not deprecated. A removed field is a validator error that names its replacement, with no rule-9 warning period; this package migrates the in-repo manifests (the repo-root `.pkey/` and `products/djdl/*`) in the same change, adopters' repos (DJDL's, Diceroll) are owner steps, and `pkey migrate` is used only where this package already plans it.

## Goal

Legacy settings are retired: `release_config.artifacts_access`, `products.branding_json`, the bespoke route aliases and the access-mode copy; the coverage `PENDING` list is empty.

## Why

D12 and D16 ([S-18 §7.3](../../notes/S-18-settings-architecture.md#73-owner-decisions-recommended-defaults-in-bold)); [S-18 §4.14.4](../../notes/S-18-settings-architecture.md#4144-everything-else) lists the retirements.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [S-18 owner decisions](../../notes/S-18-settings-architecture.md) (the 2026-10-04 header block; it wins over the sections below it).
- [S-18 §4.14.4](../../notes/S-18-settings-architecture.md#4144-everything-else), [S-18 §6.2](../../notes/S-18-settings-architecture.md#62-work-packages) row ST-25, [S-18 §7.3](../../notes/S-18-settings-architecture.md#73-owner-decisions-recommended-defaults-in-bold) D12, D16.

## Scope

**In:**

- Confirm no reader diverges, then stop writing and drop; remove aliases; copy-only access-mode unification.

**Out** (and where it belongs instead):

- Any wire enum change (none, D16).

## Design notes

- Drops follow the replayable-migration convention.

## Steps

1. Reader audit.
2. Drops.
3. Alias removal.

## Acceptance criteria

- [ ] `PENDING` is empty.
- [ ] Route coverage passes after alias removal.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
```

## Hand-off

- None: closes the ST phase.

The role agent sets `--set ST-25 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set ST-25 done`.
