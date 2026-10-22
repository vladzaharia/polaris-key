# P0-25 Service, portal and public route tables

| Field       | Value                                                                                                                                                                        |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | P0: Hygiene, unblockers and code quality (DX consolidation B: Foundations (code quality the feature tracks build on))                                                        |
| Size        | 1.2–1.8 engineer-weeks                                                                                                                                                       |
| Depends on  | [P0-16](P0-16-first-party-respond-body-module-console.md), [P0-19](P0-19-descriptor-contributions-services-slug.md), [ST-29](ST-29-admin-route-table-can-usecan.md)          |
| Unblocks    | [P0-25b](P0-25b-portal-public-route-tables.md), [P0-30](P0-30-guardrails-test-harness-test-layout.md), [P0-51](P0-51-1-0-readiness-review.md), [U-05](U-05-cloud-sync-do.md) |
| Role        | `pkey-implementer`                                                                                                                                                           |
| Plan mode   | no                                                                                                                                                                           |
| Gates       | `rule-10`                                                                                                                                                                    |
| Human input | none                                                                                                                                                                         |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                    |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **CQW-11** in [Track B, Foundations (code quality the feature tracks build on)](../../../2026-10-07-dx-consolidation/tracks.md#b-foundations-code-quality-the-feature-tracks-build-on).

## Goal

Service, portal and public route tables, as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **CQW-11** in [Track B, Foundations (code quality the feature tracks build on)](../../../2026-10-07-dx-consolidation/tracks.md#b-foundations-code-quality-the-feature-tracks-build-on). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§3.1, §3.2, §4.3); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/cq-worker-services.md`](../../../2026-10-07-dx-consolidation/audits/cq-worker-services.md).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [Track B, Foundations (code quality the feature tracks build on)](../../../2026-10-07-dx-consolidation/tracks.md#b-foundations-code-quality-the-feature-tracks-build-on): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §3.1, §3.2, §4.3, for **CQW-11**.
- [`audits/cq-worker-services.md`](../../../2026-10-07-dx-consolidation/audits/cq-worker-services.md), for file and line evidence.

## Scope

**In:**

- core/http/routes.ts declarations (method, pattern, auth, body cap, error family, permission) with automatic 405 and body cap; handlers take ctx; migrate license, config, update, sync, release, distribution, identity, then portal and public; routeCoverage derived from the tables. U-05 is born on them.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track B (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **CQW-11**; DX consolidation B: Foundations (code quality the feature tracks build on).
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [x] routeCoverage generated from the tables
- [x] Every device transcript byte-identical (slice 1 oracle: 1,800 requests, 9 listed 405 tightenings)
- [x] No hand dispatch left in migrated services (the seven service tables; the portal and core public routes are P0-25b)
- [x] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm gen transcripts --check
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- registry routeCoverage
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set P0-25 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P0-25 done`.

## Progress and continuation (2026-10-17)

**Slice 1 done: the service tables.** `core/http/routes.ts` (`serviceRoutes`) and the shared
matcher `core/http/pathMatch.ts` (moved out of `console/routeMatch.ts`, which re-exports it).
License, Config, Update, Identity, Release, Distribution and Sync (empty, U-05's rows go here) each
export a `<SLUG>_ROUTES` table; the descriptor's `handle` and `surface` are the table's, so
`routeCoverage` is derived from the rows and the OpenAPI spec did not change (the derived surfaces
equal the old hand lists, checked path by path). The `handle*Routes` switches are gone.

Verification against the code: the brief said handlers take `ctx` and the table carries a body cap
and an error family. Handlers already take `ServiceContext`; the table carries `auth`, `bodyCap`
(read through `match.readJson()`, after auth) and a per-row policy for an unlisted method. An error
family per row was left out: refusals keep the shapes their handlers give them (plain 405, wire
errors, flat), because the replay below pins them byte for byte and a family field would document
what it cannot enforce.

Tests: `serviceRouteOracle.test.ts` replays 1,800 requests (every canonical route, near misses,
each method, with and without a body) against `fixtures/service-route-oracle.json`, recorded from
the hand dispatch before the move. The only differences are in its closed `TIGHTENED` list: nine
routes whose handlers never checked the method and served POST/PUT/PATCH/DELETE (and for
`config/mint/:id/auth`, `identity/auth/*` also OPTIONS or HEAD) though the spec lists GET or GET
and POST; each now answers the plain 405. `serviceRouteTables.test.ts` pins the mechanism and
walks every row (no unlisted method reaches a handler; no CI row reaches its handler without a
token).

**Also in slice 1 (after the first review):** I-08's `authorize`/`token` and CM-29's Commerce
(`COMMERCE_ROUTES`: `binding`, `claim`, and the two store hooks, accepted only with `storeHook`
set and License on; `/commerce/hooks/*` stays the not-found) are table rows. Each was recorded
from its hand dispatch first: `service-route-oracle-2.json` (I-08, hostile `%2F` / `..` / `//` /
trailing-slash spellings on `fdroid/**` and `rollouts`, Origin/HEAD/OPTIONS on CORS-covered
routes) and `service-route-oracle-3.json` (Commerce in three product states, plus the identity
pages that changed on integ/next).

**Remaining (slice 2, not started): the portal and the public (core) routes.**
`dispatch.ts`'s `routeRequest`/`dispatchProductRoute` switches over `router.ts` route kinds and
`services/identity/portal` `handlePortal` are still hand dispatch. The core product routes
(discovery, jwks, trust manifest, devices, report, register, attest, assets) are the natural
first rows; the portal API is the larger one (its own path walk, CSRF and session gates).
`CORS_SERVICE_PATHS` (`core/cors.ts`) is still a third copy of the service path list and should
become a flag on the rows. I-08's authorize/token rows go straight into `IDENTITY_ROUTES`.

## Split 2026-10-22 (triage)

Set done on slice 1 (a44b8921e): the service tables, `SYNC_ROUTES` (U-05's rows), routeCoverage derived. U-05, P0-30 and P0-51 need only that. Slice 2 (portal `handlePortal`, the core public routes in `dispatch.ts`, the `CORS_SERVICE_PATHS` row flag) is **[P0-25b](P0-25b-portal-public-route-tables.md)**.
