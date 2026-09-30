# P0-09 Make the service list data-driven, with a drift gate

| Field       | Value                                                                                                                                              |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | P0: Hygiene and unblockers                                                                                                                         |
| Size        | 1–1.5 engineer-weeks                                                                                                                               |
| Depends on  | [P0-08](P0-08-unknown-slug-tolerance.md) (merged **and deployed**)                                                                                 |
| Unblocks    | [P1b-02](P1b-02-sdk-constants.md), [P2-01](P2-01-blob-store.md), [P2b-01](P2b-01-distribution-service.md)                                          |
| Role        | `pkey-implementer`                                                                                                                                 |
| Plan mode   | no (no wire shape changes; stop and escalate if one appears)                                                                                       |
| Gates       | new drift gate `pnpm gen:services -- --check` (joins the green gate, CI and pre-commit); rule 3 banner family; all SDKs; rule 9 parity stays green |
| Human input | confirmation that P0-08 is in production before this merges (record the deploy in the PR)                                                          |
| Repo        | `vladzaharia/polaris-key`                                                                                                                          |

## Goal

The set of opt-in services is declared once, in a data table. Every hand-maintained enumeration
of the five slugs in the Worker, the manifest package, the CLI, the console and the Node, React,
Python and Swift SDKs is either generated from that table or asserted against it by a test. After
this package, adding `distribution` (P2b-01) is: one table row, the service's own directory and
views, and whatever the drift gate names as missing. Nothing a reviewer has to remember.

## Why

The report decided it ([§11](../../README.md#11-decisions-needed) decision 17: "Service table
first? Yes"; [§3.2](../../README.md#32-service-model-release-distribution-and-update-across-everything-delivered)
"First, make the service list data-driven"). A new slug touches about 45 files across five
languages today ([notes/A3 §5.3](../../notes/A3-admin-dx.md#53-blast-radius-of-a-sixth-service-content)),
while the docs claim it is "one entry in `mount.ts`, one slug in `SERVICE_NAMESPACES`, and a
directory" (`packages/docs/src/content/docs/start/architecture.md:37-38`,
`contribute/layout.md:86-87`, and the comment at `packages/worker/src/mount.ts:11-12`). Core
enumerates the slugs itself (`core/services.ts:20-66`, `core/discovery.ts:74-80`). Two new services
are planned (`distribution`, and any later one), so the table pays for itself twice.

## Read first

- `AGENTS.md` (rules 3, 5, 6, 9) and `program/README.md` §7.
- [P0-08](P0-08-unknown-slug-tolerance.md): the unknown-slug passthrough this builds on.
- [notes/A3 §5.3](../../notes/A3-admin-dx.md#53-blast-radius-of-a-sixth-service-content) (the
  blast-radius list) and [PARITY §4.4](../../PARITY.md#44-generated-constants) (the later
  `tools/gen-sdk-constants.ts`, which consumes this table).
- The pattern to copy: `tools/gen-mirrors.ts` (`--check`), `pnpm gen:corpus -- --check` in
  `package.json:16`, `.github/workflows/ci.yml:33` and `.husky/pre-commit`.

## Scope

**In:** the table, the generator, the drift gate, and every enumeration below moved onto them.

The enumerations, verified against the code (line numbers at the time of writing):

| Where                                                                                                             | What it enumerates                                               | After this package                                                                     |
| ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `packages/worker/src/core/services.ts:20-66`                                                                      | `ServiceSlug`, `SERVICE_SLUGS`, `DEFAULT_SERVICES`, `defaults()` | imported from `@polaris-key/manifest` (generated)                                      |
| `packages/worker/src/core/services.ts:250-280`                                                                    | coherence rules (`update_requires_release`)                      | hand-written; test ties each table `requires` edge to a literal code                   |
| `packages/worker/src/router.ts:40-46`                                                                             | `SERVICE_NAMESPACES`                                             | built from `SERVICE_SLUGS`                                                             |
| `packages/worker/src/mount.ts:18-31`                                                                              | `SERVICES` registry (imports)                                    | hand-written; test: keys equal the table                                               |
| `packages/worker/src/core/discovery.ts:74-80`                                                                     | discovery `services` literal                                     | built by iterating `SERVICE_SLUGS`                                                     |
| `packages/worker/openapi/polaris-key.v3.yaml` (discovery `services.required`, ~line 2918)                         | five slugs                                                       | test: equals the table, in order                                                       |
| `packages/worker/test/boundaries.test.ts:184` and `registry`, `services`, `surfaces`, `router` tests              | "all five" lists                                                 | iterate `SERVICE_SLUGS`; boundaries also asserts `src/services/<slug>/` exists         |
| `packages/shared-manifest/src/index.ts:13-47`                                                                     | `ProductModule`, `ServiceSlug`, `SERVICE_SLUGS`                  | generated `src/services.generated.ts`                                                  |
| `packages/shared-manifest/src/index.ts:268-284`                                                                   | `MODULE_SERVICES`, `DEFAULT_ENABLED`                             | generated from `legacyModules`, `defaultEnabled`                                       |
| `packages/shared-manifest/schemas/v1/product.schema.json` (`modules.properties`)                                  | slugs + legacy names                                             | hand-written; test: keys equal slugs ∪ legacy names                                    |
| `packages/cli/src/manifest.ts:9-14,72-78`                                                                         | legacy module list, init scaffold                                | generated list; scaffold writes canonical slugs; `--modules` accepts both vocabularies |
| `packages/admin/src/api.ts:309-314`                                                                               | `ServiceSlug`                                                    | generated `src/services.generated.ts`                                                  |
| `packages/admin/src/api.ts:349-356`                                                                               | `SERVICE_ERROR_MESSAGES`                                         | hand-written; test: a message per coherence code                                       |
| `packages/admin/src/views/services/ServicesCard.tsx:70-106,492-500`                                               | `SERVICE_ROWS`, `emptyEnablement`                                | rows from the generated table (label, summary, icon name)                              |
| `packages/admin/src/route.ts:33-52,65-71,103-207`                                                                 | `Tab`, `ServiceAccent`, `SECTIONS`                               | hand-written views; test: one section per slug with the table's accent                 |
| `packages/admin/src/components/Shell.tsx:60-80`, `styles.css:113-161`                                             | tab icons, accent tokens                                         | hand-written; test: dark and light `[data-service="<accent>"]` rules per slug          |
| `packages/sdk-node/src/discovery.ts:25-40`                                                                        | `ServiceSlug`, `SERVICE_SLUGS`                                   | generated `src/services.generated.ts`                                                  |
| `packages/sdk-react/src/core/services.ts:21-66`                                                                   | `ServiceSlug`, `SERVICE_SLUGS`, `noServices`, `defaultServices`  | generated `src/core/services.generated.ts`                                             |
| `sdks/python/src/polaris_key/discovery.py:54-72`                                                                  | `SERVICE_SLUGS`, `_map`, `DEFAULT_SERVICES`                      | generated `polaris_key/_services.py`                                                   |
| `sdks/swift/Sources/PolarisKeyCore/Discovery.swift:31-37`                                                         | `enum ServiceSlug`                                               | generated `ServiceSlug.generated.swift`                                                |
| `packages/docs/astro.config.mjs:56-61`                                                                            | sidebar entries                                                  | hand-written; test: an entry and a `services/<slug>/` directory per slug               |
| docs prose, `AGENTS.md` and the other agent instruction files, the manifest skill, `README.md`, `THREAT-MODEL.md` | "five services"                                                  | an "Adding a service" checklist in `contribute/layout.md`                              |

Files that only import the types (`sdk-node` `core/context.ts`, `cli/*.ts`; `sdk-react`
`browser/*`, `desktop/*`, `react/Provider.tsx`; Swift `CoreContext.swift`, `PolarisKeyClient.swift`)
need no change. `products/gen-seed.ts` already iterates `SERVICE_SLUGS`.

**Out** (and where it belongs instead):

- Adding any slug (→ [P2b-01](P2b-01-distribution-service.md)).
- Error codes, header values, platform/arch enums and feature ids (→ [P1b-02](P1b-02-sdk-constants.md),
  which folds this generator's SDK outputs into `tools/gen-sdk-constants.ts`).
- Generating per-service views, descriptors, docs pages or Swift targets: those are real code.
- Correcting the docs' current one-line claim before this lands (→ [P0-11](P0-11-docs-drift.md));
  this package replaces it with the checklist.

## Design notes

- **The table** is `tools/services.json` (proposed name; one row per slug, canonical order):
  `slug`, `label`, `summary` (the ServicesCard text), `defaultEnabled`, `requires` (coherence
  edges, e.g. `update` → `["release"]`), `legacyModules` (`license` ← `licensing`, `config` ←
  `edgeMint`, `release` and `update` ← `releases`, `identity` ← `oidc`), `console.accent`
  (`key`, `config`, `release`, `update`, `id`: note License and Identity do not use their slug),
  `console.icon` (a lucide name), `docs` (`/docs/services/<slug>/`).
- **The generator** `tools/gen-services.ts` writes the files marked "generated" above, each with a
  GENERATED banner, and supports `--check` (regenerate in memory, fail on any difference). Add
  `"gen:services"` to the root `package.json`; add `pnpm gen:services -- --check` to the green gate
  in `AGENTS.md`, to `.github/workflows/ci.yml` next to `gen:corpus`, and to `.husky/pre-commit`.
  Add the family to rule 3's table in `AGENTS.md`.
- **Why not one import everywhere.** The Worker and CLI already depend on `@polaris-key/manifest`,
  so they import it. The console and the SDKs do not, and must not grow a dependency on a
  manifest parser; they get generated files. `client-core` is avoided on purpose: touching it is
  plan mode (`program/README.md` §7), and nothing here needs it.
- **Coherence codes stay literal.** `schema-parity.test.ts` extracts error codes from the
  validator **source** (rule 9), so codes built from table data would vanish from its sweep. Keep
  `update_requires_release` as a literal in both validators; a test asserts that every `requires`
  edge `<a> → <b>` has a literal `<a>_requires_<b>` in `core/services.ts` and in
  `shared-manifest/src/index.ts`, and a console message.
- **P0-08 first.** `serializeServices` must keep P0-08's passthrough of unknown slugs when it
  switches to iterating the table. P0-09 adds no slug, but the program ties it to the P0-08
  production deploy; the checklist's first step for every future slug is "confirm the production
  worker includes P0-08".
- **Discovery is on the wire but unchanged.** Keys, order and fragment shapes stay byte-identical;
  a test compares the document before and after. If any wire shape would change, stop: that is
  plan mode.
- Swift: the generated enum keeps `String`, `Sendable`, `Codable`, `Equatable`, `CaseIterable`.

## Steps

1. Write `tools/services.json` and `tools/gen-services.ts` with `--check`; unit-test the generator.
2. Generate into `shared-manifest`; switch the manifest package, the Worker and the CLI to it.
3. Generate the console, `sdk-node`, `sdk-react`, Python and Swift files; switch each to them.
4. Add the assertion tests listed in the table (Worker, manifest, console, docs).
5. Wire the gate into `AGENTS.md`, CI and the pre-commit hook.
6. Write the "Adding a service" checklist in `packages/docs/src/content/docs/contribute/layout.md`
   (table row → `gen:services` → directory and descriptor → `mount.ts` → migrations and
   `TABLE_OWNERS` → OpenAPI and `routeCoverage` → console views, accent CSS, icons → docs pages and
   sidebar → skills and `AGENTS.md`), fix `architecture.md:37-38` and the `mount.ts` comment.
7. Changesets for every published package touched.

## Acceptance criteria

- [ ] `pnpm gen:services -- --check` passes, and fails after a hand edit to any generated file.
- [ ] A scratch branch that adds a sixth row to `tools/services.json` and runs `gen:services`
      fails the assertion tests with messages naming the missing directory, descriptor, `mount.ts`
      entry, console section, accent CSS, docs sidebar entry and schema property. Record the output
      in the PR.
- [ ] The discovery document for a fixture product is byte-identical before and after.
- [ ] No source file outside the generated ones and `tools/services.json` contains a literal list
      of all five slugs (a grep in the PR shows it; tests excepted where they test the table itself).
- [ ] Node, React, Python and Swift suites pass with the generated constants.
- [ ] The green gate passes (`AGENTS.md`), including the new gate, Python and Swift.
- [ ] `parity.json` manifests are updated for every SDK this changes (once P1b-01 has landed).

## Verify

```sh
mise exec node@22 -- pnpm gen:services -- --check
mise exec node@22 -- pnpm test
mise exec node@22 -- pnpm typecheck
mise exec node@22 -- pnpm --filter @polaris-key/admin build
( cd sdks/python && .venv/bin/python -m pytest -q )
( cd sdks/swift && swift build && swift test )
```

## Hand-off

P2b-01 adds `distribution` as one row in `tools/services.json` plus what the gate demands, and
relies on P0-08 being in production. P1b-02 extends or replaces `tools/gen-services.ts` with
`tools/gen-sdk-constants.ts`, reading the same table for service slugs. P2-01 builds on the table's
existence (Core additions stay outside it: Core is not a service). When done:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P0-09 done`.
