# P4-02 Release: pack deliverables, `pinned` binding, embedded baselines, `contentApi` on app releases

| Field       | Value                                                                                                                                                     |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | P4: Packs (v1)                                                                                                                                            |
| Size        | 1.5–2 engineer-weeks                                                                                                                                      |
| Depends on  | [P4-01](P4-01-packs-plan.md), [P3-03](P3-03-feed-composition.md), [P4-21](P4-21-packs-wire-core.md)                                                       |
| Unblocks    | [P4-03](P4-03-ci-patch-artifacts.md), [P4-05](P4-05-pack-transports-cdn.md), [P4-09](P4-09-console-pack-views.md), [P4-12](P4-12-compat-resolution.md)    |
| Role        | `pkey-implementer`                                                                                                                                        |
| Plan mode   | no: it executes the approved `program/plans/P4-01.md`; a deviation needs a plan amendment first                                                           |
| Gates       | rule 9 (validator rule + mutation-table entry + JSON schema); D1 migration + `TABLE_OWNERS` (`data-model.mdx`); `validation-codes.mdx` (`docs gen:check`) |
| Human input | none                                                                                                                                                      |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                 |

## Goal

Release knows about packs. A product can declare pack deliverables in `.pkey/release`; the Worker
ingests CI-signed `kind: pack` release records and records their variants and patch artifacts; it
ingests app release records whose `content` block carries `contentApi`, the exact pack releases the
app pins and what each build embeds, and it refuses an app release whose pins break the v1 rules.
Afterwards, "which app releases pin which pack releases" is one query, and distribution, update
and the console read it through release's descriptor hook.

## Why

Packs are release deliverables handled exactly like the app
([README §3.7](../../README.md#37-content-packs-across-release-distribution-and-update),
[CONTENT §3](../../CONTENT.md#3-where-packs-live-across-the-three-services)). v1 ships only the
`pinned` binding and embedded baselines: Diceroll's content-streaming phases 1–2 embed or pin
every pack ([CONTENT §16](../../CONTENT.md#16-phasing-and-effort)), and pinned content is the
deterministic, reviewable end of the trade-off in
[CONTENT §6.1](../../CONTENT.md#61-binding-modes). Stamping `contentApi` on every app release from
day one means P4-12 can resolve `compatible` packs per live level without re-signing history.

## Read first

- `AGENTS.md` (rules 5, 6, 9), the `authoring-pkey-manifests` skill.
- The approved `program/plans/P4-01.md`: it is authoritative for field names, error codes, tables
  and roles. Where this brief and the plan differ, the plan wins.
- [CONTENT §4.2](../../CONTENT.md#42-initial-type-registry), [§6.1](../../CONTENT.md#61-binding-modes),
  [§6.4](../../CONTENT.md#64-publishing-checks-in-both-directions),
  [§6.9](../../CONTENT.md#69-record-and-table-changes), [§9](../../CONTENT.md#9-formats),
  [§11](../../CONTENT.md#11-server-side-by-service);
  [README §3.3](../../README.md#33-trust-model-two-signers-two-documents),
  [§3.4](../../README.md#34-release-the-record-of-everything-that-exists),
  [§3.12](../../README.md#312-what-dicerolls-pkey-would-look-like-illustrative),
  [§11](../../README.md#11-decisions-needed) (decision 1's guardrails).
- The briefs this extends: [P2-03](P2-03-release-data-model.md) (`release_deliverables`,
  `release_builds`, artifact roles, yanks), [P2-04](P2-04-release-descriptor.md) (the
  `deliverables` map in `.pkey/release`), [P3-03](P3-03-feed-composition.md) (release-record ingest).
- Code: `packages/shared-manifest/src/index.ts` (the release block from about line 876),
  `schemas/v1/release.schema.json`, `test/schema-parity.test.ts`;
  `packages/worker/src/services/release/` (`store.ts`, `admin.ts`, `resync.ts` and P3-03's
  ingest); `packages/worker/migrations/`; `packages/docs/scripts/gen-reference.mjs:248`
  (`TABLE_OWNERS`); `packages/worker/src/core/devices.ts:859` (`REPORT_KEYS`);
  `packages/worker/test/boundaries.test.ts`, `test/register.test.ts:624` (report tests).

## Scope

**In:**

- **Manifest (rule 9).** `deliverables.<packId>` with `kind: pack` and P4-01's v1 subset (`type`,
  `binding`, `baseline`, `required`, `delivery`, `handler`, `variants`, `requires.engine`,
  `entitlement`, `contentPolicy.dataOnly`, `patch`), and `deliverables.app.content.contentApi`.
  With P4-01's recommended narrow v1, `binding` accepts only `pinned` and `type` only `godot.pck`
  and `files.tree`. One validator rule, one mutation-table entry and one schema change per rule;
  `products/` fixtures and the skill's field reference updated.
- **Deliverable sync.** Resync writes pack rows into `release_deliverables` (`kind` `pack`,
  `pack_type`, `def_json`, `def_source`), with the operator-ownership guard P0-01 established.
- **Pack record ingest** (extending P3-03's `pkey-release+jws` ingest to `kind: pack`), refusing a
  record whose deliverable is unknown or not a pack, whose `type` differs from the declaration,
  whose `seq` is not above the deliverable's last, whose variants are undeclared, or whose objects
  (full blob, files index, gaps blob, file blobs, delta artifacts) are missing from the blob store
  or differ in size or SHA-256. Stores the record where P3-03 stores app records (proposed
  `release_records`) and writes `release_metadata` (`deliverable_id`, `seq`), `release_builds` per
  variant, `release_artifacts` per object role, and Core blob refs.
- **App record `content` ingest,** enforcing the v1 rules from
  [CONTENT §6.4](../../CONTENT.md#64-publishing-checks-in-both-directions) and P4-01: `contentApi`
  present when the product declares any pack; each pin names an ingested, non-yanked release of a
  declared pack deliverable; where the pinned **record** carries `requires.contentApi.<app>` or
  `requires.packs`, the app's level and the pinned set satisfy them; every `required` and every
  `baseline: embedded` pack is pinned; `embeds` name only pinned packs.
- **Migration** with P4-01's tables and columns. Proposed: `release_pins` (`product`,
  `app_release_id`, `pack_deliverable`, `pack_release_id`, `required`),
  `release_metadata.content_api`, `release_builds.embeds_json`, and the artifact role
  `files-gaps`. `TABLE_OWNERS` entries; regenerated `data-model.mdx` and `validation-codes.mdx`.
- **The release descriptor hook** (README §3.2 calls it `releaseCatalog`, README §10
  `buildCatalog`; use the name P2b-01 landed) gains pack deliverables, pack releases with variants
  and objects, pins and embeds, for P4-05, P4-09 and update.
- **Telemetry key.** `REPORT_KEYS` gains `packSetId` (and `appRelease` if P4-01 keeps it), with a
  test beside `test/register.test.ts:624`.
- **Docs.** A `services/release/packs.md` page (deliverables, bindings, `contentApi`, pins,
  embedded baselines) and the new terms in `start/concepts.md` (README §3.1: "the proposed
  additions go into `start/concepts.md` in the first implementing PR").

**Out** (and where it belongs instead):

- `binding: compatible | standalone` and their resolution, `requires.contentApi` and
  `requires.packs` as manifest rules, `conflicts`, per-pack `channels`, `release_sets`, holds,
  pack floors per `contentApi`, `packChannels` (→ [P4-12](P4-12-compat-resolution.md));
  revocation records (→ P4-13); more pack types (→ [P4-16](P4-16-more-pack-types.md)).
- Transports, availability, byte serving and gated delivery (→ [P4-05](P4-05-pack-transports-cdn.md)).
- Computing patch artifacts and signing records (→ [P4-03](P4-03-ci-patch-artifacts.md)).
- Console views and their admin API (→ [P4-09](P4-09-console-pack-views.md)).
- `provides`/`removes` checks (→ P4-20); server GC of pack objects (→ P4-14).

## Design notes

- **Products are data** (rule 5). No code path may name a pack id, a product or a pack type
  beyond the registry the validator checks. Key every table by deliverable, never by "is a pack"
  (README §11 guardrails).
- **Placement.** Pack logic lives in `services/release/packs/` behind the descriptor hook
  (README §11 guardrail), so a later split stays cheap and P4-12 extends the same module.
  `boundaries.test.ts` allows only `update → release`; distribution reads through the hook.
- **Pins are signed.** The Worker mirrors them into `release_pins` for queries but never edits
  them. A yank of a pinned pack release stops new pins; apps that already pin it keep it until an
  app release replaces it ([CONTENT §6.7](../../CONTENT.md#67-lifecycle-implications) item 6).
- **Bindings in v1.** Only pins deliver in v1, so (per P4-01's recommendation) the validator
  accepts only `binding: pinned`; a product never declares behaviour v1 silently ignores. P4-12
  widens the rule when resolution exists. If the approved plan chose to accept all three values
  now, follow the plan and have the dry run report unpinned packs as "not delivered until P4-12".
- **Refusals are publish failures.** They return a structured error to the submitting CI (the
  same shape P3-03 uses), so `pkey release publish --dry-run` (P4-03) can print them before
  anything is signed.
- **Record size.** Per-file data lives in the hash-pinned files index, so ingest reads the index
  from the blob store (bounded by its recorded `bytes`) to check file blobs; never trust sizes from
  the request body.
- **Migrations** are numbered when rebasing onto the default branch, never in advance (program
  README §5). If P2-03 put a CHECK constraint on `release_artifacts.role`, adding a role needs a
  table rebuild, as `0016_drop_dead_pii.sql` shows.

## Steps

1. Read the approved plan; list its manifest rules, error codes, tables and roles in the PR body.
2. Validator rules, mutation-table entries and schema changes; fixtures; the manifest tests
   green.
3. Migration and `TABLE_OWNERS`; regenerate the reference pages.
4. Pack record ingest, then app `content` ingest, each with positive and negative tests using
   records signed by a test release key (reuse P3-03's fixtures).
5. Extend the descriptor hook; add the report key; write the docs page and glossary terms.

## Acceptance criteria

- [ ] `schema-parity.test.ts` has one mutation per new error code; the completeness sweep passes.
      A pack declared `binding: compatible`, or with a type outside the v1 set, is refused with
      the plan's error code (unless the plan chose to accept it).
- [ ] Worker tests cover: a valid two-variant pack record ingested with every artifact row; each
      refusal listed under Scope (unknown deliverable, wrong type, stale `seq`, undeclared
      variant, missing object, wrong size, wrong SHA-256).
- [ ] Worker tests cover app records: accepted with pins and embeds; refused for a missing
      `contentApi`, a yanked pin, a pin to an unknown release, a pin whose `requires.contentApi`
      excludes the app's level, an unmet `requires.packs`, an unpinned `required` pack, and an
      `embeds` entry that is not pinned.
- [ ] Yanking a pinned pack release leaves existing pins intact and refuses a new pin to it.
- [ ] `release_pins` answers "which app releases pin pack release X" and "what does app release Y
      pin" (tested through the hook).
- [ ] A report carrying `packSetId` stores it; an unknown key is still dropped.
- [ ] `pnpm --filter @polaris-key/docs gen:check` passes (data model and validation codes).
- [ ] The green gate passes, including `test:workerd`.
- [ ] `parity.json` manifests are updated for every SDK this changes (once P1b-01 has landed):
      none, since no SDK changes here.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/manifest test
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- release boundaries register
mise exec node@22 -- pnpm --filter @polaris-key/docs gen:check
mise exec node@22 -- pnpm typecheck
mise exec node@22 -- pnpm --filter @polaris-key/worker test:workerd
```

## Hand-off

P4-05 relies on the hook's pack releases, objects and per-build `embeds`; P4-09 on `release_pins`,
`release_metadata.content_api` and the pack rows in `release_deliverables`; P4-12 extends the same
ingest with holds and resolution. Record the final table, column and role names in the PR
description if they differ from the plan, and amend the plan. Then
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P4-02 done`.

## Plan amendments (P4-01)

The approved [`plans/P4-01.md`](../plans/P4-01.md) changes this package; its §8.4 bullet for this
package, and every decision in §8.1 that names it as owner, override this brief where they differ.

## Corrections from the code (P4-02 implementation)

Recorded while implementing; the plan and the code are right where this brief differs.

- **`products/` fixtures.** No product under `products/` has a `.pkey/release` (`products/djdl`
  is `catalog.json` and `product.json` only), so none changed, as plan §3 says. The pack example
  lives in `schema-parity.test.ts`'s valid base document instead (two packs, `deliverables.app.content`
  and a build's `embeds`).
- **`requires.contentApi` and `requires.packs` at ingest.** The Scope and acceptance rows that
  refuse "a pin whose `requires.contentApi` excludes the app's level" and "an unmet
  `requires.packs`" are P4-12's: plan §2.3 reserves `requires.{contentApi, packs, features}` (v1
  ignores them), §3 refuses them in the manifest (`invalid_pack_requires`), and §6's ingest
  reasons have no such check. The app-content reasons are §6's: `content-api`, `pin-unknown`,
  `pin-mismatch`, `pin-yanked`, `pin-missing`, `pin-gated` and `embeds`.
- **The telemetry key** is `content {packSetId, appRelease?}` (plan §2.11), each member kept only
  when it is 64 lowercase hex.
- **`release_pins`** has `record_sha256` and `delivery` beside the brief's columns (plan §6).
- **Line references.** `REPORT_KEYS` is at `packages/worker/src/core/devices.ts:869` and
  `TABLE_OWNERS` at `packages/docs/scripts/gen-reference.mjs:312`; the migration is
  `0045_pack_deliverables.sql`.
- **A pack release's id** is `<packId>@<version>` (never the record's `tag`), so a pack release
  cannot collide with a GitHub-tagged app release; the plan names no id. Its variants are
  `release_builds` rows with `build_id` the variant key (`default` for none), and its objects'
  `release_artifacts` ids are `<build_id>/<role>[-<n>]`.
- **Check order.** `pack-unknown` is checked before `scheme`, because the scheme is the pack's
  declaration; a different record for an existing pack version is refused as P2-04's
  `release_exists` (409), and the same record again answers `outcome: "unchanged"`.
