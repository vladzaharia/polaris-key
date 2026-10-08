# LX-25 Redeem codes targeting a tier or add-on (optional train member)

| Field       | Value                                                                                                                                                                             |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | LX: Licensing model: licences, grants, entitlements (S-19) (phase D: optional)                                                                                                    |
| Size        | 0.5–0.7 engineer-weeks                                                                                                                                                            |
| Depends on  | [LX-08](LX-08-licensing-expand.md), [LX-11](LX-11-commerce-rework.md), [LX-35](LX-35-add-on-definitions-grantaddon.md), [P0-20](P0-20-split-identity-oidc-ts-extract-issuance.md) |
| Unblocks    | [CM-10](CM-10-gifting.md)                                                                                                                                                         |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                                                                                                             |
| Plan mode   | yes: the plan [`plans/LX-25.md`](../plans/LX-25.md) needs human approval before code                                                                                              |
| Gates       | plan mode; rule 10 (OpenAPI + `routeCoverage`); all six SDKs (`parity:check`)                                                                                                     |
| Human input | plan approval (`plans/LX-25.md`)                                                                                                                                                  |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                         |

## Amendments from approved plans (2026-10-05)

The owner approved the plans below on 2026-10-05. These amendments win over the text of this brief where they differ.

- **[`plans/LX-01.md`](../plans/LX-01.md):** Q8: this plan defines what entering an `addon` key does; nothing writes `addon` before it.

## Amendments from S-22 (2026-10-05)

The commerce plan [S-22](../../notes/S-22-polaris-key-commerce.md) (its packages are optional and deferred) changes this brief as follows. These amendments win over the text below where they differ.

- **Paid gift codes.** [CM-10](CM-10-gifting.md) mints gift codes from paid Polaris Key gift orders ([S-22 §7.8](../../notes/S-22-polaris-key-commerce.md#78-gifting), decision D21). The code model carries an `order_ref` (nullable) so a refund can void an unredeemed code and a lost dispute or refund can revoke the grant a redeemed code created.
- A code minted for a **base** offer creates a licence on redemption, not only a grant; the plan defines both.

## Consolidation 2026-10-07

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **edit** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json) ([Track K, Corpus lane (wire trains, serial)](../../../2026-10-07-dx-consolidation/tracks.md#k-corpus-lane-wire-trains-serial)); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> Stays optional. Codes target tier: or addon: through core/licensing/issue.ts (a base code mints a licence, an add-on code a grant); its device route rides LX-18 as an optional member.

- Title: was "Redeem and gift codes that create a grant on the redeemer's holder".
- Depends on: added LX-35 and P0-20.

## Goal

Optional: redeem and gift codes create a grant on the redeemer's holder.

## Why

Decisions 11 and 20: add-on keys and customer gifting via codes ([S-19 §10.3](../../notes/S-19-licensing-model.md#103-owner-decisions-recommended-defaults-in-bold) decision 11, decision 20).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode).
- [S-19 owner decisions](../../notes/S-19-licensing-model.md) (the 2026-10-04 header block; it wins over the sections below it).
- [S-19 §7.6](../../notes/S-19-licensing-model.md#76-lifecycle-terms-trials-subscriptions-refunds-dunning-upgrades-bundles), [S-19 §9](../../notes/S-19-licensing-model.md#9-phased-plan-and-work-packages) row LX-25.

## Scope

**In:**

- The plan; code minting and redeem route (OpenAPI, `routeCoverage`); SDK parity.

**Out** (and where it belongs instead):

- Licence transfer (unchanged).

## Design notes

- Plan mode: a new device-facing route across SDKs.

## Steps

1. Plan and approval.
2. Route.
3. SDKs.

## Acceptance criteria

- [ ] Redeeming creates a grant on the redeemer's holder (test).
- [ ] Parity passes.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm parity:check
```

## S-21 note (2026-10-05)

Codes are not a storefront listing path ([S-21](../../notes/S-21-polaris-storefront.md) Q14). They enter through the portal's
Activate modal, next to licence keys, and the created grant then shows in the Library.

## Hand-off

- None.

The role agent sets `--set LX-25 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set LX-25 done`.
