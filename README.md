# Polaris Key

A reusable, multi-product **licensing + remotely-managed-config + release-distribution**
platform — a single Cloudflare Worker at `key.plrs.im` plus SDKs for **Node, Python, Swift,
and React**. An always-on **Core** substrate (product registry, the device principal, trust
and signing, discovery, rate limiting, audit) carries five services a product opts into one
at a time: **License** (activation, tiers, entitlements), **Config** (signed config/secret
delivery, edge token minting), **Release** (GitHub-connected release truth, artifacts,
changelogs), **Update** (Sparkle appcasts, version feeds), and **Identity** (OIDC, browser
sessions, customer portal). Any product registers as data (no worker redeploy) and enables
only what it uses — Config serves any registered device with no licence in the picture.
Extracted and generalized from DJDL's baked-in system; djdl is the first product.

## Monorepo layout

```
packages/
  shared-protocol/   @polaris-key/protocol     — per-service wire types (subpath exports)
  shared-jws/        @polaris-key/jws          — frozen EdDSA compact-JWS encode/verify
  shared-catalog/    @polaris-key/catalog      — data-driven config catalog + Ajv validation
  shared-manifest/   @polaris-key/manifest     — `.pkey/` manifest parsing + validation
  client-core/       @polaris-key/client-core  — isomorphic verify/trust/gate/clock floor
  worker/            @polaris-key/worker       — the Worker (core/ + services/<slug>/)
  admin/             @polaris-key/admin        — the admin SPA (React + Vite)
  cli/               @polaris-key/cli          — the `pkey` CLI (manifests, bundle mint)
  sdk-node/          @polaris-key/node         — full client + CLI adapters
  sdk-react/         @polaris-key/react        — browser-OIDC + desktop-over-node + login UI
sdks/
  python/            polaris-key (PyPI)        — full client + CLI adapters
  swift/             PolarisKey (SwiftPM)      — native CryptoKit + SwiftUI login
conformance/         corpus/v2 (one signer's golden vectors) + the Node runner
tools/               sign-corpus.ts · gen-mirrors.ts · gen-services.ts + services.json (the service table)
products/            per-product data (catalog.json + product.json) + gen-seed
docs/                CONCEPTS · ADOPTER-GUIDE · CONFIG-AUTHORING · RUNBOOK · DEPLOYMENT
                     security/ (threat model, wire contract v3, audit + findings)
```

## The frozen wire contract

Every signed artifact is a compact **JWS (EdDSA / Ed25519)**:

```
header       = {"alg":"EdDSA","typ":<typ>,"kid":<kid>}   (key order fixed)
signingInput = base64url(utf8(JSON(header))) "." base64url(utf8(JSON(payload)))
signature    = Ed25519 over the ASCII bytes of signingInput
compact JWS  = signingInput "." base64url(signature)
```

The verifying key is selected by the header `kid` from a trust set (never from the
document); `alg` is asserted `EdDSA` before any signature math. Wire v3 domain-separates
four artifacts by `typ` over one shared envelope (`iss` + `aud` + `deviceId` + `issuedAt`
/ `expiresAt` / `graceUntil`): `pkey-license+jws` carries the grants, `pkey-config+jws`
carries config + secrets, `pkey-trust+jws` is the trust manifest, and `pkey-bundle+jws`
is the offline activation bundle. Splitting the old fused document in two is what makes
the services independent on the wire, not just in the router — a config document mentions
no licence at all. The encoding is pinned byte-for-byte by
`conformance/corpus/v2/cases.json`, which **every SDK and the worker verify identically**
— that is how five languages agree on the wire. `docs/security/WIRE-CONTRACT-V3.md` is the
normative spec.

## Architecture at a glance

- **Multi-tenant, product-scoped:** every D1 row, KV key, DO shard, and signature is scoped
  by a product slug; the URL is `key.plrs.im/<product>/…`. Storage is KV (hot-path token/key
  lookups) + D1 (relational metadata, release state, account/device records).
- **One enablement authority:** `products.services_json` says which services a product runs,
  fed by its `.pkey/product` manifest. Route mounting, discovery, the console nav and portal
  capabilities are all projections of it, so they cannot drift apart; a service the product
  has not enabled 404s rather than 403s — from the outside it does not exist.
- **Data-driven schema + tiers:** a product's config/secret/flag catalog and tiers/profiles
  are data; the effective config is `tier(profile) → license → device`.
- **Identity activation + provisioning hooks:** browser sign-in at `/<product>/identity/auth/*`
  mints/locates a license by subject; verified claims drive entitlements + host-allowlisted
  secrets.
- **Edge-mint + releases:** generic per-product token minting (Apple MusicKit) under Config at
  `/<product>/config/mint/*`, and GitHub-App release distribution split across Release (truth:
  sync, channels, artifacts, changelogs) and Update (the feed: Sparkle appcasts, `/version`,
  eligibility).

## Develop

```sh
pnpm install
pnpm build              # build all packages
pnpm typecheck
pnpm test               # all JS/TS suites (incl. conformance + worker + SDKs + admin)
pnpm gen:corpus -- --check   # conformance drift gate (CI)
( cd sdks/python && .venv/bin/python -m pytest )   # Python SDK
( cd sdks/swift && swift test )                    # Swift SDK
```

Run the JS suites on **Node 22** (`mise exec node@22 -- pnpm test`), the version CI pins. The
worker suite drives D1 through the native `better-sqlite3`, so a newer Node major leaves it
unbuildable and the whole worker package fails to collect.

Operations: `docs/RUNBOOK.md`. Onboarding a product: `the docs site (`/docs/build/onboarding/`)`.
Production bootstrap: `docs/DEPLOYMENT.md`.

## Tests

~2,990 tests across the stack, all green: worker 1044, python 472, sdk-node 299, admin 259,
sdk-react 247, swift 195, conformance 132, shared-catalog 110, client-core 81,
shared-manifest 62, shared-jws 46, cli 33, plus protocol/tools. The worker count includes the
per-lane attack suites (`packages/worker/test/attack/`), which turn the findings in
`docs/security/2026-08-26-security-audit.md` into regression tests: a fix that quietly comes
undone is a red build rather than a rediscovery.

## Documentation

The full docs site (`packages/docs`, Astro Starlight) is served by the worker itself at
`key.plrs.im/docs`. There is no public docs origin: it is gated behind the same platform-admin
session as the console, so an unauthenticated visit redirects into sign-in at `/manage` and
returns you to the page you wanted. It carries the long-form operator and adopter material —
the runbook, deployment, config authoring, every service in depth, the generated reference
tables — that this README only summarizes.

`docs/security/` (threat model, the wire contract spec, audit findings) and `SECURITY.md`
(vulnerability disclosure) are repo-only; they are not published to the gated site.

Agents start at [`AGENTS.md`](AGENTS.md), the canonical, vendor-neutral entrypoint; human
contributors start at [`CONTRIBUTING.md`](CONTRIBUTING.md).
