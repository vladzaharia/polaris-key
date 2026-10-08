# LX-12 Licence and add-on lifecycle states (no refund grace)

| Field       | Value                                                                                                                                                                                                                                                                                                                                                       |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | LX: Licensing model: licences, grants, entitlements (S-19) (phase B: the model, server-only)                                                                                                                                                                                                                                                                |
| Size        | 0.4–0.55 engineer-weeks                                                                                                                                                                                                                                                                                                                                     |
| Depends on  | [LX-08](LX-08-licensing-expand.md), [LX-06](LX-06-licensing-settings.md)                                                                                                                                                                                                                                                                                    |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [LX-14](LX-14-console-licensing.md), [LX-18](LX-18-licensing-wire.md), [LX-23](LX-23-subscriptions.md), [CM-05](CM-05-checkout-fulfilment.md), [CM-22](CM-22-purchases-ledger-one-revocation-path.md), [LX-40](LX-40-retire-licensing-model-settings-7-1.md), [LX-41](LX-41-durations-subscriptions-core-trials.md) |
| Role        | `pkey-implementer`                                                                                                                                                                                                                                                                                                                                          |
| Plan mode   | no                                                                                                                                                                                                                                                                                                                                                          |
| Gates       | D1 migration (replayable, scratch-SQLite rehearsal); THREAT-MODEL                                                                                                                                                                                                                                                                                           |
| Human input | none                                                                                                                                                                                                                                                                                                                                                        |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                                                                                                                   |

## Consolidation 2026-10-07

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **edit** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json) ([Track E, Licensing model](../../../2026-10-07-dx-consolidation/tracks.md#e-licensing-model)); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> Keeps ended_reason and the licence and add-on states; drops refundGraceHours (full refunds and chargebacks revoke at once; partial refunds never). Dunning lives in LX-41 and LX-23 with the store's own grace.

- Title: was "Licence and grant lifecycle: grant expiry, refund and chargeback states, `refundGraceHours`, `ended_reason`".

## Goal

Licences and grants have a lifecycle: grant expiry, refund and chargeback states, `refundGraceHours` (default 0), and `ended_reason` set when a licence ends.

## Why

There is no term model beyond one `expires_at` (G8, [S-19 §4.3](../../notes/S-19-licensing-model.md#43-gaps)); decision 21 sets the defaults.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [S-19 owner decisions](../../notes/S-19-licensing-model.md) (the 2026-10-04 header block; it wins over the sections below it).
- [S-19 §7.6](../../notes/S-19-licensing-model.md#76-lifecycle-terms-trials-subscriptions-refunds-dunning-upgrades-bundles), [S-19 §9](../../notes/S-19-licensing-model.md#9-phased-plan-and-work-packages) row LX-12.

## Scope

**In:**

- State transitions; grace setting; `ended_reason` writes.

**Out** (and where it belongs instead):

- Dunning (→ LX-23); wire reasons (→ LX-18).

## Design notes

- Chargebacks never get grace.

## Steps

1. States.
2. Grace.
3. Tests.

## Acceptance criteria

- [ ] A refunded grant stops contributing after the grace (test).
- [ ] `ended_reason` is set on disable (test).
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
```

## Hand-off

- LX-14, LX-18, LX-23.

The role agent sets `--set LX-12 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set LX-12 done`.
