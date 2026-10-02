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
- The P2-03, P2-04, P3-03 and P4-02 code: release tables (`release_records`, `release_pins`,
  `release_deliverables`, `release_builds`, `release_channel_policy`, `release_yanks`), the
  release descriptor ingest, the publish submit route and its ticket, the `.pkey/release`
  deliverables validator, and P4-03's `pkey release publish --dry-run`.
- `packages/worker/src/services/release/` (today's `channels.ts`, `store.ts`, `admin.ts`),
  `packages/worker/test/boundaries.test.ts`.
- `packages/shared-manifest/src/index.ts` (release section, ~L900–1060),
  `packages/shared-manifest/test/schema-parity.test.ts`,
  `packages/shared-manifest/schemas/v1/release.schema.json`.
- `packages/docs/scripts/gen-reference.mjs` (`TABLE_OWNERS`, ~L248).

## Scope

**In:**

- A pack module `packages/worker/src/services/release/packs/` (README decision 1 guardrail):
  `resolve.ts` (pure), `checks.ts`, `holds.ts` and storage, exposed through the `releaseCatalog`
  descriptor hook (P2b-01; implemented in `services/release/catalog.ts`). P4-02 started this
  module; extend it.
- A migration adding `release_sets`, `release_holds` and pack floors keyed per `contentApi`, with
  `TABLE_OWNERS.release` updated and `data-model.mdx` regenerated.
- Resolution and its triggers; `packSetId`; hold mirroring at app-record ingest.
- The floor operation for pack deliverables takes a `contentApi` (admin API and
  `pkey release` CLI), operator-owned with a `source` guard.
- Publish checks in both directions, and the dry run.
- `.pkey/release` (rule 9): widen P4-02's `binding: pinned`-only rule to
  `compatible | standalone`; add `requires.contentApi` keyed by app deliverable, `requires.packs`,
  `conflicts`, per-pack `channels`, and the app's `content.packChannels` (the record slots
  `holds[]` and `packChannels` were reserved by P3-01 and P4-01).
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
- **`packSetId`** is one function across v1 and v2 (P4-01 decision 11): P4-01 recommends
  lowercase hex SHA-256 of the UTF-8 lines `<packId> <releaseSha256>\n` sorted by pack-id bytes,
  pinned by `packSetIdCases` in the content corpus (P4-04), with the record hash as P3-01 defines
  it (SHA-256 over the ASCII compact JWS). The Worker has `@polaris-key/client-core` only as a
  dev dependency today, so either make it a runtime dependency and import `packSetId` from
  `@polaris-key/client-core/packs`, or compute it in the Worker with WebCrypto and prove it against
  `packSetIdCases` in a Worker test (the Worker already runs `fingerprint.json` the same way).
  Devices compute the id of their _active_ set (pins ∪ holds ∪ the feed's set).
- **Holds** (open point to settle in the PR). `release_sets` is keyed without the app release, so
  a hold cannot live inside a set, yet the research says resolution "honours holds". Proposal:
  devices apply their record's holds over the feed set, as they apply pins (P4-13 adds the
  decision rows), and release (a) mirrors holds into `release_holds` at ingest, the way P4-02
  mirrors pins into `release_pins`, (b) at app
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
- **Dry run.** `pkey release publish --dry-run` exists from P4-03 and prints the structured
  refusals P3-03 and P4-02 return. Extend its report with the before/after sets; prefer a
  `dryRun: true` field on the existing submit call to a new path (a new path is rule 10: OpenAPI +
  `routeCoverage`). The CLI joins release's report with distribution's availability (a separate
  call) to show outlets, so release stays distribution-free.
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
  `packFloors(product, channel)` and `holdsFor(product, appReleaseId)`; `packSetId` as defined
  above.
- **P4-13** composes the feed from these and freezes the wire form of sets, floors and
  `unsatisfied`; it also makes resolution skip revoked releases.
- **P4-14** reads required sets for readiness and live references for GC.
- **P4-15** builds the matrix and simulator on the same functions.
- **P4-20** adds the `provides`/`removes` check next to these checks.
- **D-04** uses bindings, holds, floors and the dry run for Diceroll.

Set the status in the PR that completes the work:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P4-12 done`.

## Corrections from implementation

Where this brief and the code disagreed, the code is the fact; these are the choices the
implementation made, recorded here in the same branch.

- **Pack floors live in their own table.** `release_channel_policy`'s primary key is
  (product, deliverable_id, channel), and every reader and both upserts (`model.ts`,
  `deliverables.ts`, `resolve.ts`, `gateway.ts`) key on that triple. Floors per contentApi line
  are `release_pack_floors(product, deliverable_id, channel, content_api, min_version, source, …)`
  (primary key with `content_api`), operator-owned (`source = 'admin'`). A pack's level-free
  `min_supported` still applies; resolution honours both.
- **Migrations 0046_a and 0046_b.** 0046_a creates `release_sets` (keyed with an `engine`
  column, and with `unsatisfied_json`), `release_set_state` (the per-product generation),
  `release_holds` (with `record_sha256`) and `release_pack_floors`, then adds
  `release_metadata.pack_channels_json` last; 0046_b adds `release_builds.conflicts_json`.
- **Requirements come from the signed record.** A pack release's `requires.contentApi`,
  `requires.packs` and `conflicts` are its record's per-variant reserved members (CONTENT §6.9;
  plans/P4-01.md §2.3 reserved them for P4-12), mirrored into `release_builds` at ingest. The
  `.pkey/release` values are the defaults CI signs. Ingest gains `pack-requires` (the signed
  values against the binding and the declared packs) and `pack-channel` (a channel the pack does
  not publish to). Client-core claims are unchanged: clients still ignore those members.
- **Engine is a selector dimension** (lead decision on review): `release_sets` is keyed by
  (channel, app deliverable, contentApi, platform, engine, variant), `engine` the live builds'
  `requires.engine` (`''` when a build declares none, which constrains nothing). During an engine
  bump each engine keeps its own set (CONTENT §6.8 row 7 as written).
- **Variants are projected per group, not crossed** (lead decision on review). The brief's
  "variant over every pack's axes" multiplies rows across packs (64 packs × 3 axes × 16 values
  measured 28.7 s and 1.9 GB). The resolvable packs are grouped (same axis names, merged across
  `requires.packs` and `conflicts`), each group resolved per combination of its own axes and
  stored as its own row; a device's set is one row per group, the one its variant projects onto.
  Every device still gets exactly the releases a whole-assignment resolution gives it, because no
  constraint crosses a group. P4-13 composes a device's set from one row per group.
- **Per-component semantics** (lead decision, review round 2). Within a row the solver splits the
  packs into components (packs some candidate's `requires.packs` or `conflicts` links) and solves
  each on its own, leaving out as few packs as possible; a pack is dropped only when its own
  component cannot keep it. This replaces "whole assignment" as the reference: it is strictly
  better (an unrelated conflicting pair never costs a satisfiable pack its place).
- **One work budget per resolution.** `MAX_RESOLUTION_WORK` (1,000,000 candidate checks) is
  shared by the whole resolution, not per problem, and charged for grouping, stages, constraint
  building, every pruning probe and range check, the component split and every solver try; stage
  outputs, live levels and solver results are memoised. Adversarial cases spend it, or finish, in
  15–60 ms on Node 22.
- **Fail closed** (lead decision on review). A trigger whose resolution fails clears the
  product's sets, writes an audit row and answers `packSets: {ok: false, reason}`; it never
  refuses the yank, floor change, pointer move or resync. Concurrent triggers are ordered by the
  `release_set_state` generation (a write knows it won from its claim's changed-row count). A
  policy change clears the stored sets inside its own batch, so a crash before the re-resolution
  leaves none stale. A CI publish resolves once: the check's after-state is stored (the stored
  rows are the "before" of the report), and the submit's two plans share a memo; the GitHub sync
  path can resolve twice.
- **`requires.features` stays refused.** No app-side value exists to check it against; this is a
  plan gap, reported rather than invented.
- **Validator codes.** New: `missing_content_api_range`, `standalone_with_content_api`,
  `unknown_content_api_app`, `invalid_pack_conflicts` (conflicts needed a code),
  `invalid_pack_channels` (the app's `content.packChannels`, as proposed) and
  `unknown_pack_channels_target` (also refuses a target channel a matched pack does not publish
  to). A pack's own `channels` list reuses `invalid_channel` with a pack-path mutation.
  `deliverables.app.content.holds` stays refused: holds are chosen per app release at publish.
  The descriptor's `content` accepts `holds` (`{pack, release {sha256, seq, version}, reason?}`,
  never a pinned pack) and `packChannels` (equal to the manifest's), both under
  `invalid_descriptor_content`.
- **P4-02's v1 pin rules narrowed.** Every expected **pinned** pack is pinned; an expected
  compatible or standalone pack needs no pin unless a build embeds it as a baseline; the
  "required means pinned" rule applies to pinned packs (a required compatible pack is checked
  against the resolved sets, `content-unsatisfied`).
- **New ingest reasons** (`release_record_rejected`): `pack-requires`, `pack-channel`,
  `pack-unsatisfiable`, `pack-sets-bound`, `pin-requires`, `hold-unknown`, `hold-mismatch`,
  `hold-yanked`, `hold-binding`, `hold-requires`, `hold-unsatisfiable`, `content-unsatisfied`,
  `pack-channels-conflict`.
- **Hook functions bind the product**, as every `ReleaseCatalog` method does:
  `liveLevels(appDeliverable, channel)`, `packSets(channel)`, `packFloors(channel)`,
  `holdsFor(appReleaseId)`, plus `heldBy(packReleaseId)` for P4-14's live references.
- **The floor operation is the admin API only.** `PUT …/release/channels/{channel}` takes
  `{deliverable, contentApi, minSupported}`. There is no CI floor route today (CI promotes, pins
  and yanks), floors are operator-owned, and a CI route would be a rule-10 change this brief's
  gates exclude, so no `pkey release` floor command was added.
- **The dry run is the Worker's.** The submit (pack and app) answers `packSets`, dry run or
  not; `dryRun: true` writes nothing. P4-03 (the CLI's `--dry-run`) is still `todo`, so printing
  the report, and joining it with Distribution's availability, is P4-03's.
- **Not checked, for want of an input:** the data-only lint result (P4-03 does not exist yet, and
  a pack record has no descriptor), and a `standalone` pack's format version against the app
  (no app-side handler version exists).
- **Console read** is the hook functions; the console view is P4-15's.

## Plan amendment for P4-13

P4-12 changed the shape P4-13 composes the feed from (lead decisions in review; P4-13 freezes the
wire form):

- **One row per group.** `release_sets` holds one row per (channel, app deliverable, contentApi,
  platform, engine, variant), where `variant` is the key over ONE group's axes (packs with the same
  variant axes, merged across `requires.packs` and `conflicts`; `''` for a group without axes) and
  the row lists that group's packs only. `engine` is the live builds' `requires.engine`, `''` when
  they declare none.
- **The device composes from one row per group.** A device's compatible and standalone set is the
  union of, for each group, the row whose variant key is the device's own variant projected onto
  that group's axes, for its channel, contentApi, platform and engine (`''` rows apply to a device
  whose build declared no engine). Its active set id is then client-core's `packSetId` over that
  union plus its pins and holds.
- **Per-component semantics.** Within a row, a pack is left out (`unsatisfied`) only when the packs
  its own dependencies and conflicts link it to cannot keep it; this, not a whole-assignment
  search, is the reference behaviour SDK-side simulators and P4-15's console must reproduce.
