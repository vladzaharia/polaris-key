# A-18c Listing import from App Store, Play, Microsoft Store and the Godot project

| Field       | Value                                                                                            |
| ----------- | ------------------------------------------------------------------------------------------------ |
| Phase       | A: Admin: store provisioning (storefronts)                                                       |
| Size        | 1–2 engineer-weeks                                                                               |
| Depends on  | [A-18b](A-18b-listing-model.md), [A-17a](A-17a-asc-write-substrate.md)                           |
| Unblocks    | none                                                                                             |
| Role        | `pkey-implementer`                                                                               |
| Plan mode   | no                                                                                               |
| Gates       | rule 10 (narrative-only admin routes); CLI docs drift gate (generated CLI reference); CLI bundle |
| Human input | none (imports use the credentials A-16 already holds)                                            |
| Repo        | `vladzaharia/polaris-key`                                                                        |

## Goal

The listing model fills itself from what already exists. `readListing` works for the Apple, Play
and Microsoft adapters, each a read under the existing gate. `pkey listing import --godot <project>`
reads `project.godot` and `export_presets.cfg` and uploads the result. Each import yields a
field-by-field diff against the model, through the admin API, before it is applied.

## Why

"Use assets that are already available" (the owner, 2026-10-04). S-15 §7.2 lists where each field
already lives: the stores' own listings (already reviewed), the Godot project and its presets, and
the manifest ([S-15 §7.2](../../notes/S-15-storefront-provisioning.md#72-where-each-field-already-exists)).

## Read first

- [notes/S-15](../../notes/S-15-storefront-provisioning.md) §5.3 (the Play edit), **§7.2**, §7.5
  (the Apple import row), §11 (A-18c).
- A-17a's client and gate (reads are allowed); `connectors/play/{poll,platform}.ts`;
  `connectors/msstore/{client,map}.ts` (P5-04 deliberately does not read listings today,
  `map.ts:355`).
- `packages/cli/src/manifest.ts`; the CLI docs generator.

## Scope

**In:**

- Apple `readListing`: `appInfoLocalizations`, `appStoreVersionLocalizations`,
  `ageRatingDeclarations` (to content descriptors) and screenshot sets, through A-17a's client and
  gate (all reads).
- Play `readListing`: `details`, `listings` and `images.list` through a read-only edit that is
  deleted afterwards. **Use A-18e's edit lease if it has landed; otherwise open a direct edit and
  leave a `TODO(A-18e)` at the call site**, since an import edit can be invalidated by P5-03's poll.
- Microsoft `readListing`: extend P5-04's GET-only client to read the last published submission's
  listing. Polling stays GET-only.
- CLI `pkey listing import --godot <project>`: name and `name_localized`, version, bundle ids
  (`application/bundle_identifier`, `package/unique_name`), category hints, copyright, company,
  icon paths (`icons/app_store_1024x1024`, falling back to `application/config/icon`; adaptive
  layers), uploaded to A-18b. No Godot editor needed in CI.
- Precedence rules (default "the store that is live wins", changeable per field) and the diff API
  the console shows before applying.

**Out:**

- Asset derivation from the imported images (→ A-18d). Console (→ A-18j).

## Design notes

- Imports never write to a store. Each is a read through the adapter's gate, so the gate's
  classification covers it.
- Godot's `application/config/description` is only a Project Manager tooltip: never import it
  (S-15 §7.2).
- Screenshots imported from one store are not pushed to another unchecked: A-18d runs each through
  the target store's fit check (S-15 §5.6).
- Imported text is data, rendered escaped (S-15 §9 3(g)).

### Corrections from the code (A-18c implementation)

- **There is no generated CLI reference.** `packages/docs/scripts/gen-reference.mjs` generates
  only the `reference/*.mdx` pages, none of them for the CLI. `pkey listing import` is documented
  in the narrative page `admin/storefront-listing.md` (hand-written, as `pkey bundle` and
  `pkey feeds setup` are). The generated page that did change is `reference/data-model.mdx`
  (the new migration), regenerated with `pnpm --filter @polaris-key/docs gen`. The CLI bundle
  (`actions/publish/dist/index.js`) is regenerated.
- **Precedence needs per-field provenance**: migration `0069_dist_listing_provenance.sql` adds
  `provenance_json` (`{field: import source}`) to `dist_listings` and `dist_listing_locales`, so an
  import can tell a value an earlier, higher-ranked import wrote from one an operator typed (A-18b
  stored only a row-level `source`). An operator's edit removes the source of each field it changes;
  rows written before 0068 read as A-18b left them (`import` rows as `manifest`).
- **The diff API is the import route itself**: `POST …/listing/import` without `confirm` answers
  the field-by-field diff and a `digest` and writes nothing; with `confirm: <digest>` (and optional
  `fields`) it re-reads the sources and applies only if the diff is unchanged (409
  `import_changed` with the new diff otherwise). A-18b's one-step manifest import moved onto this
  flow; `.pkey/product` (`product`, already in the precedence list) is a source too.
- **Icons and store images are reported, not uploaded.** A `dist_listing_assets` row needs an
  uploaded blob and digest, which A-18d's `pkey listing assets` makes. The Godot import sends the
  icon paths with their SHA-256 and PNG size, and the store imports their image URLs; the diff
  lists them (`assets`) for A-18d to start from.
- **Version and bundle ids have no model field**, so they are shown beside the outlets' identities
  (`identifiers`, with a match per outlet), not stored.
- **Play edit lease:** A-18e has not landed, so the import opens a direct read-only edit with a
  `TODO(A-18e)` at the call site (`listing/sources.ts` `playSource`).
- **Microsoft needs no client change:** the last published submission is already a GET of P5-04's
  client; a separate parser (`connectors/msstore/listing.ts`) reads its `listings`, leaving
  `parseSubmission` (and polling) untouched. Images are listed by file name only there, so they are
  skipped with a reason.
- **"The gate's fake token endpoint":** App Store Connect has no token endpoint (the JWT is minted
  locally), so the Apple test asserts every request is a GET the gate admits and nothing is
  written; the Play and Microsoft tests assert their fake token endpoints saw exactly one token,
  for the read scope, and only reads (plus Play's edit insert and delete).

## Acceptance criteria

- [ ] Each of the three adapters' `readListing` is tested against its fake vendor, and the gate's
      fake token endpoint shows only allowed reads.
- [ ] `pkey listing import --godot` reads a fixture project and uploads the expected fields; the
      CLI reference is regenerated, never hand-edited.
- [ ] An import shows a diff and applies only on confirmation; the applied rows carry
      `source = 'import'` and an audit row.
- [ ] The green gate passes (`AGENTS.md`).

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- listing import
mise exec node@22 -- pnpm --filter @polaris-key/cli test -- listing
```

## Hand-off

A-18j's Listing step calls the import and diff API. A-18e switches the Play import onto its lease
if this package landed first.

The role agent sets `--set A-18c in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set A-18c done`.
