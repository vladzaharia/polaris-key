# U-19 Security review of U-05 before any production deploy: T1–T3 and T13–T16, cross-tenant, cross-product and cross-account tests, CORS, clamp and quota paths

| Field       | Value                                                                                               |
| ----------- | --------------------------------------------------------------------------------------------------- |
| Phase       | U: Cloud Sync (S-17) (U1 MVP)                                                                       |
| Size        | 0.4–0.55 engineer-weeks                                                                             |
| Depends on  | [U-05](U-05-cloud-sync-do.md)                                                                       |
| Unblocks    | [U-10](U-10-saves-backend.md), [U-09](U-09-collections-backend.md)                                  |
| Role        | `pkey-implementer`                                                                                  |
| Plan mode   | no: follows the approved [`plans/U-01.md`](../plans/U-01.md) where it names this package            |
| Gates       | THREAT-MODEL; gates U-05's production deploy and every U1 SDK release; findings tracked as R-series |
| Human input | none                                                                                                |
| Repo        | `vladzaharia/polaris-key`                                                                           |

## Goal

An independent security review of U-05 is recorded before any production deploy: T1–T3 and T13–T16 tested, cross-tenant, cross-product and cross-account isolation proven, CORS behaviour, the HLC clamp and quota paths exercised, and every finding tracked as an R-series row.

## Why

Cloud Sync is the first device-writable data service ([S-17 §7.1](../../notes/S-17-user-data-sync.md#71-risks) risk 1).

## Read first

- `AGENTS.md` (always); `docs/security/THREAT-MODEL.md`.
- [S-17 §5.8](../../notes/S-17-user-data-sync.md#58-security), [S-17 §5.14](../../notes/S-17-user-data-sync.md#514-threat-model-deltas), [S-17 §6](../../notes/S-17-user-data-sync.md#6-phases-and-work-packages) row U-19.

## Scope

**In:** the review, added tests for any gap, THREAT-MODEL rows for T1–T16, and R-series entries for findings.

**Out** (and where it belongs instead):

- Fixes larger than a test (→ follow-up packages named in the findings).

## Design notes

- The reviewer is not the U-05 implementer.
- Verify that a key-activated device never reaches Cloud Sync data, even on a licence attached to an account (Cloud Sync needs sign-in), and that sign-out, relink and portal device removal cut access on the next request.

## Steps

1. Review against T1–T16. 2. Tests for gaps. 3. Findings recorded.

## Acceptance criteria

- [ ] Every threat row has a passing test or a tracked finding.
- [ ] The PR states go or no-go for U-05's production deploy.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- sync
```

## Hand-off

- U-10 and U-09 build on the reviewed DO; U1 SDK releases cite this review.

The role agent sets `--set U-19 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set U-19 done`.
