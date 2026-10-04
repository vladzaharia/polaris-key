# F-03 Package releases: the `package` deliverable kind, descriptor, ingest, the system product and `pkey release publish` package mode

| Field       | Value                                                                                                                                                                                                                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase       | F: Package feeds (pkg.plrs.im) (tier-1)                                                                                                                                                                                                                                                    |
| Size        | 2–3 engineer-weeks                                                                                                                                                                                                                                                                         |
| Depends on  | [F-01](F-01-feeds-plan.md)                                                                                                                                                                                                                                                                 |
| Unblocks    | [F-04](F-04-npm-feed.md), [F-05](F-05-pypi-feed.md), [F-06](F-06-swift-registry.md), [F-07](F-07-maven-feed.md), [F-08](F-08-oci-registry.md), [F-09](F-09-godot-feed.md), [F-11](F-11-console-feeds.md), [F-30](F-30-cargo-feed.md), [F-31](F-31-go-proxy.md), [F-32](F-32-nuget-feed.md) |
| Role        | `pkey-implementer`                                                                                                                                                                                                                                                                         |
| Plan mode   | no separate plan: this package executes the approved [`plans/F-01.md`](../plans/F-01.md) exactly, and stops to ask if the code disagrees with it                                                                                                                                           |
| Gates       | rule 9 (`.pkey/release` package deliverables, the descriptor's `package` branch, `.pkey/distribution` refusal); D1 migrations and `TABLE_OWNERS`; Action-bundle drift (CLI); `docs gen:check`; THREAT-MODEL; `gen:corpus`/`gen:transcripts`/`gen:constants -- --check` stay unchanged      |
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
- [ ] `gen:corpus`, `gen:transcripts` and `gen:constants -- --check` show no diff.
- [ ] The green gate passes (`AGENTS.md`).

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/manifest test
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- release packages migrations
mise exec node@22 -- pnpm --filter @polaris-key/cli test -- package
mise exec node@22 -- pnpm --filter @polaris-key/cli bundle:action -- --check
mise exec node@22 -- pnpm --filter @polaris-key/docs gen:check
mise exec node@22 -- pnpm gen:corpus -- --check && mise exec node@22 -- pnpm gen:transcripts -- --check
```

## Hand-off

- The ecosystem packages read `releaseCatalog.packageVersions`.
- F-11 reads the tables through Distribution's admin handlers.
- F-10 declares the system product's packages and publishes them.

The role agent sets `--set F-03 in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set F-03 done`.
