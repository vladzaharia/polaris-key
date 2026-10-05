# LX-09 `resolveDeviceEntitlements`: `legacy` (byte-identical) and `combined` modes, contributors under `entitlementHolder: device`, combine and state rules, holder report, caching by holder versions, every caller switched

| Field       | Value                                                                                                                                                                                                                                                                                               |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | LX: Licensing model: licences, grants, entitlements (S-19) (phase B: the model, server-only)                                                                                                                                                                                                        |
| Size        | 1–1.4 engineer-weeks                                                                                                                                                                                                                                                                                |
| Depends on  | [LX-05](LX-05-reserved-names-warn.md), [LX-08](LX-08-licensing-expand.md)                                                                                                                                                                                                                           |
| Unblocks    | [LX-10](LX-10-anchor-choice.md), [LX-13](LX-13-entitlements-backend.md), [LX-14](LX-14-console-licensing.md), [LX-15](LX-15-portal-licensing.md), [LX-16](LX-16-licensing-contract.md), [LX-18](LX-18-licensing-wire.md), [LX-22](LX-22-licensing-closeout.md), [LX-24](LX-24-per-seat-features.md) |
| Role        | `pkey-implementer`                                                                                                                                                                                                                                                                                  |
| Plan mode   | no                                                                                                                                                                                                                                                                                                  |
| Gates       | conformance corpus (`gen:corpus --check`); drift gate (`--check`)                                                                                                                                                                                                                                   |
| Human input | none                                                                                                                                                                                                                                                                                                |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                                                           |

## Goal

`resolveDeviceEntitlements` computes every device's entitlements in `legacy` mode (byte-identical to today) and `combined` mode (contributors under `entitlementHolder: device`, combine and state rules), produces the holder report, caches by holder versions, and every caller uses it.

## Why

The core of OC ([S-19 owner decisions](../../notes/S-19-licensing-model.md) item 1 (model OC adopted), [S-19 owner decisions](../../notes/S-19-licensing-model.md) item 3 (`entitlementHolder: device`)); decision 5 keeps existing products on `legacy` until their operator reads the report.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [S-19 owner decisions](../../notes/S-19-licensing-model.md) (the 2026-10-04 header block; it wins over the sections below it).
- [S-19 §7.3](../../notes/S-19-licensing-model.md#73-resolution-one-core-function) (all subsections), [S-19 §7.4](../../notes/S-19-licensing-model.md#74-combine-rules-entitlement-kinds-and-reserved-names), [S-19 §7.14](../../notes/S-19-licensing-model.md#714-migration-expand-dual-write-switch-contract) step 5, [S-19 §9](../../notes/S-19-licensing-model.md#9-phased-plan-and-work-packages) row LX-09.

## Scope

**In:**

- The resolver in Core; holder report; caching; switch the document, pack gate, registry tokens, portal and Cloud Sync callers; cost measurement.

**Out** (and where it belongs instead):

- Anchor choice (→ LX-10); wire members (→ LX-18).

## Design notes

- Corpus unchanged (`gen:corpus --check`).
- Operators cannot cancel a paid purchase by override in `combined` (decision 6).

## Steps

1. `legacy` with a byte-identity property test.
2. `combined` and report.
3. Caller switch.
4. Measure cost.

## Acceptance criteria

- [ ] `legacy` output is byte-identical to today on a live-shaped snapshot (property test).
- [ ] The `combined` diff equals the holder report (test).
- [ ] `gen:corpus --check` is unchanged.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm gen:corpus -- --check
```

## Hand-off

- LX-10, LX-13, LX-15, LX-18, U-01/U-02 (Cloud Sync quotas `byEntitlement`), PX-W3 re-run checks.

The role agent sets `--set LX-09 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set LX-09 done`.
