# ST-12 Device trust policy editor

| Field       | Value                                                                            |
| ----------- | -------------------------------------------------------------------------------- |
| Phase       | ST: Settings, access control and console shell (phase 3: coverage)               |
| Size        | 0.9–1.25 engineer-weeks                                                          |
| Depends on  | [ST-08](ST-08-product-settings-hub.md), [ST-09](ST-09-platform-settings-area.md) |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md)                                           |
| Role        | `pkey-implementer`                                                               |
| Plan mode   | no                                                                               |
| Gates       | THREAT-MODEL; console CSP parity                                                 |
| Human input | none                                                                             |
| Repo        | `vladzaharia/polaris-key`                                                        |

## Consolidation 2026-10-07

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **edit** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json) ([Track D, Administration, access control and console identity](../../../2026-10-07-dx-consolidation/tracks.md#d-administration-access-control-and-console-identity)); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> Keeps the device trust policy editor only. The auto-issue editor becomes the automatic-licences section of P2-10's product Access page; store credential editors go to the channel page's Setup tab (A-22); commerce settings and store-product mapping go to CM-23.

- Title: was "API-only settings into the console: device trust policy (critical), auto-issue editor, commerce settings, store credentials and settings editors".

## Goal

The API-only settings get console editors: device trust policy (critical), the auto-issue editor, commerce settings and store-product mapping, and store credentials and settings.

## Why

These settings exist only behind admin routes ([S-18 §2.2](../../notes/S-18-settings-architecture.md#22-settings-with-no-proper-home)); the trust policy is security-critical and needs a guarded console write path ([S-18 §4.15](../../notes/S-18-settings-architecture.md#415-threat-model-and-privacy-deltas) item 8).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [S-18 owner decisions](../../notes/S-18-settings-architecture.md) (the 2026-10-04 header block; it wins over the sections below it).
- [S-18 §2.2](../../notes/S-18-settings-architecture.md#22-settings-with-no-proper-home), [S-18 §4.15](../../notes/S-18-settings-architecture.md#415-threat-model-and-privacy-deltas) item 8, [S-18 §5.2](../../notes/S-18-settings-architecture.md#52-s-15-storefront-provisioning-and-the-a-18-packages), [S-18 §6.2](../../notes/S-18-settings-architecture.md#62-work-packages) row ST-12.

## Scope

**In:**

- Editors in the hub and Platform area; L2 to relax and L1 to tighten the trust policy; new THREAT-MODEL row for the trust-policy console path.

**Out** (and where it belongs instead):

- Store-product mapping on S-19's many-to-many shape: coordinate with LX-11 (S-18's "LX-07") and LX-14; if LX-11 has landed, build on its shape, not today's single `flag`.

## PENDING entries to remove

ST-06 left a shrinking allow-list in `packages/worker/scripts/settings-coverage.ts`. Its "PENDING owners" decision ([ST-06](ST-06-settings-docs-coverage.md#design-notes)) assigns this package the 6 entries below. Register each one in the settings registry (the note names the intended key, where there is one), then delete it from `PENDING` and lower `PENDING_CEILING` by the same count. `checkCoverage` refuses an entry that is both pending and registered, so the two edits land together.

- `table:platform_store_settings`
- `table:platform_credentials`
- `table:outlet_credentials`
- `table:dist_store_products`
- `column:dist_store_products.source`
- `env:PLATFORM_APPLE_TEAM_ID` (`stores.appStore.teamId`)

## Design notes

- Coordinate the Commerce page with A-17g.

## Steps

1. Trust policy first.
2. Auto-issue, commerce, stores.

## Acceptance criteria

- [ ] Every `PENDING` entry listed under "PENDING entries to remove" is registered and gone from `settings-coverage.ts`, `PENDING_CEILING` is 6 lower, and `settings-coverage.test.ts` passes.
- [ ] Relaxing the trust policy needs L2 and tightening L1 (tests).
- [ ] THREAT-MODEL row added.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin test
mise exec node@22 -- pnpm --filter @polaris-key/worker test
```

## Hand-off

- LX-14 extends the commerce mapping editor.

The role agent sets `--set ST-12 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set ST-12 done`.
