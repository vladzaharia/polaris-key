# Polaris Key

A reusable, multi-product **licensing + remotely-managed-config + release-distribution**
platform — a single Cloudflare Worker at `key.plrs.im` plus SDKs for **Node, Python, Swift,
and React**. Any product registers as data (no worker redeploy) and gets licensing, signed
config delivery, OIDC activation, tiers/entitlements, generic provisioning hooks, edge token
minting, and GitHub-connected release distribution (Sparkle appcasts, binaries, changelogs).
Extracted and generalized from DJDL's baked-in system; djdl is the first product.

## Monorepo layout

```
packages/
  shared-protocol/   @plrs/protocol   — wire types (ManagedConfigDoc, aud/iss, …)
  shared-jws/        @plrs/jws         — frozen EdDSA compact-JWS encode/verify
  shared-catalog/    @plrs/catalog     — data-driven config catalog + Ajv validation
  worker/            @plrs/worker      — the Cloudflare Worker (multi-tenant)
  admin/             @plrs/admin       — the admin SPA (React + Vite)
  sdk-node/          @plrs/node        — full client + CLI adapters
  sdk-react/         @plrs/react       — browser-OIDC + desktop-over-node + login UI
sdks/
  python/            polaris-key (PyPI)       — full client + CLI adapters
  swift/             PolarisKey (SwiftPM)     — native CryptoKit + SwiftUI login
conformance/         the cross-language golden corpus (one signer, runners per language)
tools/               sign-corpus.ts · gen-mirrors.ts
products/            per-product data (catalog.json + product.json) + gen-seed
docs/                RUNBOOK.md · ADOPTER-GUIDE.md
```

## The frozen wire contract

The managed-config document is a compact **JWS (EdDSA / Ed25519)**:

```
header       = {"alg":"EdDSA","kid":<kid>}            (key order fixed)
signingInput = base64url(utf8(JSON(header))) "." base64url(utf8(JSON(payload)))
signature    = Ed25519 over the ASCII bytes of signingInput
compact JWS  = signingInput "." base64url(signature)
```

The verifying key is selected by the header `kid` from a trust set (never from the
document); `alg` is asserted `EdDSA` before any signature math. The payload
(`ManagedConfigDoc`) is product-scoped via `aud` + `iss`. The encoding is pinned
byte-for-byte by `conformance/corpus/v1/cases.json`, which **every SDK and the worker
verify identically** — that is how five languages agree on the wire.

## Architecture at a glance

- **Multi-tenant, product-scoped:** every D1 row, KV key, DO shard, and signature is scoped
  by a product slug; the URL is `key.plrs.im/<product>/…`. Storage is KV (hot-path token/key
  lookups) + D1 (relational metadata, release state, account/device records).
- **Data-driven schema + tiers:** a product's config/secret/flag catalog and tiers/profiles
  are data; the effective config is `tier(profile) → license → device`.
- **OIDC activation + provisioning hooks:** browser sign-in mints/locates a license by
  subject; verified claims drive entitlements + host-allowlisted secrets.
- **Edge-mint + releases:** generic per-product token minting (Apple MusicKit) and
  GitHub-App release distribution (channels, Sparkle appcasts, fuzzy asset/changelog
  extraction).

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

Operations: `docs/RUNBOOK.md`. Onboarding a product: `docs/ADOPTER-GUIDE.md`.

## Tests

~660 tests across the stack, all green: worker 198, sdk-react 129, sdk-node 90, admin 71,
python 63, swift 55, shared-jws 28, shared-catalog 20, conformance 13, plus protocol/tools.
Two real bugs were caught by the suite and fixed (a JWS verify that could throw instead of
failing closed; an admin `useResource` render loop).
