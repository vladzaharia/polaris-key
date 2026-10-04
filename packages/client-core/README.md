# @polaris-key/client-core

The isomorphic client substrate every JS Polaris Key SDK is built from: **WebCrypto only, zero
Node APIs, no I/O**. Everything here is a pure function over bytes, claims and clocks, so the
identical implementation runs inside [`@polaris-key/node`](../sdk-node), inside
[`@polaris-key/react`](../sdk-react)'s browser bundle, and inside a Worker. Transport, storage
and keyrings belong to the hosts that consume it — this package never opens a socket, never
touches a filesystem, and never reads `process.env`.

It verifies the frozen wire contract v3 compact-JWS envelope (Ed25519 / EdDSA), evaluates the
license gate, resolves layered config, merges trust sets, and verifies offline activation
bundles — the same rules the cross-language conformance corpus pins across Node, React, Python,
Swift and Godot. See `docs/security/WIRE-CONTRACT-V3.md` for the normative spec; this package is a
_correct_ implementation of it, not the definition.

## Why one implementation

Two JS hosts — `@polaris-key/node` and `@polaris-key/react` — each need the identical answer to
"is this signed document valid, and what does the gate say." Reimplementing that twice is
exactly the divergence class the conformance corpus exists to catch: a "harmless"
platform-specific tweak in one copy and the two SDKs quietly start disagreeing about which
artifacts they trust. Factoring it into one isomorphic package instead makes that
disagreement _structurally_ impossible — there is only one `verifyDoc`, one `licenseState`,
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

| Subpath                            | Exports                                                                                                                           | What it does                                                                                   |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `@polaris-key/client-core`         | everything below                                                                                                                  | the barrel                                                                                     |
| `@polaris-key/client-core/verify`  | `verifyDoc`, `verifyLicenseDoc`, `verifyConfigDoc`, `LICENSE_DOC`, `CONFIG_DOC`                                                   | JWS verification + per-document claim validation                                               |
| `@polaris-key/client-core/trust`   | `verifyTrustManifest`, `mergeTrust`                                                                                               | trust-manifest verification and the two-tier pinned-then-discovered merge                      |
| `@polaris-key/client-core/bundle`  | `verifyBundle`, `inspectBundle`, `MAX_BUNDLE_BYTES`                                                                               | offline activation bundle verification, all-or-nothing, in wire-contract §7's numbered order   |
| `@polaris-key/client-core/gate`    | `licenseState`, `isUsable`                                                                                                        | the license gate state machine over a cached document + the clock floor                        |
| `@polaris-key/client-core/config`  | `resolveValue`, `resolveSource`, `listUserEntries`                                                                                | layered config resolution (WIRE-CONTRACT-V3 §2.2.1, `config-matrix.json`)                      |
| `@polaris-key/client-core/headers` | `canonicalPlatform`, `canonicalArch`                                                                                              | a runtime's platform/arch spelling to its canonical header value (§5.2, `headers.json`)        |
| `@polaris-key/client-core/semver`  | `parseSemver`, `compareSemver`, `channelForVersion`, `isDevBuild`                                                                 | client-side semver + the build-channel family (WIRE-CONTRACT-V3 §5.1)                          |
| `@polaris-key/client-core/claims`  | `CLOCK_SKEW_SECONDS`, `MAX_GRACE_SECONDS`, `REFRESH_MARGIN_SECONDS`                                                               | the shared claim-validation constants every implementation must agree on                       |
| `@polaris-key/client-core/clock`   | `highWaterMark`, `effectiveNow`                                                                                                   | the monotonic clock floor: `max(issuedAt)` over every re-verified artifact                     |
| `@polaris-key/client-core/errors`  | `PolarisError`                                                                                                                    | the one error type, carrying the server's machine-readable code                                |
| `@polaris-key/client-core/store`   | `CACHE_VERSION`, `Store`, `CacheRecordV3`                                                                                         | the persistence _contract_ (types only) — no concrete store lives here                         |
| `@polaris-key/client-core/stages`  | `initialBootState`, `bootTransition`, `bootGuardAction`, `MAX_FAILED_BOOTS`, `BOOT_STAGES` and the other vocabulary lists         | the boot stage machine every renderer drives, and the boot guard's launch decision             |
| `@polaris-key/client-core/version` | `parseVersion`, `compareVersions`                                                                                                 | version ordering under a product's scheme (`semver`, `semver+build`, `4part`), exact past 2^53 |
| `@polaris-key/client-core/feed`    | `verifyFeed`, `feedClaims`, `feedFloor`, `reloadFeeds`, `commitFeed`, `boundChannels`                                             | the channel feed (`pkey-feed+jws`): steps 3–9, floors keyed by the canonical channel           |
| `@polaris-key/client-core/record`  | `verifyReleaseRecord`, `releaseRecordClaims`, `recordHash`, `reloadReleaseRecords`                                                | the release record (`pkey-release+jws`): hash before signature, pinned release keys only       |
| `@polaris-key/client-core/decide`  | `decideUpdate`, `bootDecision`, `rolloutBucket`, `effectiveCapabilities`, `resolveUpdateOutlet`, `outletEntry`, `isUndismissable` | the update decision (`update-matrix.json`), synchronous; the bucket is its one async input     |
| `@polaris-key/client-core/check`   | `runUpdateCheck`                                                                                                                  | `update.decide()`'s I/O-free core: the order, the fallback and the error map of §2.5           |
| `@polaris-key/client-core/packs`   | `plan`, `selectVariant`, `planTarget`, `applyFull`, `applyDelta`, `applyFile`, `verifyMarker`, `PackEngine`, the install state    | packs (plans/P4-01.md §2.6–§2.9): the planner, the appliers and the pipeline, over ports       |

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
presenting a pinned `kid` with _different_ key bytes is a substitution attempt, so the whole
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
`not-applicable` before any other check runs, and `activation` — an online token _or_ a
verified bundle import — replaces v2's boolean `hasToken`. `isUsable` is true for `ok`,
`grace` and `not-applicable`.

### Update (`feed.ts`, `record.ts`, `decide.ts`, `check.ts`) — wire v4

The signed update path of WIRE-CONTRACT-V4, in the contract's order (plans/P3-01.md §2.5):

- `verifyFeed` verifies a `pkey-feed+jws` against the **effective** product trust set, then
  its claims, the channel binding (the claim is never `latest`, and equals the requested name or
  its alias target), the selector, freshness on the network path, and the `seq` floor. Floors are
  keyed by the **canonical** channel — each committed feed's own `channel` claim — and read only
  after the claim is bound; no function here resolves an alias to pick a key. `reloadFeeds`
  re-verifies the cached `feeds` slice and derives the floors (never stored); `commitFeed` is
  step 9's write, removing the requested name's entry after an alias answer.
- `verifyReleaseRecord` refuses a body over `MAX_RECORD_JWS_BYTES` or with a non-ASCII byte
  without hashing it, compares `recordHash` with the feed's pin **before** any signature work,
  selects the key from the pinned release keys only (refusing one whose bytes are also a product
  key), then checks the claims and the cross-check against the pin.
- `decideUpdate` is synchronous and total; `rolloutBucket` (WebCrypto, so async) is computed
  first and passed in. With an optional `content` input (plans/P4-13.md §2.6) it also composes
  the device's pack set (`selectPackRows` picks one row per group at the device's level,
  platform and exact engine), answers `packs`, fills `binary.prestage`, and adds the content
  blocks. `bootDecision` maps the answers:

  | Answer                                                                            | Boot value |
  | --------------------------------------------------------------------------------- | ---------- |
  | `blocked {revoked-content}`, or any answer with `contentBlock: "revoked-content"` | `required` |
  | `packs`                                                                           | `none`     |
  | `blocked {content-floor}`, and any answer with `contentBlock: "content-floor"`    | `optional` |
  | `none`, and a `platform` answer that is not mandatory                             | `none`     |
  | everything else                                                                   | `optional` |

  Floors never stop play: a mandatory offer and `blocked` are prompts the player cannot dismiss
  (`isUndismissable`). Only a CI-signed revocation of a **required** pack gives `required`.

- Content in the feed (plans/P4-13.md §2.2–§2.4), each read beside the claims so a malformed
  member is unusable and never refuses anything: `feedContent` parses `packSets`, `packFloors`
  and `revocations` (each, or `null`); `holdsOf` reads an app record's or stamp's `holds`
  (`null` when unusable); `revocationOf` reads a `kind: revocation` body; `verifyRevocation`
  checks a revocation record against a feed entry with the pinned release keys (steps 12–16);
  `newerRevocation` picks the winner of two revocations of one target (newest `issuedAt`, then
  the higher record hash).
- Content-key delegation (plans/P4-19.md §2.2–§2.6, V4 §2.5.4): `verifyReleaseRecord` takes an
  optional `delegation` (the compact JWS of the delegation a `pkd1-<sha256>` kid names) and then
  runs the delegated path: the delegation verified against the pinned release keys only, its key
  never a release or product key (step `delegation`), the record's signature with the delegated
  key (`jws`), and step 16's scope (`scope`: `kind: pack`, the pack under the scope root by whole
  segments (`coversPack`), a delegated type, tree layout only, `issuedAt` inside the window). The
  result's `delegation` is `{sha256, deliverable, types, issuedAt, expiresAt}`, or null for a
  release-key signer; without the option the behaviour is P4-13's. `delegationHashOf` reads the
  hash from a record's header kid (`delegatedKid` builds one), `delegationOf` reads a
  `kind: delegation` body (effective types = `types ∩ DELEGABLE_PACK_TYPES`), `verifyDelegation`
  verifies one by hash, and `recordRevoked(recordSha256, delegationSha256, revoked)` answers
  `record`, `delegation` or null. A feed `revocations` entry may carry `kind: "delegation"`.
- `runUpdateCheck` takes the two fetches as callbacks and the cache slices, and returns the
  `UpdateCheck` plus the slices to write — the shared core of `update.decide()` in both JS SDKs.

`CacheRecordV3` carries the two optional slices, `feeds` and `releaseRecords`, as signed JWSs
only; `CACHE_VERSION` stays 3.

### Packs (`packs/`) — plans/P4-01.md §2.6–§2.10

The language-neutral half of packs, every function over **injected ports** (an incremental
SHA-256, a zstd decoder with `decode(frame, size)` and `decodeWithPrefix(frame, prefix, size,
windowLogMax)`, positional byte sources and sinks, and the record and object fetches), so the
same code runs in Node, in a browser and under the corpus runner. Nothing here does I/O.

- **Wire functions** (P4-21, P4-04): `isPackId`, `objectRef`, `contentClaims`, `parseFilesIndex`,
  `checkPaths`, `treeDigest`, `variantKey`, `parseContentStamp`, `packSetId`, `frameWindow`,
  `windowLogMax`, `windowAllowed`.
- **Selection and planning**: `selectVariant` (`variantCases`), `planTarget` (`targetCases`) and
  `plan`, notes/A7 §4.2 with `full.requests` (`plan-matrix.json#rows`); its refusals are verdicts.
- **Appliers**: `applyFull`, `applyDelta`, `applyFile` and `parsePatch`, first failure as the
  verdict, counters included (`content/cases.json#applyCases`). Every `zstd-patch-from` frame
  passes §2.7 rule 3's window check before it is decoded, whichever decoder the host injected, and
  a base that starts with the zstd dictionary magic is refused (rule 5). A port with
  `decodeStream` streams a whole payload instead of decoding it into one buffer.
- **Markers**: `verifyMarker` (V4 §3.7, `markerCases`) and `matchEmbedded`, the host's match of
  the embedded bytes and the content stamp's pin. `verifyReleaseRecord` takes `pin.kind`
  (default `app`).
- **Install state**: `active`, `previous`, `inflight` (the journal), `observed` and
  `confirmedBootSeq`, as pure transitions (`commitInstall`, `rollbackInstall`, `confirmBoot`,
  `gcRoots`) over a store with atomic replace. Each entry carries its pack record verbatim and
  `reloadPackState` re-verifies it on every load; nothing read back is trusted. A store's `read`
  answers null only for a missing document; an unreadable one makes the engine write and install
  nothing (`pack-state-unreadable`), a torn one is quarantined and suspends garbage collection of
  what existed when the hold started until `recoverState()`, and an entry whose payload check
  throws is kept but not used (an active one carried over as `previous` by the next commit,
  re-verified before a rollback; it replaces an older verified `previous`, because it is the most
  recent install, so a rollback while it is still unreadable refuses rather than reaching further
  back). The torn hold's first snapshot is saved beside the quarantine (`readHoldList`,
  `writeHoldList`) and reused across restarts. The quarantine members of `PackStateStore` are required; a
  store that lacks them at run time has a torn document treated as unreadable.
- **The data-only rule** (plans/P4-19.md §2.5, `dataOnlyCases`): `dataOnlyRefusal(path, head,
tail)` answers `extension` (a path that is not already normalised, or an extension outside
  `DATA_ONLY_EXTENSIONS`), `content` (a Godot, archive, native-code or script magic in the first
  64 bytes after a BOM and whitespace, a trailing `GDPC`, or a zip end record in the last 65,557
  bytes) or null. `dataOnlyPathRefusal` is the path half, `dataOnlyFileRefusal` takes whole
  bytes, and `dataOnlyTreeSink` wraps an applier's tree sink so a delegated install refuses a file
  before it is written. Delegated installs only; release-signed packs keep their own rules.
- **`PackEngine`**: CONTENT §10's pipeline — preflight, journal, `Range`/`If-Range` fetch whose
  resume re-hashes what is staged, apply with fallbacks, commit (the pointer swap), activation,
  confirm, rollback, garbage collection and embedded baselines. `estimate` sizes a download for
  a consent dialog; `bootPackOptions` and `runBootFetch` are the stage machine's host side
  (`fetch.consent`, `fetch.progress`, `fetch.done`). `memoryPackStorage` and
  `memoryPackStateStore` are the in-memory stores.

`@polaris-key/node` (`client.update.packs`) and `@polaris-key/react` (`createBrowserPacks`) are this
engine with their own transport, storage, zstd and SHA-256.

### Config (`config.ts`)

`resolveValue`/`resolveSource` implement the one precedence every SDK honors:

```
enforced | hidden (remote)  >  local override  >  environment  >  remote default  >  fallback
```

Isomorphic on purpose: the environment is an injected lookup table, never `process.env` read
here, so the same function resolves config inside a browser bundle (a host without an
environment passes `{}`). This module owns the dot-to-`__` mapping (`run.concurrency` →
`${envPrefix}run__concurrency`) every host's `PKEY_CONFIG_*` convention builds on, and the
environment-value rule (WIRE-CONTRACT-V3 §2.2.1 rule 2): a value is parsed only when the raw
string is one strict JSON text (no duplicate names, no lone surrogate, no U+0000 in a member
name, every number zero or of magnitude 10^−307 up to below 10^308, at most 64 levels deep),
and is otherwise the raw string. Reading a variable never throws. Every layer reads own
properties only, so a key named `constructor` is an ordinary key. `listUserEntries(ctx)` lists
the document's entries minus `hidden`, each with its resolved value.

### Headers (`headers.ts`)

`canonicalPlatform` and `canonicalArch` map a runtime's report (`darwin`, `x64`, …) through
`PLATFORM_SPELLINGS` / `ARCH_SPELLINGS` from `@polaris-key/protocol/core`, after ASCII case
folding, to the WIRE-CONTRACT-V3 §5.2 value, or `null` when the spelling has none (the host
then omits the header).

### Clock (`clock.ts`)

`highWaterMark` folds every **re-verified** artifact's `issuedAt` — license doc, config doc,
_and_ the trust manifest — into one floor; `effectiveNow` is `max(systemClock, floor)`. The
trust manifest has to be in the fold: a floor built from a license document alone is provably
inert, because `doc.issuedAt < doc.graceUntil` always holds, so it can never reach the end of
grace. This is why Core refreshes trust on its own schedule instead of riding a service's
document fetch.

### Store (`store.ts`)

Types only — `Store` and `CacheRecordV3`. The cache holds **signed artifacts only** (the
compact JWS of each document and of the trust manifest, plus two unsigned hints that can only
ever make the gate stricter); every counter a security decision reads is _derived_ by
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

`parseSemver`/`compareSemver` order versions exactly as the Worker does (pinned by the
conformance corpus), so a client-side "is this build too old" check and the server's build gate
cannot disagree about the same version string. `channelForVersion` matches the Worker's function
of the same name (WIRE-CONTRACT-V3 §5.1 rule 2): `dev`, `beta` (for `0.0.0-beta*` and the legacy
`0.0.0-staging*`), `pr` or `stable`. It returns the coarse family an SDK sends as
`X-PKey-Channel`; only the Worker narrows a PR build to `pr-<n>`. Clients never compute the
build gate itself: they record the Worker's 403.

### Stages (`stages.ts`)

The boot protocol as one pure reducer: `bootTransition(state, event) → { state, emits }` over
`initialBootState({ allowOffline, allowGrace, requiredPacks })`. Every renderer (Godot's
`PKeyBoot`, a React or SwiftUI view, a terminal) does the work of each stage, reports the result
as an event, and draws only what the machine emits. The normal path is
`idle → shell → guard → sync → gate → decide → fetch → mount → ready` (then `background` and back
to `ready`), and every stage is entered even when it has nothing to do. The stops are
`offline`, `blocked` and `error`, from which `retry` resumes at the shell, the guard or the
sync, whichever the boot had not finished. The gate also waits for the player
(`needs-activation`, `revoked`, and `expired` or a refused `grace` after an answered sync).

An event the current stage does not accept, or a malformed one, is **ignored**: the input
state comes back as the same object with no emits. Every accepted event emits something, so
an empty `emits` always means the event was ignored. `bootGuardAction({ staged, failedBoots })`
is the launch decision of the boot guard: `roll-back` at `MAX_FAILED_BOOTS` (2) unconfirmed
launches, otherwise `apply-staged` when a verified update is staged, otherwise `none`.

`conformance/corpus/v2/stage-matrix.json` pins the machine row by row, and the Node, Python and
Swift runners replay every row, every probe of its `accepts` table and every guard case. The
stage machine is client behaviour, not part of the wire contract.

**What a host sends.** A host reports a result with the stage's own event whenever that event
can express it, and sends `fail { code }` only for an exception or a broken invariant in its
own work:

| Stage    | The result event                                                                                                                                                                             | `fail` only for, for example                    |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `shell`  | `shell.done`, also when the SDK discarded a cache that did not re-verify                                                                                                                     | a store it cannot read                          |
| `guard`  | `guard.done` with the outcome of `bootGuardAction`: `none` → `ok`, `apply-staged` → `applied`, `roll-back` → `rolled-back`, each once done                                                   | a slot swap or a rollback that threw            |
| `sync`   | `sync.done ok`, `offline` or `error`, classified below. A device with no token first registers inside `sync` when it can do so without the player. The host's own timer sends `sync.timeout` | an exception from `register()` or `sync()`      |
| `gate`   | `gate.status` from `licenseState`, sent again while waiting after each activation, enrolment, sign-in or bundle import. The gate's Retry sends `retry`                                       | computing the status threw; never while waiting |
| `decide` | `decide.done optional` when the update check says this build is behind, otherwise `none` (also when the check failed)                                                                        | an exception                                    |
| `fetch`  | `fetch.done` with `installed`, the pack ids present afterwards; a failed download is `failed`, or `offline` without a network                                                                | the pack store threw                            |
| `mount`  | `mount.done`                                                                                                                                                                                 | a pack that did not mount                       |

A sync counts each signed document the product runs, and a keyless registration when the host
makes one, by its final answer. It is `ok` when everything counted was **answered** (200 with a
verified document, 304, 401, a 403 build block, or 429), `offline` when anything counted got
**no answer** (no HTTP response, or the SDK's own deadline), and `error` otherwise. A host that
cannot tell no answer from an unusable one sends `error`. So a 401 still reaches
`waiting { revoked }` and a 403 still reaches `blocked`, even under `allowOffline: false`.

## Who consumes it

| Consumer                                          | How                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`@polaris-key/node`](../sdk-node)                | direct dependency; re-exports the pieces its users need under `@polaris-key/node/core` and friends                                                                                                                                                                                                                     |
| [`@polaris-key/react`](../sdk-react)              | direct dependency; the shared `core/adapter.ts` projection layer uses `licenseState`/`resolveValue`/`resolveSource` so the desktop and browser transports gate and resolve config identically, and the browser adapter additionally verifies documents directly since it has no privileged Node process to delegate to |
| The conformance corpus (`conformance/corpus/v2/`) | the Node/React runner verifies every vector through this package; the Python and Swift runners assert the _same_ outcomes from their own independent ports                                                                                                                                                             |
| The Worker (`packages/worker/src/core/`)          | **not a dependency.** `core/bundles.ts` _mints_ what `inspectBundle` here verifies, and restates constants it must agree with (e.g. the 365-day grace ceiling) rather than importing them — a signer and a verifier sharing a runtime dependency would blur which side owns the contract                               |

## Develop

```sh
pnpm --filter @polaris-key/client-core typecheck
pnpm --filter @polaris-key/client-core test
pnpm --filter @polaris-key/client-core build
```
