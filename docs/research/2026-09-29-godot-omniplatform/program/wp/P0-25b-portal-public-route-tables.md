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

- [ ] Portal `handlePortal` dispatches from a route table; no hand dispatch left in it
- [ ] Core public routes in `dispatch.ts` dispatch from a table
- [ ] `CORS_SERVICE_PATHS` replaced by a per-row CORS flag; the CORS tests are unchanged
- [ ] Every device transcript and the 1,800-request oracle stay byte-identical (listed 405 tightenings only)
- [ ] routeCoverage derived from the tables (rule 10: OpenAPI and the descriptor `surface` stay in step)
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

Each acceptance item's test in its lane, then the full green gate in `AGENTS.md`.

## Hand-off

The role agent sets `--set P0-25b in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P0-25b done`.
