# ST-17 Resync dry-run plan shared by resync, link and the deploy hook; drift endpoint and view from the snapshot; Revert and Keep

| Field       | Value                                                                         |
| ----------- | ----------------------------------------------------------------------------- |
| Phase       | ST: Settings architecture (S-18) (phase 4: manifest round trip)               |
| Size        | 0.8–1.1 engineer-weeks                                                        |
| Depends on  | [ST-01c](ST-01c-settings-backfill.md), [ST-08](ST-08-product-settings-hub.md) |
| Unblocks    | [ST-18](ST-18-promote-export.md), [ST-25](ST-25-legacy-retirement.md)         |
| Role        | `pkey-implementer`                                                            |
| Plan mode   | no                                                                            |
| Gates       | rule 10 (OpenAPI + `routeCoverage`); console CSP parity                       |
| Human input | none                                                                          |
| Repo        | `vladzaharia/polaris-key`                                                     |

## Goal

Resync, link and the deploy hook share one dry-run plan (`apply`, `skipClaimed`, `delete`, `conflicts`), stored in `product_sync_state.plan_json`; the hub shows drift from the snapshot with Revert and Keep.

## Why

Model C is safe only if operators can see what a resync will do and where console and manifest differ ([S-18 §4.5](../../notes/S-18-settings-architecture.md#45-manifest-interaction-model-c-made-safe) items 4–5).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [S-18 owner decisions](../../notes/S-18-settings-architecture.md) (the 2026-10-04 header block; it wins over the sections below it).
- [S-18 §4.5](../../notes/S-18-settings-architecture.md#45-manifest-interaction-model-c-made-safe), [S-18 §6.2](../../notes/S-18-settings-architecture.md#62-work-packages) row ST-17.

## Scope

**In:**

- `POST …/resync?dryRun=1`; plan function shared by the three paths; `plan_json`; drift endpoint and view.

**Out** (and where it belongs instead):

- Promote to repo (→ ST-18).

## Design notes

- Reuses ST-01c's classifier.

## Steps

1. Plan function.
2. Endpoint.
3. Drift view.

## Acceptance criteria

- [ ] The webhook path records the same plan it applies (test).
- [ ] Drift lists every claimed field with Revert and Keep (e2e).
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm --filter @polaris-key/admin test
```

## Hand-off

- ST-18 promotes selected claims.

The role agent sets `--set ST-17 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set ST-17 done`.
