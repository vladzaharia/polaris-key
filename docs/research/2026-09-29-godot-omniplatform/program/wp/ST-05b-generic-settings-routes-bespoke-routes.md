# ST-05b Generic settings routes; the bespoke settings routes removed

| Field       | Value                                                                                                                       |
| ----------- | --------------------------------------------------------------------------------------------------------------------------- |
| Phase       | ST: Settings, access control and console shell (DX consolidation B: Foundations (code quality the feature tracks build on)) |
| Size        | 0.5–0.7 engineer-weeks                                                                                                      |
| Depends on  | [ST-05a](ST-05a-one-settings-read-write-path.md)                                                                            |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md)                                                                                      |
| Role        | `pkey-implementer`                                                                                                          |
| Plan mode   | no                                                                                                                          |
| Gates       | `rule-10`                                                                                                                   |
| Human input | none                                                                                                                        |
| Repo        | `vladzaharia/polaris-key`                                                                                                   |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **ST-05 (split)** in [Track B, Foundations (code quality the feature tracks build on)](../../../2026-10-07-dx-consolidation/tracks.md#b-foundations-code-quality-the-feature-tracks-build-on).

- Owner 2026-10-07: no compatibility window. What this package replaces (a route, mode, shape, Action input or CLI form) is removed in the same release; the one exception is a path that native app binaries already on end-user machines call (DJDL's desktop builds, the permanent alias routes), removed once DJDL has shipped a build on 0.9 (`tracks.md` rule 6).
- Absorbs ST-05 (split; this package takes its share): ST-05a: one settings read/write path (fold the A-13 platform store into the registry resolver and writeSetting). ST-05b: the generic routes (S-18 §4.7 minus history, as-of and restore), with the bespoke routes removed in the same release (no alias, no adapter).

## Goal

Generic settings routes; the bespoke settings routes removed, as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **ST-05 (split)** in [Track B, Foundations (code quality the feature tracks build on)](../../../2026-10-07-dx-consolidation/tracks.md#b-foundations-code-quality-the-feature-tracks-build-on). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: the [decision record](../../../2026-10-07-dx-consolidation/integration.md) (no audit names **ST-05 (split)**).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [Track B, Foundations (code quality the feature tracks build on)](../../../2026-10-07-dx-consolidation/tracks.md#b-foundations-code-quality-the-feature-tracks-build-on): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md), for **ST-05 (split)**.

## Scope

**In:**

- The generic settings admin routes of S-18 §4.7 minus history, as-of and restore, declared on ST-29's route table if it has landed. The bespoke settings routes (…/update/settings, …/license/policy, …/trust-policy, …/distribution/access and the rest S-18 §4.7 lists) are removed in this package's release, with no alias and no adapter: the console moves to the generic routes in the same change, because it ships in lockstep with the Worker. Neither the CLI nor the Action calls them (checked 2026-10-08: the CLI's admin calls are /manage/api/me, …/bundles, …/distribution/listing/import and the products routes, and the Action is the bundled CLI on the CI plane), so neither moves.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track B (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **ST-05 (split)**; DX consolidation B: Foundations (code quality the feature tracks build on).
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] Every settings write goes through the generic path
- [ ] No bespoke settings route answers; OpenAPI and routeCoverage list none, and the console calls only the generic routes (test)
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm gen transcripts --check
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- registry routeCoverage
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set ST-05b in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set ST-05b done`.
