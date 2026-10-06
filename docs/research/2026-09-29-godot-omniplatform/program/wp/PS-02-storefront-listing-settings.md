# PS-02 Listing state: `storefront.polarisKey.{enabled,listed,audience,offerPaths,groupLabels}` in the S-18 registry, `portal_product_settings` columns, `discover_enabled` backfill to `unlisted`

| Field       | Value                                                                                         |
| ----------- | --------------------------------------------------------------------------------------------- |
| Phase       | PS: Polaris Key storefront: the Library as a distribution channel (S-21) (phase 1: substrate) |
| Size        | 0.4–0.6 engineer-weeks                                                                        |
| Depends on  | [ST-03](ST-03-settings-registry.md)                                                           |
| Unblocks    | [PS-03](PS-03-obtain-path-engine.md), [PS-06](PS-06-console-polaris-key-storefront.md)        |
| Role        | `pkey-implementer`                                                                            |
| Plan mode   | no                                                                                            |
| Gates       | migration (expand-only); table owners; workerd                                                |
| Human input | none                                                                                          |
| Repo        | `vladzaharia/polaris-key`                                                                     |

## Goal

Every product carries an operator-owned Polaris Key listing state (`auto`, `listed`, `unlisted`), an audience, the path kinds it offers and group labels, as S-18 registry entries backed by `portal_product_settings` columns, and products that opted out of Discover are `unlisted` after the migration.

## Why

Today the only control is the Discover opt-out `discover_enabled` (0071). The owner wants the operator to decide whether to list ([S-21 §6.2](../../notes/S-21-polaris-storefront.md#62-listing-state-and-settings-ps-02), D3). The planned `identity.discover.listed` (S-18 D22) is superseded and never built.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [notes/S-21](../../notes/S-21-polaris-storefront.md): the owner-decisions block (it wins over the sections below it) and the sections in this brief's refs.
- `packages/worker/src/core/settings/{types,define,registry,core}.ts`; `services/license/settings.ts` (a column-backed entry).
- `packages/worker/migrations/0071_portal_discover.sql`; `services/identity/portal/repo.ts` (`portal_product_settings` reads and writes).
- [S-18 §7.3 D22](../../notes/S-18-settings-architecture.md).

## Scope

**In:**

- Registry entries in the core slice, exactly the table in S-21 §6.2 (keys, scopes, values, defaults, ownership, confirm levels, `readers`, `docs`).
- Expand-only migration: `store_listed TEXT NOT NULL DEFAULT 'auto' CHECK (store_listed IN ('auto','listed','unlisted'))`, `store_audience TEXT NOT NULL DEFAULT 'eligible' CHECK (store_audience IN ('eligible','everyone'))`, `store_offer_paths_json TEXT` (NULL = all), `store_group_labels_json TEXT`; backfill `store_listed = 'unlisted'` where `discover_enabled = 0`; rollback note.
- A reader `storefrontListing(db, product)` returning the resolved values, used by PS-03.
- Writes: `portal_product_settings` writer extended, audited; until ST-05 lands, the existing portal-settings admin route accepts the new fields.

**Out** (and where it belongs instead):

- Evaluation (→ PS-03). Console controls (→ PS-06). Dropping `discover_enabled` (→ PS-11).

## Design notes

- `auto` must reproduce today's Discover exactly; nothing appears or disappears on deploy.
- `discover_enabled` stays read (dual-read: `discover_enabled = 0` forces `unlisted`) until PS-11.
- `audience: everyone` is confirm level L2.

### Corrections from the code (PS-02 implementation, 2026-10-05)

Recorded under step 1; the code is the fact. Each was decided on the recommended option (decisions
delegated to the lead).

- **`storefront.polarisKey.enabled` is in the platform slice, not the core slice.** `rules.ts`
  lets only the platform slice hold platform-scope entries. It is registered `pending: PS-03`:
  nothing reads it yet (PS-03's candidate query is the first reader), and no route can write a
  non-A-13 platform scalar until ST-05.
- **The core slice owns a second namespace, `storefront`** (`registry.ts`), so the four product
  entries pass the namespace rule while staying Core's (every product can list, Distribution on
  or off).
- **`groupLabels` is `operator`, not `claimable`, for now.** A claimable entry needs a
  `manifest.path` that the product schema has (`settings-registry.test.ts`), and `.pkey/product`
  has no `storefront.groupLabels` yet (S-21 §6.2 puts that field out of scope). The package that
  adds the manifest field flips the entry to `claimable`.
- **`audience` confirms as an ordered enum**, `{ up: L2, down: L0 }`, with `widensWhen: higher`
  and `critical: true` (a reason on every ST-05 write). It is not `securityWidening`: it widens
  visibility, not access. The route enforces the L2 typed confirmation now: widening to
  `everyone` needs `"confirm": "storefront.polarisKey.audience"`, as the platform-settings route
  asks for its key.
- **Migration number is 0085** (`0085_storefront_listing.sql`): main took 0074 for UX-15's
  `0074_license_refusals.sql`, 0075-0077 for feeds-2 (F-22, F-30, F-31) and 0078 for hosted
  assets while this package was in review; at integration (integ/ps-1) the lead assigned 0085,
  since integ/identity-store-1 claims 0079-0083 and LX-14a 0084. `LATEST_MIGRATION` points at
  it.
- **Dual-write as well as dual-read.** Writing `storeListed` sets `discover_enabled` to 0 exactly
  when `unlisted`; `discoverEnabled: false` alone makes the product `unlisted`, and `true` returns
  an `unlisted` product to `auto`. The two columns stay coherent for a pre-0085 Worker in the
  deploy window.
- **The settings view derives `discoverEnabled` from the resolved state** (`listed !== 'unlisted'`)
  rather than echoing the raw column, so a deploy-window row (a pre-0085 Worker writing
  `discover_enabled = 1` over `store_listed = 'unlisted'`) reads hidden in both fields.
- **An unknown `store_listed` value resolves to `unlisted`** (fail closed); only a missing column
  reads the `auto` default. The CHECK constraint makes the first case unreachable in practice.
- **Discover's candidate query also skips `store_listed = 'unlisted'`** (one predicate in
  `listDiscoverCandidates`), so either column hides a product. `auto` and `listed` keep today's
  offers exactly; PS-03 still owns evaluation.
- **Route field names** are flat, beside the existing ones: `storeListed`, `storeAudience`,
  `storeOfferPaths` (`null` = every kind), `storeGroupLabels`. A change writes a second audit row,
  `storefront.polarisKey.update`, naming what changed (the console's activity verbs and the
  activity docs list it).
- **Value sets live in one Core module**, `core/storefront/polarisKeyListing.ts`, so the registry
  names them without importing a service. The database reader `storefrontListing(db, product)` is
  Identity's (`services/identity/portal/storefrontListing.ts`), because `portal_product_settings`
  is Identity's table. A stored value that no longer parses fails closed: no paths, no labels.
- **Docs coverage.** ST-06's generated coverage page does not exist yet. The entries point at the
  new "Polaris Key listing" section of `/docs/services/identity/portal/`, which the registry test
  checks exists.

## Steps

1. Re-read the S-21 sections above; verify this brief against the code and record any correction here.
2. Implement the **In** list in small commits prefixed `PS-02:`.
3. Add the tests named in the acceptance criteria.
4. Run the green gate and the gates in the header; set `--set PS-02 in-review`.

## Acceptance criteria

- [x] The registry test passes with the five new entries; docs coverage lists them.
- [x] Migration test: a product with `discover_enabled = 0` reads `unlisted`; others read `auto`.
- [x] A pre-migration Worker reads and writes the table unaffected (expand-only).
- [x] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test settings portalDiscover
```

## Hand-off

PS-03 reads `storefrontListing`. PS-06 edits the values.

The role agent sets `--set PS-02 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set PS-02 done`.
