# P4-15 Console: compatibility matrix and the "what does this device get?" simulator

| Field       | Value                                                                                                                                     |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | P4: Packs (v2)                                                                                                                            |
| Size        | 1–1 engineer-weeks                                                                                                                        |
| Depends on  | [P4-12](P4-12-compat-resolution.md)                                                                                                       |
| Unblocks    | none (milestone: content ships between app releases)                                                                                      |
| Role        | `pkey-implementer`                                                                                                                        |
| Plan mode   | no                                                                                                                                        |
| Gates       | none in the graph; admin API routes are narrative-only in `routeCoverage.test.ts`; console help links are gated by the docs slug manifest |
| Human input | none                                                                                                                                      |
| Repo        | `vladzaharia/polaris-key`                                                                                                                 |

## Goal

The console's Release section gains two read-only views. (1) A **compatibility matrix**: app
releases × pack releases, each cell `pinned`, `held`, `compatible`, `incompatible` or `revoked`
(plus yanked), with the live `contentApi` levels highlighted and per-outlet liveness overlaid. (2)
A **"what does this device get?" simulator**: pick app release × outlet × platform × variant and
see the pack set that device runs, its `packSetId`, each pack's declared and effective binding
with the reason (for example "compatible (pinned by Play Asset Delivery)"), the floors that apply
and any blocker. The simulator calls the same functions that compose the feed; there is no second
implementation.

## Why

Floors, holds, `packChannels`, store lag and transport narrowing interact. Without these views an
operator learns what a device gets only when the device gets it
([README §6.2](../../README.md#62-administrator-operator) item 4;
[CONTENT §6.6](../../CONTENT.md#66-transport-imposed-binding-per-outlet), last paragraph;
[§6.9](../../CONTENT.md#69-record-and-table-changes), console). Support also needs to reproduce any
device's content from `appRelease + packSetId` ([CONTENT §6.7](../../CONTENT.md#67-lifecycle-implications)
item 13). The graph marks this package as the milestone "Content ships between app releases".

## Read first

- `AGENTS.md` (rule 4 terminology; the docs conventions for help links).
- [CONTENT §6.1–§6.9](../../CONTENT.md#61-binding-modes), especially §6.6 and §6.8;
  [README §6.2](../../README.md#62-administrator-operator) items 2 and 4 and the
  operator-ownership model.
- Console: `packages/admin/src/route.ts` (the `release` section and its `items`, ~L166),
  `packages/admin/src/views/Releases.tsx`, `packages/admin/src/lib/docsLinks.ts`,
  `packages/admin/test/releases.test.tsx`, `packages/admin/test/docsLinks.test.ts`, and P4-09's pack
  views.
- Worker admin surfaces: `packages/worker/src/services/release/admin.ts` (dispatch on
  `rest.length === 1`), `packages/worker/src/services/update/admin.ts`,
  `packages/worker/src/admin/api.ts` (session, CSRF and rate-limit gates run there), and the
  `NARRATIVE_ONLY` set in `packages/worker/test/routeCoverage.test.ts`.
- The P4-12 hook functions and, if landed, P4-13's feed composer (narrowing, floors, revocations)
  and P4-14's rollout and readiness data.

## Scope

**In:**

- `GET /manage/api/products/<slug>/release/compat`: matrix data from release alone (app releases
  with level, channel and live flag; pack releases with binding, requirements, yank and revocation
  state; the cell state per pair).
- `GET /manage/api/products/<slug>/update/simulate?appRelease=&outlet=&platform=&variant=`: runs
  update's feed-composition functions for that selector and applies the app record's pins and
  holds; returns the active set, `packSetId`, per-pack declared and effective binding with reason,
  floors, `unsatisfied` markers, rollout state and the decision a fresh device would reach.
- A "Compatibility" tab in the Release section with the matrix and the simulator panel; the
  per-outlet liveness overlay fetched from distribution's availability admin API (P2b-06) and
  joined in the SPA.
- A docs page for both views (proposed `packages/docs/src/content/docs/services/release/compatibility.md`)
  and its help links in `route.ts` and `docsLinks.ts`.

**Out** (and where it belongs instead):

- Readiness blockers in the Distribution matrix (→ [P4-14](P4-14-readiness-gc-rollouts.md)).
- Editing floors, holds or yanks from the matrix: link to the existing controls (P2-07, P4-12).
- Pinning one device or a cohort to a set (CONTENT §6.7 item 13): not scheduled.

## Design notes

- **Cell states.**
  - `pinned`: the app record pins that pack release.
  - `held`: the app record holds it.
  - `compatible`: the pack release's `requires.contentApi.<app>` contains the app's level and its
    engine requirement holds. Mark the release that is the current set member distinctly.
  - `incompatible`: otherwise.
  - `revoked`: a `kind: revocation` record names it (P4-13). Render it when the API returns it;
    before P4-13 lands the API never does.
  - Yanked is shown as a modifier, not a separate state.
- **Live levels** come from P4-12's live-app computation (floor-based), so the highlighted levels
  match what the feed carries.
- **Liveness overlay.** Which outlets currently serve each app release comes from distribution's
  availability. Fetch it separately and overlay in the SPA, so release's endpoint stays
  distribution-free (CONTENT §6.3: release never reads distribution).
- **The simulator lives under update's admin surface** because update may import release and
  reads distribution through hooks. It must call the functions the feed composer calls. The test
  for that: for a fixture, the simulator's `packSetId` equals the one `client-core` computes from
  the composed feed for the same selector.
- **Before P4-13 and P4-14 land**, narrowing, revocations and pack rollouts are absent. Show the
  declared binding and say "effective binding not yet available" rather than guessing. The graph
  has P4-15 depend only on P4-12; see the report on adding P4-13 and P4-14.
- **Size.** Show live app releases plus the last N (default 10) per channel, and live pack releases
  plus the last N per deliverable; paginate the rest.
- **Terminology** (rule 4): device, product, tier. Help links live in exactly two tables and are
  gated against the built slug manifest; a new page means updating both in the same change.

## Steps

1. Release's `compat` endpoint over the P4-12 hooks, with Worker tests.
2. Update's `simulate` endpoint over the feed composer, with the equivalence test.
3. The Compatibility tab: matrix, simulator form and result, liveness overlay.
4. The docs page and help links; the green gate.

## Acceptance criteria

- [ ] Worker tests build the CONTENT §6.8 row 1 fixture (App Store serves 1.4 at level 3, direct
      and Play serve 1.5 at level 4; `diceroll.foes` 1.x and 2.x). The `compat` endpoint returns
      the expected cell states and live levels {3, 4}; `simulate` returns different sets for 1.4
      and 1.5.
- [ ] `simulate` for an outlet whose transport is `play-pad` reports the pack's effective binding
      as pinned with the transport as the reason (once P4-13 has landed; until then, the declared
      binding and the "not yet available" note).
- [ ] An equivalence test shows the simulator's `packSetId` equals `client-core`'s for the same
      composed feed and selector.
- [ ] `packages/admin/test/` covers rendering every cell state, the simulator form and result, and
      the liveness overlay; `docsLinks.test.ts` passes with the new page.
- [ ] The green gate passes (`AGENTS.md`), including `pnpm --filter @polaris-key/admin build` and
      `pnpm --filter @polaris-key/docs check:links`.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- admin
mise exec node@22 -- pnpm --filter @polaris-key/admin test
mise exec node@22 -- pnpm --filter @polaris-key/admin build
mise exec node@22 -- pnpm --filter @polaris-key/docs build
mise exec node@22 -- pnpm --filter @polaris-key/docs check:links
```

## Hand-off

- **D-04** uses the simulator to validate Diceroll's bindings, holds and floors before release.
- Support uses `simulate` with a device's reported `appRelease + packSetId` to reproduce its
  content; the endpoint's response shape is the contract for any later support tooling.

Set the status in the PR that completes the work:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P4-15 done`.
