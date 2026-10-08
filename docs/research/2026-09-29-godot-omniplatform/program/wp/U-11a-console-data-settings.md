# U-11a Users -> Data tab (absorbs U-11b, U-11c)

| Field       | Value                                                                                                                                                                                                                                                                                       |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | U: Cloud Sync (S-17) (U1 MVP)                                                                                                                                                                                                                                                               |
| Size        | 0.6–0.85 engineer-weeks                                                                                                                                                                                                                                                                     |
| Depends on  | [U-03](U-03-account-overrides.md), [U-05](U-05-cloud-sync-do.md), [I-12](I-12-console-users.md), [ST-08](ST-08-product-settings-hub.md), [U-29](U-29-effective-config-provenance.md), [U-09](U-09-collections-backend.md), [U-10](U-10-saves-backend.md), [ST-07](ST-07-settings-row-v2.md) |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md)                                                                                                                                                                                                                                                      |
| Role        | `pkey-implementer`                                                                                                                                                                                                                                                                          |
| Plan mode   | no: follows the approved [`plans/U-01.md`](../plans/U-01.md) where it names this package                                                                                                                                                                                                    |
| Gates       | console CSP parity; rule 10 (OpenAPI + `routeCoverage`); THREAT-MODEL; accessibility and console tests; cross-product visibility test                                                                                                                                                       |
| Human input | none                                                                                                                                                                                                                                                                                        |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                                                   |

## Amendments from approved plans (2026-10-05)

The owner approved the plans below on 2026-10-05. These amendments win over the text of this brief where they differ.

- **[`plans/U-01.md`](../plans/U-01.md):** the registry hub area (S-18) for the Cloud Sync data settings.

## Consolidation 2026-10-07

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **edit** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json) ([Track G, Managed config and Cloud Sync](../../../2026-10-07-dx-consolidation/tracks.md#g-managed-config-and-cloud-sync)); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> One Users -> Data tab: per-key table from U-29's effective-config read (account override, synced choice, effective), quota meter, records and files browser with history and restore (absorbs U-11b, U-11c), audit and step-up; on ST-07's settings engine; components shared with PX-18.

- Title: was "Console Data tab, settings half: settings, account overrides, "what the app sees", quota meters, audit and step-up on I-12's Users page".
- Depends on: added U-29, U-09, U-10 and ST-07.
- Absorbs U-11b: One Data tab for one store.
- Absorbs U-11c: One browser for one store.

## Goal

The console's Users page (I-12) gains a Data tab for one pairwise subject: settings, account overrides, "what the app sees" (the effective values with sources), quota meters, and audit, with step-up for writes.

## Why

Operators need to support customers' synced settings without seeing other products ([S-17 §5.10](../../notes/S-17-user-data-sync.md#510-console-surfaces)).

## Read first

- `AGENTS.md` (always); `docs/design/ADMIN.md`.
- [S-17 §5.10](../../notes/S-17-user-data-sync.md#510-console-surfaces), [S-17 §6](../../notes/S-17-user-data-sync.md#6-phases-and-work-packages) row U-11.
- I-12's Users page.

## Scope

**In:** the settings half of the Data tab.

**Out** (and where it belongs instead):

- Saves (→ U-11b); collections (→ U-11c).

## Design notes

- **In the settings hub (S-18, owner, 2026-10-04).** The Cloud Sync console section lands as an area of the product settings hub built by [ST-08](ST-08-product-settings-hub.md), using `SettingsRow` v2.
- Pairwise subject only; every read and write audited (T10).
- The Data tab appears on I-12's Users page for every product with Cloud Sync on, which implies Identity on (owner, 2026-10-04, final answers).
- Contact email follows S-16 D19 (accepted): the buyer email, and the account's primary email only with the person's consent.

## Steps

1. Admin routes. 2. Tab UI.

## Acceptance criteria

- [ ] The tab shows only this product's subject data (test).
- [ ] Writes need step-up and are audited (tests).
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin test
```

## Hand-off

- U-11b and U-11c add their halves.

The role agent sets `--set U-11a in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set U-11a done`.
