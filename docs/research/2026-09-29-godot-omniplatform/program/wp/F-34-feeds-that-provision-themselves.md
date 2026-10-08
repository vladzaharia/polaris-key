# F-34 Feeds that provision themselves, Customers by default

| Field       | Value                                                                                                                                                |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | F: Package feeds (pkg.plrs.im) (DX consolidation I: Packages, updates and packs)                                                                     |
| Size        | 0.8–1.1 engineer-weeks                                                                                                                               |
| Depends on  | [F-33](F-33-personal-tokens-pkeyp-packages-read.md)                                                                                                  |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [P2-10](P2-10-product-access-page-who-gets-what.md), [F-35](F-35-publish-public-registries-absorbs-dc-13.md) |
| Role        | `pkey-implementer`                                                                                                                                   |
| Plan mode   | no                                                                                                                                                   |
| Gates       | `threat-model`                                                                                                                                       |
| Human input | none                                                                                                                                                 |
| Repo        | `vladzaharia/polaris-key`                                                                                                                            |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **FX-02** in [Track I, Packages, updates and packs](../../../2026-10-07-dx-consolidation/tracks.md#i-packages-updates-and-packs).

- UX rows absorbed (`uxRows` in `backlog-changes.json`): UX-33.

- Clears its entries in `packages/admin/test/copy.debt.json` (ST-37's console copy ledger).

## Goal

Feeds that provision themselves, Customers by default, as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **FX-02** in [Track I, Packages, updates and packs](../../../2026-10-07-dx-consolidation/tracks.md#i-packages-updates-and-packs). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§4.2, §4.3, §4.4); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/feeds-updates-packs.md`](../../../2026-10-07-dx-consolidation/audits/feeds-updates-packs.md).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [Track I, Packages, updates and packs](../../../2026-10-07-dx-consolidation/tracks.md#i-packages-updates-and-packs): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §4.2, §4.3, §4.4, for **FX-02**.
- [`audits/feeds-updates-packs.md`](../../../2026-10-07-dx-consolidation/audits/feeds-updates-packs.md), for file and line evidence.

## Scope

**In:**

- Manifest ingest writes dist_registry_owners and dist_registry_feeds for declared package ecosystems at Customers with derived exact-name namespaces; packageFeeds becomes an off switch; feed settings cut to four sections (Upstream, Untagged manifests and the asset-listing fields go; hide-yanked becomes a default); feed access is Public or Customers only: before the feed-level Entitled option goes, each entitled feed's mode and flag move onto every deliverable's dist_access (the stricter-of rule in registry/authorize.ts:14-30,304-330 then holds per deliverable), with a P0-49 report; Packages empty state 'Waiting for the first package...' (UX-33). Existing public feeds are not flipped. Registers its keys through ST-05a (no ST-09 wait).

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track I (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **FX-02**; DX consolidation I: Packages, updates and packs.
- Security review and THREAT-MODEL rows before merge (`sec`).
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] A declared npm package gets a Customers feed with no console step
- [ ] Four access options become two, and no principal gains read access in the migration (test)
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm gen:transcripts -- --check
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set F-34 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set F-34 done`.
