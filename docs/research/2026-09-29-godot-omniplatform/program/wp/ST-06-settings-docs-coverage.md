# ST-06 `gen:settings`: generated settings reference page, ⌘K index and `--check`; `settings-coverage.test.ts` with a `PENDING` allow-list that only shrinks

| Field       | Value                                                                                                   |
| ----------- | ------------------------------------------------------------------------------------------------------- |
| Phase       | ST: Settings architecture (S-18) (phase 1: foundation)                                                  |
| Size        | 0.5–0.7 engineer-weeks                                                                                  |
| Depends on  | [ST-03](ST-03-settings-registry.md), [ST-02](ST-02-platform-inventory.md)                               |
| Unblocks    | [ST-10](ST-10-settings-search.md)                                                                       |
| Role        | `pkey-implementer`                                                                                      |
| Plan mode   | no                                                                                                      |
| Gates       | generated docs pages (`docs gen:check`; regenerate, never hand-edit); docsLinks; drift gate (`--check`) |
| Human input | none                                                                                                    |
| Repo        | `vladzaharia/polaris-key`                                                                               |

## Goal

`gen:settings` generates the settings reference docs page and the ⌘K index from the registry, with `--check`; `settings-coverage.test.ts` fails when a setting exists without a registry entry, using a `PENDING` allow-list that may only shrink.

## Why

"Configure everything" stays true only if a gate catches a new setting with no home ([S-18 §4.13](../../notes/S-18-settings-architecture.md#413-drift-gates-keeping-configure-everything-true)).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [S-18 owner decisions](../../notes/S-18-settings-architecture.md) (the 2026-10-04 header block; it wins over the sections below it).
- [S-18 §4.13](../../notes/S-18-settings-architecture.md#413-drift-gates-keeping-configure-everything-true), [S-18 §6.2](../../notes/S-18-settings-architecture.md#62-work-packages) row ST-06.

## Scope

**In:**

- Generator and `--check`; docs page; ⌘K index.
- Coverage test with the shrinking `PENDING` list.

**Out** (and where it belongs instead):

- The ⌘K UI (→ ST-10).

## Design notes

- Generated pages are regenerated, never hand-edited (rule 3).
- The coverage test fails on a listed-but-registered entry, so the list only shrinks.

## Steps

1. Generator.
2. Coverage test.
3. Wire into the gate.

## Acceptance criteria

- [x] `gen:settings --check` passes and fails on a stale page.
- [x] The coverage test fails on an entry that is both pending and registered.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Corrections and decisions (ST-06 implementation, 2026-10-05)

The code is the fact; these record where it, or an open question, shaped the work.

- **Page path.** S-18 §4.13 names `reference/settings.md`; every page in that directory is `.mdx`
  with an MDX-comment GENERATED banner, so the page is `reference/settings.mdx`.
- **Where the generator lives.** The registry is TypeScript assembled by `mount.ts`, and
  `packages/docs/scripts/gen-reference.mjs` is a regex-over-source `.mjs` emitter that cannot
  import it. `gen:settings` is therefore a Worker script (`packages/worker/scripts/gen-settings.ts`,
  run by `tsx` like ST-02's `gen:platform-inventory`) that writes both outputs; the worker suite's
  `settings-generated.test.ts` byte-compares them, so `pnpm test` (and the gate) catches a stale page
  without a separate gate step. `pnpm gen:settings -- --check` is added to CI and `AGENTS.md`.
- **The ⌘K index** is `packages/admin/src/console/settings.generated.ts`: `SETTINGS_INDEX` (one record
  per entry: key, aliases, scope, entity, service, area, label, description, keywords, docs,
  ownership, critical, secret, pending, deprecated) and `NOT_A_SETTING_INDEX` (the fixed-on-purpose
  rows search explains). It carries no hrefs: deep links belong to ST-10, over ST-08's hub routes.
  It is added to `docsLinks.test.ts`'s sources, so every entry's `docs` page is link-gated.
- **Coverage data** lives in `packages/worker/scripts/settings-coverage.ts` (data plus a pure
  `checkCoverage`, read by the test and the generator, never at runtime; not under `src/`, because
  it names the credential tables and `outletCredentialReach.test.ts` allows only their accessors
  in the Worker source to do so): `NOT_A_SETTING` (S-18 A.4's
  rows plus rows explaining the concrete targets), `PENDING` (59 entries, each with its owning work
  package) and `PENDING_CEILING` (equal to the length; lower it with every removal).
- **Targets.** Ownership markers are every column named `source` or ending `_source` in the
  migrated schema (26 today). Settings-shaped tables are an explicit list plus any table ending in
  `_settings`, `_config`, `_policy` or `_policies`. "Every `env.<NAME>` read" is checked as every
  `Env` member in ST-02's inventory, which ST-02's gate keeps a superset of every name `src/` reads;
  bindings and secrets are explained as a class. Manifest fields are the top-level properties of
  the `product`, `schema`, `release` and `distribution` schemas (a property declared `false`, such
  as distribution `capabilities`, cannot appear and is skipped); nested-field parity is ST-19's.
- **What declares a target.** A column storage declares its column and table; a rich adapter
  declares its table and that table's row-level markers; a `varName` declares its env name; a
  manifest path declares its top-level field; the six legacy product/release markers are declared
  through the value column each governs (`SOURCE_MARKERS`). `platform_settings` and
  `product_settings` are the registry's own stores.
- **PENDING owners (decided by the lead's delegation, recommended option).** SQL-only stores and
  the email cap var: ST-11. API-only stores (store settings and credentials, outlet credentials,
  store-product mapping, the Apple team id): ST-12. Listing tables and the `listing:` block:
  ST-13. `portal_product_settings`: ST-14. Feeds policy and email sender vars: ST-09. Operator-owned
  product objects the hub hosts (keys, secrets, channel and pack floors): ST-08. Every
  manifest-declared field or table with no entry yet (the release GitHub block and columns,
  deliverables, channel policy, publishing, transports, provisioning, duplicate spellings): ST-19,
  whose registry ↔ manifest parity test needs exactly these entries. ST-25 still closes the list.
- **PENDING owners must be registered work packages** (checked against `workpackages.json`); the
  test does not check their status, so marking a package done never breaks the gate by itself.

## Verify

```sh
mise exec node@22 -- pnpm gen:settings -- --check
mise exec node@22 -- pnpm --filter @polaris-key/worker test
```

## Hand-off

- ST-10 reads the index; ST-11, ST-14 and ST-25 shrink `PENDING`.

The role agent sets `--set ST-06 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set ST-06 done`.
