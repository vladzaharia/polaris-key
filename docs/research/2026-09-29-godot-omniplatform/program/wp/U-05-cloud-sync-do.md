# U-05 Cloud Sync Durable Object and routes: settings and members, `seq`, clients, tombstones, push rules 1–8, the settings account-merge hook, `403 account_required`, coalesced directory, limits and ceilings, pull and push routes, browser bearer and CORS

| Field       | Value                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase       | U: Cloud Sync (S-17) (U1 MVP)                                                                                                                                                                                                                                                                                                                                                                                      |
| Size        | 2–2.8 engineer-weeks                                                                                                                                                                                                                                                                                                                                                                                               |
| Depends on  | [U-01](U-01-cloud-sync-plan.md), [U-02](U-02-principal-binding.md), [U-04](U-04-catalog-and-service.md)                                                                                                                                                                                                                                                                                                            |
| Unblocks    | [U-19](U-19-security-review.md), [U-06](U-06-sdk-settings-node-python.md), [U-20](U-20-sdk-settings-react.md), [U-07](U-07-sdk-settings-swift-kotlin.md), [U-21](U-21-sdk-settings-godot.md), [U-12](U-12-privacy-settings-portal.md), [U-11a](U-11a-console-data-settings.md), [U-10](U-10-saves-backend.md), [U-09](U-09-collections-backend.md), [U-14](U-14-live-pokes.md), [PX-W11](PX-W11-cloud-sync-api.md) |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                                                                                                                                                                                                                                                                                                                                              |
| Plan mode   | yes: executes the approved [`plans/U-01.md`](../plans/U-01.md) (no separate plan)                                                                                                                                                                                                                                                                                                                                  |
| Gates       | plan mode; `errors.json` (rule 3), transcripts (rule 1), `gen:constants -- --check`; rule 10 (OpenAPI + `routeCoverage`); THREAT-MODEL; `test:workerd`; `wrangler.toml`; `TABLE_OWNERS`; D1 migration; merged-account test; load test of one DO at the push limit (rows written and billable duration per op)                                                                                                      |
| Human input | a staging deploy for the one-DO load test at the push limit                                                                                                                                                                                                                                                                                                                                                        |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                                                                                                                                                                          |

## Goal

Devices push and pull user settings through `/<p>/sync/` against one Durable Object per `(product, subject)`, with push rules 1–8 enforced on the server, `403 account_required` for devices with no principal (neither signed in nor on a licence attached to an account), the settings account-merge hook, coalesced D1 directory writes, unlicensed limits and product ceilings, and browser bearer access through the CORS list.

## Why

This is the MVP's core service ([S-17 §5.4](../../notes/S-17-user-data-sync.md#54-sync-protocol)). Pull is the baseline; the DO serialises a principal's writes and owns `seq` ([S-17 §5.2](../../notes/S-17-user-data-sync.md#52-data-model)).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode); [`plans/U-01.md`](../plans/U-01.md) (this package executes it).
- [S-17 §5.2](../../notes/S-17-user-data-sync.md#52-data-model), [S-17 §5.4](../../notes/S-17-user-data-sync.md#54-sync-protocol), [S-17 §5.5](../../notes/S-17-user-data-sync.md#55-conflict-strategies-and-developer-merge-hooks), [S-17 §5.7](../../notes/S-17-user-data-sync.md#57-quotas-and-limits), [S-17 §5.8](../../notes/S-17-user-data-sync.md#58-security), [S-17 §5.17](../../notes/S-17-user-data-sync.md#517-cost-and-abuse-model), [S-17 §6](../../notes/S-17-user-data-sync.md#6-phases-and-work-packages) row U-05.
- `packages/worker/src/core/cors.ts:83-87`, `packages/worker/src/core/rateLimit.ts`, `packages/worker/wrangler.toml`.

## Scope

**In:**

- The DO: `meta`, `settings`, `setting_members`, `clients`, `tombstones`, lazy migrations; push rules 1–8; HLC clamp.
- The settings account-merge hook (copy or per-key merge into the surviving subject's DO, the survivor's pairwise subject winning per D21; device rows rewritten).
- Pull and push routes, `403 account_required` (licence state untouched), `cursor_expired`, `client_mismatch`.
- Coalesced directory alarm (at most once every 15 minutes), per-product aggregate every 15 minutes, unlicensed limits, product ceilings (50 GiB, 100k data-holding users, 2,000 pushes/s), `RateLimitDO` limits.
- Browser bearer and CORS inclusion; discovery fragment; `errors.json`, OpenAPI, `routeCoverage`, transcripts.
- Deletion hook body for Cloud Sync data (`deleteAll`).

**Out** (and where it belongs instead):

- Saves (→ U-10) and records (→ U-09); live pokes (→ U-14).

## Design notes

- No Cloud Sync without a Polaris Key account, ever (owner). The principal comes from U-02's `resolveSyncPrincipal` (`devices.subject ?? subjectFor(license.account_id, product)`), so the routes work on products with Identity off: Cloud Sync requires Config and the platform account, not the Identity toggle (owner clarification, 2026-10-04).
- `account_required` tells the SDK which offer to show, in the shape U-01 fixes: always the Worker-built portal link ("Add this licence to your Polaris Key account to sync"), and sign-in only when the product's Identity service is on. It never forces anything.
- The principal is resolved per request, so a detach or relink that changes the licence-owner line takes effect on the next request (old subject never served).
- The first-party session cookie is never accepted on `/sync` routes.
- Production deploy waits for U-19's security review.

## Steps

1. `errors.json` and contract types.
2. DO and push rules with scenario-backed tests.
3. Routes, CORS, limits and ceilings.
4. Merge and deletion hooks; transcripts; load test on staging.

## Acceptance criteria

- [ ] Every transcript in [S-17 §5.13](../../notes/S-17-user-data-sync.md#513-wire-impact) for settings is recorded and passes.
- [ ] `403 account_required` leaves licence state and cached documents untouched (transcript).
- [ ] A merged account's settings end up in the surviving subject's DO (test).
- [ ] On a product with Identity off, a key-activated device on a licence attached to an account syncs, and the same device after detach gets `account_required` (tests).
- [ ] Load test results (rows written, billable duration per op) in the PR.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- sync
mise exec node@22 -- pnpm gen:transcripts -- --check
mise exec node@22 -- pnpm --filter @polaris-key/worker test:workerd
```

## Hand-off

- U-19 reviews it before production; the settings SDK packages build against its transcripts; U-10 and U-09 extend the DO.

The role agent sets `--set U-05 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set U-05 done`.
