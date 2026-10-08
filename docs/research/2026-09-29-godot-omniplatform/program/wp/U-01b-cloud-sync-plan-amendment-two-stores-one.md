# U-01b Cloud Sync plan amendment: two stores, one conflict vocabulary, quota as an entitlement

| Field       | Value                                                                                                                                     |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | U: Cloud Sync (S-17) (DX consolidation G: Managed config and Cloud Sync)                                                                  |
| Size        | 0.4–0.6 engineer-weeks                                                                                                                    |
| Depends on  | none                                                                                                                                      |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [U-05](U-05-cloud-sync-do.md), [U-10](U-10-saves-backend.md), [U-09](U-09-collections-backend.md) |
| Role        | `pkey-wire-planner` (planning only)                                                                                                       |
| Plan mode   | yes: this package writes `plans/U-01b.md`, which needs human approval                                                                     |
| Gates       | `plan-mode`                                                                                                                               |
| Human input | plan approval (`plans/U-01b.md`)                                                                                                          |
| Repo        | `vladzaharia/polaris-key`                                                                                                                 |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **U-01b** in [Track G, Managed config and Cloud Sync](../../../2026-10-07-dx-consolidation/tracks.md#g-managed-config-and-cloud-sync).

## Goal

Cloud Sync plan amendment: two stores, one conflict vocabulary, quota as an entitlement, as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **U-01b** in [Track G, Managed config and Cloud Sync](../../../2026-10-07-dx-consolidation/tracks.md#g-managed-config-and-cloud-sync). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§1.5, §4.1, §4.2, §4.3); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/config-cloudsync.md`](../../../2026-10-07-dx-consolidation/audits/config-cloudsync.md).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode), and the skill that applies, if any.
- [Track G, Managed config and Cloud Sync](../../../2026-10-07-dx-consolidation/tracks.md#g-managed-config-and-cloud-sync): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §1.5, §4.1, §4.2, §4.3, for **U-01b**.
- [`audits/config-cloudsync.md`](../../../2026-10-07-dx-consolidation/audits/config-cloudsync.md), for file and line evidence.

## Scope

**In:**

- Amend plans/U-01.md: synced settings on config.set/clear/setting/onConfigChange plus one records store with files, saves and session as templates; owner-only access at launch; one conflict vocabulary (lastWrite, max, min, merge, union, revision); no onAttach; open settings (256 keys / 64 KiB); quota is the pkey.cloudSync.bytes entitlement alone (registry default 256 MiB, tiers override, licence-less devices use the anonymous-devices tier or the constant; no cloudSync.quota), one ceiling (cloudSync.ceiling.bytes) and writesPaused; minTrust to the trust policy; save slots a platform constant; SDK names (cloudSync.saves; collection() reserved); export and delete with each store. Contract text only: WIRE-CONTRACT-V4 §13 text, errors.json deltas, sync-scenarios.json appended in Track K's W-SYNC slot (U-05's transcripts follow), validator rule table, brief changes for U-05..U-23 and PX-18. No discovery member is added.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track G (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **U-01b**; DX consolidation G: Managed config and Cloud Sync.
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Write `plans/U-01b.md` and stop for human approval; name the corpus regeneration and every SDK that follows where the wire is touched.
3. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] No signed corpus change
- [ ] Plan approved; every Cloud Sync brief updated
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm gen:corpus -- --check
mise exec node@22 -- pnpm gen:transcripts -- --check
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set U-01b in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set U-01b done`.
