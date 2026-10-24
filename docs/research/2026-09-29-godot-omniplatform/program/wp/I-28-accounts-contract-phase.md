# I-28 Accounts contract phase

| Field       | Value                                                                                             |
| ----------- | ------------------------------------------------------------------------------------------------- |
| Phase       | I: Identity: one Polaris Key account, then per-app identity (S-16) (DX consolidation F: Identity) |
| Size        | 0.4–0.6 engineer-weeks                                                                            |
| Depends on  | [P0-17](P0-17-layering-move-lead-codemod-at-batch-6.md)                                           |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [I-28b](I-28b-accounts-contract-drops-release-n-1.md)     |
| Role        | `pkey-implementer`                                                                                |
| Plan mode   | no                                                                                                |
| Gates       | none beyond the green gate                                                                        |
| Human input | none                                                                                              |
| Repo        | `vladzaharia/polaris-key`                                                                         |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **IX-01** in [Track F, Identity](../../../2026-10-07-dx-consolidation/tracks.md#f-identity).

## Corrections (2026-10-23)

Verified against the code by the slice plan (`_lead/plans/I-28-MO-13-slices.md` §0). The code is the fact; the slices I-28.1 to I-28.4 carry the work.

- **A1.** There are no `_v` views (`CREATE VIEW` appears in no migration). The RUNBOOK ledger phrase "and their views" is dropped.
- **A2.** There is no `admin/repo.ts` (P0-17 moved the code). The `portal_*` SQL sites are `services/identity/accounts/legacy.ts`; `merge.ts:344-357`; `deletion.ts` (`endLicenseLinks`, the belt-and-braces delete, the erasure batch, the disable mirror); `links.ts` (`mirrorLinkRemoval`); the descriptor's `licenseDelete`; `productDeletion.ts:12`; `portal/repo.ts` (`getPortalAccount` copy, `rekeyLegacyPortalIdentities` and its callers); `scheduled.ts` (`REQUIRED_INDEXES`).
- **A3.** `legacy.ts` also holds the §8 Q1 settlement (`settleOwnershipConflicts`) and `endLicenseLinks` / `moveLicenseOwnerEndingLinks` (called by `claim.ts`). They go only if production has no unsettled loser and no portal link on a floating licence: the precondition check counts both.
- **A4.** Two `rekeyLegacy*` helpers: `rekeyLegacyPortalIdentities` writes a contract table and goes; `rekeyLegacyAccountLinks` writes `account_links` and stays (D1).
- **A5.** No code inserts into the four tables (the only `INSERT INTO portal_*` targets `portal_audit`), so they only shrink; an older Worker does no harm on empty tables.
- **A6.** The mirrors keep the I-05 rollback sound (`0068_accounts.down.sql`). Emptying the tables first makes that script exact again (D2).
- **A7.** Erasure of a legacy account's portal rows stops with the mirrors; emptying the tables in release N closes the 14-day readable-residue gap (D2).
- **A8.** `REQUIRED_INDEXES` and `0129_b` require three portal indexes that the drop removes: the requirement leaves in release N (`0141_b`, D4). `defaultTierMigration.test.ts` reads `0129_b`'s own list.
- **A9.** The `TABLE_OWNERS` rows, the settings-coverage row `column:portal_license_links.source` and `data-model.mdx` stay while the tables exist and move with the drop to I-28b; the schema-walking tests need one declared list (`RETIRED_TABLES`, D7).
- **A10.** `terms_json` is not fully dormant: `ACCOUNT_COLUMNS` (`mergeUndo.ts`) still copies it (D5).
- **A11.** `00XX_` cannot name an index assertion (filename sorts, wrangler order, `LATEST_MIGRATION`): provisional `0141_a` / `0141_b`, renumbered by the lead at merge (D3).
- **A12.** Seams and ledger: the `LICENSE_WRITE_SEAMS` row for `legacy.ts` goes with the file; ledger rows "Portal tables" and "Portal-to-account catch-up" change.
- **A13.** `licenseLinkSupersededNotice` has no caller besides `legacy.ts` and one test (D6).
- **A14.** THREAT-MODEL.md :6614 and :6622 wrongly say security notices read `portal_account_emails`; A6, :6708-6717, PRIVACY.md :320-323, :354-357, :391-394 and RUNBOOK :2212-2219 describe the legacy catch-up.
- **A15.** P0-17 is done, so I-28 is unblocked. No wire, route or error code is involved. `licenses.sub` stays (I-32).

## Goal

Accounts contract phase, as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **IX-01** in [Track F, Identity](../../../2026-10-07-dx-consolidation/tracks.md#f-identity). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§3.2, §4.2, §4.3); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/identity.md`](../../../2026-10-07-dx-consolidation/audits/identity.md).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [Track F, Identity](../../../2026-10-07-dx-consolidation/tracks.md#f-identity): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §3.2, §4.2, §4.3, for **IX-01**.
- [`audits/identity.md`](../../../2026-10-07-dx-consolidation/audits/identity.md), for file and line evidence.

## Scope

**In:**

- Release N of the accounts contract: stop every read and write of portal*accounts, portal_account_emails, portal_account_identities and portal_license_links with their \_v views, and accounts.terms_json; delete accounts/legacy.ts's catch-up, the rekeyLegacy\* helpers and every portal*\* reference (merge.ts, deletion.ts, portal/repo.ts, admin/repo.ts, the Identity descriptor's licenseDelete); TABLE_OWNERS and data-model docs; a reconciliation query recorded in the RUNBOOK first. No drop here: I-28b drops the tables a release later. licenses.sub stays until I-32.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track F (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **IX-01**; DX consolidation F: Identity.
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] Precondition query clean in production
- [ ] No portal\_\* reference remains
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm gen transcripts --check
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set I-28 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set I-28 done`.
