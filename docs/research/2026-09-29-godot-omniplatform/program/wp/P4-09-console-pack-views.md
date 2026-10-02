# P4-09 Console: pack deliverables and releases, and which app releases pin which packs

| Field       | Value                                                                                                       |
| ----------- | ----------------------------------------------------------------------------------------------------------- |
| Phase       | P4: Packs (v1)                                                                                              |
| Size        | 0.5 engineer-weeks                                                                                          |
| Depends on  | [P4-02](P4-02-pack-deliverables.md), [P2-07](P2-07-console-builds.md)                                       |
| Unblocks    | none                                                                                                        |
| Role        | `pkey-implementer`                                                                                          |
| Plan mode   | no                                                                                                          |
| Gates       | admin tests and build; console help links against the built slug manifest (`docsLinks`, `docs check:links`) |
| Human input | none                                                                                                        |
| Repo        | `vladzaharia/polaris-key`                                                                                   |

## Goal

An operator sees packs where the app already appears, in the Release section. A deliverables list
shows the app and every pack with kind, type, binding, required, baseline, delivery, entitlement
and latest release. A pack deliverable's page lists its releases (version, `seq`, variants, payload
and full-download sizes, delta menu, yanked) and, for each release, **which app releases pin it**.
An app release's page shows its `contentApi`, its pins and what each build embeds. Everything is
read-only in v1 and comes from P4-02's tables through a small admin read API.

## Why

"No separate content section: packs appear wherever the app does"
([CONTENT §14](../../CONTENT.md#14-experiences);
[README §6.2 item 4](../../README.md#62-administrator-operator)). With only the `pinned` binding in
v1, the operator's key question is "which app release carries which pack release", for example
before yanking a pack release (a yank never changes existing pins,
[CONTENT §6.7](../../CONTENT.md#67-lifecycle-implications) item 6) or when a player's diagnostics
name an app release and a `packSetId`.

## Read first

- `AGENTS.md` ("Conventions when writing docs pages": console help links live in exactly two
  tables and are gated against the built slug manifest).
- [README §6.2](../../README.md#62-administrator-operator) item 4;
  [CONTENT §6.9](../../CONTENT.md#69-record-and-table-changes) ("Console").
- [P4-02](P4-02-pack-deliverables.md) (tables: `release_deliverables` pack rows, `release_pins`,
  `release_metadata.content_api`, `release_builds.embeds_json`, or the names the plan settled) and
  [P2-07](P2-07-console-builds.md) (the builds and channels view this extends).
- Code: `packages/admin/src/views/Releases.tsx`, `views/releases/`, `src/api.ts` (release truth
  store DTOs near line 382, calls near line 790), `src/route.ts` (the `release` section near line
  166), `src/lib/docsLinks.ts`, `packages/admin/test/`;
  `packages/worker/src/services/release/admin.ts` (`handleReleaseAdmin`, the
  `/manage/api/products/<slug>/release/*` surface), `packages/worker/test/admin.test.ts`,
  `packages/worker/test/docsLinks.test.ts`.

## Scope

**In:**

- **Admin read API** in `services/release/admin.ts` (proposed paths):
  `GET …/release/deliverables`, `GET …/release/deliverables/<id>/releases` (with variants, object
  sizes, delta menu, yanked and "pinned by"), and `contentApi`, pins and per-build embeds on the
  existing app release payload. Same session, CSRF and platform-admin gates as today.
- **Views**: a Deliverables list (a new Release-section tab, proposed label "Deliverables"), a pack
  deliverable detail with its releases and "pinned by", and the app release additions.
- A pack deliverable that no app release pins is flagged "not pinned by any app release", since
  in v1 only pins deliver (P4-02).
- The tab's help link in `route.ts` and `lib/docsLinks.ts`, pointing at the
  `services/release/packs/` page P4-02 wrote.
- Admin and Worker tests.

**Out** (and where it belongs instead):

- The compatibility matrix (app releases × pack releases: pinned, held, compatible, incompatible,
  revoked) and the "what does this device get?" simulator (→ [P4-15](P4-15-console-compat-matrix.md)).
- Pack rows in the Distribution matrix, transport states and readiness blockers (→ P4-14;
  platform transport states → P5-08).
- Update-health views: plan strategies, hot delta pairs, fallback rates (→ P6-03).
- Any write control (promote, pin, yank for packs): the existing channel-policy controls apply
  per deliverable once P2-07's view handles deliverables generically.

## Design notes

- **Admin routes are narrative-only** in `routeCoverage.test.ts` (`adminApi` is in
  `NARRATIVE_ONLY`), so no OpenAPI entry is needed; the docs page describes them.
- **Never name a product, pack id or pack type in code** (rule 5): render whatever the tables hold.
  Pack types and bindings are plain strings from the registry.
- **Sizes**: show payload size and full-download bytes, and the per-strategy bytes from the delta
  menu where the record gives them; do not compute dedupe ratios the record does not carry.
- **Terminology** from `start/concepts.md`: "pack", "deliverable", "binding", "pin", "embedded
  baseline". Do not call the app a "product" or a pack a "bundle" (the offline bundle owns that
  word, [CONTENT §2](../../CONTENT.md#2-vocabulary)).
- A help link to a page that does not exist fails `docsLinks.test.ts`; P4-02 writes the page first.

## Steps

1. Admin read endpoints with Worker tests (empty product, app only, app plus two packs with pins).
2. DTOs and calls in `api.ts`.
3. The Deliverables tab, the pack detail and the app release additions, reusing P2-07's
   components.
4. Help links in both tables; admin tests; build.

## Acceptance criteria

- [ ] For a fixture product with an app and two packs, the Deliverables tab lists all three with
      their kind, type, binding and required flags.
- [ ] A pack release shows every app release that pins it; an app release shows its
      `contentApi`, its pins and each build's embeds (admin test with a mocked API).
- [ ] A yanked pack release still shows the app releases that pin it, marked yanked.
- [ ] A pack deliverable with no pins shows the "not pinned by any app release" flag.
- [ ] `docsLinks.test.ts` and `pnpm --filter @polaris-key/docs check:links` pass.
- [ ] The green gate passes, including `pnpm --filter @polaris-key/admin build` and
      `pnpm --filter @polaris-key/worker assemble`.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- admin docsLinks
mise exec node@22 -- pnpm --filter @polaris-key/admin test
mise exec node@22 -- pnpm --filter @polaris-key/admin build
mise exec node@22 -- pnpm --filter @polaris-key/docs build
mise exec node@22 -- pnpm --filter @polaris-key/docs check:links
```

## Hand-off

P4-15 builds the compatibility matrix and simulator on the same admin API and deliverable pages;
P4-14 adds per-outlet pack state. Then
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P4-09 done`.

## Plan amendments (P4-01)

The approved [`plans/P4-01.md`](../plans/P4-01.md) changes this package; its §8.4 bullet for this
package, and every decision in §8.1 that names it as owner, override this brief where they differ.

## Corrections from implementation

- **Data source.** The views read Release's own `releaseCatalog` hook (`deliverables`, `releases`,
  `packDeliverables`, `packRelease`, `packFiles`, `pinnedBy`) through `ctx.hooks`, plus one
  product-wide query each over `release_pins` (pin counts, and every app release's pins with the
  pinned release's version) where the hook answers one release at a time. The read model lives in
  `services/release/packs/adminView.ts`; `admin.ts` only routes.
- **Routes as built** (all `GET`, narrative-only, documented on `services/release/packs.md` and
  the operator table on `services/release/channels.md`): `…/release/deliverables`,
  `…/release/deliverables/<id>/releases` (at most 100 releases, newest first) and, per the P4-01
  §8.4 amendment ("files through `packFiles`, one index per request"),
  `…/release/deliverables/<id>/releases/<releaseId>/files?variant=<key>` (at most 2,000 files with
  a `total`). The variant key rides in the query because the unvaried key is `""`. `GET
…/release/releases` gains `contentApi`, `pins[]` and `builds[].embeds`.
- **Gate beside the signed entitlement.** Per the §8.4 amendment, the deliverables row carries
  `gate` (`delivery.entitlement`) and `latest.entitlement` (the latest pack record's); the console
  shows both when they differ. `gateKnown` is false while Distribution is off, so an unknown gate
  is not shown as "ungated".
- **No object keys.** No response names an object's blob-store key (a gated pack's `gated/`
  path); only sizes, codecs and hashes.
- **The pack page is a route leaf**, `#/p/<slug>/deliverables/<id>` (`Leaf` in `route.ts`, with
  `LEAF_PARENT` generalised), so a pack's page deep-links like a license or profile.
- **Worker tests** live in `test/packs.test.ts` ("console pack views (P4-09)"), not
  `test/admin.test.ts`: that file holds P4-02's pack fixtures (staging, signed records, pins). The
  shared `admin()` helper in `test/releaseRoutesFixture.ts` now passes the pathname without the
  query to `handleAdmin`, as the router does.
- **P4-12 was not on main** when the views were written: no pack sets, holds or floors are shown (follow-up).
- **Bounded reads (review).** A pack page reads its records with `packReleasesMany` (a chunked
  `IN` helper in `packs/catalog.ts`, sharing `packRelease`'s row mapping) and its pins with P4-05's
  `pinnedByMany`, grouped by pack release; a 100-release page takes 12 queries (the test's ceiling
  is 16). The app releases' pins are read for the listed app release ids only, in chunked `IN`s.
- **P4-12 landed during the final merge.** The "not pinned by any app release" flag now applies
  to `pinned` packs only (and to a pack whose declaration does not read back); a compatible or
  standalone pack with no pins reads "none (resolved sets)". Showing pack sets, holds and floors
  is still a follow-up.
