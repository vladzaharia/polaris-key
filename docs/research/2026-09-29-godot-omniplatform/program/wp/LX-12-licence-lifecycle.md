# LX-12 Licence and grant lifecycle: grant expiry, refund and chargeback states, `refundGraceHours`, `ended_reason`

| Field       | Value                                                                                                                                         |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | LX: Licensing model: licences, grants, entitlements (S-19) (phase B: the model, server-only)                                                  |
| Size        | 0.4–0.55 engineer-weeks                                                                                                                       |
| Depends on  | [LX-08](LX-08-licensing-expand.md), [LX-06](LX-06-licensing-settings.md)                                                                      |
| Unblocks    | [LX-14](LX-14-console-licensing.md), [LX-18](LX-18-licensing-wire.md), [LX-23](LX-23-subscriptions.md), [CM-05](CM-05-checkout-fulfilment.md) |
| Role        | `pkey-implementer`                                                                                                                            |
| Plan mode   | no                                                                                                                                            |
| Gates       | D1 migration (replayable, scratch-SQLite rehearsal); THREAT-MODEL                                                                             |
| Human input | none                                                                                                                                          |
| Repo        | `vladzaharia/polaris-key`                                                                                                                     |

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
