# P4-12 Release: `compatible`/`standalone` resolution per live `contentApi`, holds, floors, publish checks

| Field       | Value                                                                                                                                                                                                          |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | P4: Packs (v2)                                                                                                                                                                                                 |
| Size        | 1.5–2 engineer-weeks                                                                                                                                                                                           |
| Depends on  | [P4-02](P4-02-pack-deliverables.md)                                                                                                                                                                            |
| Unblocks    | [P4-13](P4-13-revocation-floors-decision.md), [P4-14](P4-14-readiness-gc-rollouts.md), [P4-15](P4-15-console-compat-matrix.md), [P4-20](P4-20-save-compat.md), [D-04](D-04-diceroll-after-p4.md)               |
| Role        | `pkey-implementer`                                                                                                                                                                                             |
| Plan mode   | no                                                                                                                                                                                                             |
| Gates       | migration (plus `TABLE_OWNERS` and the generated `data-model.mdx`); rule 9 (validator rule, mutation-table entry, JSON schema, generated `validation-codes.mdx`); rule 10 only if the dry run needs a new path |
| Human input | none                                                                                                                                                                                                           |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                      |

## Goal

On every publish, pointer move, floor change or yank, release resolves one **pack set** per
(channel, app deliverable, live `contentApi`, platform, variant) over `compatible` and
`standalone` packs. It stores each set in `release_sets` with a content-addressed `packSetId`,
mirrors holds from signed app records into `release_holds`, keeps pack floors per `contentApi`
line, and runs the two-way publish checks. `pkey release publish --dry-run` shows the resulting
sets and which app releases receive them. An unsatisfiable publish fails with the selector and
the unmet constraint.

## Why

Content ships between app releases only if `compatible` packs are resolved for every
`contentApi` level that is still live; during store lag several levels are live at once
([CONTENT §6.3](../../CONTENT.md#63-resolution-what-the-server-computes),
[§6.8](../../CONTENT.md#68-diceroll-worked-through) row 1). Pack floors per level let a fix be
backported to an older content line (README decisions 18 and 19). The server resolves and the
client only verifies (CONTENT principle 5), so this logic exists once, here. P4-02 shipped
deliverables, `pinned` packs and `contentApi` on app records; this adds the other two bindings.

## Read first

- `AGENTS.md` (rules 5, 6, 9), and the `authoring-pkey-manifests` skill.
- [CONTENT §6.1–§6.5](../../CONTENT.md#61-binding-modes), [§6.7](../../CONTENT.md#67-lifecycle-implications)
  items 3–4, [§6.8](../../CONTENT.md#68-diceroll-worked-through) and
  [§6.9](../../CONTENT.md#69-record-and-table-changes).
- [README §3.4](../../README.md#34-release-the-record-of-everything-that-exists) (schema,
  resolution rules, publish checks), [§3.7](../../README.md#37-content-packs-across-release-distribution-and-update),
  [§3.12](../../README.md#312-what-dicerolls-pkey-would-look-like-illustrative) (illustrative
  `.pkey/release`), and [§11](../../README.md#11-decisions-needed) decisions 1 (guardrails),
  13, 18 and 19.
- The P2-03, P2-04 and P4-02 code: release tables (`release_deliverables`, `release_builds`,
  `release_channel_policy`, `release_yanks`), the release descriptor ingest, the publish submit
  route and its ticket, the `.pkey/release` deliverables validator.
- `packages/worker/src/services/release/` (today's `channels.ts`, `store.ts`, `admin.ts`),
  `packages/worker/test/boundaries.test.ts`.
- `packages/shared-manifest/src/index.ts` (release section, ~L900–1060),
  `packages/shared-manifest/test/schema-parity.test.ts`,
  `packages/shared-manifest/schemas/v1/release.schema.json`.
- `packages/docs/scripts/gen-reference.mjs` (`TABLE_OWNERS`, ~L248).

## Scope

**In:**

- A pack module `packages/worker/src/services/release/packs/` (README decision 1 guardrail):
  `resolve.ts` (pure), `checks.ts`, `holds.ts` and storage, behind the `releaseCatalog` hook.
- A migration adding `release_sets`, `release_holds` and pack floors keyed per `contentApi`, with
  `TABLE_OWNERS.release` updated and `data-model.mdx` regenerated.
- Resolution and its triggers; `packSetId`; hold mirroring at app-record ingest.
- The floor operation for pack deliverables takes a `contentApi` (admin API and
  `pkey release` CLI), operator-owned with a `source` guard.
- Publish checks in both directions, and the dry run.
- `.pkey/release` (rule 9): `binding: compatible | standalone`, `requires.contentApi` keyed by app
  deliverable, `requires.packs`, `conflicts`, per-pack `channels`, and the app's
  `content.packChannels`.
- Hook functions update, distribution and the console read (see Hand-off).

**Out** (and where it belongs instead):

- Putting sets, floors, revocations and per-outlet narrowing into the feed, and the client
  decision (→ [P4-13](P4-13-revocation-floors-decision.md)); `kind: revocation` records (→ P4-13).
- Outlet readiness, pack rollouts, GC (→ [P4-14](P4-14-readiness-gc-rollouts.md)).
- The console matrix and simulator (→ [P4-15](P4-15-console-compat-matrix.md)).
- The `provides`/`removes` check, although CONTENT §6.4 lists it with the pack checks
  (→ [P4-20](P4-20-save-compat.md)).
- Named contracts (`contracts: {scenes: 4, balance: 7}`, CONTENT §6.2): not scheduled.

## Design notes

- **Live app releases**: every non-yanked app release at or above its channel's floor, per app
  deliverable and channel, honouring `includes` (beta ⊇ stable). The floor decides, not store
  availability. **Release never reads distribution**, which keeps the chain
  release ← distribution ← update one-way (CONTENT §6.3 step 1).
- **Resolution** for each selector (CONTENT §6.3 step 3): per pack, the highest release by the
  deliverable's version scheme, ties broken by `seq`, that satisfies `requires.contentApi.<app>`
  (the range contains the level), `requires.engine` (against the app release's engine for that
  platform), `requires.packs`, `conflicts`, the pack floor for (deliverable, channel, level), yanks
  (a yanked release resolves only by explicit pin), channel `includes` and the `packChannels`
  mapping. `standalone` packs ignore `contentApi` and appear in every level's set; engine and
  format requirements still apply. `pinned` packs never enter a set.
- **Solver.** Greedy highest-first per pack with backtracking on dependency or conflict failure,
  in a deterministic order (pack id bytes). Products have tens of packs and hundreds of releases;
  bound the search and fail with a clear error if the bound is hit. Keep it a pure function with
  table-driven tests.
- **Unsatisfiable selectors.** A publish that leaves a selector unsatisfiable fails. A floor change
  or yank must not be refused for that reason, because "a floor with no backport" is how an
  operator deliberately blocks old content lines (CONTENT §6.8, last row). Store such a set with a
  marker, proposed `unsatisfied: [{pack, reason: "content-floor" | "dependency" | …}]`, so P4-13 can
  produce `blocked(content-floor)`. P4-13 freezes the wire form.
- **Selectors and variants.** Platforms come from the live app releases' builds; variants from the
  packs' variant axes (texture, locale, quality). Propose a canonical variant key such as
  `locale=fr;texture=astc` (axes sorted). Identical sets for different selectors share a
  `packSetId`, so the feed can deduplicate.
- **`packSetId`**: if P4-01 fixed the formula (v1 reports it in telemetry), use it. Otherwise
  propose lowercase hex SHA-256 of the canonical JSON array `[[packId, releaseRecordSha256], …]`
  sorted by `packId` bytes, without whitespace. Devices compute the id of their _active_ set (pins
  ∪ holds ∪ the feed's set) with the same function, so it is wire-visible and P4-13 pins it in
  the corpus. One implementation, exported for reuse.
- **Holds** (open point to settle in the PR). `release_sets` is keyed without the app release, so
  a hold cannot live inside a set, yet the research says resolution "honours holds". Proposal:
  devices apply their record's holds over the feed set, as they apply pins (P4-13 adds the
  decision rows), and release (a) mirrors holds into `release_holds` at ingest, (b) at app
  publish, checks that the level's set with each hold substituted still satisfies dependencies and
  conflicts, (c) at pack publish, refuses a release that would make any live app release's held set
  unsatisfiable, and (d) exposes held releases as live references for GC.
- **`packChannels`** (open point). The mapping is stamped into each app record
  (`content.packChannels`, README §3.12) but sets are keyed per (channel, level). Proposal: an app
  publish fails if its mapping differs from another live app release with the same channel, app
  deliverable and level, so a mapping change needs a `contentApi` bump.
- **Tables** (README §3.4):
  - `release_sets(product, channel, app_deliverable, content_api, platform, variant, pack_set_id, set_json, resolved_at)`;
  - `release_holds(product, app_release_id, pack_deliverable, pack_release_id, reason)`;
  - floors keyed per (deliverable, channel, `contentApi`) in `release_channel_policy`
    (CONTENT §6.9). P2-03 creates that table per (deliverable, channel). Add a nullable
    `content_api` (NULL for apps and level-independent floors) with a unique index on
    `(product, deliverable_id, channel, COALESCE(content_api, -1))`. If P2-03 made the triple the
    primary key, rebuild the table with the `_v2` → copy → drop → rename pattern the migrations
    already use (and that `gen-reference.mjs` replays).
  - Key every table by deliverable, never by "is a pack" (decision 1 guardrail). Number the
    migration when rebasing, never in advance.
- **Triggers and cost.** Re-resolve in the request that publishes, moves a pointer, yanks or
  changes a floor. Replace a channel's rows in one D1 batch so readers never see half a set. It is
  pure computation over D1 rows; keep it inside the Worker CPU budget with a test at a realistic
  size (say 20 packs × 200 releases × 3 levels × 6 platforms).
- **Publish checks** (CONTENT §6.4, README §3.4):
  - _Pack release_: for every live level in its declared range, re-resolve the would-be sets; fail
    on unsatisfied dependencies, a missing variant for a live platform, or the data-only violation
    CI reported (P4-03's lint result in the descriptor).
  - _App release_: pins and holds reference existing, non-yanked releases whose requirements the app
    satisfies; every `required` compatible pack has at least one compatible release on each of the
    app's channels.
  - Both report the resulting sets and the app releases that receive them.
- **Dry run.** Prefer a `dryRun: true` field on the existing submit call (P2-02, P2-06) to a new
  path; if a new path is unavoidable, it is rule 10 (OpenAPI + `routeCoverage`). The CLI joins
  release's report with distribution's availability (a separate call) to show outlets, so release
  stays distribution-free.
- **Rule 9.** Each new validator error code needs a mutation-table entry and a schema change.
  Proposed codes: `invalid_pack_binding`; `missing_content_api_range` (a `compatible` pack without
  `requires.contentApi`); `standalone_with_content_api`; `unknown_content_api_app` (a key that is
  not an app deliverable, validator-only: `schema: "accepts"`); `invalid_pack_channels` (pattern:
  a pack id or a prefix ending in `.*`, mapped to a channel name); `unknown_pack_channels_target`
  (a pattern matching no declared pack, validator-only). Update the authoring skill and
  `packages/docs/src/content/docs/build/manifest/authoring.md`.
- **Boundaries** (rule 6): update may import release; distribution and Core read release through
  hooks; nothing else imports `services/release/packs/`.

## Steps

1. Write the pure resolver and its table tests first (the §6.8 scenarios below).
2. Add the migration, `TABLE_OWNERS` entries and store functions; regenerate `data-model.mdx`.
3. Wire the triggers (publish, pointer move, yank, floor change) and hold mirroring.
4. Add the publish checks and the dry run; extend the floor operation with `contentApi`.
5. Add the manifest fields with validator rules, mutation-table entries and schema; regenerate
   `validation-codes.mdx`.
6. Expose the hook functions; run the green gate.

## Acceptance criteria

- [ ] Pure resolver tests cover: live levels {3, 4} with `diceroll.foes` 1.x (requires 3) and 2.x
      (requires 4) giving two sets (CONTENT §6.8 row 1); a floor "≥ 1.3.4 for contentApi 3"
      selecting the backport (row 3); a `standalone` `l10n.table` pack in every level's set
      (row 5); an engine bump failing until pack releases for the new engine exist (row 7);
      `includes` fallback; ties by `seq`; yanked releases excluded unless pinned; a hold whose
      substitution breaks a dependency failing the app publish; `packChannels` routing
      `diceroll.events.*` to `events`; the same input giving the same `packSetId`.
- [ ] An unsatisfiable floor change succeeds and stores the `unsatisfied` marker; an
      unsatisfiable pack publish fails with the selector and constraint in the error.
- [ ] Worker tests: a pack publish writes `release_sets`; a floor change, a pointer move and a
      yank each re-resolve; an app publish mirrors holds into `release_holds`; a dry run writes
      nothing and returns the report.
- [ ] The migration applies on a fresh and on a migrated database; `TABLE_OWNERS` lists the new
      tables; `pnpm --filter @polaris-key/docs gen:check` passes.
- [ ] `packages/shared-manifest/test/schema-parity.test.ts` passes with a mutation entry per new code.
- [ ] `packages/worker/test/boundaries.test.ts` passes.
- [ ] The green gate passes (`AGENTS.md`).

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- release
mise exec node@22 -- pnpm --filter @polaris-key/manifest test
mise exec node@22 -- pnpm --filter @polaris-key/docs gen:check
mise exec node@22 -- pnpm typecheck
```

## Hand-off

Downstream packages rely on these names (propose, then keep):

- `releaseCatalog` hook functions: `liveLevels(product, appDeliverable, channel)`,
  `packSets(product, channel)` (rows of `release_sets` with `set_json` and `unsatisfied`),
  `packFloors(product, channel)`, `holdsFor(product, appReleaseId)`, and the shared
  `packSetId(entries)` function.
- **P4-13** composes the feed from these and freezes the wire form of sets, floors and
  `unsatisfied`; it also makes resolution skip revoked releases.
- **P4-14** reads required sets for readiness and live references for GC.
- **P4-15** builds the matrix and simulator on the same functions.
- **P4-20** adds the `provides`/`removes` check next to these checks.
- **D-04** uses bindings, holds, floors and the dry run for Diceroll.

Set the status in the PR that completes the work:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P4-12 done`.
