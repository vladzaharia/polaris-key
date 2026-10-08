# P0-19 Descriptor contributions and services/<slug>/api.ts facades

| Field       | Value                                                                                                                                                                                        |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | P0: Hygiene, unblockers and code quality (DX consolidation B: Foundations (code quality the feature tracks build on))                                                                        |
| Size        | 1–1.4 engineer-weeks                                                                                                                                                                         |
| Depends on  | [P0-17](P0-17-layering-move-lead-codemod-at-batch-6.md)                                                                                                                                      |
| Unblocks    | [P0-23](P0-23-portal-off-release-tables.md), [P0-25](P0-25-service-portal-public-route-tables.md), [P0-51](P0-51-1-0-readiness-review.md), [ST-40](ST-40-integration-facts-sdk-sightings.md) |
| Role        | `pkey-implementer`                                                                                                                                                                           |
| Plan mode   | no                                                                                                                                                                                           |
| Gates       | none beyond the green gate                                                                                                                                                                   |
| Human input | none                                                                                                                                                                                         |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                    |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **CQW-05** in [Track B, Foundations (code quality the feature tracks build on)](../../../2026-10-07-dx-consolidation/tracks.md#b-foundations-code-quality-the-feature-tracks-build-on).

## Goal

Descriptor contributions and services/<slug>/api.ts facades, as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **CQW-05** in [Track B, Foundations (code quality the feature tracks build on)](../../../2026-10-07-dx-consolidation/tracks.md#b-foundations-code-quality-the-feature-tracks-build-on). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§3.1, §3.2, §4.3); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/cq-worker-core.md`](../../../2026-10-07-dx-consolidation/audits/cq-worker-core.md), [`audits/cq-worker-services.md`](../../../2026-10-07-dx-consolidation/audits/cq-worker-services.md).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [Track B, Foundations (code quality the feature tracks build on)](../../../2026-10-07-dx-consolidation/tracks.md#b-foundations-code-quality-the-feature-tracks-build-on): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §3.1, §3.2, §4.3, for **CQW-05**.
- [`audits/cq-worker-core.md`](../../../2026-10-07-dx-consolidation/audits/cq-worker-core.md), for file and line evidence.
- [`audits/cq-worker-services.md`](../../../2026-10-07-dx-consolidation/audits/cq-worker-services.md), for file and line evidence.

## Scope

**In:**

- Descriptor contributes.{integration, maintenance, subjectStore, onAuthorization} replace registerSubjectStore, registerLicenseHolderHooks and registerAuthorizationListener; scheduled.ts iterates descriptors (today scheduled.ts:53-69 imports services); one serviceContext() builder replaces four; services/<slug>/api.ts facades for console, scheduled, dispatch and webhook callers; each service's integration contributor returns its console prerequisites and domain facts (consumed by ST-40).

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track B (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **CQW-05**; DX consolidation B: Foundations (code quality the feature tracks build on).
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] No side-effect registration imports remain
- [ ] Every enabled service answers an integration contribution
- [ ] Boundary test covers api.ts imports
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm gen:transcripts -- --check
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set P0-19 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P0-19 done`.
