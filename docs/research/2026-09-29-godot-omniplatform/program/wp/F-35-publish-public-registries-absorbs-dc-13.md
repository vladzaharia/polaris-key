# F-35 Publish to public registries (absorbs DC-13)

| Field       | Value                                                                            |
| ----------- | -------------------------------------------------------------------------------- |
| Phase       | F: Package feeds (pkg.plrs.im) (DX consolidation I: Packages, updates and packs) |
| Size        | 1.2–1.6 engineer-weeks                                                           |
| Depends on  | [F-34](F-34-feeds-that-provision-themselves.md)                                  |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md)                                           |
| Role        | `pkey-implementer`                                                               |
| Plan mode   | no                                                                               |
| Gates       | `threat-model`, `rule-9`                                                         |
| Human input | owner decision 3 (answered 2026-10-07, open to veto)                             |
| Repo        | `vladzaharia/polaris-key`                                                        |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **FX-03** in [Track I, Packages, updates and packs](../../../2026-10-07-dx-consolidation/tracks.md#i-packages-updates-and-packs).

## Goal

Publish to public registries (absorbs DC-13), as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **FX-03** in [Track I, Packages, updates and packs](../../../2026-10-07-dx-consolidation/tracks.md#i-packages-updates-and-packs). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§3.1, §3.2, §6); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/backlog-sweep.md`](../../../2026-10-07-dx-consolidation/audits/backlog-sweep.md), [`audits/release-distribution.md`](../../../2026-10-07-dx-consolidation/audits/release-distribution.md).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [Track I, Packages, updates and packs](../../../2026-10-07-dx-consolidation/tracks.md#i-packages-updates-and-packs): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §3.1, §3.2, §6, for **FX-03**.
- [`audits/backlog-sweep.md`](../../../2026-10-07-dx-consolidation/audits/backlog-sweep.md), for file and line evidence.
- [`audits/release-distribution.md`](../../../2026-10-07-dx-consolidation/audits/release-distribution.md), for file and line evidence.

## Scope

**In:**

- npmjs (provenance) and PyPI (trusted publishing) first, then Maven Central, crates.io and GHCR: a CI-plane step (pkey feeds publish-public) in the Action using each registry's OIDC trusted publishing, so Polaris Key holds no registry secret; per-package operator approval (L2, irreversible), manifest intent allowed; the package must be Public; stable and beta only (latest/next), never dev or main; re-hash against the record; console and portal show 'Also on npmjs'; a registry wizard (claim, trusted-publisher deep link, verify). Our own SDKs stay feeds-only unless owner decision 3 changes.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track I (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **FX-03**; DX consolidation I: Packages, updates and packs.
- Security review and THREAT-MODEL rows before merge (`sec`).
- Gated on owner decision 3 ([README §8](../../../2026-10-07-dx-consolidation/README.md#8-owner-decisions)), answered on 2026-10-07 under delegated authority with the recommendation and open to the owner's veto; a veto takes that row's "If the answer is no" column.
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] A dev or main version is never pushed (test)
- [ ] No registry secret stored by Polaris Key
- [ ] Security review signed
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/cli test
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set F-35 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set F-35 done`.
