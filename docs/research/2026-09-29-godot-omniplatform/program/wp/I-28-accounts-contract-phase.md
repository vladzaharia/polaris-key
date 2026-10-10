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
