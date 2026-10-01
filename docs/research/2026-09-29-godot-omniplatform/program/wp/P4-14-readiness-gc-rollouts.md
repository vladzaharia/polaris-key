# P4-14 Distribution: outlet readiness holds, per-outlet pack rollouts and halts, server GC

| Field       | Value                                                                                                                    |
| ----------- | ------------------------------------------------------------------------------------------------------------------------ |
| Phase       | P4: Packs (v2)                                                                                                           |
| Size        | 1–1.5 engineer-weeks                                                                                                     |
| Depends on  | [P4-12](P4-12-compat-resolution.md), [P2b-04](P2b-04-rollouts-delivery.md), [P4-13](P4-13-revocation-floors-decision.md) |
| Unblocks    | [P4-15](P4-15-console-compat-matrix.md), [P5-08](P5-08-platform-pack-transports.md)                                      |
| Role        | `pkey-implementer`                                                                                                       |
| Plan mode   | no                                                                                                                       |
| Gates       | migration (plus `TABLE_OWNERS` and the generated `data-model.mdx`); rule 10 only if a public route changes               |
| Human input | none                                                                                                                     |
| Repo        | `vladzaharia/polaris-key`                                                                                                |

## Goal

Three things work end to end. (1) Distribution computes `dist_readiness` per (app release,
outlet) from the app's required pack set and the outlet's transport. It keeps the app release off
every outlet Polaris Key controls until the set is available there, and shows the blocker (with a
warning) on store outlets it cannot hold. (2) Pack releases get per-outlet rollouts, pause, resume
and halt through the same `dist_rollouts` machinery as the app, and the feed carries them. (3)
Core's GC deletes blobs, chunk bundles and deltas that no live reference needs, after a grace
period and never before the R2 bucket-lock age.

## Why

An app release must not go live on an outlet before its required packs are available through that
outlet's transport; otherwise it boots without required content
([CONTENT §6.4](../../CONTENT.md#64-publishing-checks-in-both-directions), README decision 19).
Packs roll out and halt per outlet exactly like the app ([README §3.9](../../README.md#39-rollouts-halts-and-telemetry);
[CONTENT §6.8](../../CONTENT.md#68-diceroll-worked-through) row 2). Content-addressed storage
grows forever without GC, and on Apple the asset-pack quotas make retirement routine
([CONTENT §6.7](../../CONTENT.md#67-lifecycle-implications) item 7, [§11](../../CONTENT.md#11-server-side-by-service)).

## Read first

- `AGENTS.md` (rules 5, 6, 10), and [README §3.5](../../README.md#35-storage-and-byte-delivery),
  [§3.8](../../README.md#38-distribution-distribution-service) (`dist_readiness`, `dist_rollouts`,
  `dist_transports`, `dist_availability`) and [§3.9](../../README.md#39-rollouts-halts-and-telemetry).
- [CONTENT §6.4](../../CONTENT.md#64-publishing-checks-in-both-directions),
  [§6.6](../../CONTENT.md#66-transport-imposed-binding-per-outlet),
  [§6.7](../../CONTENT.md#67-lifecycle-implications) items 5 and 7, and
  [§11](../../CONTENT.md#11-server-side-by-service) (GC).
- [notes/E8 §5.7](../../notes/E8-content-delivery.md#57-storage-layout-and-garbage-collection)
  (server GC, bucket locks, repacking).
- The code this builds on: P2-01's blob store (`blob_objects`, `blob_refs`, bucket-lock rules),
  P2b-03's availability records and CI reports, P2b-04's rollouts and halts, P2b-06's
  distribution matrix, P4-05's pack transports and gated delivery, P4-12's hook functions, P3-03's
  feed composer.
- `packages/worker/src/scheduled.ts` (its three properties: product-scoped, idempotent,
  fault-isolated) and the `[triggers]` block in `packages/worker/wrangler.toml`.
- `packages/docs/scripts/gen-reference.mjs` (`TABLE_OWNERS`, ~L248).

## Scope

**In:**

- A migration: `dist_readiness(product, app_release_id, outlet_id, blocking_pack_release_id, state)`
  (README §3.8) and GC bookkeeping on `blob_objects` (for example `unreferenced_since`), with
  `TABLE_OWNERS` updated.
- Readiness computation, its triggers, its effect on the feed and storefront feeds for
  self-hosted outlets, warnings for store outlets, an operator override, and the blockers in the
  admin API and P2b-06's Distribution matrix.
- Pack rollouts and halts per outlet: admin operations, `pkey distribution rollout|halt
--deliverable <packId>`, and the feed composer carrying them.
- Server GC: reference collection through hooks, two-phase mark and sweep from `scheduled.ts`,
  grace period, bucket-lock age, gated prefix, lazy deltas, and a dry-run listing.
- A per-bundle live-data ratio in the admin API, for later repacking.

**Out** (and where it belongs instead):

- Holding a store release through a connector (`PENDING_DEVELOPER_RELEASE`) and retiring old
  `contentApi` asset packs within Apple's quotas (→ [P5-08](P5-08-platform-pack-transports.md),
  with P5-02).
- Rewriting bundles below ~50% live data into the next release's bundles: a CI step with no owner
  yet (see P4-10).
- Auto-halt from telemetry and the update funnel (→ P6-03).
- Generating lazy deltas (→ [P4-17](P4-17-lazy-deltas.md)); this package only collects cold ones.
- The compatibility matrix and simulator (→ [P4-15](P4-15-console-compat-matrix.md)).

## Design notes

- **Required set** of an app release: its record's pins and holds, plus the `required` packs of
  the set for its `contentApi` on each of its channels (P4-12 hooks). Distribution reads release
  through Core descriptor hooks; release never reads distribution.
- **Readiness per transport** (CONTENT §6.4):
  - `embedded`, `play-pad` and `steam-depot` builds are ready by construction;
  - `pkey-cdn` and `web` are ready when every required pack release's objects are published
    (`blob_objects` rows exist);
  - `apple-ba` is ready when the level's asset pack (`<pack>-c<contentApi>`, CONTENT §6.6; hyphen, not dot: notes/S-01) is
    approved. ASC states arrive with P5-02/P5-08; until then, CI-reported availability (P2b-03)
    stands in;
  - `msix-optional` and `flatpak-ext` use CI-reported availability.
- **Holding.** Where Polaris Key is authoritative (self-hosted rollouts: direct downloads,
  sideload sources, the F-Droid relay, web), distribution's `delivery` hook (P2b-01) answers
  "not live" until readiness is `ready`, so neither update's feed nor the storefront feeds offer
  the release there. On store outlets, record the blocker and warn; where Polaris Key cannot hold a release (a
  manual store release) it only warns (CONTENT §6.4).
- **States** (proposed): `pending | blocked | ready | overridden`. An override is operator-owned
  (`*_source` guard, audited) and survives resync, per the operator-ownership model in
  [README §6.2](../../README.md#62-administrator-operator).
- **Triggers:** an app release published or promoted; an availability change for a pack release;
  a transport change for a deliverable or outlet; a set re-resolved by P4-12. Recompute only the
  affected (app release, outlet) rows.
- **Pack rollouts** reuse `dist_rollouts(product, deliverable_id, outlet_id, channel, release_id,
rollout_bp, rollout_salt, state, mirrored, source)` from P2b-04, which is already keyed by
  deliverable. The bucket is evaluated on the device:
  `u32(sha256(salt ‖ installId)[0..4]) mod 10000` (README §3.6). A halt reverts devices to the
  previous set; that is a pack-only rollback (CONTENT §6.7 item 5). The feed field and decision
  row for "outside the bucket, keep the previous release" come from the v4 plan and P4-13. If
  neither has them, stop and route that to P4-13's plan; this package has no corpus gate. Store
  outlets mirror the store's own rollout through connectors (P5-\*), not here.
- **GC is Core's** (CONTENT §11). An object is collectable when:
  - no live app release pins or holds it;
  - no live level's current set resolves to it, nor the previous pointer's set (rollback needs it);
  - no outlet lists it as available;
  - no retained chunk index references it (bundles may be shared across releases, P4-10);
  - it has been unreferenced for the grace period (proposed 30 days, configurable).

  Deltas are disposable caches (E8 §5.7): collect a delta when either endpoint is collectable or
  when P4-17 marks it cold. Telemetry-based retention ("until the installed base has moved on") is
  a later refinement with P6-03.

- **Bucket locks.** README §3.5 puts objects "immutable under R2 bucket locks", and E8 §5.7 uses
  locks as a minimum age. P2-01 locks `blobs/`, `bundles/`, `deltas/` and `gated/` **by age**
  (proposed 180 days) precisely so this GC is possible. A delete before the lock age fails, so
  sweep only objects whose `created_at` is older than the lock rule for their prefix; in practice
  the lock age, not the grace period, bounds how soon anything goes. If a prefix was locked
  indefinitely, GC cannot collect there: escalate instead of weakening the lock.
- **Bookkeeping.** P2-01's tables are `blob_objects(storage_key, sha256, size, kind
blob|bundle|delta, gated, verified_at, created_at)` and `blob_refs(product, storage_key,
ref_kind, ref_id, created_at)`. `blob_refs` rows written at ingest (P2-04, P4-02, P4-10) are
  the per-release references; liveness comes from the hooks, not from the existence of a ref.
- **Sweep mechanics.** Mark `unreferenced_since`; after the grace period, re-check references,
  delete from R2, then delete the row. Keep `scheduled.ts`'s three properties: product-scoped,
  idempotent (a second run deletes nothing new), fault-isolated per product. Batch R2 deletes
  (at most 1,000 keys per call) and cap the work per tick to stay inside CPU and subrequest
  limits; the next tick resumes.
- **Gated prefix** objects (`gated/…`, P2-01's key builders) follow the same rules. Never move an
  object between prefixes.

## Steps

1. Migration, `TABLE_OWNERS`, regenerated `data-model.mdx`.
2. Readiness: computation per transport, triggers, the `delivery`-hook effect, override, admin API
   and matrix blockers.
3. Pack rollouts and halts: admin operations, CLI, feed composition.
4. GC: reference collection through the P4-12 and distribution hooks, mark and sweep in
   `scheduled.ts`, dry-run listing, bundle liveness.
5. Tests and the green gate.

## Acceptance criteria

- [ ] Readiness tests per transport: `embedded` ready at once; `pkey-cdn` ready only after the
      pack's blobs exist; `apple-ba` blocked until CI-reported approval of `foes-c4` (CONTENT
      §6.8 row 1); an override flips the state and is audited.
- [ ] While readiness is `blocked` on the direct outlet, the composed feed and the storefront
      feeds do not offer that app release there; on the App Store outlet the matrix shows the
      blocker and a warning.
- [ ] A pack release at 25% on one outlet appears in that outlet's feed with its rollout; a halt
      removes it; other outlets are unaffected.
- [ ] GC tests: a referenced object is kept; an unreferenced object inside the grace period is
      kept; one past both grace and lock age is deleted from R2 and D1; a delta whose base was
      collected is deleted; a second run deletes nothing; one product's failure does not stop the
      others (`packages/worker/test/scheduled.test.ts`).
- [ ] The migration applies; `TABLE_OWNERS` lists the new table;
      `pnpm --filter @polaris-key/docs gen:check` passes.
- [ ] The green gate passes (`AGENTS.md`), including the workerd smoke job.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- scheduled
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm --filter @polaris-key/worker test:workerd
mise exec node@22 -- pnpm --filter @polaris-key/docs gen:check
```

## Hand-off

- **P5-08** relies on readiness states for `apple-ba` (and on connectors feeding them), on
  per-outlet pack rollouts for store outlets, and on GC honouring platform availability.
- **P4-17** relies on GC collecting lazy deltas it marks cold.
- **P4-15** overlays readiness and liveness from the admin API.

Set the status in the PR that completes the work:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P4-14 done`.
