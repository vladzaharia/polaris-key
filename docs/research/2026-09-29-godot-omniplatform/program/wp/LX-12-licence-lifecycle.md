# LX-12 Licence and add-on lifecycle states (no refund grace)

| Field       | Value                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | LX: Licensing model: licences, grants, entitlements (S-19) (phase B: the model, server-only)                                                                                                                                                                                                                                                                                                   |
| Size        | 0.4–0.55 engineer-weeks                                                                                                                                                                                                                                                                                                                                                                        |
| Depends on  | [LX-08](LX-08-licensing-expand.md), [LX-06](LX-06-licensing-settings.md)                                                                                                                                                                                                                                                                                                                       |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [LX-11](LX-11-commerce-rework.md), [LX-14](LX-14-console-licensing.md), [LX-18](LX-18-licensing-wire.md), [LX-23](LX-23-subscriptions.md), [CM-05](CM-05-checkout-fulfilment.md), [CM-22](CM-22-purchases-ledger-one-revocation-path.md), [LX-40](LX-40-retire-licensing-model-settings-7-1.md), [LX-41](LX-41-durations-subscriptions-core-trials.md) |
| Role        | `pkey-implementer`                                                                                                                                                                                                                                                                                                                                                                             |
| Plan mode   | no                                                                                                                                                                                                                                                                                                                                                                                             |
| Gates       | D1 migration (replayable, scratch-SQLite rehearsal); THREAT-MODEL                                                                                                                                                                                                                                                                                                                              |
| Human input | none                                                                                                                                                                                                                                                                                                                                                                                           |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                                                                                                                                                      |

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

## Corrections found in the code (2026-10-09)

- **No grace, so "after the grace" is "at once".** With `refundGraceHours` dropped, the first
  criterion is met when a refunded grant stops counting in the second the refund is written. The
  registered `licensing.refundGraceHours` setting stays registered, unread; LX-40 removes it with
  the other licensing-model settings.
- **No migration.** LX-08 already added `ended_reason`, `superseded_by` and both vocabularies
  (triggers). LX-12 adds no column, trigger or index. It does not backfill the licences disabled
  before it: rule 5 sends value backfills through P0-49, which is not built. Those rows read as
  `suspended` (LX-41's table already has that state). The migration gate is therefore not
  exercised.
- **The two machines are one module.** `core/licensing/lifecycle.ts` holds the licence and grant
  tables (pure, imports nothing, as LX-32's `terms.ts`). `lifecycleWrites.ts` derives every
  guarded UPDATE, the bulk `CASE` form and the grant contribution predicate from those tables.
  `GRANT_STATES` moved there from `core/grants.ts`, which re-exports it.
- **The writers.** Four paths disable a licence today, and each now writes its reason. The
  console's Disable and a batch's Disable unused keys write `revoked`, and so does a product's
  deletion. The sign-in merge of an enrolled licence (`activateFromIdentity`) writes
  `superseded`, with `superseded_by`. Enable clears the reason (and a superseded licence's
  `superseded_by`; an active licence's pointer is kept), and is refused (409) for `refunded` and
  `chargeback`: only the store's reversal undoes a money end.
  `admin/repo.ts`'s `setLicenseStatus` is gone. No path refunds or charges back a licence yet:
  those events are for CM-05 and CM-22.
- **Grant reads.** The one grant a document reads before LX-09, the licence's `oidc` grant, now
  goes through the lifecycle's contribution predicate (`active` or `past_due`, inside
  `expires_at`). No stored row changes value, so documents are byte-identical. The grant writers
  exclude store-sourced grants until LX-11 retires the dual-write. Store refunds still project as
  `revoked` until CM-22 routes them through the lifecycle.
- **Console.** No console file changes. The admin licence summary carries `endedReason` and
  `supersededBy` (OpenAPI `AdminLicenseSummary`) for LX-14 to show.

## Follow-ups (from review, 2026-10-09)

- **CM-22: a reversal must never lift an operator end or a standing chargeback.** One reason
  column (one state per grant) holds one end. So a refund that replaced an operator's end, an
  operator's revoke after a refund (`same`), or a chargeback after a refund (or the reverse) each
  leave one recorded end. That end's reversal then reinstates the item while the other end
  stands. Nothing writes a reversal through the lifecycle yet. It becomes a real fail-open when
  CM-22 wires store reversals, so this is a CM-22 acceptance criterion (added to its brief; see
  THREAT-MODEL "Licence and add-on lifecycle (LX-12)").
- **LX-23: align the provisioned-keys move with the contribution predicate.** The document layer
  (`oidcGrantLayer`) counts an `oidc` grant that is `active` or `past_due` inside `expires_at`.
  The provisioned-keys move (`moveProvisionedKeys` in `core/grants.ts`, through
  `activeOidcEntries`) still reads `state = 'active'` only. The two agree while nothing writes
  `past_due` or an expiry on an `oidc` grant. The package that first does (LX-23) must align them,
  or a move could plan against keys the document no longer shows.
- **CM-22 / LX-11:** route store refunds through the lifecycle as `refunded` and lift the
  store-source exclusion once the dual-write retires.
- **The operator's suppress (LX-13, LX-14):** make the `oidc` grant's sign-in upsert keep
  `suppressed`; it writes `active` on every sign-in today.

## Acceptance criteria

- [x] A refunded grant stops contributing after the grace (test). With no grace it stops at once:
      `test/licenseLifecycle.test.ts` "a refunded grant stops counting at once".
- [x] `ended_reason` is set on disable (test): `licenseLifecycle.test.ts` (Disable, product
      deletion), `licenseBatches.test.ts` (Disable unused keys), `enroll.test.ts` (the merge's
      `superseded`).
- [x] The green gate passes (`AGENTS.md`), including every drift gate listed in the header
      (the lead gate, scope changed, 2026-10-09; the migration gate is not exercised: no migration).

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
```

## Hand-off

- LX-14, LX-18, LX-23.

The role agent sets `--set LX-12 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set LX-12 done`.
