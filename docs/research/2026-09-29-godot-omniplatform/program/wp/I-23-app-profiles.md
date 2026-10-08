# I-23 App-specific profiles per account × product, with consent and per-product export and deletion

| Field       | Value                                                                                                         |
| ----------- | ------------------------------------------------------------------------------------------------------------- |
| Phase       | I: Identity: one Polaris Key account, then per-app identity (S-16) (layer-2)                                  |
| Size        | 1–1.4 engineer-weeks                                                                                          |
| Depends on  | [I-20](I-20-layer-2-plan.md)                                                                                  |
| Unblocks    | none                                                                                                          |
| Role        | `pkey-implementer`                                                                                            |
| Plan mode   | no: follows the approved [`plans/I-20.md`](../plans/I-20.md) where it names this package                      |
| Gates       | D1 migration; `TABLE_OWNERS`; THREAT-MODEL; privacy docs; rule 10 (OpenAPI + `routeCoverage`); privacy review |
| Human input | none                                                                                                          |
| Repo        | `vladzaharia/polaris-key`                                                                                     |

## Consolidation 2026-10-07

> **Parked 2026-10-07 (DX consolidation).** Optional and `deferred`, so `--ready` and `--critical`
> skip it. Revive only if a product needs per-app profile fields that a Cloud Sync record cannot hold. Re-read this brief against the code before reviving it.

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **parked** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> App-specific profiles duplicate Cloud Sync account x product data. Partial sharing is I-34's granular consent. Revive only if a product needs per-app profile fields that a Cloud Sync record cannot hold.

- Optional now (was required).

## Goal

Each account can hold an app-specific profile per product, with the shape from `plans/I-20.md`, shared only by consent and covered by per-product export and deletion.

## Why

App-specific profiles are part of the layer 2 scope the owner approved ([S-16 owner decisions](../../notes/S-16-identity-service.md)); they are account × product data, so deletion and merge must reach them ([S-16 §5.5](../../notes/S-16-identity-service.md#55-privacy)).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`; [`plans/I-20.md`](../plans/I-20.md).
- [S-16 owner decisions](../../notes/S-16-identity-service.md), [S-16 §5.1](../../notes/S-16-identity-service.md#51-concepts-and-data-model) (account × product data), [S-16 §5.5](../../notes/S-16-identity-service.md#55-privacy), [S-16 §8](../../notes/S-16-identity-service.md#8-work-packages) row I-23.

## Scope

**In:** the profile table and API per the plan, consent on Continue-to-App, merge and deletion hooks registered in I-05's registries, export entries.

**Out** (and where it belongs instead):

- Issuer claims (→ I-21).

## Design notes

- App-specific profiles are part of the per-product Identity service and exist only for products with Identity on (owner, 2026-10-04). Consent rides on the D22 "Continue to <App>" grant (decided 2026-10-04).
- Consented profile claims are join keys between developers; say so on the consent screen ([S-16 §5.4](../../notes/S-16-identity-service.md#54-threat-model-deltas) item 12).

## Steps

1. Table, API and consent.
2. Hooks and export.

## Acceptance criteria

- [ ] A profile is visible only to its product and only with consent (tests).
- [ ] Per-product removal and account deletion delete it (tests).
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- identity profile
```

## Hand-off

- I-21 can expose consented profile claims.

The role agent sets `--set I-23 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set I-23 done`.
