# A-18b Shared listing model: `dist_listing*` tables, per-store projection and fit report, per-locale release notes

| Field       | Value                                                                                                                                                                                                                                                                                                                                           |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | A: Admin: store provisioning (storefronts)                                                                                                                                                                                                                                                                                                      |
| Size        | 1–2 engineer-weeks                                                                                                                                                                                                                                                                                                                              |
| Depends on  | [A-18a](A-18a-storefront-adapter-layer.md)                                                                                                                                                                                                                                                                                                      |
| Unblocks    | [A-18c](A-18c-listing-import.md), [A-18d](A-18d-listing-asset-derivation.md), [A-18e](A-18e-play-adapter.md), [A-18f](A-18f-msstore-adapter.md), [A-18h](A-18h-ci-plane-adapters.md), [A-18i](A-18i-pr-plane-generators.md), [A-18j](A-18j-console-storefronts.md), [A-18m](A-18m-apple-listing-push.md), [PS-01](PS-01-polaris-key-adapter.md) |
| Role        | `pkey-implementer`                                                                                                                                                                                                                                                                                                                              |
| Plan mode   | no: Distribution tables, not a manifest or signed document                                                                                                                                                                                                                                                                                      |
| Gates       | D1 migration and `TABLE_OWNERS`; rule 10 (narrative-only admin routes, `NARRATIVE_ONLY`); feeds golden files unchanged for manifest-only products                                                                                                                                                                                               |
| Human input | none                                                                                                                                                                                                                                                                                                                                            |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                                                                                                       |

## Goal

Each product has one listing, entered once or imported, from which every store's listing is
projected. The five `dist_listing*` tables exist with validators. Each adapter's `ListingProfile`
projects the model to a payload or a list of `{field, locale, limit, actual}` issues, never a
silent truncation, and the fit report aggregates them per store. Per-release, per-locale store
notes exist with a 500-character short form. AltStore and Obtainium feeds read the model and fall
back to `.pkey/distribution` `listing`.

## Why

Every store asks for the same name, descriptions, URLs, art and notes at different lengths. S-15
found about 70 % of it already exists somewhere (§2, §7.2). A model stored once, with per-store
projections, is what makes "Add to storefronts" a review rather than data entry
([S-15 §7](../../notes/S-15-storefront-provisioning.md#7-the-shared-listing-model)).

## Read first

- [notes/S-15](../../notes/S-15-storefront-provisioning.md) §5.5, **§7.1–§7.3**, §7.5, §11
  (A-18b and the A-17d change).
- A-18a's `core/storefront/adapter.ts` (`ListingProfile`).
- `packages/worker/migrations/0007_backend_contracts.sql` (`release_metadata.notes`),
  `services/release/{descriptor,changelog}.ts`.
- `packages/shared-manifest/src/distribution.ts` and its schema (`listing`); the AltStore and
  Obtainium renderers under `services/distribution/feeds/`.

## Scope

**In:**

- Tables, exactly as named in S-15 §7.1: `dist_listings`, `dist_listing_locales`,
  `dist_listing_assets`, `dist_listing_release_notes`, `dist_listing_overrides`. Operator-owned,
  audited, with `source = 'admin' | 'import'`. `TABLE_OWNERS`: Distribution.
- Validators for every field's model limit (name ≤ 30, subtitle ≤ 30, short description ≤ 78,
  description ≤ 4,000, features 20 × 200, promotional text ≤ 170, release-notes short ≤ 500) and
  the asset slot list with `textAllowed: none | title | free`.
- The projection: one `ListingProfile` per store with S-15 §7.3's column (Apple, Play, Microsoft,
  Steam, Flathub, Snap, winget, F-Droid), per-store keyword packing, and the fit report (green,
  amber warn, red blocks).
- Per-locale store notes defaulting from `release_metadata.notes` with markdown stripped
  (`release/changelog.ts`), plus a proposed sentence-boundary cut to 500 shown for edit.
- Import from `.pkey/distribution` `listing` (the other sources are A-18c).
- AltStore and Obtainium renderers read the model, falling back to the manifest's `listing`.
- Admin API (product-scoped, narrative-only): read, update, overrides, release notes, fit report.
  Audit rows; the `D/admin/*` narrative.
- **Retrofit A-17d** if it landed first: its `whatsNew` reads `dist_listing_release_notes`, and its
  preflight adds the Apple fit report (S-15 §11).

**Out:**

- Store imports and the Godot project reader (→ A-18c). Asset derivation (→ A-18d). Console
  (→ A-18j). Any store push (→ A-18e, A-18f, A-18m).

## Design notes

- **Not a manifest.** The model is Distribution data; `.pkey/distribution` `listing` stays an
  import source and override. No manifest, signed-descriptor or wire change; per-locale notes live
  in Distribution, not in the release descriptor (S-15 §5.5).
- **Never truncate silently.** Over-limit values are issues; a proposed cut is shown, never sent
  unseen. This is conformance item 7 (S-15 §6.6) and the harness from A-18a checks it per adapter.
- **Precedence** defaults to "the store that is live wins" (S-15 §7.2) and is changeable per field;
  A-18c implements the import side, this package stores the precedence.
- Imported listing text is data: stored as text and rendered escaped, never as HTML (S-15 §9 3(g)).
- Microsoft keywords validate to 7 × 30 (the stricter of the two documented limits).

### Corrections from the code (A-18b implementation)

- **Rule 10 needs no table change.** Every console route is the `adminApi` route kind, which
  `routeCoverage.test.ts` already lists in `NARRATIVE_ONLY`; the listing routes ride it, as every
  other `/manage/api/products/<slug>/distribution/…` route does.
- **The migration is `0065_dist_listing_model.sql`.** It was written as `0063_dist_listing.sql`
  (main's highest was `0062`) and renumbered at integration: PX-W1 (portal wave 1) landed first
  with `0063_dist_listing.sql` (the single `dist_listing` table, the manifest's root listing for the
  portal presentation) and `0064_portal_self_service.sql`. That table is a different one: it is a
  manifest-ingest snapshot, not operator data, so the two coexist. A-18c's import can read it as the
  `.pkey/distribution` source instead of an outlet's merged listing.
- **The manifest's root `listing` is not stored by itself.** Distribution keeps only each outlet's
  merged listing (`dist_outlets.listing_json`). The import is therefore an explicit admin action
  (`POST …/listing/import`) that reads the listing an outlet shows (named, or the first live one
  with a listing), never a manifest ingest. Asset URLs are not imported (assets are blobs, A-18d).
- **The feeds read the model field by field over the manifest listing**, so a product without a
  `dist_listings` row renders byte-identical feeds. Only AltStore (and PAL) and Obtainium switch;
  Scoop, Flathub and F-Droid keep reading the manifest. The feed cache stamp follows the model.
- **Release notes reach Distribution through a new read-only hook method,
  `ReleaseCatalog.releaseNotes`** (Distribution may not read Release's tables). The Markdown
  stripping reuses the download page's linear-time copy of `release/changelog.ts`'s rules
  (`page/model.ts` `stripMarkdown`, now exported).
- **The store columns live in `core/storefront/listingProfiles.ts`** as data for all eight stores;
  only the Apple adapter exists, and its `ListingProfile` is now derived from its column
  (`adapterListingProfile`). A-18e–i and A-18m derive theirs the same way.
- **A-17d had landed, so it is retrofitted:** `distribute/version-localization` takes an optional
  `releaseId` and defaults `whatsNew` (store notes) and `promotionalText` (the model) from the
  listing when the request omits them, refusing a value over Apple's limit
  (`listing_does_not_fit`); the preflight gains an advisory `listingFit` check that never blocks
  `ready` (App Store Connect's own listing is what review sees until A-18m).

## Steps

1. Migration, `TABLE_OWNERS`, validators.
2. Profiles and projection with tests per store column; the fit report.
3. Release notes and the manifest import; the feed renderers' switch with goldens.
4. Admin API, audit, narrative; the A-17d retrofit if needed.

## Acceptance criteria

- [ ] The five tables exist with the names above; `TABLE_OWNERS` updated.
- [ ] Every store column of S-15 §7.3 has a projection test, including an over-limit case that
      yields an issue and no truncation.
- [ ] Feeds golden files are unchanged for a product with only a manifest `listing`.
- [ ] Admin routes are in `NARRATIVE_ONLY` with worker tests, audit rows and narrative docs.
- [ ] A-17d reads `dist_listing_release_notes` (if A-17d has landed).
- [ ] The green gate passes (`AGENTS.md`).

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- listing feeds routeCoverage
```

## Hand-off

- A-18c writes imports into these tables; A-18d writes `dist_listing_assets`.
- Every adapter (A-18e–i, A-18m) consumes `project(listing, profile)`.
- A-18j edits the model and renders the fit report.

The role agent sets `--set A-18b in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set A-18b done`.
