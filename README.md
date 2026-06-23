# Polaris Key

A reusable, multi-product **licensing + remotely-managed-config + release-distribution**
platform — a single Cloudflare Worker at `key.plrs.im` plus SDKs for Node, Python, Swift,
and React. Extracted and generalized from DJDL's baked-in system so any product can adopt
licensing, signed config delivery, OIDC enrollment, tiers/entitlements, and GitHub-connected
release distribution (Sparkle appcasts, binaries, changelogs).

> Status: **early build (Phase 0)** — the frozen wire contract + cross-language conformance
> spine are in place. See the master plan referenced in the project tracker for the full roadmap.

## Monorepo layout

```
packages/
  shared-protocol/   @polaris-key/protocol  — wire types ONLY (ManagedConfigDoc, …)
  shared-jws/        @polaris-key/jws        — frozen EdDSA compact-JWS encode/verify
  shared-catalog/    @polaris-key/catalog    — product config catalog loader + validation (WIP)
conformance/
  corpus/v1/cases.json — the cross-language golden corpus (one signer, four runners)
  runners/node/        — the Node conformance runner (Python/Swift/React mirror it)
tools/
  sign-corpus.ts       — signs the corpus (deterministic Ed25519); `--check` = CI drift guard
  gen-mirrors.ts       — emits typed catalog mirrors (TS/Python/Swift) (WIP)
infra/                 — Terraform (Cloudflare D1/KV/custom domains) (WIP)
```

## The frozen wire contract

The managed-config document is a compact **JWS (EdDSA / Ed25519)**:

```
header       = {"alg":"EdDSA","kid":<kid>}            (key order fixed)
signingInput = base64url(utf8(JSON(header))) "." base64url(utf8(JSON(payload)))
signature    = Ed25519 over the ASCII bytes of signingInput
compact JWS  = signingInput "." base64url(signature)
```

The verifying key is selected by the header `kid` from a trust set (never from the document);
`alg` is asserted `EdDSA` before any signature math. The payload (`ManagedConfigDoc`) is
product-scoped via `aud` + `iss`. The encoding is pinned byte-for-byte by
`conformance/corpus/v1/cases.json`, which every SDK verifies.

## Develop

```sh
pnpm install
pnpm build          # build all packages
pnpm test           # run all tests (incl. the conformance runner)
pnpm typecheck
pnpm gen:corpus            # regenerate the conformance corpus
pnpm gen:corpus -- --check # fail if the committed corpus is stale (CI gate)
```
