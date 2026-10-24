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
- [x] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Progress and corrections (P0-25b)

Verified against the code. Corrections to the brief:

- The core table is `packages/worker/src/publicRoutes.ts` (composition layer: its handlers need `SERVICES`, and Core imports no service). It is keyed by the router's route **kind**, not a path: `router.ts` still decides which kind a path is (it percent-decodes `/devices/<id>` once and answers `badRequest`), and each row carries `surface` (the OpenAPI templates `routeCoverage` now derives `CORE_KIND_PATHS` from), `cors`, `auth` and `handler`.
- The portal table is `PORTAL_ROUTES` in `services/identity/portal/index.ts`; rows are matched with `core/http/routes.ts` `bestRow` (also now used by `serviceRoutes`), and an `accept` that refuses falls through to the next row. `methods` there are documentation, not a gate: every handler keeps its own method policy, so no response changes.
- `CORS_SERVICE_PATHS` and `CORS_CORE_KINDS` are gone from `core/cors.ts`; coverage is `cors: true` on `ServiceRouteDecl` rows (carried out by the descriptor `surface`) and `cors` on the core rows. `isCorsCoveredRoute` and a derived `CORS_SERVICE_PATHS` are exported by `publicRoutes.ts`; the CORS tests changed only in their import path.
- The oracle is `test/publicRouteOracle.test.ts` (3,144 requests, recorded before the move); `test/corsFlags.test.ts` holds the flags to the old list verbatim.
- No 405 tightening, no spec change, no transcript change.
- Done in the follow-up slice P0-25b-2: `handlePortalApi`'s own path walk is `PORTAL_API_ROUTES` in `portal/api.ts`. Each row names `auth` (`none` | `session`), `csrf` (`change` | `always`) and `sweep` (the per-request licence-link sweep), and the `**` row carries the session and CSRF gate for every path no other row names. `test/portalApiOracle.test.ts` (10,092 requests, recorded from the hand dispatch before the move, with the licence link and session count each request leaves behind) and `test/portalApiRouteTable.test.ts` (path to row, and every row's gates) hold it. The brief's "no hand dispatch left in `handlePortal`" holds: `handlePortal` has none.
- P0-25b.1: the scoped gate passed steps 1-16 (build, gen --check, typecheck, tests, prettier, admin build, assemble, check:links, workerd); the admin e2e step was stopped (no admin file changed).

## Corrections (2026-10-23)

P0-25b.1 merged `integ/next-stage` (7ce6ef45b) into the branches (base 1099323cc, 748 commits behind) and re-recorded both oracles.

- **R1. Already built.** The branches held the whole scope; what was left was a merge-forward.
- **R2. Conflicts.**
  - `core/cors.ts`: the flag design stays and the list stays gone; staging's `Retry-After` in `CORS_EXPOSE_HEADERS` (U-05.14, e4b2fccc0) stays; staging's `"sync"` and `"sync/ops"` list entries moved onto the `SYNC_ROUTES` rows as `cors: true` and into `OLD_CORS_SERVICE_PATHS`.
  - `portal/api.ts`: the table rows take staging's call shapes: device-login start reads its body on POST only (ST-34.5, ec96df392); the `sweep` gate and `handleMe`/`handleCapabilities`/`handleLicenses` use `syncLicenseLinksAndNotify(env, db, accountId, now, noticeOrigin(env, req))` and `handleLicenses(req, env, db, ...)` (LX-27c.3, d6ed41b34).
  - `program/INDEX.md`: regenerated.
- **R3. Semantic drift.** `SYNC_ROUTES` rows carry `cors: true`; `adminDevice` and `adminPasskey` (ST-34.6, ST-30c.5) reach `handleAdmin` unchanged.
- **R4. Scope reading.** "Core public routes" means the product-scoped core kinds; the platform switch stays kind dispatch.
- **R5. Verify** includes the workerd smoke, because dispatch is runtime code.
- **Fixture re-record** (from staging's hand dispatch, both oracle tests copied unchanged). `public-route-oracle.json`: 4,348 to 4,362 rows. `portal-api-oracle.json`: 10,092 rows, 8 changed. Every changed row traces to a staging commit:
  - 14 new `cors .../djdl/sync` and `.../sync/ops` rows: U-05.12, U-05.13 (the sync routes).
  - 115 `access-control-expose-headers` rows gain `Retry-After`: U-05.14 (e4b2fccc0).
  - About 722 HTML 404 rows (body 29,7xx to 30,7xx bytes, style hash): 46f180490 FIX-RC-LOCKER (the Help 404 uses the Locker tab icons).
  - 5 `/docs` rows (CSP script hashes) and the `/docs` bodies: 9a51d9c94 DOCS-CSP (docs inline-script hashes).
  - 12 `.well-known/polaris.json` rows (4,716 to 4,773 bytes): U-05.1, U-05.2 (Cloud Sync in the discovery document).
  - portal API: `GET /api/me/export` and `/api/products/{prod}/export` on the console and customer hosts (8 rows): LX-33.2 (52ee75baa, the implicit Default tier is invisible to customers).

## Verify

Each acceptance item's test in its lane, then the full green gate in `AGENTS.md`.

## Hand-off

The role agent sets `--set P0-25b in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P0-25b done`.
