---
title: "Architecture"
description: "One worker, a modular monolith: core/ plus services/<slug>/, the shipped ServiceDescriptor, boundary enforcement by test, and hide-don't-reveal dispatch."
sidebar:
  order: 4
---

Polaris Key is **one deployed Cloudflare Worker**. Inside it, the code is a **modular monolith**:
an always-on `core/` substrate plus one directory per opt-in service, with a boundary between them
that is enforced on every commit. The design goal is "split-ready, not split" — the seams that
would let a service become its own Worker are real and policed, but per-service Workers are
explicitly out of scope and nothing has been split.

## The layout

```
packages/worker/src/
  core/        router.ts, products.ts, devices.ts, trust.ts, signing.ts,
               discovery.ts, rateLimit.ts, errors.ts, audit.ts, registry.ts
  services/
    license/   routes.ts, document.ts, activation.ts, tiers.ts, policy.ts, admin/
    config/    routes.ts, document.ts, schema.ts, profiles.ts, mint.ts, admin/
    release/   routes.ts, sync, channels.ts, assets, changelog, install, store.ts, admin.ts
    update/    routes.ts, feed.ts, eligibility.ts, admin.ts
    identity/  routes.ts, oidc.ts, browserSession.ts, portal/, admin.ts
  mount.ts     the composition root's service table
  router.ts    pure route matching
```

**Core owns dispatch and knows nothing about which services exist.** The list of names lives in
`mount.ts` — the composition root — and deliberately _not_ in `core/`. It is its own module rather
than part of the entrypoint because the admin API is reachable _from_ the entrypoint, so importing
the table out of there would close a cycle. The table is built once at module scope and shared by
the two dispatchers that need it: the public router and the admin API. Descriptors are stateless
route tables, so rebuilding the map per request would be work on every cold path for no benefit.

The slugs themselves are declared once, in the service table (`tools/services.json`), and
generated into every language; Core iterates them without knowing any by name. Adding a service
is a checklist rather than a one-liner — the table row, its directory and descriptor, its
`mount.ts` entry, console views and docs pages — and a drift test names each missing piece. See
[Adding a service](/docs/contribute/layout/#adding-a-service).

## The service descriptor, as shipped

`core/registry.ts` declares one interface. This is the contract a service has with Core, and it is
smaller than the design spec's sketch:

```ts
interface ServiceDescriptor {
  slug: ServiceSlug;
  handle(ctx: ServiceContext): Promise<Response | null>;
  discoveryFragment(ctx: DiscoveryContext): Promise<Record<string, unknown>>;
  adminHandle?(
    ctx: ServiceContext & { session: AdminSession },
  ): Promise<Response | null>;
  manifestIngest?(
    parsed: ParsedManifest,
    product: string,
    now: number,
  ): DbStatement[];
  manifestIngestAlways?(
    parsed: ParsedManifest,
    product: string,
    now: number,
  ): DbStatement[];
  authorizeRegistration?(ctx: RegistrationAuthContext): Promise<boolean>;
}
```

| Member                   | What it is                                                                                                                                                                                                                          |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `slug`                   | the one word used as the directory, the route namespace, the SDK sub-client and the console section.                                                                                                                                |
| `handle`                 | handles a product-scoped request. `ctx.rest` is the path _after_ `/<product>/<service>`, already split; the service owns its sub-routing from there.                                                                                |
| `discoveryFragment`      | this service's slice of `/<product>/.well-known/polaris.json`. **Only called when enabled** — Core emits `{"enabled": false}` and nothing else for the rest.                                                                        |
| `adminHandle?`           | handles `/manage/api/products/<slug>/<service>/…`. Every service implements it.                                                                                                                                                     |
| `manifestIngest?`        | rows this service wants written when a product manifest is ingested (link or resync). **Run only while the service is enabled.** Distribution implements it (P2b-02).                                                               |
| `manifestIngestAlways?`  | rows kept current on every ingest **whatever the enablement**, for a record that must already be right when the service is turned on. Distribution's `app` delivery-access row is its one user (P2b-04).                            |
| `authorizeRegistration?` | may this caller be given a device credential? Only Identity implements it.                                                                                                                                                          |
| descriptor hooks         | `releaseCatalog?` (Release), `delivery?` and `outletCapabilities?` (Distribution), `licenseProvenance?` (License): read-only views another service reads through `ctx.hooks`, gated on the provider's enablement (`core/hooks.ts`). |

Three details in that interface are load-bearing:

**`handle` returns `null`, not a 404, when no route inside the service matched.** Only Core knows
whether "no match" should be a `404`, a fall-through to the alias table, or a redirect, and
centralising that decision is what keeps the not-found response byte-identical whether a service is
disabled, absent, or simply has no such route.

**`manifestIngest` runs inside Release's link and resync batch.** Core's pipeline
(`manifestIngestStatements`) runs each enabled service's hook and hands the statements to the
ingest, so a service's rows land atomically with the rest without Release importing the service.
A disabled service's hook does not run. `manifestIngestAlways` is the one exception: Core runs it
whatever the enablement, because turning a service on in the console runs no ingest. It may write
only a record that does nothing until its service is on. Both return the repo's own `DbStatement`,
not a `D1PreparedStatement`, because every batch site in the worker goes through the `Db`
abstraction so the same code runs on D1 and on the in-memory SQLite the tests use.

**`authorizeRegistration` is the one place Core delegates an authorization decision to a service.**
It exists because one of the three registration policies is named after a service:
`requires-identity` means "register, but only behind a product login", and only Identity knows what
a product login looks like. It is deliberately _not_ given a `ServiceContext` — there is no route
here and no path to route, and handing a service the shape it answers requests with would invite it
to answer this one with a `Response`. The contract is a **predicate**; status, body, and whether a
reason is disclosed all stay Core's. A descriptor that omits it is one Core can never satisfy a
policy with, which is the correct default: an unimplemented hook must not read as an open door.

## Boundary enforcement is a test, not a lint rule

A file under `src/services/<slug>/` may import exactly four things:

1. `../../core/…` — the always-on substrate.
2. anything within its own service directory.
3. a package — `@polaris-key/*` and the worker's other **declared** runtime dependencies. The set
   is read from `package.json` `dependencies`, so widening it requires a reviewed dependency change
   rather than an edit to the rule.
4. node builtins (`node:*`).

Everything else is refused, and two refusals matter most: `services/<a>/` importing `services/<b>/`,
and reaching back into legacy top-level modules (`../../repo.js`, `../../licensing.js`, …) — the
seam the whole re-organisation exists to remove, and exactly the import a hurried move leaves
behind.

:::note[The mechanism differs from the design spec]
The spec called for ESLint `no-restricted-imports` zones. What shipped is
**`packages/worker/test/boundaries.test.ts`**, a static import walk over `src/services/`. This repo
has no ESLint installed — `pnpm lint` is Prettier — so standing up a flat-config toolchain to
express one restricted-import zone would have been a larger change than the rule it enforces, and
it would not run on the gate that already covers every commit. The enforcement is equivalent and
CI-gated; only the mechanism differs.
:::

The suite is written so it cannot quietly become a no-op. It walks **every file actually present**
under `src/services/`, and it separately asserts that every service in the table was scanned, that
Identity's nested `portal/` directory was walked and not just its top level, and that the rule
itself still allows what it should and refuses what it should. A rename or a broken walk fails
loudly instead of passing on an empty set.

### The one sanctioned cross-service edge

`update → release` — and nothing else. Update renders a feed over Release's truth store, which is a
hard dependency by design. The test does not merely _permit_ the edge, it proves the edge is
**live**: if Update ever stopped importing Release the exception should be deleted rather than left
standing as a hole nothing needs. It also asserts nothing crosses back the other way.

Identity was the case that exercised the rule hardest, because it genuinely needs license-shaped
answers: its OIDC sign-in mints and claims licenses, and its browser session authorizes a device and
enforces the build gate. None of that became an `identity → license` import. It became
`core/authz.ts` and `core/gate.ts`, with License re-exporting them. That is what "everything else
crosses via core-mediated interfaces" means in practice.

## Hide, don't reveal

Enablement is enforced at dispatch, **before the descriptor is consulted**, so a disabled service's
code never runs — it cannot read a row, write an audit entry, consume a rate-limit token, or make a
timing difference that distinguishes "off" from "absent". Three different causes collapse into one
answer:

- the service is disabled for this product,
- no descriptor is registered for that slug,
- no route matched inside the service.

All three return the same `404` with the same body (`{"error": {"code": "not_found"}}`), because
telling them apart is precisely the reconnaissance being refused. It is the same posture the worker
already takes for unknown products, so probing a slug tells a caller nothing.

The router reinforces this from the other side. Platform paths — `/manage`, `/docs`, the portal
roots, `/webhooks/github` — are matched **before** product slugs, so a product slug can never shadow
them, and the same names are on a reserved list the manifest validator and the manual-create path
both enforce (`reserved_slug`), so a product can never be registered into a permanently shadowed
namespace.

### The four permanent aliases

Four paths predate service namespacing and are baked into artefacts nobody can recall — `SUFeedURL`
values compiled into shipped app bundles, and `curl … | sh` lines in published documentation. They
are kept **forever**, and they are implemented by _rewriting_: an alias resolves to the same
service route, with the same segments, as its canonical spelling.

| Alias                        | Canonical                           |
| ---------------------------- | ----------------------------------- |
| `/<p>/appcast.xml`           | `/<p>/update/appcast.xml`           |
| `/<p>/<channel>/appcast.xml` | `/<p>/update/<channel>/appcast.xml` |
| `/<p>/version`               | `/<p>/update/version`               |
| `/<p>/install.sh`            | `/<p>/distribution/install.sh`      |

P2b-04 moved every byte route from Release to Distribution and kept Release's old spellings the
same way: `/<p>/release/install.sh`, `/<p>/release/dl/…`, `/<p>/release/builds/…`,
`/<p>/release/files/…` and `/<p>/release/blobs/…` are permanent aliases of their
`/<p>/distribution/…` routes (download URLs the SDKs build, and byte URLs discovery advertised).
That rewrite runs before the service-namespace match, because `release` is itself a namespace.

There is therefore no second handler to keep in step and no way for the two spellings to answer
differently. A request carries an `alias` flag, but it exists so the route table can be asserted on
— **not** so a handler can branch; a handler that read it would re-introduce exactly the divergence
the rewrite exists to prevent. The service-namespace match runs before the channel-appcast pattern,
so a product cannot have a release channel named `release` or `update` that shadows the service it
belongs to.

`/<p>/changelog` is deliberately _not_ on that list: it was never compiled into a binary or a
published command, so it moved to `/<p>/release/changelog` outright.

## What is actually deployed

One worker, with four platform primitives behind it:

| Primitive                 | Role                                                                                                                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **D1**                    | relational metadata — products, licenses, devices, release state, portal accounts, audit                                                                                        |
| **KV** (`HOT`)            | hot-path token and key lookups                                                                                                                                                  |
| **Durable Object** (`RL`) | `RateLimitDO`, SQLite-backed rather than the legacy KV-backed class                                                                                                             |
| **Cron** (`17 3 * * *`)   | daily maintenance: audit and portal-audit retention, expired download tokens, dormant device seats, a re-run of the deploy-time index assertion, and the blob collector (P4-14) |

Every D1 row, KV key, DO shard and signature is **product-scoped**, and the URL carries the scope:
`key.plrs.im/<product>/…`. The worker also serves a single assets root assembled from two built
frontends — the admin SPA and this documentation site — with the worker matched first so the
platform routes above always win.

The odd cron minute is deliberate: `0 3 * * *` puts a job in the same second as every other cron on
the platform, and a sweep that competes with a thundering herd for D1 is a sweep that starts timing
out.

## Related

- [The service model](/docs/start/service-model/) — the enablement column the dispatcher reads.
- [Concepts & terminology](/docs/start/concepts/) — the canonical definitions.
- [Core](/docs/services/core/) — what the substrate actually serves.
- [The wire contract](/docs/build/wire/) — the byte-level document rules.
