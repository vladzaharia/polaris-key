# @polaris-key/client-core

The isomorphic client substrate every JS Polaris Key SDK is built from: **WebCrypto only, zero
Node APIs, no I/O**. Everything here is a pure function over bytes, claims and clocks, so the
identical implementation runs inside [`@polaris-key/node`](../sdk-node), inside
[`@polaris-key/react`](../sdk-react)'s browser bundle, and inside a Worker. Transport, storage
and keyrings belong to the hosts that consume it — this package never opens a socket, never
touches a filesystem, and never reads `process.env`.

It verifies the frozen wire contract v3 compact-JWS envelope (Ed25519 / EdDSA), evaluates the
license gate, resolves layered config, merges trust sets, and verifies offline activation
bundles — the same rules the cross-language conformance corpus pins across Node, React, Python
and Swift. See `docs/security/WIRE-CONTRACT-V3.md` for the normative spec; this package is a
*correct* implementation of it, not the definition.

## Why one implementation

Two JS hosts — `@polaris-key/node` and `@polaris-key/react` — each need the identical answer to
"is this signed document valid, and what does the gate say." Reimplementing that twice is
exactly the divergence class the conformance corpus exists to catch: a "harmless"
platform-specific tweak in one copy and the two SDKs quietly start disagreeing about which
artifacts they trust. Factoring it into one isomorphic package instead makes that
disagreement *structurally* impossible — there is only one `verifyDoc`, one `licenseState`,
one `highWaterMark` — which is also why this package touches no Node builtin: the same bytes
have to run inside a browser tab (React's browser transport, with no privileged process to
delegate to) as inside a privileged Node process.

Python and Swift are separate languages, so they carry independent — not shared — ports of the
same rules. They are proven identical to this package's behaviour by running the same
`conformance/corpus/v2/` vectors against their own implementations, not by importing it.

## Install

```sh
pnpm add @polaris-key/client-core
```

Most consumers won't add this directly: `@polaris-key/node` and `@polaris-key/react` both
depend on it and re-export the pieces their users need. Reach for it directly when building a
new host — a third JS runtime, a Worker-side verifier, a test harness — that needs the raw
verification primitives with no transport or store attached.

## Subpath exports

Each module is also its own entry point, for a host that wants a single concern without
pulling the barrel (`sideEffects: false`, so an unused subpath costs nothing either way):

| Subpath | Exports | What it does |
| --- | --- | --- |
| `@polaris-key/client-core` | everything below | the barrel |
| `@polaris-key/client-core/verify` | `verifyDoc`, `verifyLicenseDoc`, `verifyConfigDoc`, `LICENSE_DOC`, `CONFIG_DOC` | JWS verification + per-document claim validation |
| `@polaris-key/client-core/trust` | `verifyTrustManifest`, `mergeTrust` | trust-manifest verification and the two-tier pinned-then-discovered merge |
| `@polaris-key/client-core/bundle` | `verifyBundle`, `inspectBundle`, `MAX_BUNDLE_BYTES` | offline activation bundle verification, all-or-nothing, in wire-contract §7's numbered order |
| `@polaris-key/client-core/gate` | `licenseState`, `isUsable` | the license gate state machine over a cached document + the clock floor |
| `@polaris-key/client-core/config` | `resolveValue`, `resolveSource`, `listUserEntries` | layered config resolution |
| `@polaris-key/client-core/semver` | `parseSemver`, `compareSemver`, `channelForVersion`, `isDevBuild` | client-side semver + channel helpers, mirroring the Worker's `gate.ts` |
| `@polaris-key/client-core/claims` | `CLOCK_SKEW_SECONDS`, `MAX_GRACE_SECONDS`, `REFRESH_MARGIN_SECONDS` | the shared claim-validation constants every implementation must agree on |
| `@polaris-key/client-core/clock` | `highWaterMark`, `effectiveNow` | the monotonic clock floor: `max(issuedAt)` over every re-verified artifact |
| `@polaris-key/client-core/errors` | `PolarisError` | the one error type, carrying the server's machine-readable code |
| `@polaris-key/client-core/store` | `CACHE_VERSION`, `Store`, `CacheRecordV3` | the persistence *contract* (types only) — no concrete store lives here |

## The pieces

### Verify (`verify.ts`)

`verifyDoc` runs the frozen `@polaris-key/jws` path (encoded-length caps, strict base64url,
duplicate-key rejection, verify-before-parse, `kid` selected only from the caller's trust set),
then asserts the full wire-contract v3 claim set on top: `aud`, `iss` (always the literal
`key.plrs.im`, never derived from the caller's base URL), `deviceId`, the freshness window
with a 300s clock skew, and a `graceUntil` bounded to `issuedAt + MAX_GRACE_SECONDS` (365
days) — applied at **verify** time, not only by the gate, so an over-generous document never
reaches the cache. `checkFreshness: false` switches to the reload profile (a cache reload or a
bundle import, where a past `expiresAt` is expected and normal). Returns the payload or
`null` — never throws — so every call site fails closed identically.

### Trust (`trust.ts`)

`verifyTrustManifest` verifies a signed `pkey-trust+jws` against the caller's **pinned** keys
only, never against the previously-discovered set. Two rules the v1 client lacked: a manifest
presenting a pinned `kid` with *different* key bytes is a substitution attempt, so the whole
manifest is rejected and the previous trust set is kept; and `status: "revoked"` keys are
dropped, with the returned `discovered` set **replacing** (not merging into) the prior one, so
a key that simply disappears from a newer manifest is revoked too. `mergeTrust(pinned,
discovered)` spreads pins **last** — so a manifest key can never shadow a compiled-in pin.

### Bundle (`bundle.ts`)

`inspectBundle` walks wire-contract §7's four numbered steps in order — the bundle JWS against
pins, the bundle's own claims, the inner trust manifest against pins, each inner document
against the effective set — and reports which step refused as a `BundleRefusalReason`, because
"get a bundle minted for this device" and "the trust manifest inside it was rejected" are
different operator remedies. `verifyBundle` is the plain `VerifiedBundle | null` shape for
callers that only need yes/no. Both are pure verifiers: writing the cache is the host's job
(`@polaris-key/node`'s `core/bundle.ts` calls this and writes; React's does the same), which is
what makes "all or nothing" structural rather than disciplinary — there is no partial result to
persist, because a refusal returns no documents at all.

### Gate (`gate.ts`)

`licenseState` computes the renderable status from `{ licenseServiceEnabled, activation, doc,
now, highWaterMark, blocked, lastSyncUnauthorized }`. Two v3 rules sit ahead of the (otherwise
unchanged) v2 state machine: a product with the license service disabled reports
`not-applicable` before any other check runs, and `activation` — an online token *or* a
verified bundle import — replaces v2's boolean `hasToken`. `isUsable` is true for `ok`,
`grace` and `not-applicable`.

### Config (`config.ts`)

`resolveValue`/`resolveSource` implement the one precedence every SDK honors:

```
enforced | hidden (remote)  >  local override  >  environment  >  remote default  >  fallback
```

Isomorphic on purpose: the environment is an injected lookup table, never `process.env` read
here, so the same function resolves config inside a browser bundle. This module owns the
dot-to-`__` mapping (`run.concurrency` → `${envPrefix}run__concurrency`) every host's
`PKEY_CONFIG_*` convention builds on.

### Clock (`clock.ts`)

`highWaterMark` folds every **re-verified** artifact's `issuedAt` — license doc, config doc,
*and* the trust manifest — into one floor; `effectiveNow` is `max(systemClock, floor)`. The
trust manifest has to be in the fold: a floor built from a license document alone is provably
inert, because `doc.issuedAt < doc.graceUntil` always holds, so it can never reach the end of
grace. This is why Core refreshes trust on its own schedule instead of riding a service's
document fetch.

### Store (`store.ts`)

Types only — `Store` and `CacheRecordV3`. The cache holds **signed artifacts only** (the
compact JWS of each document and of the trust manifest, plus two unsigned hints that can only
ever make the gate stricter); every counter a security decision reads is *derived* by
re-verifying those strings on load, never read from disk unverified. `CACHE_VERSION` (3) is a
hard cutover: a record at any other version is discarded, not migrated. Concrete
implementations — `FileStore`/`KeyringStore` in `@polaris-key/node`, the browser/desktop
stores in `@polaris-key/react`, `KeychainStore` in Swift — live with their host.

### Errors (`errors.ts`)

`PolarisError` is for the transport/orchestration layers built on top of this package. The
verification path itself never throws: `verifyDoc`, `verifyTrustManifest` and `inspectBundle`
all fail closed by returning `null` (or a tagged refusal), so a call site that forgets a
`catch` cannot silently treat "rejected" as "accepted."

### Semver (`semver.ts`)

`parseSemver`/`compareSemver`/`channelForVersion`/`isDevBuild` mirror the Worker's `gate.ts`
byte for byte (pinned by the conformance corpus), so a client-side "is this build too old"
check and the server's build-gate enforcement can never drift into disagreeing about the same
version string.

## Who consumes it

| Consumer | How |
| --- | --- |
| [`@polaris-key/node`](../sdk-node) | direct dependency; re-exports the pieces its users need under `@polaris-key/node/core` and friends |
| [`@polaris-key/react`](../sdk-react) | direct dependency; the shared `core/adapter.ts` projection layer uses `licenseState`/`resolveValue`/`resolveSource` so the desktop and browser transports gate and resolve config identically, and the browser adapter additionally verifies documents directly since it has no privileged Node process to delegate to |
| The conformance corpus (`conformance/corpus/v2/`) | the Node/React runner verifies every vector through this package; the Python and Swift runners assert the *same* outcomes from their own independent ports |
| The Worker (`packages/worker/src/core/`) | **not a dependency.** `core/bundles.ts` *mints* what `inspectBundle` here verifies, and restates constants it must agree with (e.g. the 365-day grace ceiling) rather than importing them — a signer and a verifier sharing a runtime dependency would blur which side owns the contract |

## Develop

```sh
pnpm --filter @polaris-key/client-core typecheck
pnpm --filter @polaris-key/client-core test
pnpm --filter @polaris-key/client-core build
```
