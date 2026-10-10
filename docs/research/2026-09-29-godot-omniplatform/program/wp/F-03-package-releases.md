# F-03 Package releases: the `package` deliverable kind, descriptor, ingest, the system product and `pkey release publish` package mode

| Field       | Value                                                                                                                                                                                                                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase       | F: Package feeds (pkg.plrs.im) (tier-1)                                                                                                                                                                                                                                                    |
| Size        | 2–3 engineer-weeks                                                                                                                                                                                                                                                                         |
| Depends on  | [F-01](F-01-feeds-plan.md)                                                                                                                                                                                                                                                                 |
| Unblocks    | [F-04](F-04-npm-feed.md), [F-05](F-05-pypi-feed.md), [F-06](F-06-swift-registry.md), [F-07](F-07-maven-feed.md), [F-08](F-08-oci-registry.md), [F-09](F-09-godot-feed.md), [F-11](F-11-console-feeds.md), [F-30](F-30-cargo-feed.md), [F-31](F-31-go-proxy.md), [F-32](F-32-nuget-feed.md) |
| Role        | `pkey-implementer`                                                                                                                                                                                                                                                                         |
| Plan mode   | no separate plan: this package executes the approved [`plans/F-01.md`](../plans/F-01.md) exactly, and stops to ask if the code disagrees with it                                                                                                                                           |
| Gates       | rule 9 (`.pkey/release` package deliverables, the descriptor's `package` branch, `.pkey/distribution` refusal); D1 migrations and `TABLE_OWNERS`; Action-bundle drift (CLI); `docs gen:check`; THREAT-MODEL; `gen corpus`/`gen transcripts`/`gen constants --check` stay unchanged         |
| Human input | none (the system product is created by the bootstrap action after deploy; the trusted-publisher registration is F-10's)                                                                                                                                                                    |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                                                  |

## Goal

A product can declare `kind: "package"` deliverables in `.pkey/release`. `pkey release publish`
packs, extracts and publishes a package version through an upload ticket. Release ingests it into
`release_packages`, unique forever, with Worker-computed digests and no signed record. Yank,
unyank, deprecate and channel moves work and enqueue a render. The `polaris-key` system product
can be bootstrapped. No device-facing surface ever shows a package. The corpus, transcripts and
constants are byte-identical.

## Why

[S-12 §6](../../notes/S-12-package-feeds.md#6-data-model) makes a package a Release deliverable, so that history, channels,
yank, audit, trusted publishing and blob refs come from existing code. This package builds the
data side every ecosystem feed reads.

## Read first

- [`plans/F-01.md`](../plans/F-01.md) §2, §3, §6.3–§6.5, §6.10.
- `packages/shared-manifest/src/index.ts:660-702`, `:941`, `:1142`, `:2770-2850`;
  `descriptor.ts:1-140`, `:690-730`; `schemas/v1/{release,release-descriptor}.schema.json`;
  `test/schema-parity.test.ts`.
- `packages/worker/src/services/release/{publish,model,policy,recordRoute,deliverables,resolve}.ts`,
  `migrations/0016*`, `0027_a_release_model.sql`, `0045_a*`, `0046_a*`;
  `admin/handlers/products.ts`; `packages/cli/src/publish.ts`.

## Scope

**In:**

- **Manifest (rule 9):** `DELIVERABLE_KINDS`, `PACKAGE_ECOSYSTEMS`, `SYSTEM_PRODUCT_SLUG`, the six
  rules of plan §3.1, the descriptor branch of §3.2, the distribution refusal of §3.3, the JSON
  Schemas and the mutation rows.
- **Migrations:** `products.system`, the `release_deliverables` rebuild, `release_packages`, and the
  registry tables plus `registry_render_queue` (plan §6.4), with `TABLE_OWNERS` and the replay test.
- **Ingest:** the descriptor branch, namespace and size checks, `DigestStream` digests, the
  `package-unsigned` and `package-version-taken` reasons, the tombstone rule, and the
  `enqueuePackageRender` calls.
- **The kind-switch inventory** of plan §6.3, every item with a test.
- **The `ReleaseCatalog` hook:** `packageVersions` and `packageDeliverables`.
- **The system product:** `ensureSystemProduct`, `POST /manage/api/platform/feeds/bootstrap`, and
  the create, delete and rename refusals.
- **The `packageFeeds` toggle** route and audit.
- **CLI:** `pkey release publish --deliverable <package id>`, with the six extractors under
  `packages/cli/src/package/`, the old-Worker dry-run guard and fixture packages per ecosystem.
- **Docs:** `concepts.md` entries (rule 4) and `build/manifest/authoring.md`.

**Out:**

- Rendering and routes (→ F-04 to F-09).
- Console pages (→ [F-11](F-11-console-feeds.md)).
- Our own SDK workflows (→ [F-10](F-10-sdks-onto-feeds.md)).

## Design notes

- The release id is `<deliverable>@<version>`. Locations are `r2` only. The Worker never unzips:
  extractors run in the CLI, and the Worker checks shape and agreement.
- The migration is forward-only. RUNBOOK says how to roll back past it.
- Hotspots: the migration numbers and the CLI bundle are assigned at rebase, one at a time.

## Steps

1. Manifest constants, rules, schemas and mutation rows.
2. Migrations and the replay test; `TABLE_OWNERS`; `docs gen`.
3. Descriptor ingest, digests and tombstones; the kind-switch inventory with tests.
4. The system product and the `packageFeeds` toggle.
5. CLI extractors and package mode; the Action bundle; docs.

## Acceptance criteria

- [ ] `schema-parity` passes with a row for every new code.
- [ ] A package release never appears in the channel feed, an update decision, `/release/latest`,
      the appcast, the records route, the download page or a storefront feed (one test each).
- [ ] Republishing a yanked version is refused. A `record` on a package descriptor is refused.
- [ ] The migration replay test passes on a populated fixture.
- [ ] `gen corpus`, `gen transcripts` and `gen constants --check` show no diff.
- [ ] The green gate passes (`AGENTS.md`).

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/manifest test
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- release packages migrations
mise exec node@22 -- pnpm --filter @polaris-key/cli test -- package
mise exec node@22 -- pnpm --filter @polaris-key/cli bundle:action -- --check
mise exec node@22 -- pnpm --filter @polaris-key/docs gen:check
mise exec node@22 -- pnpm gen corpus --check && mise exec node@22 -- pnpm gen transcripts --check
```

## Corrections (recorded while implementing, against the code)

Where the code disagreed with plans/F-01.md, the code was the fact. None of these changes a wire
shape, the corpus or `PROTOCOL_VERSION`.

1. **Migration numbers.** `0058_a_products_system`, `0058_b_release_deliverables_kind`,
   `0058_c_release_packages`, `0058_d_registry` (after main's highest at the final merge, `0057_platform_operations`). `LATEST_MIGRATION`
   follows.
2. **The `release_deliverables` rebuild sets the child rows aside** instead of relying on
   `PRAGMA defer_foreign_keys = ON`: SQLite counts the violations the DROP's implicit DELETE makes
   and never recounts them when the renamed copy brings the parent rows back, so a deferred
   transaction still fails at its end whenever `release_channel_policy` or `release_pack_floors`
   has a row. The children are copied to `_f03` tables, removed, and restored after the rename;
   every step converges on a replay (the 0017 discipline). A package's `ecosystem` and
   `package_name` are required by `stmtUpsertDeliverable`, not a CHECK, so even a full replay over
   a migrated database keeps every row. The R11 "additive only" test lists the file beside 0016
   and 0017.
3. **`registry_render_queue` coalesces and is product-first**: primary key `(product,
deliverable_id)` (`'*'` = every package of the owner) with a `generation` that an enqueue bumps
   and a drain's delete matches, instead of matching on `enqueued_at ≤ start` (seconds-resolution
   timestamps would drop an enqueue landing in the render's second; R11-05 requires product-first
   keys). F-03 ships the enqueue and the read/consume helpers (`core/registryQueue.ts`); the drain,
   `registryMaterialiser` and the cron hook are F-02's framework.
4. **Digests use `node:crypto`'s streaming `createHash`** (the Worker runs with `nodejs_compat`;
   `ed25519Stream.ts` already streams SHA-512 through it), which covers SHA-1, SHA-512 and MD5 in
   workerd and Node alike, so no per-algorithm `DigestStream` fallback is needed.
5. **The hook signatures are product-scoped by `HookContext`**, like every other reader:
   `packageDeliverables()`, `packageVersions(deliverableId)`, plus `packageChannelHeads(deliverableId)`
   (each channel's head, which the renderers turn into `latest` and channel tags). `deliverables()`
   never lists a package, so every Distribution consumer (readiness, rollouts, the matrix, the
   download page, the storefront feeds, connectors, the blob collector's pack walk) excludes them
   at one place; `release()`, file and blob resolution and `channelPolicies()` exclude them too.
6. **Release reads feed settings through a new `delivery.packageFeed(ecosystem)` hook**
   (namespace, ceiling under the platform policy, `ext`), because the namespace, size and Swift
   signing rules read Distribution's `dist_registry_*` tables (rule 6). No configured feed for the
   ecosystem is `package-namespace`; Distribution off is `distribution_disabled` (409).
7. **Feed-level rules are the Worker's, not the validator's**: `maven-snapshot`,
   `package-namespace`, `package-too-large` and `swift-unsigned` read operator settings, so the
   descriptor validator emits only the existing codes (`invalid_descriptor`,
   `unsupported_deliverable_kind`, `unknown_deliverable`, …) and the Worker maps its findings to
   `package-shape`. The GitHub-sync descriptor path refuses a package descriptor.
8. **There is no Release admin delete** to refuse, and no slug rename: "rename" is a `PATCH` of the
   system product's `name`, refused (409 `system_product`) like its delete. The bootstrap audits to
   A-12's `platform_audit` (landed) as `feed.bootstrap`.
9. **Deprecate is a Release admin route**, `POST|DELETE …/release/releases/:id/deprecate`, beside
   yank: Distribution (F-11's feeds pages) cannot write Release state, so F-11 calls it. Yank and
   unyank update `release_packages.state` in their own batch.
10. **Vocabulary details**: a package's `artifacts` is a map of 1–16 `{ match }` entries; OCI
    metadata gains `root` (the digest the version's tag points to); Swift and OCI releases need
    `--version` (their archives carry none); the Swift extractor takes the `*.sig` beside the
    archive and the `Package*.swift` manifests of the scratch directory (F-06 confirms SwiftPM's
    file names). The console lists packages with a `package` badge and no pack-detail link, and
    keeps the system product out of the switcher and the Products list.

## Hand-off

- The ecosystem packages read `releaseCatalog.packageVersions`.
- F-11 reads the tables through Distribution's admin handlers.
- F-10 declares the system product's packages and publishes them.

The role agent sets `--set F-03 in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set F-03 done`.
