# P0-14 One product slug rule in `shared-manifest`: `SLUG_SHAPE` and the reserved admin route actions (`kek`, `link-repo`, `slug-check`) in the validator, the mutation table and the schema, used by manual create, link-repo and the slug check

| Field       | Value                                                                                                         |
| ----------- | ------------------------------------------------------------------------------------------------------------- |
| Phase       | P0: Hygiene, unblockers and code quality                                                                      |
| Size        | 0.25–0.5 engineer-weeks                                                                                       |
| Depends on  | none                                                                                                          |
| Unblocks    | none                                                                                                          |
| Role        | `pkey-implementer`                                                                                            |
| Plan mode   | no                                                                                                            |
| Gates       | rule 9 (`schema-parity.test.ts` mutation table); the generated `validation-codes` page; worker and CLI suites |
| Human input | none                                                                                                          |
| Repo        | `vladzaharia/polaris-key`                                                                                     |

## Goal

One product slug rule, defined once in `@polaris-key/shared-manifest`, and every path that names
or creates a product applies it: `pkey validate`, the manifest validator in link-repo and resync,
the slug check (`GET /manage/api/products/slug-check`), and manual create
(`POST /manage/api/products`). A slug one path accepts, every path accepts. A slug one path
refuses, every path refuses with the same code.

## Why

UX-72 (`wp/UX-72-create-probes`, merged in `a1e5a898e`) made link-repo and the slug check stricter
than the validator. `packages/worker/src/services/release/linkRepo.ts` defines
`SLUG_SHAPE = /^[a-z0-9][a-z0-9-]{0,63}$/`, which refuses a leading hyphen, and
`PRODUCT_ROUTE_ACTIONS` (`kek`, `link-repo`, `slug-check`), which a product slug would shadow
under `/manage/api/products/`. But `validateManifestDocuments` still checks `^[a-z0-9-]{1,64}$`
and only `RESERVED_PRODUCT_SLUGS`, and so does the published `product.schema.json`. So
`pkey validate` passes a manifest that link-repo then refuses. Manual create
(`admin/handlers/products.ts`) is looser again: it checks `/^[a-z0-9-]+$/` with no length bound.
AGENTS.md rule 9 says a validation rule lives in the validator with a mutation-table entry and a
schema that matches. This moves the rule there.

## Read first

- `AGENTS.md` (rule 9 and the drift gates) and the `authoring-pkey-manifests` skill.
- `packages/shared-manifest/src/index.ts`: `SLUG_RE` (around line 542), `RESERVED_PRODUCT_SLUGS`
  (around line 1197), and the `invalid_slug` / `reserved_slug` checks in
  `validateManifestDocuments` (around line 1365).
- `packages/shared-manifest/schemas/v1/product.schema.json` `$defs.slug`, and
  `release-descriptor.schema.json`'s slug pattern.
- `packages/shared-manifest/test/schema-parity.test.ts`, the mutation table.
- `packages/worker/src/services/release/linkRepo.ts`: `SLUG_SHAPE`, `SLUG_MAX`,
  `PRODUCT_ROUTE_ACTIONS`, `isReservedSlug`, `checkSlug`, `freeVariant`.
- `packages/worker/src/admin/handlers/products.ts`: the slug-check route and manual create's slug
  checks.
- `packages/shared-manifest/src/descriptor.ts` `SLUG_RE` and `packages/cli/src/ci.ts`, which
  repeat the old pattern for a product slug.
- `packages/admin/src/lib/products.ts` `slugError` (the console's inline hint).

## Scope

**In:**

- In `shared-manifest`: export `PRODUCT_SLUG_PATTERN` (`^[a-z0-9][a-z0-9-]{0,63}$`) with a matching
  `RegExp`, `PRODUCT_SLUG_MAX = 64`, `PRODUCT_ROUTE_ACTIONS` and one `isReservedProductSlug(slug)`
  that covers `RESERVED_PRODUCT_SLUGS`, the route actions and `SYSTEM_PRODUCT_SLUG`.
- `validateManifestDocuments`: `invalid_slug` on the new shape (its message names the pattern),
  `reserved_slug` on a route action. Keep both existing codes; add no new code.
- Mutation table: add entries for a leading-hyphen slug (`invalid_slug`, `schema: "rejects"`) and
  for each route action (`reserved_slug`, `schema: "rejects"`).
- `product.schema.json` `$defs.slug`: the new `pattern`, the route actions added to the `not.enum`,
  and an updated description.
- The worker imports these instead of keeping its own. `linkRepo.ts` drops `SLUG_SHAPE` and
  `PRODUCT_ROUTE_ACTIONS` and calls the shared helpers. Manual create refuses an invalid shape
  (`422 invalid slug`, `reason: "invalid_slug"`) and a reserved slug (`422 reserved slug`,
  `reason: "reserved_slug"`) through the same helpers, so a 65-character or leading-hyphen slug
  is refused there too.
- `descriptor.ts`, `release-descriptor.schema.json` and `cli/src/ci.ts` use the shared pattern for
  a product slug. They read existing products, so they take the shape but not the reservations.
- The console's `slugError` mirrors the shape and the 64-character bound (it already refuses a
  leading hyphen). The server stays the authority.
- Regenerate the `validation-codes` docs page.

**Out** (and where it belongs instead):

- Renaming or migrating an existing product. See the design note on existing slugs.
- Other slug-like fields (pack types, package names, outlet owners), which have their own rules.

## Design notes

- **Not plan mode.** The manifest validator and schema are not wire (`shared-protocol`,
  `shared-jws`, `client-core`, signed documents and the corpus are). It is a validator rule, so
  rule 9's drift gate applies. Run `schema-parity.test.ts` and the docs `--check`.
- **Existing slugs.** The new shape only refuses a leading hyphen (length and alphabet are
  unchanged), and the route actions only refuse three names. Before tightening, check that no
  registered product holds such a slug: `products/*/` fixtures, the worker test seeds, and a
  read-only `SELECT slug FROM products WHERE slug LIKE '-%' OR slug IN ('kek','link-repo','slug-check')`
  that the lead runs against production D1. If one exists, stop and report. Resync would start
  refusing that product's manifest, and that is a migration decision for the human.
- **One list.** When a new admin action is added under `/manage/api/products/<segment>`, it is
  added to `PRODUCT_ROUTE_ACTIONS` in `shared-manifest`. Say so in the constant's doc comment, and
  point to it from the comment in `admin/handlers/products.ts`.
- `SYSTEM_PRODUCT_SLUG` stays out of the manifest `not.enum`. The system product's own manifest
  carries it, and only manual create and the slug check refuse it, as today.

## Steps

1. Run the existing-slug check above.
2. Write the mutation-table entries and the worker tests first: manual create with a leading
   hyphen, 65 characters, and each route action; the slug check unchanged.
3. Move the constants and helpers into `shared-manifest`, then point the validator, schema, worker,
   descriptor, CLI and console at them.
4. Regenerate the `validation-codes` page and run the scoped suites.

## Acceptance criteria

- [ ] `PRODUCT_SLUG_PATTERN`, `PRODUCT_SLUG_MAX`, `PRODUCT_ROUTE_ACTIONS` and
      `isReservedProductSlug` are exported from `@polaris-key/shared-manifest`, and
      `packages/worker/src` defines no slug regex or route-action list of its own (grep).
      _Correction (implementation, P0-14): read as the create and check paths
      (`services/release/linkRepo.ts`, `admin/handlers/products.ts`), which now hold none. The
      worker still parses a product segment out of paths and keys with its own patterns (the
      router's `/([a-z0-9-]+)`, `core/blobs.ts` and `core/hostedAssets.ts` key shapes,
      `distribution/bytes.ts`, and the existing-product lookups in
      `platformStoreConnections.ts` / `platformStoreProvisioning.ts`). Those read existing
      products, never create one, and several are embedded in compound path regexes, so they are
      left as they are and filed as a follow-up._
- [ ] `pkey validate` refuses a manifest whose slug starts with `-` (`invalid_slug`) or is `kek`,
      `link-repo` or `slug-check` (`reserved_slug`), and accepts what link-repo accepts (tests).
- [ ] `schema-parity.test.ts` carries the new mutations, both `schema: "rejects"`, and passes.
- [ ] Manual create refuses a leading-hyphen slug, a 65-character slug and each route action
      with 422 and the matching `reason` (tests in `packages/worker/test`).
- [ ] The slug check's answers are unchanged (`createProbes.test.ts` passes untouched).
- [ ] The generated `validation-codes` page is current
      (`pnpm --filter @polaris-key/docs gen -- --check`).
- [ ] The green gate passes (`AGENTS.md`), including the rule 9 drift gate.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/shared-manifest test
mise exec node@22 -- pnpm --filter @polaris-key/worker test createProbes products
mise exec node@22 -- pnpm --filter @polaris-key/cli test
mise exec node@22 -- pnpm --filter @polaris-key/docs gen -- --check
```

## Hand-off

- Any later admin route under `/manage/api/products/<segment>` adds its segment to
  `PRODUCT_ROUTE_ACTIONS` in `shared-manifest`, which reserves it everywhere at once.

The role agent sets `--set P0-14 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P0-14 done`.
