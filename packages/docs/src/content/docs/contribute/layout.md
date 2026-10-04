---
title: "Monorepo layout"
description: "The package map, the Worker's core/ and services/ split, the boundary test that enforces it, mount.ts as the composition root, the service table, and the checklist for adding a service."
sidebar:
  order: 3
---

The `pnpm` + `turbo` JS workspace covers `packages/*`, `tools`, `products`, and the Node
conformance runner. Python, Swift, Godot and Kotlin are standalone toolchains under `sdks/`, with their
own package managers and their own place in CI.

## The map

```
packages/
  shared-protocol/   @polaris-key/protocol     per-service wire types (subpath exports)
  shared-jws/        @polaris-key/jws          frozen EdDSA compact-JWS encode/verify
  shared-catalog/    @polaris-key/catalog      data-driven config catalog + Ajv validation
  shared-manifest/   @polaris-key/manifest     `.pkey/` manifest parsing + validation
  client-core/       @polaris-key/client-core  isomorphic verify/trust/gate/clock floor
  worker/            @polaris-key/worker       the Cloudflare Worker (core/ + services/<slug>/)
  admin/             @polaris-key/admin        the admin SPA + customer portal (React + Vite)
  cli/               @polaris-key/cli          the `pkey` CLI (manifests, bundle mint)
  sdk-node/          @polaris-key/node         full client + CLI adapters
  sdk-react/         @polaris-key/react        browser-OIDC + desktop-over-node + login UI
  docs/              @polaris-key/docs         this site — Astro Starlight, served at /docs
sdks/
  python/            polaris-key (PyPI)        full client + CLI adapters
  swift/             PolarisKey (SwiftPM)      native CryptoKit + SwiftUI login
  godot/             Godot addon               pure-GDScript verify and a headless runner
  kotlin/            Gradle build              :core + the service modules + :update + :packs + :sdk (JVM), the :conformance runner; :platform, :android (Android)
conformance/          corpus/v2 ONLY (one signer's golden vectors) + the Node runner
tools/                sign-corpus.ts · gen-mirrors.ts
products/             per-product data (catalog.json + product.json) + gen-seed
docs/                 repo-only operator material — RUNBOOK, DEPLOYMENT, PRIVACY — plus
                      security/ and superpowers/ (historical); the adopter/config/concepts
                      guides moved into this site (see the AGENTS.md mapping table)
```

Two directories are both called `docs` and are not the same thing: `packages/docs/` is this
site's source; the repo-root `docs/` is long-form markdown, most of it repo-only (see the
README's Documentation section). Where this page says "the docs site" it means the former;
where it names a file like `docs/RUNBOOK.md` it means the latter.

## Inside the Worker: `core/` and `services/<slug>/`

`src/core/` is the always-on substrate: the product registry, the device principal, trust and
signing, discovery, rate limiting, the error taxonomy, audit, and manifest-ingest dispatch. Each
`src/services/<slug>/` is one opt-in service — `license`, `config`, `release`, `distribution`,
`update`, `identity`.

A service module may import:

1. `../../core/…` — the substrate above.
2. anything within its own service directory.
3. a declared package dependency (`@polaris-key/*`, or any other entry in the Worker's own
   `package.json` `dependencies`).
4. Node builtins (`node:*`).

Everything else is refused, and in particular one service may not import another's directory.
The **one** sanctioned exception is `services/update → services/release`: Update renders a feed
over Release's truth store, which is a hard dependency by design. Every other cross-service need
goes through a Core-mediated interface — a hook on `ServiceDescriptor` that Core calls and the
service answers, never a direct import between services. The chain release ← distribution ←
update is not a licence to import along it: Distribution reads Release, and Update reads
Distribution, only through the **descriptor hooks** in `core/hooks.ts` (`releaseCatalog`,
`delivery`, `outletCapabilities`). Core builds them per request from the registry and the
product's enablement, and each answers `null` — without running the provider's code — while the
service that provides it is off. Hooks are read-only, and each has exactly one provider.

### Enforcement: `boundaries.test.ts`

`packages/worker/test/boundaries.test.ts` walks every file actually present under
`src/services/` and asserts the rule above holds — exhaustively, not on a sample. It is a test
rather than an ESLint rule because this repo has no ESLint installed (`pnpm lint` is Prettier);
a test runs on the same gate everything else does, needs no new dependency, and can say _why_
in its failure message.

The identity service is the one that exercised the rule hardest: its OIDC sign-in mints and
claims licenses, and its browser session enforces the same build gate License's document route
does. Neither need became an `identity → license` import — both became `core/authz.ts` and
`core/gate.ts`, with License re-exporting them so there is exactly one definition of each. That
move is what "cross via a Core-mediated interface" means in practice, and the boundary test is
what stops the cheaper answer — a direct import — from being taken next time.

## `mount.ts`: the composition root

`src/mount.ts` holds one map, `SERVICES`, built once at module scope from the service
descriptors. It is deliberately not inside `core/`: Core owns dispatch and knows nothing about
which services exist — `core/registry.ts` takes a registry as a parameter rather than importing
one — and importing the descriptors is the composition root's job, not Core's.

The service _names_ are not declared here either. They are rows of the service table, below;
`router.ts`'s `SERVICE_NAMESPACES`, the discovery document and Core's enablement map all iterate
the generated `SERVICE_SLUGS`, and a test fails until every row has its `mount.ts` entry.

## The service table

`tools/services.json` is the one declaration of the opt-in services: one row per slug, in
canonical order, carrying the label, the console summary, `defaultEnabled`, the coherence
`requires` edges, the legacy `.pkey/product` module names that enable it, the console accent
token and icon, and the docs path. Core is not a service and has no row.

`pnpm gen:services` (`tools/gen-services.ts`) writes every language's constants from it, each
file carrying a GENERATED banner:

| Generated file                                                               | Read by                           |
| ---------------------------------------------------------------------------- | --------------------------------- |
| `packages/shared-manifest/src/services.generated.ts`                         | the manifest package, Worker, CLI |
| `packages/admin/src/services.generated.ts`                                   | the console                       |
| `packages/sdk-node/src/services.generated.ts`                                | the Node SDK                      |
| `packages/sdk-react/src/core/services.generated.ts`                          | the React SDK                     |
| `sdks/python/src/polaris_key/_services.py`                                   | the Python SDK                    |
| `sdks/swift/Sources/PolarisKeyCore/ServiceSlug.generated.swift`              | the Swift SDK                     |
| `sdks/godot/addons/polaris_key/core/services_generated.gd`                   | the Godot SDK                     |
| `sdks/kotlin/core/src/main/kotlin/im/plrs/key/core/ServiceSlug.generated.kt` | the Kotlin SDK                    |

`pnpm gen:services -- --check` regenerates in memory and fails on any difference; it runs in the
green gate, in CI and in the pre-commit hook. The console and the SDKs get their own generated
files rather than importing the manifest package because they must not depend on a manifest
parser.

What is **not** generated is real code — directories, descriptors, views, docs pages — and the
coherence error codes, which stay literal (`update_requires_distribution`) because the rule-9 parity
test reads codes from validator source. For each of those an assertion test names what a new
row is missing, so the drift gate, not a reviewer's memory, produces the list below.

## Adding a service

Follow the steps in order. After step 2, `pnpm test` fails with a message per missing piece;
work down the list until it passes.

1. **Confirm the production Worker tolerates unknown slugs.** A newer build writes the new slug
   into `products.services_json`; an older build must carry it through rather than reset the
   record (P0-08). Confirm the production deploy includes that before the first slug ships.
2. **Add the row** to `tools/services.json` and run `pnpm gen:services`. Commit the generated
   files with it.
3. **Directory and descriptor.** Create `packages/worker/src/services/<slug>/` with an
   `index.ts` exporting its `ServiceDescriptor` (`slug: "<slug>"`). `boundaries.test.ts` scans
   it from then on.
4. **`mount.ts`.** Import the descriptor and add it to `SERVICES` in table order
   (`serviceTable.test.ts` checks keys and order).
5. **Coherence.** For each `requires` edge `<a> → <b>`, add a literal `<a>_requires_<b>` to
   `validateServices` in `packages/worker/src/core/services.ts` and to the manifest validator
   (`packages/shared-manifest/src/index.ts`) with its rule-9 mutation-table entry, and a
   message to the console's `SERVICE_ERROR_MESSAGES`. An edge that is removed takes its code,
   its mutation entry and its message with it (P2b-01 retired `update_requires_release` this
   way when `update → release` became `update → distribution`).
6. **Manifest schema.** Add the slug (and any new legacy module name) to
   `$defs.modules.properties` in `packages/shared-manifest/schemas/v1/product.schema.json`.
7. **Migrations and `TABLE_OWNERS`.** Any tables the service owns get a D1 migration and an
   entry in `TABLE_OWNERS` (`packages/docs/scripts/gen-reference.mjs`); regenerate the reference
   pages.
8. **OpenAPI and `routeCoverage`.** Add the slug to the discovery document's
   `services.required` in `packages/worker/openapi/polaris-key.v3.yaml` (in table order), and
   every new route to the spec and to `routeCoverage.test.ts` (rule 10).
9. **Console.** A `SECTIONS` entry in `packages/admin/src/console/nav.ts` with the table's accent (the
   slug) and its pages (each with a path, an icon and a docs link), a page module in
   `packages/admin/src/console/pages/`, a section accent in
   `@polaris-key/brand` (`packages/brand/src/tokens/services.ts`; its `services.test.ts` fails
   until there is one, and `gen:brand` emits the `[data-service="<slug>"]` rule), and the row's
   icon in `ServicesCard`'s `SERVICE_ICONS` (a type error until it is there).
10. **Docs.** A `packages/docs/src/content/docs/services/<slug>/` section with an `index` page,
    and its entry under "Services" in `packages/docs/astro.config.mjs`, in table order.
11. **Parity and SDKs.** The feature registry (`conformance/parity/features.json`) must accept
    the slug as a feature's `service`; SDK sub-clients for the service follow their own work.
12. **Skills and agent files.** Update `AGENTS.md`'s repo notes and the
    `authoring-pkey-manifests` skill if the manifest vocabulary changed.

## One worker, one deployment

There is exactly one Cloudflare Worker (`wrangler.toml`'s `name = "polaris-key"`), multi-tenant
by product slug — every D1 row, KV key, Durable Object shard, and signature is scoped by
`<product>`, and the URL shape is `key.plrs.im/<product>/…`. There is no per-product or
per-service worker to keep in sync.

The admin SPA (`packages/admin`) and this docs site (`packages/docs`) are both built to static
assets and assembled into that **same** Worker's one `[assets]` root
(`pnpm --filter @polaris-key/worker assemble`), so a single `wrangler deploy` ships the data
plane, the console, and the docs site together. See
[Releasing](/docs/contribute/releasing/) for how that deploy is triggered and gated.
