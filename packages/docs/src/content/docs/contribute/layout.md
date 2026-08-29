---
title: "Monorepo layout"
description: "The package map, the Worker's core/ and services/ split, the boundary test that enforces it, and mount.ts as the composition root."
sidebar:
  order: 3
---

The `pnpm` + `turbo` JS workspace covers `packages/*`, `tools`, `products`, and the Node
conformance runner. Python and Swift are standalone toolchains under `sdks/`, with their own
package managers and their own place in CI.

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
`src/services/<slug>/` is one opt-in service — `license`, `config`, `release`, `update`,
`identity`.

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
service answers, never a direct import between services.

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

`src/mount.ts` holds one map, `SERVICES`, built once at module scope from the five service
descriptors. It is deliberately not inside `core/`: Core owns dispatch and knows nothing about
which services exist — `core/registry.ts` takes a registry as a parameter rather than importing
one — and knowing the five names is the composition root's job, not Core's.

Adding a service is two edits, both outside Core: one entry in `mount.ts`'s map, and its slug in
`router.ts`'s `SERVICE_NAMESPACES` set. Core never learns the name.

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
