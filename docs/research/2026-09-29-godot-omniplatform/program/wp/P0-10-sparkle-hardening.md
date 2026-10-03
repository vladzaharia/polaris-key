# P0-10 Raise Swift's Sparkle floor to 2.9.6 and stream Sparkle verification

| Field       | Value                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------ |
| Phase       | P0: Hygiene and unblockers                                                                 |
| Size        | 0.25–0.5 engineer-weeks                                                                    |
| Depends on  | none                                                                                       |
| Unblocks    | [P3-09](P3-09-updater-feeds.md)                                                            |
| Role        | `pkey-implementer`                                                                         |
| Plan mode   | no                                                                                         |
| Gates       | worker tests + `test:workerd`; Swift build and tests (macOS); new worker dependency review |
| Human input | none (a macOS runner for `swift test`; CI provides one)                                    |
| Repo        | `vladzaharia/polaris-key`                                                                  |

## Goal

Two independent hardening fixes in one small PR. (1) The Swift package cannot resolve a Sparkle
older than 2.9.6. (2) The Worker verifies a Sparkle EdDSA signature over a DMG of any size GitHub
allows without holding the DMG in memory, so a 150 MB game DMG gets a signed appcast item instead
of an isolate out-of-memory crash, and an unverifiable asset fails closed with a clean 404.

## Why

- `sdks/swift/Package.swift:57` pins `from: "2.6.4"` (the CVE-2025-0509 floor, comment at `:23-27`
  and `:56`). Sparkle 2.9.5 and 2.9.6 fixed a symlink attack in delta patching, a root
  privilege-escalation, and package installs that ignored failed signature validation
  ([notes/E6 §0](../../notes/E6-client-tools.md#0-headline-recommendations-read-this-first) item 7).
  `Package.resolved` already resolves 2.9.6; the floor does not enforce it for adopters.
  Report [§9.1](../../README.md#91-polaris-key-worth-fixing-regardless-of-godot) issue #16.
- `verifySparkleSignature` (`packages/worker/src/services/release/sparkle.ts:75-129`) calls
  `fetchAssetBytes` (`github.ts:411-429`), which reads the whole body with `res.arrayBuffer()`
  before checking its size, against a cap of 256 MiB (`sparkle.ts:24`) inside a 128 MB isolate.
  A large DMG risks an out-of-memory crash on the first appcast request and again after every
  24-hour verdict expiry; the crash is not a catchable `NotFoundError`
  ([notes/A1 §4](../../notes/A1-release-update.md#4-byte-hosting-model), issue #11).

## Read first

- `AGENTS.md` (the workerd smoke job) and the R6 audit findings (R6-03).
- `packages/worker/src/services/release/sparkle.ts`, `github.ts:311-429` (`fetchAsset`,
  `readCapped`, `fetchAssetBytes`), `services/update/feed.ts:170-200` (the caller).
- `packages/worker/test/release.test.ts:568-677` (real-keypair signature fixtures, fail-closed cases).
- `packages/worker/wrangler.toml` (`compatibility_flags = ["nodejs_compat"]`: `node:crypto`
  hashing is available in workerd).
- [notes/E6 §1.3](../../notes/E6-client-tools.md#13-ed25519-verification-profile-cross-implementation-hazard)
  (verification strictness across implementations).
- `sdks/swift/Package.swift`, `sdks/swift/README.md:24,206`, and the docs pages that state the
  2.6.4 floor: `packages/docs/src/content/docs/services/update/sparkle.md:49-52`,
  `start/quickstart.md:204`, `build/onboarding.md:227`.

## Scope

**In:**

- Swift: `from: "2.9.6"`; update the two comments, `sdks/swift/README.md` and the three docs
  pages to say 2.9.6 and why (delta-patch symlink and privilege-escalation fixes).
- Worker: a streaming Ed25519 verifier for Sparkle signatures.
  - Hash `R || A || M` with an incremental SHA-512 (`node:crypto` `createHash("sha512")`), where
    `R` is the first 32 bytes of the signature, `A` the 32-byte public key and `M` the DMG body
    read chunk by chunk from `fetchAsset`.
  - Reduce the digest mod `L` to `k`; reject `S ≥ L`; accept iff `[S]B == R + [k]A`, with point
    decoding and arithmetic from `@noble/curves` (pinned to an exact version).
  - Byte cap raised to GitHub's asset maximum (2 GiB) and enforced while streaming; an absent or
    lying `Content-Length` cannot bypass it.
- Keep every existing contract: returns `false` (never throws) for bad keys, bad signatures,
  missing or oversized assets; the KV verdict memo keeps its key
  (`sparkle.ts:40-54`: product, asset id, signature, public key).
- Raise the verdict TTL from one day to 30 days: the key covers every input, and a re-uploaded
  asset gets a new id, so a verdict cannot go stale. This cuts repeat DMG downloads from GitHub.
- Delete `fetchAssetBytes` if nothing else uses it.

**Out** (and where it belongs instead):

- Sparkle 2.9 signed feeds (`SURequireSignedFeed`), WinSparkle and other feed formats (→ P3-09).
- Moving verification to publish time (CI-signed release records) (→ P3-03).
- Serving bytes from R2 (→ P2-01, P2-05).
- Adding negative Ed25519 vectors to the conformance corpus (→ P3-02, issue #19).

## Design notes

- **Why not WebCrypto.** `crypto.subtle.verify` needs the whole message in one buffer; there is no
  streaming Ed25519 API in Workers or Node. PureEdDSA's only whole-message step is the SHA-512 of
  `R || A || M`, which can be streamed; the rest is two scalar multiplications.
- **Strictness.** Match what WebCrypto accepted before for every existing fixture: reject
  `S ≥ L`, reject undecodable points, use the cofactorless equation. Add a property test that
  signs random messages with WebCrypto and checks both verifiers agree, including a flipped bit
  in `M`, `R` and `S`, and the RFC 8032 §7.1 vectors.
- **Dependency.** `@noble/curves` is audited and depends only on `@noble/hashes` (same author,
  also audited; corrected during implementation: 2.4.0 is not dependency-free), but it is a new runtime
  dependency of the Worker (a T6 supply-chain surface, `THREAT-MODEL.md` §4). Pin the exact
  version, add it to `packages/worker/package.json` `dependencies` (the boundaries test derives its
  allowed imports from there), and say why in the PR. If review rejects the dependency, the
  fallback is a hard cap of 64 MiB with a clean 404 and a health warning, and large DMGs wait for
  P2-05.
- **Memory.** The verifier holds only the hash state and the current chunk. Cancel the reader on
  every exit path (see `readCapped`, `github.ts:354-388`, for the pattern).
- **CPU.** Native SHA-512 over 2 GiB is seconds; point arithmetic is milliseconds. Note the
  first-request latency in the PR; the 30-day memo makes it rare.

## Steps

1. Swift floor, comments, README and docs.
2. `streamingEd25519Verify(publicKey, signature, body: ReadableStream, maxBytes)` (landed as `streamingEd25519Check`/`streamingEd25519Verify` in `services/release/ed25519Stream.ts`, called from `sparkle.ts`) in
   `services/release/sparkle.ts` (or a sibling module in the same service).
3. Switch `verifySparkleSignature` to it; raise the TTL; remove the buffering path.
4. Tests in Node and a smoke test under `test:workerd` (the `node:crypto` path differs).

## Acceptance criteria

- [x] `sdks/swift/Package.swift` declares `from: "2.9.6"`; `swift build` and `swift test` pass on
      macOS; no doc in the repo still names 2.6.4 as the floor.
- [x] Worker test: the existing R6-03 fixtures (valid, tampered, wrong key, missing sidecar) give
      the same results as before.
- [x] Worker test: a lazily generated 300 MiB body with a valid signature verifies, and the test
      asserts no single buffer larger than one chunk was retained (count bytes held by the reader).
- [x] Worker test: a body larger than the cap, with or without `Content-Length`, returns `false`
      without throwing; so does `S ≥ L`.
- [x] Property test: WebCrypto and the streaming verifier agree on 200 random cases and on the
      RFC 8032 §7.1 vectors.
- [x] `pnpm --filter @polaris-key/worker test:workerd` passes with a streaming-verify smoke case.
- [x] The green gate passes (`AGENTS.md`).

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- release updateFeed R6-release
mise exec node@22 -- pnpm --filter @polaris-key/worker typecheck:workerd
mise exec node@22 -- pnpm --filter @polaris-key/worker test:workerd
( cd sdks/swift && swift build && swift test )
```

## Hand-off

P3-09 (WinSparkle and Sparkle feed extensions) reuses `streamingEd25519Check` / `streamingEd25519Verify` (`services/release/ed25519Stream.ts`) for any EdDSA
signature over a large artifact. As landed, a final negative verdict is also memoised (`"0"`, `NEGATIVE_VERIFY_CACHE_TTL_SECONDS`, 24 h, same `sparkle-sig` key) beyond this brief's positive 30-day TTL; reusers must know negatives are cached. The verifier is stricter than WebCrypto (it refuses small-order public keys); the DoS residual (no single-flight, an aborted request never writes a verdict, up to 2 GiB per miss, bounded per IP) is accepted and owned by P3-03 (R10-05 addendum, R6-03). P5-07 (the macOS Sparkle bridge for Godot) relies on the 2.9.6
floor. When done:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P0-10 done`.
