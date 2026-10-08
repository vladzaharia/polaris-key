# P0-44 Corpus generator split (corpus lane, right after HA-12)

| Field       | Value                                                                                                                                                                                        |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | P0: Hygiene, unblockers and code quality (DX consolidation B: Foundations (code quality the feature tracks build on))                                                                        |
| Size        | 1.5–2 engineer-weeks                                                                                                                                                                         |
| Depends on  | [HA-12](HA-12-presentation-discovery.md)                                                                                                                                                     |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [U-01b](U-01b-cloud-sync-plan-amendment-two-stores-one.md), [LX-18](LX-18-licensing-wire.md), [SP-34](SP-34-client-core-takes-neutral-typescript.md) |
| Role        | `pkey-implementer`                                                                                                                                                                           |
| Plan mode   | no                                                                                                                                                                                           |
| Gates       | `corpus`, `drift-gate`                                                                                                                                                                       |
| Human input | none                                                                                                                                                                                         |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                    |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **CQT-03** in [Track B, Foundations (code quality the feature tracks build on)](../../../2026-10-07-dx-consolidation/tracks.md#b-foundations-code-quality-the-feature-tracks-build-on).

## Approved plans (2026-10-08)

These approved plans change this package. Where they differ from the text below, they win.

- [`plans/UK-02b.md`](../plans/UK-02b.md) §8: moves `tools/ui-matrix.ts` if UK-02b lands first (D11).

## Goal

Corpus generator split (corpus lane, right after HA-12), as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **CQT-03** in [Track B, Foundations (code quality the feature tracks build on)](../../../2026-10-07-dx-consolidation/tracks.md#b-foundations-code-quality-the-feature-tracks-build-on). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§4.1, §4.2, §4.3); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/cq-sdks-tools.md`](../../../2026-10-07-dx-consolidation/audits/cq-sdks-tools.md).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [Track B, Foundations (code quality the feature tracks build on)](../../../2026-10-07-dx-consolidation/tracks.md#b-foundations-code-quality-the-feature-tracks-build-on): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §4.1, §4.2, §4.3, for **CQT-03**.
- [`audits/cq-sdks-tools.md`](../../../2026-10-07-dx-consolidation/audits/cq-sdks-tools.md), for file and line evidence.

## Scope

**In:**

- Split tools/sign-corpus.ts into tools/corpus/<family>.ts plus reference/, byte-identical output; Swift CorpusLocator over #filePath; remove Resources/v2 and Resources/transcripts mirrors and their generator targets; AGENTS.md rule 1 updated. The first corpus-lane item after HA-12, before I-09 and LX-18, with a brief sign-corpus.ts freeze; it does not hold non-corpus builders.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track B (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **CQT-03**; DX consolidation B: Foundations (code quality the feature tracks build on).
- Holds the serial corpus lane (tracks.md rule 3) from the moment it regenerates the corpus or re-records transcripts until it merges.
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] Corpus output byte-identical
- [ ] Swift reads the corpus without a mirror copy
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm gen:corpus -- --check
mise exec node@22 -- pnpm gen:transcripts -- --check
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set P0-44 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P0-44 done`.
