# P0-25b Portal and core public route tables, and the CORS row flag

| Field       | Value                                                                                                                 |
| ----------- | --------------------------------------------------------------------------------------------------------------------- |
| Phase       | P0: Hygiene, unblockers and code quality (DX consolidation B: Foundations (code quality the feature tracks build on)) |
| Size        | 0.1–0.15 engineer-weeks                                                                                               |
| Depends on  | [P0-25](P0-25-service-portal-public-route-tables.md)                                                                  |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md)                                                                                |
| Role        | `pkey-implementer`                                                                                                    |
| Plan mode   | no                                                                                                                    |
| Gates       | `rule-10`                                                                                                             |
| Human input | none                                                                                                                  |
| Repo        | `vladzaharia/polaris-key`                                                                                             |

## Split 2026-10-22 (triage)

Filed from [P0-25](P0-25-service-portal-public-route-tables.md) by the program triage (`/Users/vlad/Repos/pk-wt/_lead/triage-2026-10-22.md`, size 4–6 h). P0-25 carries what is on staging; this package carries the rest.

On staging already: P0-25 slice 1 (a44b8921e) on staging: `core/http/{routes,pathMatch,body}.ts`, a `<SLUG>_ROUTES` table per service, routeCoverage derived from them.

## Goal

Portal and core public route tables, and the CORS row flag. Done when every acceptance criterion holds and the green gate passes.

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- The parent brief [P0-25](P0-25-service-portal-public-route-tables.md), its Progress and Split notes.

## Scope

**In:**

- Slice 2 of P0-25: `handlePortal` and the core public routes in `dispatch.ts` move onto route tables (`core/http/routes.ts`, `pathMatch.ts`), and the `CORS_SERVICE_PATHS` list becomes a flag on the route row. Same oracle as slice 1: the recorded requests stay byte-identical, `routeCoverage` is derived from the tables, and the OpenAPI spec does not change except where a documented 405 tightens.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and everything P0-25 already shipped.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [x] Portal `handlePortal` dispatches from a route table; no hand dispatch left in it
- [x] Core public routes in `dispatch.ts` dispatch from a table
- [x] `CORS_SERVICE_PATHS` replaced by a per-row CORS flag; the CORS tests are unchanged
- [x] Every device transcript and the 1,800-request oracle stay byte-identical (listed 405 tightenings only)
- [x] routeCoverage derived from the tables (rule 10: OpenAPI and the descriptor `surface` stay in step)
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Progress and corrections (P0-25b)

Verified against the code. Corrections to the brief:

- The core table is `packages/worker/src/publicRoutes.ts` (composition layer: its handlers need `SERVICES`, and Core imports no service). It is keyed by the router's route **kind**, not a path: `router.ts` still decides which kind a path is (it percent-decodes `/devices/<id>` once and answers `badRequest`), and each row carries `surface` (the OpenAPI templates `routeCoverage` now derives `CORE_KIND_PATHS` from), `cors`, `auth` and `handler`.
- The portal table is `PORTAL_ROUTES` in `services/identity/portal/index.ts`; rows are matched with `core/http/routes.ts` `bestRow` (also now used by `serviceRoutes`), and an `accept` that refuses falls through to the next row. `methods` there are documentation, not a gate: every handler keeps its own method policy, so no response changes.
- `CORS_SERVICE_PATHS` and `CORS_CORE_KINDS` are gone from `core/cors.ts`; coverage is `cors: true` on `ServiceRouteDecl` rows (carried out by the descriptor `surface`) and `cors` on the core rows. `isCorsCoveredRoute` and a derived `CORS_SERVICE_PATHS` are exported by `publicRoutes.ts`; the CORS tests changed only in their import path.
- The oracle is `test/publicRouteOracle.test.ts` (3,144 requests, recorded before the move); `test/corsFlags.test.ts` holds the flags to the old list verbatim.
- No 405 tightening, no spec change, no transcript change.
- Not done (named follow-up slice, P0-25b-2): `handlePortalApi`'s own path walk in `portal/api.ts` (CSRF and session gates per route). The brief's "no hand dispatch left in `handlePortal`" holds: `handlePortal` has none.
- The full green gate was not run here (scoped checks only, per the lead); the last box is left for the lead's gate.

## Verify

Each acceptance item's test in its lane, then the full green gate in `AGENTS.md`.

## Hand-off

The role agent sets `--set P0-25b in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P0-25b done`.
