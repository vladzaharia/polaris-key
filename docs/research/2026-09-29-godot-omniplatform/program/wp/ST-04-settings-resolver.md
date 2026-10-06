# ST-04 Settings resolver: source chain over row- and column-backed keys, cache, `writeSetting()`, audit with before, after, origin, reason and key, discovery-vs-enforcement test

| Field       | Value                                                                                                                                                                                                                                                        |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase       | ST: Settings architecture (S-18) (phase 1: foundation)                                                                                                                                                                                                       |
| Size        | 0.8–1.1 engineer-weeks                                                                                                                                                                                                                                       |
| Depends on  | [ST-03](ST-03-settings-registry.md), [ST-01b](ST-01b-resync-claims.md)                                                                                                                                                                                       |
| Unblocks    | [I-09](I-09-key-entry-attach.md), [PX-W13b](PX-W13b-display-name-settings.md), [ST-05](ST-05-settings-admin-api.md), [ST-15](ST-15-hardcoded-policy.md), [ST-16](ST-16-platform-defaults.md), [ST-24](ST-24-audit-retention.md), [CM-03](CM-03-merchants.md) |
| Role        | `pkey-implementer`                                                                                                                                                                                                                                           |
| Plan mode   | no                                                                                                                                                                                                                                                           |
| Gates       | `TABLE_OWNERS`; drift gate (`--check`)                                                                                                                                                                                                                       |
| Human input | none                                                                                                                                                                                                                                                         |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                    |

## Goal

One resolver returns a setting's effective value with its source chain over row- and column-backed keys, and every write goes through `writeSetting()`, which audits before, after, origin, reason and key.

## Why

Each service resolves its own settings today with different precedence ([S-18 §2.3](../../notes/S-18-settings-architecture.md#23-six-precedence-patterns-five-vocabularies)). [S-18 §4.4](../../notes/S-18-settings-architecture.md#44-precedence-and-inheritance) defines one chain; [S-18 §4.6](../../notes/S-18-settings-architecture.md#46-audit-history-and-concurrency) defines the audit shape.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [S-18 owner decisions](../../notes/S-18-settings-architecture.md) (the 2026-10-04 header block; it wins over the sections below it).
- [S-18 §4.3](../../notes/S-18-settings-architecture.md#43-storage), [S-18 §4.4](../../notes/S-18-settings-architecture.md#44-precedence-and-inheritance), [S-18 §4.6](../../notes/S-18-settings-architecture.md#46-audit-history-and-concurrency), [S-18 §4.11](../../notes/S-18-settings-architecture.md#411-sdk-surface-per-language), [S-18 §6.2](../../notes/S-18-settings-architecture.md#62-work-packages) row ST-04.

## Scope

**In:**

- Resolver: default → deploy var → platform → product (manifest or console) → entity, with policy clamps and ceiling locks; result `{ value, source, chain, lockedBy?, drift? }`.
- Per-isolate cache reusing A-13's 30-second platform cache; product rows read with the product fetch.
- `writeSetting()` with the audit row shape; discovery-vs-enforcement test.

**Out** (and where it belongs instead):

- HTTP routes (→ ST-05); platform defaults' fan-out UI (→ ST-16).

## Design notes

- Column-backed keys keep today's hot-path reads.
- `gen:transcripts --check` must stay unchanged: no wire effect.
- A test asserts no handler writes a registry-backed column directly.

### As built (2026-10-06), where the code corrected the brief

- **Where it lives.** `packages/worker/src/core/settings/resolve.ts` (resolver: pure
  `resolvePlatformValue` / `resolveProductValue`, loaders `resolvePlatformSetting` /
  `resolveProductSettings`), `write.ts` (`writeSetting` / `writeSettings`), `columns.ts` (Core's
  column adapters) and `snapshot.ts`; Release's tables are adapted in
  `services/release/settingsColumns.ts`, contributed through the slices' new `columns` field.
  Service handlers get the registry as `ServiceContext.settings` (built by both dispatchers,
  `settingsRegistryFor`), the same pattern as `ingest` and `hooks`.
- **Audit shape.** Migration `0101_settings_audit.sql` (the lead's number) adds `before_json`,
  `after_json`, `origin`, `reason` and `setting_key` to `audit`, and `origin`, `reason`,
  `setting_key` to `platform_audit`, with a partial index per table on `setting_key`. Both sides
  are stored as A-13's `{stored, version, effective, source}` so one renderer reads both tables.
  The origin vocabulary is code (`SETTING_ORIGINS`), not a CHECK, so a new origin needs no
  rebuild of an append-only table. One row per changed setting: a multi-field route writes
  several rows under its existing action (`product.update`, `storefront.polarisKey.update`, …).
- **Switched writers.** Product PATCH (name, licence defaults, admin group), Revert to manifest,
  the catalog publish (`config.catalog`, rich: the caller's statements ride in the batch), the
  licence policy (fingerprint, auto-issue) and its revert, services and its revert, device trust
  policy, update settings (metadata access, compatibility window, operator policy) and their
  revert, the portal listing (`storefront.polarisKey.*`), and feed retention. All bespoke routes
  write in compatibility mode (`strict: false`: no version in their contracts); ST-05's generic
  API is strict. A-13's platform-settings route keeps its own versioned write path for A-13's
  keys (ST-05 folds it in); `writeSetting()` writes any other platform key.
- **Claims.** On a repo-linked product a console write to a claimable key claims it; on a manual
  product no claim row is written for a claimable or manifest key (ST-01b's rule, so a later
  link still applies the manifest) and its version stays 0. Keys claimed through a legacy marker
  (`services_source`, `access_source`, `compat_source`, the policy markers) keep their pre-ST-04
  behaviour on the system product; every row-claimed key there is refused until ST-20.
- **The product PATCH now applies the registry specs.** A value outside an entry's value spec is
  refused 422 `invalid_value`: the name and the admin group are at most 200 characters, the
  device limit at most 1,000,000 (the offline grace keeps its 1–365 check). An empty PATCH (no
  field) writes nothing: no `product.update` row, and `modified_at` is not bumped.
- **Retention's author.** `writeSetting()` takes an optional `author` for the stored rows;
  `setPruneRetention()` (the feed route's write) keeps the table's `admin:<sub>` spelling.
- **Expired claims.** The write path reads an expired break-glass row (`expires_at` passed) as
  no claim, version 0, exactly as the resolver does; a write over it restarts the version at 1.
- **Not wired here.** `identity.reservedDisplayTerms` and `identity.displayNameApproved` are
  `pending: { wp: "PX-W13b" }`: wiring them needs the manifest validator to take extra terms and
  an approval (a `shared-manifest` change). PX-W13b, registered for it, does that.

### Batch 3 integration (2026-10-06, the one main merge)

- **ST-20 on the one write path.** `writeSetting()` takes `breakGlass` (`{ reason, seconds? }`):
  on a manifest-authoritative product (the system product always) a console write to a governed
  key, a claimable key claimed through a `product_settings` row, is refused
  (`manifest_authoritative`) without it; with it the claim row stores the reason and
  `expires_at` (at most 7 days, `invalid_break_glass` beyond), and the audit summary may take the
  outcome (`audit.summary` as a function). A key with a `systemLock` is refused on the system
  product (`locked`). The mode's reading moved to `core/settings/authority.ts` (re-exported by
  `settingsClaims.ts`); `decideClaim`, `stmtSetManifestAuthority` and `claimFacts` are gone. The
  products PATCH (including the mode itself, `core.manifest.authoritative`) and the catalog publish
  route their break-glass through it; ST-20's apply side (`claimsForApply`,
  `endBreakGlassStatements`) stays, its column writes now through the column adapters.
- **LX-06 through `writeSetting()`.** `writeRowSetting` / `revertRowSetting` keep their checks and
  answers and write through it (a row-backed Revert with the snapshot's value puts a
  `source = 'manifest'` row back). The inlined `system_product` refusal is gone: the system
  product and any manifest-authoritative customer product are decided like every other governed
  key (break-glass). The resolver applies `legacyDefault` (by `products.created_at`) and
  `systemLock`. The settings registry reaches the portal's consent view from `dispatch.ts`, and
  `resolvedEntitlementModel` reads `licensing.entitlementModel` through the resolver; by the
  lead's decision D1 on LX-06, `entitlementModelFor` stays `legacy` until LX-09 switches it (a
  test pins that a product registered after the cut-over still reads legacy in the consent view).
- **ST-19b.** `core.registration`'s adapter and probe were in place; the `.pkey/release` block's
  column entries got decode-only adapters (`release.github`, `binaryName`, `channelWorkflow`,
  `betaBranch`, `summaryMarker`, `manualChannels`, `keys`), and the four discovery-carried ones
  probes that write as the manifest writer does. `linkExisting.ts`'s link is a listed manifest
  writer.
- **For batch 4.** `core/settingsBackfill.ts` (ST-01c) is listed as a manifest writer, skipped
  while absent. PX-W9's `keyEntryLimit(db, product)` maps to
  `resolveProductSetting(ctx, product, "identity.keyEntry.limit")` (the value, else
  `KEY_ENTRY_LIMIT_DEFAULT`): the same row, validation and default, plus the platform bound
  (`identity.keyEntry.limit` at platform scope, `max`) and expired-claim handling; its five callers
  need the settings context (`env`, `db`, the registry).

## Steps

1. Resolver with property tests.
2. `writeSetting()` and audit.
3. Switch existing writers one by one.

## Acceptance criteria

- [x] Resolver property tests cover every source and the policy clamp direction
      (`test/settings-resolver.test.ts`, with A-13 parity and the loaders).
- [x] `gen:transcripts --check` is unchanged.
- [x] No handler writes a registry-backed column outside `writeSetting()` (test:
      `test/settings-writes.test.ts`; discovery agreement: `test/settings-discovery.test.ts`).
- [x] The green gate passes (`AGENTS.md`), including every drift gate listed in the header. Before
      the lead numbered the migration (0101), its only red was record-deploy's migration-name
      check and `checkRepresentable`'s migration order on the placeholder.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm gen:transcripts -- --check
```

## Hand-off

- ST-05, ST-11, ST-15, ST-16 and ST-24 build on the resolver and `writeSetting()`.
- **ST-05** (follow-ups from ST-04's review):
  - N5a: on a manual product a claimable or manifest key keeps no `product_settings` row, so its
    version stays 0 and the strict API cannot detect a concurrent console edit of it; decide
    whether such keys get a version row (it must not read as a claim when the product is linked
    later).
  - N5b: `WriteOptions.confirm` is one typed key per call, so a batch with two L2/L3 keys cannot
    confirm both; take one confirmation per key.
  - N6: the resolver sets `lockedBy: "platform"` whenever a bound exists, even when it did not
    clamp; set it only when the bound changed the value (or rename it), and update the console.
  - N7: the catalog publish stores the whole catalog in `after_json` (and the previous one in
    `before_json` once decoded); cap or summarise rich values in the audit row.
  - N9: a THREAT-MODEL note for `writeSetting()` as the one write path (what strict and
    compatibility mode each enforce, the guard, and the A-13 route folded in).
  - Fold A-13's platform-settings route into `writeSetting()` (strict), filling `origin` and
    `setting_key` on its `platform_audit` rows.
- **ST-20** (done in the batch 3 merge): break-glass claims set `product_settings.expires_at`
  through `writeSetting()`'s `breakGlass` option; an expired claim reads as none on both paths.

The role agent sets `--set ST-04 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set ST-04 done`.
