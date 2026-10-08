# U-05 Cloud Sync service and routes per U-01b

| Field       | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase       | U: Cloud Sync (S-17) (U1 MVP)                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Size        | 2–2.8 engineer-weeks                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Depends on  | [U-01](U-01-cloud-sync-plan.md), [U-02](U-02-principal-binding.md), [U-04](U-04-catalog-and-service.md), [I-08](I-08-app-passthrough.md), [ST-01b](ST-01b-resync-claims.md), [ST-03](ST-03-settings-registry.md), [U-01b](U-01b-cloud-sync-plan-amendment-two-stores-one.md), [P0-25](P0-25-service-portal-public-route-tables.md)                                                                                                                           |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [U-19](U-19-security-review.md), [U-06](U-06-sdk-settings-node-python.md), [U-20](U-20-sdk-settings-react.md), [U-07](U-07-sdk-settings-swift-kotlin.md), [U-21](U-21-sdk-settings-godot.md), [U-12](U-12-privacy-settings-portal.md), [U-11a](U-11a-console-data-settings.md), [U-10](U-10-saves-backend.md), [U-09](U-09-collections-backend.md), [U-14](U-14-live-pokes.md), [PX-18](PX-18-cloud-sync-section.md) |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                                                                                                                                                                                                                                                                                                                                                                                        |
| Plan mode   | yes: executes the approved [`plans/U-01.md`](../plans/U-01.md) (no separate plan)                                                                                                                                                                                                                                                                                                                                                                            |
| Gates       | plan mode; `errors.json` (rule 3), transcripts (rule 1), `gen:constants -- --check`; rule 10 (OpenAPI + `routeCoverage`); THREAT-MODEL; `test:workerd`; `wrangler.toml`; `TABLE_OWNERS`; D1 migration; merged-account test; load test of one DO at the push limit (rows written and billable duration per op)                                                                                                                                                |
| Human input | a staging deploy for the one-DO load test at the push limit                                                                                                                                                                                                                                                                                                                                                                                                  |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                                                                                                                                                                                                                    |

## Amendments from approved plans (2026-10-05)

The owner approved the plans below on 2026-10-05. These amendments win over the text of this brief where they differ.

- **[`plans/U-01.md`](../plans/U-01.md):** the `protocol/sync` subpath and its `gen:constants` subpath; a sharded limiter (one `RateLimitDO` cannot hold the product push limit); `cloudSync.writesPaused`; no `sync_product_settings` table and no ceiling admin routes; the effective-limit formula. U-05 does not wait for LX-09 (Q9). `byEntitlement` maps limits to developer-declared numeric flags that combine by `max` (Q3).
- **[`plans/LX-01.md`](../plans/LX-01.md):** §7: `byTier` is the tier of the highest-`rank` contributing licence; `byEntitlement` reads `sync.storageBytes` and `sync.slots` from the effective set; `requiresFlag` calls `resolveDeviceEntitlements`, licence-less devices are allowed, and `writes.requireLicense` checks the anchor's usability.

## Consolidation 2026-10-07

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **edit** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json) ([Track G, Managed config and Cloud Sync](../../../2026-10-07-dx-consolidation/tracks.md#g-managed-config-and-cloud-sync)); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> Implements U-01b: synced settings plus open settings (256 keys / 64 KiB); quota is the pkey.cloudSync.bytes entitlement (registry default 256 MiB, tiers override; licence-less devices use the anonymous-devices tier or the constant), one ceiling and writesPaused; no cloudSync.quota, byTier, byEntitlement, unlicensed or writes; minTrust through the trust policy. Born on P0-25's route tables; subject store registered through the descriptor (P0-19); registers its own settings rows. Its sync-\* transcripts are re-recorded in Track K's W-SYNC slot, after U-01b's appended scenarios.

- Title: was "Cloud Sync Durable Object and routes: settings and members, `seq`, clients, tombstones, push rules 1–8, the settings account-merge hook, `403 account_required`, coalesced directory, limits and ceilings, pull and push routes, browser bearer and CORS".
- Depends on: added U-01b and P0-25.

## Approved plans (2026-10-08)

These approved plans change this package. Where they differ from the text below, they win.

- [`plans/U-01b.md`](../plans/U-01b.md) §11: §13.1–13.5, D3 (open settings), D5 (quota, resolved per device), D6 (`cloudSyncWrite`, `writes_paused`, the two settings), `empty`, the `syncAccess` change, §6.1's migration, T6, T14, T17, T18, the "One module for the licence question" rewrite and the PRIVACY row. It drops `byTier`, `unlicensed` and `requireLicense`. Its `cloudSyncWrite` relies on U-01b's lenient reader.

## Goal

Devices push and pull user settings through `/<p>/sync/` against one Durable Object per `(product, subject)`, with push rules 1–8 enforced on the server, `403 account_required` for devices with no signed-in account, the settings account-merge hook, coalesced D1 directory writes, unlicensed limits and product ceilings, and browser bearer access through the CORS list.

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

- **Ceilings as rows (S-18, owner, 2026-10-04).** The per-product Cloud Sync ceilings are `product_settings` rows registered through [ST-03](ST-03-settings-registry.md) on [ST-01b](ST-01b-resync-claims.md)'s table; no `sync_product_settings` table ([S-18 §5.4](../../notes/S-18-settings-architecture.md#54-s-17--u-01-cloud-sync)). Platform maxima for them arrive with [ST-16](ST-16-platform-defaults.md). Quotas follow S-19 decision 19: `byEntitlement` plus `byTier` on the highest-rank contributing licence.
- No Cloud Sync without signing in, ever (owner; literal sign-in per the final answers of 2026-10-04). The principal comes from U-02's `resolveSyncPrincipal` (`devices.subject`, set only by sign-in through the product), and Cloud Sync requires Config and Identity. A key-activated device, even on a licence attached to an account, gets `account_required`.
- `account_required` carries the sign-in offer in the shape U-01 fixes (I-08's `signInUrl` and device-code start). It never forces anything.
- The principal is resolved per request, so a sign-out, a relink that clears the binding or a merge alias takes effect on the next request (old subject never served).
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
- [ ] A key-activated device that never signed in gets `account_required` even when its licence is attached to an account; a signed-in device syncs (tests).
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
