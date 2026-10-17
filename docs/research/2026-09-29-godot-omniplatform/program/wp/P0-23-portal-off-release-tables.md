# P0-23 Portal off Release's tables

| Field       | Value                                                                                                                 |
| ----------- | --------------------------------------------------------------------------------------------------------------------- |
| Phase       | P0: Hygiene, unblockers and code quality (DX consolidation B: Foundations (code quality the feature tracks build on)) |
| Size        | 0.6–0.9 engineer-weeks                                                                                                |
| Depends on  | [P0-19](P0-19-descriptor-contributions-services-slug.md)                                                              |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md)                                                                                |
| Role        | `pkey-implementer`                                                                                                    |
| Plan mode   | no                                                                                                                    |
| Gates       | `rule-10`                                                                                                             |
| Human input | none                                                                                                                  |
| Repo        | `vladzaharia/polaris-key`                                                                                             |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **CQW-09** in [Track B, Foundations (code quality the feature tracks build on)](../../../2026-10-07-dx-consolidation/tracks.md#b-foundations-code-quality-the-feature-tracks-build-on).

## Goal

Portal off Release's tables, as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **CQW-09** in [Track B, Foundations (code quality the feature tracks build on)](../../../2026-10-07-dx-consolidation/tracks.md#b-foundations-code-quality-the-feature-tracks-build-on). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§3.2); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/cq-worker-services.md`](../../../2026-10-07-dx-consolidation/audits/cq-worker-services.md).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [Track B, Foundations (code quality the feature tracks build on)](../../../2026-10-07-dx-consolidation/tracks.md#b-foundations-code-quality-the-feature-tracks-build-on): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §3.2, for **CQW-09**.
- [`audits/cq-worker-services.md`](../../../2026-10-07-dx-consolidation/audits/cq-worker-services.md), for file and line evidence.

## Scope

**In:**

- A delivery.downloadToken hook (mint, read, spend, purge) implemented by Distribution; portal downloads only through customerDownloads; delete listPortalReleases, listPortalArtifacts, getPortalReleaseFacts and the token SQL (services/identity/portal/repo.ts:1014-1240); delete the GET /api/releases listing and its SPA fallback; OpenAPI and routeCoverage updated.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track B (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **CQW-09**; DX consolidation B: Foundations (code quality the feature tracks build on).
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Corrections (2026-10-17)

- The `delivery.downloadToken` hook was not built. Hooks are read-only (`core/hooks.ts` rule 2),
  and `release_download_tokens` is also read by Release (`packages/prune.ts`) and swept by Core, so
  a Distribution-owned table or hook would have added Release/Distribution seams. The table is
  now Core's (`TABLE_OWNERS`), with mint, read, spend and purge in `core/assets/downloadTokens.ts`;
  Identity's portal and maintenance call it. All four portal seams are gone.
- The portal reads Release only through `releaseCatalog` (`CatalogSourceArtifact` gained
  `sourceUrl` and `kind`; `releaseNotes` gained `sourceUrl` and `metadataAccess`).
- `GET /api/releases` is kept, rebuilt over the hook: the product page's What's new notes and the
  library's fallback read it. Deleting it is a SPA change (follow-up: add notes to
  `customerDownloads`, then drop the route and `PortalRelease` fallback).

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [x] Table-crossing allow-list loses its portal->release rows
- [x] Portal e2e (PX-20 suite) green (worker portal\* and attack suites)
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm gen transcripts --check
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- registry routeCoverage
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set P0-23 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P0-23 done`.
