# R2 — Cryptography and key custody

Red-team lane: the JWS wire contract, the trust manifest, envelope encryption, key rotation,
entropy, constant-time comparison.

Tree: branch `lewd-owl`, HEAD `bd26e0b`. Toolchain: Node 22
(`~/.local/share/mise/installs/node/22/bin`), Python 3.14 (`sdks/python/.venv`), Swift 6 via
`/usr/bin/swiftc`.

**PoC files (the only files added; no source file was modified):**

- `packages/shared-jws/src/attack.test.ts` — 13 tests, all passing
- `packages/sdk-node/test/R2-trust-attack.test.ts` — 10 tests, all passing

Verification: `packages/shared-jws` 42/42 green, `packages/sdk-node` 154/154 green,
`prettier --check` clean, `tsc --noEmit` clean for both packages.

## Severity summary

| ID    | Severity | Title                                                                                         | PoC         |
| ----- | -------- | --------------------------------------------------------------------------------------------- | ----------- |
| R2-01 | CRITICAL | Trust-set poisoning: the on-disk cache overrides a **pinned** kid                             | passing     |
| R2-02 | HIGH     | No client-side key revocation — the trust set only ever grows                                 | passing     |
| R2-03 | HIGH     | The cached document is never re-verified on load                                              | passing     |
| R2-04 | MEDIUM   | Protected header has no size cap; the 64 KiB payload cap is bypassable                        | passing     |
| R2-05 | MEDIUM   | Python's lenient base64url accepts JWS that Node and Swift reject                             | passing     |
| R2-06 | MEDIUM   | Duplicate JSON keys: Swift is first-wins, TS/Python last-wins                                 | passing     |
| R2-07 | MEDIUM   | Python's `sign_jws` emits different bytes than Node's `signJws`                               | passing     |
| R2-08 | MEDIUM   | `verifyDoc` omits `iss`/`expiresAt`/`schemaVersion`/`licenseId`; zero clock skew              | passing     |
| R2-09 | MEDIUM   | KEK rotation is impossible — single KEK, hard `kekId` equality, no migration                  | code-traced |
| R2-10 | MEDIUM   | One key signs both config docs and trust manifests; no `typ` domain separator                 | code-traced |
| R2-11 | MEDIUM   | Content-only ETag: a 304 never refreshes the signed validity window                           | passing     |
| R2-12 | LOW      | `randomId()` is 72 bits and backs magic links, CSRF, and all typed ids                        | code-traced |
| R2-13 | LOW      | Device-flow `userCode` is a case-folded prefix of `deviceCode`                                | code-traced |
| R2-14 | LOW      | CSRF checks use `!==` while session HMACs correctly use `safeEqual`                           | code-traced |
| R2-15 | LOW      | Edge-mint: no RSA modulus assertion; EdDSA path emits SDK-format JWS under an arbitrary `kid` | code-traced |
| R2-16 | LOW      | Conformance corpus does not cover a single one of R2-04…R2-08                                 | code-traced |
| R2-17 | LOW      | Unsigned `.well-known/polaris.json` advertises `trust.pinnedKeys`                             | code-traced |

Nine hypotheses or sub-claims were **refuted** — see the [Refuted](#refuted) section.

---

## R2-01 — Trust-set poisoning: the on-disk cache overrides a pinned kid

**Severity: CRITICAL.** The single security property the SDK advertises — "the verifying key is
selected by the header `kid` from a caller-supplied trust set, NEVER from the document"
(`packages/shared-jws/src/index.ts:11-13`) — is defeated by one write to a plain JSON file. The
attack does not add a _new_ kid; it **substitutes the key bytes behind a kid the application
explicitly pinned in source**, so every downstream defence that reasons "the kid must be one I
pinned" still passes.

**Location (identical bug, three SDKs):**

- `packages/sdk-node/src/client.ts:184-186` — `this.trust = { ...this.trust, ...this.cache.trustedKeys }`
- `packages/sdk-node/src/client.ts:542` — `this.trust = { ...this.trust, ...next }` (same order in `refreshTrust`)
- `sdks/python/src/polaris_key/client.py:188-189` — `self._trust = {**self._trust, **self._cache.trustedKeys}`
- `sdks/python/src/polaris_key/client.py:550` — same order in `_refresh_trust`
- `sdks/swift/Sources/PolarisKey/PolarisKeyClient.swift:168-170` — `trust.merge(trustedKeys) { _, new in new }` (`new` = cache wins)
- `sdks/swift/Sources/PolarisKey/PolarisKeyClient.swift:469` — same in `refreshTrust`

The spread/merge places the cache **after** the pinned keys, so on a key collision the cache wins.
The correct order is the opposite: the pin must be terminal.

**Preconditions.** Write access to `<configDir>/<product>/managed.json`
(`packages/sdk-node/src/store.ts:174`). For a licensing product the machine's user IS the primary
adversary, and no binary patching is needed. Additional non-user paths to that write:

- `XDG_CONFIG_HOME` selects the directory (`packages/sdk-node/src/client.ts:117-119`), and
  `mkdirSync(dir, { recursive: true, mode: 0o700 })` (`store.ts:172`) does **not** tighten an
  existing loose directory — pointing it at a shared/world-writable path is enough.
- Any process running as the same user: a malicious npm/pip postinstall, a restored backup, a
  synced dotfiles directory, a second app from the same vendor.
- `writeSecure` uses `O_NOFOLLOW` and 0600 (`store.ts:138-150`), which is good hygiene but is
  irrelevant here — the attacker writes the file legitimately, they do not need to race it.

**Exploit steps (all three assertions machine-verified):**

1. Generate an attacker Ed25519 keypair.
2. Write `managed.json` = `{"doc":null,"lastAcceptedIssuedAt":0,"trustedKeys":{"<PINNED_KID>":"<attacker pub>"}}`.
3. Start the client with `trust.pinnedKeys = { "<PINNED_KID>": "<real pub>" }`.
4. Serve any `/config` document signed by the attacker key under `<PINNED_KID>`.
5. `refresh()` returns `applied: true`; `isLicensed()`, `isEntitled()`, `getSecret()`, and
   `getProfile()` all return the attacker's values. The control test proves the _same_ forged
   document is rejected when the cache is absent.

**Amplifier — self-perpetuation.** `refreshTrust` (`client.ts:517-548`) verifies the trust
manifest against `this.trust`, i.e. against the already-poisoned set. The third PoC signs a trust
manifest with the planted key, mints a brand-new `attacker-forever-2099` kid, and shows it
persisted to `managed.json`. From then on the attacker's _own_ kid is trusted even if the
substituted pinned kid is later noticed and removed.

**PoC status:** PASSING —
`packages/sdk-node/test/R2-trust-attack.test.ts` → `describe("R2-02 · trust-set poisoning …")`,
3 tests (attack, negative control, self-perpetuation).

**Fix direction.** Make the pin terminal in all three SDKs:
`{ ...cachedKeys, ...pinnedKeys }` / `trust.merge(cached) { pinned, _ in pinned }`. Better still,
keep two separate maps (`pinned`, `discovered`) and resolve `kid` against `pinned` first, never
letting a discovered key shadow a pinned one. Persisting the _union_ of pinned + discovered keys
into the cache (`client.ts:543-546` writes `trustedKeys: this.trust`) should also stop — only
discovered keys belong in the cache.

---

## R2-02 — No client-side key revocation: the trust set only ever grows

**Severity: HIGH.** There is no code path anywhere in any SDK that removes a kid from a trust set.
Once a client has seen a kid it trusts it forever, on disk, across restarts. Combined with R2-01
this makes a compromise permanently unrecoverable for already-deployed clients.

**Location:**

- Merge-only, never prune: `packages/sdk-node/src/client.ts:535-547`;
  `sdks/python/src/polaris_key/client.py:535-553`;
  `sdks/swift/Sources/PolarisKey/PolarisKeyClient.swift:463-473`.
- The filter reads `alg`/`kty`/`crv` and **ignores `key.status`** — `client.ts:536-540`,
  `client.py:539-547`, `PolarisKeyClient.swift:464-467`. The wire type declares the field
  (`packages/shared-protocol/src/index.ts:109`: `status: Exclude<SigningKeyStatus,"revoked">`) and
  the server populates it (`packages/worker/src/jwks.ts:54-57`), but no client reads it.
- Server-side "revocation" is removal-by-omission:
  `packages/worker/src/repo.ts:329-331` selects `status IN ('active','staged','retired')`, so a
  `revoked` key simply vanishes from `/.well-known/polaris-trust.jws`. There is no negative
  statement for a client to act on.

**Confirmed absence of a pruning path.** Grepped `trustedKeys` / `trust` assignment across
`packages/sdk-node/src`, `sdks/python/src`, `sdks/swift/Sources`: the only writes are the two
merges above plus `store.clearCache()` on `deactivate()`. There is no revocation list, no
`status` handling, no expiry on individual keys (only `TrustManifestDoc.expiresAt`, which gates
the _manifest_, not the keys it already installed), and no re-pinning on version upgrade.

**Exploit steps (machine-verified):**

1. Manifest #1 (signed by the pinned key) publishes `{PINNED, product-key-2026}`. Client merges.
2. The operator revokes `product-key-2026`; manifest #2 (signed by the pinned key, higher
   `issuedAt`) contains only `{PINNED}`.
3. After processing manifest #2 the client's persisted `trustedKeys` **still contains
   `product-key-2026`**, and a document signed by it still passes `verifyDoc`.

A second test proves the `status` gap directly: a manifest key marked `"retired"` is merged as
fully trusted and signs an accepted `/config` document.

**Blast radius.** `handleTrustManifest` (`packages/worker/src/jwks.ts:60-61`) signs the manifest
with `product.signingKeyPem` / `product.signingKid` — the _same_ active key that signs licence
documents (see R2-10). So one leaked product signing key lets an attacker (a) forge licences and
(b) permanently install arbitrary new kids on every client that polls, with **no mechanism to
undo (b)** short of shipping a new application build with a new pin. Rotating the server key does
not help: the compromised key remains in every client's cache forever.

**PoC status:** PASSING — `describe("R2-03 · no client-side key revocation …")`, 2 tests.

**Fix direction.** Make the manifest authoritative rather than additive: replace the discovered
set with the manifest's `active`+`staged` keys (union'd with the pins) on every successful
refresh; treat `retired` as verify-only-until-`retiredAt` and drop it after; publish revoked kids
explicitly with `status:"revoked"` so a client can prune eagerly; add a per-key `notAfter`.

---

## R2-03 — The cached document is never re-verified when it is loaded

**Severity: HIGH.** `readCache()` is a bare `JSON.parse` with no signature check, and the parsed
`doc` is used directly by every payload accessor.

**Location:** `packages/sdk-node/src/store.ts:194-202` (`JSON.parse(raw) as CacheRecord`),
consumed at `packages/sdk-node/src/client.ts:183` (`this.cache = await this.store.readCache()`).
The JWS itself is never stored, so there is nothing to re-verify against. Mirrors:
`sdks/python/src/polaris_key/client.py:187`,
`sdks/swift/Sources/PolarisKey/PolarisKeyClient.swift:168`.

**Preconditions.** Same file write as R2-01, but _strictly weaker_ — no key generation and no
network interception required.

**Exploit steps (machine-verified).** Hand-write `managed.json` with a fabricated `doc` (no
signature anywhere in the file) whose `graceUntil` is a century out. With the network hard-down
(`503` on everything), `status()` is `"ok"`, `isLicensed()` is `true`, `isEntitled()` is `true`,
and `getSecret()` returns the attacker-authored secret.

**Related — anti-replay is resettable.** `lastAcceptedIssuedAt` (the sole replay guard,
`packages/sdk-node/src/verify.ts:27-32`) lives in the same attacker-writable file and is read
back at `client.ts:496`. Rewriting it to `0` re-opens the window for any previously issued
document — e.g. a genuinely signed, higher-tier doc captured before a downgrade. The second PoC
replays a 2023-dated document cleanly.

**PoC status:** PASSING — `describe("R2-04 · the cached document is NEVER re-verified …")`, 2 tests.

**Fix direction.** Persist the compact JWS, not the decoded document, and re-run `verifyDoc` on
every load (that also re-checks `aud`/`deviceId`). Bind `lastAcceptedIssuedAt` into the same
signed/authenticated blob, or store it in the OS keyring alongside the token rather than in the
plaintext cache. Note this does not remove the need to fix R2-01: re-verification is worthless if
the trust set used for it is itself loaded from the same file.

---

## R2-04 — The protected header has no size cap; the 64 KiB payload cap is bypassable

**Severity: MEDIUM.** `MAX_DOC_BYTES` is documented as the guard that "blocks a JSON-parse memory
DoS" (`packages/shared-jws/src/index.ts:31-37, 151`). It guards only the payload segment. Moving
the blob into the **protected header** removes the guard entirely in all three implementations —
the header is base64-decoded and `JSON.parse`d with no bound at all, before any signature or
trust check.

**Location:**

| Impl   | Header decode + parse (uncapped)                        | Payload cap                          |
| ------ | ------------------------------------------------------- | ------------------------------------ |
| TS     | `packages/shared-jws/src/index.ts:149`                  | `:150-152` (before `JSON.parse`)     |
| Python | `sdks/python/src/polaris_key/verify.py:84, 94`          | `:90-91` (before `json.loads`)       |
| Swift  | `sdks/swift/Sources/PolarisKey/JWSVerifier.swift:44-46` | `:77` (**after** `isValidSignature`) |

Two further defects:

1. **The cap is applied after a full decode.** `base64UrlDecode(encPayload)` (TS `:150`) allocates
   an `atob` string _plus_ a `Uint8Array` of the attacker's chosen size before
   `payloadBytes.byteLength > MAX_DOC_BYTES` runs. Same in Python (`verify.py:85` then `:90`) and
   Swift (`JWSVerifier.swift:45` then `:77`). The guard bounds parse cost, not allocation.
2. **The transport is unbounded too.** `packages/sdk-node/src/fetch.ts:90` does
   `await res.text()` with no `Content-Length` check before handing the string to `verifyJws`.

**Preconditions.** The attacker must be able to hand a JWS to a verifier. `verifyJws` is only
called on responses from the configured `baseUrl` (`sdk-node/src/verify.ts:22`,
`client.ts:523`) and those are HTTPS, so this is **not** an unauthenticated remote DoS against a
default deployment. It is reachable via: a hostile or compromised control plane; an
attacker-influenced `baseUrl`; or — the most likely case — an adopter calling the exported,
publicly documented `verifyJws` on a token from an untrusted source, which the package's own
docblock invites.

**Exploit steps (machine-verified).** An 8 MiB `junk` field in the protected header reaches the
trust-set lookup — proved with a `Proxy` trust set that records `kid` reads, so the assertion is
deterministic rather than timing-based. The contrasting 8 MiB _payload_ never reaches the lookup,
which isolates the header as the missing guard. A third test records the cost of a 16 MiB
over-cap payload (~19 ms vs ~1.2 ms baseline), demonstrating the pre-cap allocation.

**PoC status:** PASSING — `packages/shared-jws/src/attack.test.ts` →
`describe("R2-01 · the protected header has NO size cap …")`, 3 tests.

**Fix direction.** Cap `encHeader.length` and `encPayload.length` (the _encoded_ lengths, before
decoding) at the top of `verifyJws` in all three SDKs — e.g. 1 KiB header, 88 KiB payload
(64 KiB × 4/3 + slack). Add a `Content-Length` guard in `fetchManagedConfig`. Move Swift's cap
above `isValidSignature` for parity. Add corpus cases (see R2-16).

---

## R2-05 — Python's lenient base64url accepts JWS that Node and Swift reject

**Severity: MEDIUM.** `sdks/python/src/polaris_key/b64url.py:16-23` calls
`base64.urlsafe_b64decode(s + pad)`, which defaults to `validate=False` and therefore **silently
discards** every character outside the base64 alphabet. Node's `atob` throws on them; Swift's
`Data(base64Encoded:)` (default options, no `.ignoreUnknownCharacters`) returns `nil`. The module
docstrings in all three files claim a byte-for-byte identical construction pinned by the corpus.

**Measured, end-to-end, against the real `polaris_key.verify.verify_jws`:**

```
clean verify:  True
  sig junk '!!'      -> rejected
  sig junk '@'       -> rejected
  sig junk '***'     -> ACCEPTED
  sig junk '\n \t'   -> ACCEPTED
  sig junk '  '      -> rejected
  sig junk '===='    -> ACCEPTED
```

(Acceptance is length-dependent because the re-padding at `b64url.py:22` uses `len(s)`, which
counts the junk; a 3- or 4-character injection keeps the count consistent while a 2-character one
does not.) The same three mangled strings are rejected by Node (`verifyJws` returns `null`) and by
Swift (verified with a standalone `swiftc` probe: `Data(base64Encoded:)` returned `nil` for
`"\n \t"`, `"!!"`, `"@"`, and `"***"`).

**Impact — honest assessment.** This is not a forgery: the signature still covers
`encHeader.encPayload`, so the _document_ cannot be altered. What it grants is **unbounded wire
malleability in one SDK only**: an attacker can mint arbitrarily many distinct JWS strings that
Python accepts as the same valid document. Anything upstream that de-duplicates, rate-limits,
caches, allow-lists, or logs by the token string can be bypassed against Python clients, and the
"identical verification across languages" invariant that the whole conformance programme exists to
guarantee is measurably false. `b64url_decode` is also used for trust-set public keys
(`verify.py:66`), so a trust entry containing junk imports successfully in Python and fails
elsewhere.

**PoC status:** PASSING — the TS half (`attack.test.ts` →
`describe("R2-05 · base64url decoding is LENIENT …")`, asserts Node throws on all four junk
classes and that both base64 alphabets decode identically); the Python half is the transcript
above, produced by running the shipped `verify_jws` under `sdks/python/.venv`.

**Fix direction.** `base64.urlsafe_b64decode(s + pad, validate=True)` — or, better, a shared
strict decoder that rejects anything outside `[A-Za-z0-9_-]`, rejects `+`/`/` (the standard
alphabet is currently accepted by all three; see the passing TS assertion), and rejects explicit
`=` padding on the wire. Add a corpus case for each.

---

## R2-06 — Duplicate JSON keys: Swift is first-wins, TS/Python last-wins

**Severity: MEDIUM.** Duplicate-member handling in the protected header is unspecified by the
"frozen" contract and the three runtimes **disagree**, in the one place that matters most: the
algorithm-downgrade guard.

**Measured ground truth (probed directly against each runtime):**

| Runtime | Parser                                                  | Winner    |
| ------- | ------------------------------------------------------- | --------- |
| TS      | `JSON.parse`                                            | **last**  |
| Python  | `json.loads`                                            | **last**  |
| Swift   | `JSONSerialization.jsonObject` (`JWSVerifier.swift:46`) | **first** |

Swift probe output: `{"alg":"none","kid":"x","alg":"EdDSA"}` → `["kid": x, "alg": none]`;
`{"alg":"EdDSA","kid":"x","alg":"none"}` → `["alg": EdDSA, "kid": x]`. Python:
`json.loads('{"alg":"none","kid":"x","alg":"EdDSA"}')` → `{'alg': 'EdDSA', 'kid': 'x'}`.

So the same signed bytes yield **opposite answers** from the check at
`packages/shared-jws/src/index.ts:158` / `verify.py:102` / `JWSVerifier.swift:52-54`. The same
split applies to `kid`, which means the two families select **different verification keys** for
one signed token.

**Impact — honest assessment.** The header is covered by the signature, so an external attacker
cannot craft one; exploitation requires the signing key. That makes this a **contract defect**
rather than a live forgery: (a) it falsifies the documented "byte-identical, corpus-pinned"
invariant; (b) it gives a compromised or malicious signer a platform-selective artifact (a
document that macOS accepts and Node rejects, or vice versa) usable as a covert kill switch or a
repudiation trick; (c) it means any future change that moves an unsigned field into the header, or
reorders the checks, converts this into a direct downgrade. It should be pinned now, cheaply,
rather than after such a change.

**PoC status:** PASSING — `attack.test.ts` → `describe("R2-06 · duplicate JSON keys …")`, 2 tests
proving TS is last-wins in both directions, with the measured Swift/Python results recorded in the
file header.

**Fix direction.** Reject any protected header containing duplicate members (a manual scan is
cheap on a ≤1 KiB header once R2-04 is fixed), or canonicalise: require the header to be exactly
`{"alg":"EdDSA","kid":"<kid>"}` byte-for-byte, which the signer already emits. Add corpus cases
for both orderings.

---

## R2-07 — Python's `sign_jws` produces different bytes than Node's `signJws`

**Severity: MEDIUM.** `sdks/python/src/polaris_key/verify.py:176-177` calls
`json.dumps(payload, separators=(",", ":"))` **without** `ensure_ascii=False`, so every non-ASCII
code point is escaped to `\uXXXX`. `JSON.stringify` emits raw UTF-8. Same payload, different
signing input, different signature.

**Measured:**

```
payload  {"n":"Ångström 💻"}
python   eyJuIjoiXHUwMGM1bmdzdHJcdTAwZjZtIFx1ZDgzZFx1ZGNiYiJ9   ({"n":"Ångström 💻"})
node     eyJuIjoiw4VuZ3N0csO2bSDwn5K7In0                        ({"n":"Ångström 💻"})
```

**Why CI cannot catch it.** `tools/sign-corpus.ts` has exactly one signer (Node), and the corpus's
`valid-unicode-profile-name` case only exercises each SDK's _verifier_ against a Node-signed
vector. The one test that exercises Python's signer,
`sdks/python/tests/test_conformance.py:52-68`, round-trips `{"hello": "world", "n": 7}` — pure
ASCII. Swift ships no signer outside its test file.

**Impact.** The two signers are not interchangeable. Any tooling, test fixture, or future
alternative signer written in Python produces artifacts that will not byte-match the Node signer
or the corpus, and cross-checking a Node-produced signature against a Python re-serialisation
fails. `verify_jws` itself is unaffected (it correctly signs/verifies over the received bytes and
never re-serialises).

**PoC status:** PASSING (measured transcript above, both signers run on the real code).

**Fix direction.** `json.dumps(..., separators=(",", ":"), ensure_ascii=False)` and encode UTF-8
explicitly. Add a non-ASCII payload to `test_sign_roundtrips_against_corpus_key`, and have
`--check` assert that the Python signer reproduces the corpus's `valid-unicode-profile-name` JWS
byte-for-byte.

---

## R2-08 — `verifyDoc` omits `iss`, `expiresAt`, `schemaVersion`, `licenseId`; zero clock skew

**Severity: MEDIUM.** `verifyDoc` checks signature, `aud`, `deviceId`, and monotonic `issuedAt`
— nothing else.

**Location:** `packages/sdk-node/src/verify.ts:22-33`;
`sdks/python/src/polaris_key/verify.py:156-165`;
`sdks/swift/Sources/PolarisKey/JWSVerifier.swift:118-125`. All three are identical in what they
omit.

Not checked: `iss` (despite `packages/shared-protocol/src/index.ts:88` declaring it "always
`ISSUER`" and `refreshTrust` checking it for _manifests_ at `client.ts:527`), `expiresAt`,
`graceUntil`, `schemaVersion`, `licenseId`, and any `nbf`/future-`issuedAt` sanity. There is no
leeway/skew parameter anywhere in the codebase.

**Exploit steps (machine-verified).** A 400-day-expired document carrying `iss:
"https://evil.example"` and `schemaVersion: 999` is accepted by `verifyDoc`, `refresh()` reports
`applied: true`, and it is written to `managed.json` verbatim (both foreign fields survive to disk).

**Mitigating control, stated honestly.** The _gate_ does enforce the window
(`packages/sdk-node/src/gate.ts:44-53`), so `status()` correctly reports `"expired"` and
`isLicensed()` is `false`. That is the real defence and it works.

**What the gate does not cover — the actual finding.** The payload accessors never consult the
gate. In the same PoC, with `status() === "expired"`:

```
client.isEntitled("polarisVpn")            -> true
client.getSecret("soundcloud.oauth")       -> "FORGED-SECRET"
client.getConfig("quality.floor", 1)       -> 9999
```

`client.ts:249-270` (`getSecret`/`isEntitled`/`getEntitlements`) and the Python/Swift equivalents
read `cache.doc.payload` directly with no status check. So an expired or replayed document still
yields entitlements, enforced config, and delivered secrets. Any adopter who calls
`isEntitled()` without also calling `isLicensed()` has no expiry enforcement at all, and the API
shape actively invites that.

**Clock skew.** `DOC_EXPIRY_SECONDS = 3600` (`shared-protocol/src/index.ts:268`) with zero leeway
means a client whose clock is more than an hour fast reports `"grace"` on a brand-new document
(asserted). In the other direction, a document with `issuedAt` ten years in the future is accepted
and gates `"ok"` (asserted) — there is no `nbf` check.

**PoC status:** PASSING — `describe("R2-08 · verifyDoc omits iss / expiresAt / …")`, 2 tests.

**Fix direction.** Assert `iss === ISSUER`, `schemaVersion` within a supported range, and
`issuedAt <= now + skew` in `verifyDoc`. Add a `clockSkewSeconds` option (default 300) used by
both `verifyDoc` and the gate. Make `isEntitled`/`getSecret`/`getConfig` return the fallback (or
throw) when `isUsable(status)` is false, or at minimum document loudly that they do not gate.

---

## R2-09 — KEK rotation is impossible

**Severity: MEDIUM.** Confirmed exactly as hypothesised.

**Location:** `packages/worker/src/keyvault.ts:67-83` (`importKek` reads the single
`env.PLATFORM_KEK` and has no second slot) and `:135-138`:

```ts
const expected = env.PLATFORM_KEK_ID || "default";
if (sealed.kekId !== expected) {
  throw new Error(`sealed value uses unavailable KEK ${sealed.kekId}`);
}
```

`kekId` is written into every blob (`:106`) but is only ever used for this equality check — it
is a version _label_ with no version _resolution_. There is no dual-KEK window, no keyring, and no
re-encryption migration anywhere in the repo (grepped `PLATFORM_KEK` across
`packages/`, `tools/`, `docs/`: 20 hits, all either the single-key import, the equality check,
tests, or documentation).

**Blast radius.** Rotating `PLATFORM_KEK` instantly bricks **every** sealed value:
`product_keys.enc_private_json` and `product_secrets.enc_value_json` for every tenant. The
downstream failure is silent-by-design: `loadProduct` catches the `open()` throw and returns
`null` (`packages/worker/src/product.ts:100-119`), and a `null` product means every
`/config`, `/activate`, `/token`, `/mint`, and trust-manifest request 404s. So a KEK rotation is
a **full-platform, all-tenant outage** with no partial-failure signal, and there is no rollback
other than restoring the old KEK value.

The repo already knows: `docs/RUNBOOK.md:88-89` — "`PLATFORM_KEK` … Rotating it requires a
deliberate re-encryption migration; do not rotate it as a routine secret." That migration does not
exist. Practically, the platform cannot respond to a KEK compromise, and it cannot satisfy any
compliance requirement for periodic key rotation.

**PoC status:** code-traced (no runtime PoC — the failure mode is a documented total outage, not
something worth triggering).

**Fix direction.** Accept `PLATFORM_KEK` plus `PLATFORM_KEK_PREVIOUS` (a small kid→key map),
resolve the unwrapping key by `sealed.kekId` instead of asserting equality, and add an admin task
that re-seals every `product_keys`/`product_secrets` row under the new KEK, verifying each
round-trip before committing. Ship it before the first production KEK is set.

---

## R2-10 — One key signs both config documents and trust manifests; no `typ` domain separator

**Severity: MEDIUM.**

**Single-key overload.** `packages/worker/src/jwks.ts:60-61` signs the trust manifest with
`product.signingKeyPem` / `product.signingKid` — the same active key `configDoc.signDoc` uses for
licence documents (`packages/worker/src/licensing.ts:557`). The key that says "this device is
licensed" is also the key that says "here are the keys you should trust from now on". Compromise
of a single key therefore yields both forgery _and_ permanent trust injection, which is precisely
what makes R2-02 unrecoverable.

**No domain separation.** `signJws` emits `{"alg":"EdDSA","kid":<kid>}` with no `typ`, `cty`, or
payload-type discriminator (`packages/shared-jws/src/index.ts:117`), and `verifyJws` never checks
one. Three structurally different document types ride the same envelope: `ManagedConfigDoc`,
`TrustManifestDoc`, and edge-mint EdDSA tokens (`packages/worker/src/edgeMint.ts:227`, which also
passes `kid ?? ""`).

Cross-protocol replay was tested and currently fails, but only incidentally:

- manifest replayed as a config doc → rejected because `doc.deviceId` is `undefined`
  (`verify.ts:26`);
- config doc replayed as a manifest → `for (const key of doc.keys)` (`client.ts:536`) throws a
  `TypeError` on `undefined`, which happens to be swallowed by
  `await this.refreshTrust().catch(() => false)` at `client.ts:447`.

Relying on a `TypeError` swallowed by a bare `.catch` is not a security control.

**PoC status:** code-traced (replay attempts confirmed rejected; the finding is the missing
separation and the shared key, not a live bypass).

**Fix direction.** Add `"typ"` to the protected header (`pkey-config+jws`, `pkey-trust+jws`,
`pkey-mint+jwt`) and assert it at each call site — this is a wire change, so pair it with a
`PROTOCOL_VERSION` bump and corpus regeneration. Separately, give the trust manifest its own
long-lived root key, kept offline and distinct from the per-product signing key, so that key
rotation and trust distribution are not the same credential.

---

## R2-11 — Content-only ETag: a 304 never refreshes the signed validity window

**Severity: MEDIUM.**

**Location:** `packages/worker/src/configDoc.ts:83-95` hashes
`{schemaVersion, aud, iss, licenseId, deviceId, profile, payload}` — `issuedAt`, `expiresAt`, and
`graceUntil` are deliberately excluded (`:81-82`). `packages/worker/src/licensing.ts:553-556`
returns a bodyless `304` whenever the client's `If-None-Match` matches. The SDK's 304 branch
(`packages/sdk-node/src/client.ts:460-465`) only clears `blocked`/`lastSyncUnauthorized`: it does
**not** update the doc, the etag, or `lastVerifiedAt`.

**Consequence.** A client whose configuration is stable receives exactly one signed document,
ever. Its `expiresAt` is frozen at `issuedAt + 3600`, so after one hour a **continuously online,
continuously authenticated** client reports `"grace"`, and after `maxOfflineDays` it reports
`"expired"`. `lastVerifiedAt` is likewise frozen, so any "last checked" UI is wrong. In the other
direction, an administrator who _shortens_ a licence's `max_offline_days` cannot propagate that
change while the content hash is unchanged — the client keeps its longer window.

This is both a correctness bug and a freshness-of-signed-artifact failure: the cache validator
does not cover the fields that determine the artifact's validity.

**PoC status:** PASSING — `describe("R2-08 …")` → `it("R2-11: a 304 (content-only ETag) never
refreshes the signed validity window")`. Five refreshes after the first produce exactly one
served document; `lastVerifiedAt` is unchanged; `status(t0 + 3601)` is `"grace"` and
`status(t0 + 31d)` is `"expired"`.

**Fix direction.** Either include a coarse freshness bucket in the ETag material (e.g.
`floor(issuedAt / (DOC_EXPIRY_SECONDS / 2))`), or keep the content ETag but have the server skip
the 304 once the caller's document would be past half-life, or have the SDK send
`If-None-Match` only while its cached doc is comfortably inside `expiresAt`. Update
`lastVerifiedAt` on a 304 regardless — a 304 _is_ a successful authenticated verification.

---

## R2-12 — `randomId()` is 72 bits and backs magic links, CSRF, and all typed ids

**Severity: LOW.** `packages/worker/src/crypto.ts:42-44` — `randomBytes(9)` = **72 bits**, below
the 128-bit floor used elsewhere in the same codebase.

Consumers: the portal magic-link token (`packages/worker/src/portal/auth.ts:348`, used verbatim
as the KV key and as a URL query parameter), the browser-session CSRF token
(`packages/worker/src/browserSession.ts:124`), and every `lic_`/`dev_`/`flow_`/`acct_`/`aud_`/
`tier_`/`prof_` identifier.

By contrast the admin and portal session CSRF tokens use `randomToken(16)` = 128 bits
(`packages/worker/src/admin/session.ts:122`, `packages/worker/src/portal/session.ts:82`), and
device tokens use `randomBytes(32)` = 256 bits (`crypto.ts:38`). The inconsistency is the tell.

**Honest exploitability.** 2^72 is not online-brute-forceable, and the magic-link path is
rate-limited and TTL-bounded, so this is a margin-of-safety issue rather than a live break. The
magic-link token is additionally stored **unhashed** in KV (`portal/auth.ts:352`) and travels in a
URL, so it is exposed to referrer headers, browser history, and mail-scanner logs — a
128-bit-plus-hashed token would cost nothing.

**Fix direction.** Raise `randomId` to 16 bytes; store the magic-link token as
`hashKey(token, pepper)` and look up by hash; use `randomToken(16)` for the browser-session CSRF
token to match the other two.

---

## R2-13 — Device-flow `userCode` is a case-folded prefix of `deviceCode`

**Severity: LOW.** `packages/worker/src/oidc.ts:198-203`:

```ts
function deviceUserCode(state: string): string {
  return state
    .slice(0, 8)
    .toUpperCase()
    .replace(/(.{4})/, "$1-");
}
```

called as `const deviceCode = b64url(randomBytes(16)); const userCode = deviceUserCode(deviceCode)`
(`oidc.ts:575-576`).

The user code is therefore not an independent credential: it is the first 8 characters of the
polling secret, uppercased. Anyone who sees the user code (screenshot, shoulder-surf, support
ticket, screen share — it is rendered at `oidc.ts:650` for the user to read) learns ~48 bits of
the 128-bit device code. RFC 8628 requires the two to be independent for exactly this reason.

**Honest exploitability.** ~80 bits of the device code remain unknown, so this is not directly
brute-forceable; the finding is the structural coupling and the loss of the user code's role as an
independent confirmation factor. Separately, the verification URI embeds the full device code as a
query parameter (`oidc.ts:589`), putting the polling secret into browser history and any
intermediate URL log.

**Fix direction.** Generate `userCode` from its own `crypto.getRandomValues` draw over a
human-friendly alphabet (RFC 8628 suggests `BCDFGHJKLMNPQRSTVWXZ`), key the KV record by the user
code as well, and put the device code in a POST body or a short-lived opaque handle rather than a
query string.

---

## R2-14 — CSRF checks use `!==` while session HMACs correctly use `safeEqual`

**Severity: LOW.** Three CSRF comparisons are plain `!==`:

- `packages/worker/src/browserSession.ts:304` — `csrf !== session.record.csrf`
- `packages/worker/src/admin/api.ts:165` — `presented !== session.csrf`
- `packages/worker/src/portal/api.ts:607` — `presented !== session.csrf`

**Honest exploitability: very low.** V8 string `!==` compares length then bytes; extracting a
17–22 character secret from that through HTTP-response jitter across the internet is not a
practical attack, `SameSite=Strict` is the primary CSRF defence, and reaching the comparison
already requires a valid session cookie. I am **not** inflating this to a real vulnerability.

What makes it worth recording is the inconsistency: the same codebase already has a correct
constant-time helper and uses it for the security-critical comparisons — `safeEqual` at
`packages/worker/src/admin/session.ts:70-75` and `packages/worker/src/portal/session.ts:53-58`,
applied to the session HMAC. Three call sites simply did not get it.

The two `licenseCore.ts` sites named in the brief are **not** findings and are covered under
[Refuted](#refuted): `:356` and `:470` compare two SHA-256/HMAC digests, and a timing oracle there
would require a preimage to exploit.

`packages/worker/src/portal/auth.ts:272` (`claims.nonce !== flow.nonce`) is likewise not
exploitable: the nonce comes from an already-`jwtVerify`-validated ID token, the comparand is
server-held, and the response is a fixed HTML error page.

**Fix direction.** Route the three CSRF comparisons through `safeEqual`, and hoist it into a
shared module so the next call site inherits it.

---

## R2-15 — Edge-mint key handling

**Severity: LOW.** `packages/worker/src/edgeMint.ts`:

- **No RSA modulus assertion.** `signRs256` (`:118-138`) imports whatever PEM the sealed product
  secret contains. Workers' WebCrypto sets the floor; the application asserts nothing, so a
  misconfigured recipe can sign RS256 with a weak key and nothing warns.
- **Hand-rolled PKCS#1 → PKCS#8.** `rsaToPkcs8` (`:68-86`) assembles the DER envelope by hand
  with a hard-coded `rsaEncryption` prefix and a manual `derLen` (`:55-65`). Reviewed: `derLen` is
  correct for definite short and long form; the `/BEGIN PRIVATE KEY/` test correctly does _not_
  match `BEGIN RSA PRIVATE KEY`; and `BEGIN ENCRYPTED PRIVATE KEY` also does not match, so it
  takes the wrap path and fails closed at `importKey`. No bug found — but this is unnecessary
  bespoke ASN.1 in a signing path.
- **The EdDSA path emits the SDK's own wire format.** `:227` calls
  `signJws(claims, pem, kid ?? "")`, producing exactly the `{"alg":"EdDSA","kid":…}` envelope that
  `verifyJws` consumes, with the `kid` taken from a config column and no `typ` (see R2-10). A
  recipe configured with a `kid` matching a trusted product kid and key material matching that kid
  would let any licensed device mint arbitrary-claim documents that SDKs accept as licence
  documents. That requires an administrator to seal the product signing key as a product secret —
  a footgun, not a vulnerability, but one the design does not prevent.
- The confused-deputy guard (`:184-187`), the reserved-claim sanitiser (`:161-163`), and the
  server-controlled `aud` are all implemented correctly.

**Fix direction.** Assert `key.algorithm.modulusLength >= 2048` after import; replace the
hand-rolled wrapper with a strict parse or require PKCS#8 at ingest; add `typ` (R2-10) and refuse
a mint `kid` that collides with any row in `product_keys`.

---

## R2-16 — The conformance corpus covers none of R2-04 … R2-08

**Severity: LOW (as a control gap).** `conformance/corpus/v1/cases.json` has 22 cases
(`tools/sign-corpus.ts:163-565`): `djdl-baseline`, `valid-stable`, `tampered-payload`,
`wrong-kid`, `wrong-alg-none`, `malformed-two-parts`, `valid-second-key-multi-trust`,
`valid-extension-extra-fields`, `right-kid-wrong-key`, `malformed-empty-string`,
`malformed-four-parts`, `valid-unicode-profile-name`, `valid-v2-management-states`,
`valid-updated-at-roundtrip`, `wrong-alg-es256`, `wrong-alg-hs256`, `empty-trust-set`,
`foreign-kid-only`, `valid-large-integer-timestamps`, `base64url-payload-padding`,
`base64url-payload-trailing-data`, `valid-nul-byte-in-string`.

**Precisely missing:**

1. Any oversized **header** case — R2-04's entire attack surface (no case has a header other than the canonical 39-byte one).
2. Any oversized **payload** case. The only cap test in the whole tree is Swift-local
   (`sdks/swift/Tests/PolarisKeyTests/ConformanceTests.swift:155-199`), so the at-cap/over-cap
   boundary is unpinned for Node and Python and untested cross-language.
3. Any out-of-alphabet-character case — R2-05. (`base64url-payload-padding` covers a `=` in the
   payload only, and passes for the wrong reason: it changes the signing input.)
4. Any junk-in-the-**signature**-segment case, which is where R2-05 actually bites.
5. Any duplicate-JSON-key case — R2-06 (neither ordering, neither for `alg` nor for `kid`).
6. Any Python-**signer** vector. `--check` only re-runs the Node signer, so R2-07 is structurally
   invisible to CI.
7. Any `TrustManifestDoc` vector at all — the trust-manifest path (R2-01, R2-02, R2-10) has zero
   cross-language pinning.
8. Any `verifyDoc`-level vector (`aud`/`deviceId`/`issuedAt`/`expiresAt`/`iss`) — R2-08. The
   corpus stops at raw `verifyJws`; `gate-matrix.json` covers the gate but not document
   acceptance.
9. Any missing-required-field or wrong-type payload case, which would have exposed that TS accepts
   anything, Python requires all keys, and Swift requires all keys _and_ correct types.

**Fix direction.** Add a case for each of the nine above and regenerate. Items 1–5 and 9 are
pure additions to `tools/sign-corpus.ts:build()`; item 6 needs a Python `--check` step in CI;
item 7 needs a second corpus section with its own expectation shape.

---

## R2-17 — Unsigned discovery advertises `trust.pinnedKeys`

**Severity: LOW.** `packages/sdk-node/src/discovery.ts:16-21, 103, 115` parses and exposes
`trust.pinnedKeys`, `trust.signingKid`, and `trust.signingPub` from
`GET /<product>/.well-known/polaris.json` — an **unsigned** JSON document. The SDK does not wire
them into a client trust set automatically (verified: `PolarisKeyClient` only ever reads
`opts.trust.pinnedKeys` at `client.ts:148`), so this is not a live bypass. But the API shape
invites an adopter to bootstrap their pin from the very channel the pin exists to distrust, and
`packages/cli/src/manifest.ts:145-160` (`trustSnippet`) hands out copy-paste pins without saying
where they must not come from.

**Fix direction.** Rename to `advertisedKeys`, document them as _diagnostic only_, and have the
CLI emit the pin with an explicit "obtain out-of-band; never fetch at runtime" comment.

---

## Refuted

Nine claims or sub-claims I set out to prove and could not — recorded so they are not re-audited.

1. **AES-GCM construction (`packages/worker/src/keyvault.ts`) is sound.** The nonce is 12 fresh
   `crypto.getRandomValues` bytes per `seal` (`:93-94`); the AAD binds
   `pkey:v2:<product>:<kind>:<id>` (`:59-63`) so blobs cannot be swapped between products,
   between signing keys and secrets, or between two secrets of one product; the tag is WebCrypto's
   128-bit default; and `open()` propagates the `subtle.decrypt` rejection rather than returning
   anything, so a partial or wrong plaintext cannot escape. `importKek` rejects any KEK that does
   not decode to exactly 32 bytes (`:73-75`).
2. **The unvalidated `iv` length is not exploitable.** `open()` does pass `b64urlDecode(sealed.iv)`
   to `subtle.decrypt` with no length check (`:144`), but (a) the IV is authenticated by the tag,
   so an attacker without the KEK cannot produce a blob that decrypts under any IV, and
   (b) measured in Node 22, WebCrypto AES-GCM rejects IVs of 0, 1, 8, and 1024 bytes with
   `OperationError` and accepts 12–64. Worth a defensive `length !== 12` check; not a finding.
3. **Nonce-reuse risk is negligible.** 96-bit random nonces under one KEK give a birthday-bound
   concern only past ~2^32 seals; seals happen on key/secret creation, not per request.
4. **Swift applying the payload cap after `isValidSignature` is not a vulnerability.** Swift is in
   fact _stricter_ than TS and Python here: it never JSON-decodes the payload before the signature
   check (`JWSVerifier.swift:71-77` then `:88`), whereas both others `JSON.parse` unauthenticated
   payload bytes first. The ordering costs one wasted Ed25519 verification. Recorded under R2-04
   as a parity nit only.
5. **Algorithm downgrade is correctly blocked in all three SDKs.** `alg` is asserted `"EdDSA"` and
   `kid` asserted a string before any signature math (`index.ts:158`, `verify.py:100-102`,
   `JWSVerifier.swift:52-54`), and my control tests confirm `none`, `HS256`, and `ES256` are all
   rejected. Key selection is from the trust set, never from the document, in all three.
6. **Session-cookie HMAC comparison is constant-time.** Both `admin/session.ts:70-75` and
   `portal/session.ts:53-58` implement and use a proper `safeEqual`. The forgery-relevant
   comparison — the one that would give a signature oracle — is done correctly.
7. **`licenseCore.ts:356` and `:470` are not exploitable timing leaks.** Both compare two
   SHA-256/HMAC digests (`existing.token_hash !== tokenHash`,
   `device.token_hash !== tokenHash`). The attacker controls the _token_, not the _digest_, so
   walking a byte-prefix match would require a preimage. Same for
   `packages/worker/src/portal/auth.ts:272`, where the comparand comes from an
   already-`jwtVerify`-validated ID token and the response is a fixed error page.
8. **`hashKey` is sound.** `packages/worker/src/crypto.ts:75-90` uses HMAC-SHA-256 under
   `KEY_HASH_PEPPER` when configured, SHA-256 otherwise — the documented offline-dump property
   holds.
9. **Cross-protocol replay between config docs and trust manifests currently fails.** A manifest
   replayed as a config doc is rejected on `deviceId`; a config doc replayed as a manifest throws
   in the key loop. The first is a real check; the second is accidental (a `TypeError` swallowed
   by `.catch(() => false)` at `client.ts:447`) and is why R2-10 still recommends a `typ`
   discriminator.

Also verified sound and not reported: `tools/sign-corpus.ts`'s `--check` drift guard (it re-emits
in memory and diffs, and it mirrors the Swift bundle so the copy cannot drift);
`configDoc.validatePayload` catalog pruning before signing; `edgeMint.sanitizeTemplate` stripping
`iat`/`exp`/`nbf`/`aud`; `store.writeSecure`'s `O_NOFOLLOW` + 0600; and `importVerifyKey`'s
32-byte assertion in all three SDKs.

---

## Remediation

Landed on branch `lewd-owl` by the client/crypto remediation lane. Scope: `packages/sdk-node/**`,
`tools/sign-corpus.ts`, `conformance/**`. The shared TS core (`packages/shared-jws`) was
remediated separately by the Lead and is consumed here, not modified.

**Result:** `@polaris-key/node` 162/162, `@polaris-key/conformance-node` 68/68,
`@polaris-key/jws` 42/42, `pnpm gen:corpus -- --check` clean, `tsc --noEmit` clean, Prettier clean.

| Finding                   | Status                  | Where                                                                                                                                                                                   | Test                                                                                                                                                    |
| ------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R2-01                     | **fixed**               | `src/trust.ts` `mergeTrust()` is `{...discovered, ...pinned}`; the cache is no longer a key source; a manifest presenting a pinned `kid` with different bytes is rejected **wholesale** | `R2-trust-attack.test.ts` "R2-02 · trust-set poisoning" ×3; corpus `trust-pinned-substitution`                                                          |
| R2-02                     | **fixed**               | `verifyTrustManifest()` reads `key.status`, drops `revoked`, and REPLACES the discovered set so absence prunes                                                                          | `R2-trust-attack.test.ts` "R2-03 · no client-side key revocation" ×2; corpus `key-status-revoked`, `trust-prune-on-absence`, `trust-prune-to-pins-only` |
| R2-03                     | **fixed**               | `store.ts` `CacheRecord` v2 stores `configJws`/`trustJws` only; `client.loadCache()` re-verifies both and derives every counter; failure ⇒ `needs-activation`                           | `R2-trust-attack.test.ts` "R2-04 · the cached document is NEVER re-verified" ×2; `client.test.ts` cache-shape assertions                                |
| R2-04                     | fixed by Lead           | consumed via `verifyJws`                                                                                                                                                                | corpus `header-oversized`, `payload-at-cap`, `payload-over-cap`                                                                                         |
| R2-05                     | Python lane             | corpus vectors added here                                                                                                                                                               | corpus `sig-out-of-alphabet-{stars,whitespace,padding}`                                                                                                 |
| R2-06                     | fixed by Lead           | consumed via `verifyJws`                                                                                                                                                                | corpus `duplicate-key-header-alg`, `duplicate-key-payload`                                                                                              |
| R2-07                     | Python lane             | corpus vector added here, pinning raw UTF-8 signed bytes                                                                                                                                | corpus `valid-non-ascii-payload`                                                                                                                        |
| R2-08                     | **fixed**               | `src/verify.ts` asserts `typ`, `iss`, `expiresAt`, bounded `graceUntil`, `issuedAt` upper bound, `CLOCK_SKEW = 300`                                                                     | `verify.test.ts` "claim validation (§3)" ×7; corpus `docCases` ×12                                                                                      |
| R2-10                     | **fixed (client half)** | `verifyDoc` requires `pkey-config+jws`, `verifyTrustManifest` requires `pkey-trust+jws`                                                                                                 | corpus `typ-wrong`, `trust-manifest-as-config`; `verify.test.ts`                                                                                        |
| R2-11                     | **fixed**               | `client.ts` `not-modified` branch escalates to an unconditional re-fetch past the doc's half-life (`REFRESH_MARGIN_SECONDS`)                                                            | `R2-trust-attack.test.ts` "R2-11: a 304 … never refreshes"                                                                                              |
| R2-16                     | **fixed**               | `tools/sign-corpus.ts` — 12 new raw cases, plus new `docCases` (12) and `trustCases` (10) sections                                                                                      | `conformance/runners/node/corpus.test.ts` 57 cases                                                                                                      |
| R2-09, R2-12…R2-15, R2-17 | not addressed           | Worker/CLI lanes — out of this lane's scope                                                                                                                                             | —                                                                                                                                                       |

### Deviations from WIRE-CONTRACT-V2, and why

Three clauses could not be implemented literally. None was improvised around silently.

1. **§3 `schemaVersion` "must be a known version; unknown ⇒ fail closed" — implemented as a
   shape check, not an allow-list.** On a `ManagedConfigDoc` this field carries the _product
   catalog_ version, not a wire-format discriminator: the Worker sets it from
   `schema.catalog_version` (`packages/worker/src/product.ts:114`), which increments on every
   catalog edit and is unbounded per product. An allow-list would reject every product that
   has ever revised its catalog. `verify.ts` therefore enforces
   `Number.isInteger(v) && v >= 1`. `TrustManifestDoc.schemaVersion` IS typed as the literal
   `1` and hardcoded by the Worker, so **that** one is allow-listed (`trust.ts`).
   R2-08's `schemaVersion: 999` payload is now rejected for its `iss` and expiry, not its
   catalog version.

2. **§4.2 "re-verify `configJws` … with full §3 claim checks" — the freshness bounds are
   applied on the network path only.** Applying `expiresAt > now - CLOCK_SKEW` on cache reload
   would delete offline grace outright: a cached doc is _expected_ to be past its 1-hour
   `expiresAt`, and `graceUntil` (up to `maxOfflineDays`) is the signed outer bound. The split
   is explicit and tested: `VerifyOptions.checkFreshness` (default true) is false on reload;
   everything else in §3 — signature, `typ`, `aud`, `iss`, `deviceId`, `graceUntil` bounds —
   runs identically on both paths. Same treatment for the trust manifest, whose `expiresAt` is
   `now + 300` (`worker/src/jwks.ts:8`); enforcing that on reload would strand every offline
   client that has rotated keys. Corpus `doc-expired-reload-path` pins the behaviour.

3. **§6 `typ-missing` ⇒ reject contradicts §7.2, which requires tolerating an absent `typ` for
   one release.** The Lead's `verifyJws` implements §7.2 (absent `typ` accepted, _wrong_ `typ`
   rejected). The corpus pins the shipped transitional behaviour: case `typ-missing` expects
   **ok**, with the rollout step spelled out in its description. §6's `reject` row becomes
   correct at rollout step 4 and the case flips then. **Lead decision needed** on whether §6
   or §7.2 is authoritative for the corpus.

### Corpus additions

New raw `cases` (22 → 34): `valid-non-ascii-payload`, `header-oversized`, `payload-at-cap`,
`payload-over-cap`, `duplicate-key-header-alg`, `duplicate-key-payload`,
`sig-out-of-alphabet-stars`, `sig-out-of-alphabet-whitespace`, `sig-out-of-alphabet-padding`,
`typ-missing`, `typ-wrong`, `trust-manifest-as-config`.

Two new sections, both additive (existing runners iterating `cases` are unaffected):

- **`docCases`** (12) drives `verifyDoc`: `doc-valid-control`, `doc-expired`,
  `doc-expired-within-skew`, `doc-expired-reload-path`, `iss-mismatch`, `issued-far-future`,
  `issued-future-within-skew`, `grace-before-expiry`, `grace-unbounded`,
  `doc-replayed-below-floor`, `doc-aud-mismatch`, `doc-device-mismatch`.
- **`trustCases`** (10) drives the §1 merge/prune rules: `trust-learn-rotated-key`,
  `key-status-revoked`, `key-status-retired-and-staged-are-trusted`, `trust-prune-on-absence`,
  `trust-pinned-substitution`, `trust-pinned-kid-same-bytes`, `trust-prune-to-pins-only`,
  `trust-expired-manifest`, `trust-aud-mismatch`, `trust-signed-by-non-pinned-key`.

`CorpusCase` gains an optional `typ` — the type the _call site_ expects. Runners MUST pass it
to their verifier; ignoring it makes `typ-wrong` and `trust-manifest-as-config` pass
incorrectly. **This is a runner-contract change for the Python, Swift and React lanes.**

`payload-at-cap` carries a real 64 KiB document, so `cases.json` grew from 38 KB to 330 KB
(mirrored into the Swift bundle). `header-oversized` pins the 1 KiB boundary rather than
R2-04's 8 MiB PoC — same code path, committable size.

### Note for the Python and Swift lanes

`valid-non-ascii-payload` pins the canonical signed bytes for a payload with non-ASCII in both
keys and values (Latin-1 supplement, combining diacritics, CJK, Arabic, and an astral-plane
emoji). Its `jws` is what a correct signer must reproduce byte-for-byte: re-serialising its
`doc` with `ensure_ascii=True` produces `\uXXXX` escapes and a different signature, which is
exactly R2-07. A signer round-trip assertion against this case makes the fix verifiable.

---

## Remediation (Python)

Scope: `sdks/python/**` only. Implemented against `docs/security/WIRE-CONTRACT-V2.md`
(including the §3.1 corrections) and aligned rule-for-rule with the reference
implementations `packages/shared-jws/src/index.ts`, `packages/sdk-node/src/claims.ts`,
`verify.ts` and `trust.ts` — every shared constant is taken from those files rather than
re-derived, because a re-derived constant is exactly how five implementations drift.

**Verification:** `cd sdks/python && .venv/bin/python -m pytest -q` → **231 passed**
(baseline 126). That includes all three conformance sections — 34 `cases`, 12 `docCases`,
10 `trustCases` — plus the 15-row gate matrix. `pnpm gen:corpus -- --check` reports every
artifact `up to date`; nothing here desynced the corpus.

**Regression suite:** `sdks/python/tests/test_wire_contract_v2.py` — 69 tests, each an
**inverted PoC**: it asserts that an attack the red team proved working now fails.
`sdks/python/src/polaris_key/trust.py` is new (the §1 rules, extracted so the corpus can
drive them directly).

| Finding                          | Fix                                                                                                                                                                                                                                                                                                                                                                           | Test proving it                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R2-05                            | `b64url.py` decodes strictly: `^[A-Za-z0-9_-]*$` enforced before re-padding, so `+`, `/`, `=`, whitespace and every other byte raise `ValueError` instead of being silently discarded. Reject, never sanitise.                                                                                                                                                                | `test_r2_05_*` (the exact `***` / `\n \t` / `====` transcript from this finding, plus standard-alphabet, explicit padding, and junk in a trust-set key) + corpus `sig-out-of-alphabet-{stars,whitespace,padding}`                                                                                                                                                                                                                                    |
| R2-07                            | `sign_jws` passes `ensure_ascii=False` with `separators=(",", ":")`, and gained an optional `typ` (header order `alg`,`typ`,`kid`; byte-identical to v1 when omitted).                                                                                                                                                                                                        | `test_r2_07_non_ascii_payload_matches_the_node_signer_bytes`; `test_conformance.py::test_python_signer_reproduces_the_non_ascii_corpus_vector_byte_for_byte` re-signs `valid-non-ascii-payload` and asserts byte equality with the Node-signed JWS                                                                                                                                                                                                   |
| R2-04                            | Encoded caps (`MAX_HEADER_B64` / `MAX_PAYLOAD_B64` = `ceil(bytes×4/3)+4`) applied **before** any decode; decoded header capped at 1024 B; payload decoded and parsed **only after** the signature verifies.                                                                                                                                                                   | `test_r2_04_oversized_header_never_reaches_the_trust_set` (a recording trust set proves no `kid` lookup happens), `test_r2_04_payload_at_cap_accepted_over_cap_rejected`, `test_r2_04_payload_is_not_parsed_before_the_signature_is_verified` (counts `_parse_strict_json` calls: 1 on a bad signature, 2 on a good one) + corpus `header-oversized`, `payload-at-cap`, `payload-over-cap`                                                           |
| R2-06                            | `json.loads(..., object_pairs_hook=_reject_duplicate_keys)` for header **and** payload — rejection, not last-wins.                                                                                                                                                                                                                                                            | `test_r2_06_duplicate_header_keys_are_rejected` (both `alg` orderings + duplicate `kid`), `test_r2_06_duplicate_payload_keys_are_rejected` (correctly signed, so the duplicate is the only defect) + corpus `duplicate-key-header-alg`, `duplicate-key-payload`                                                                                                                                                                                      |
| R2-10                            | `TYP_CONFIG` / `TYP_TRUST` emitted and asserted. Absent `typ` accepted during rollout (§3.1 correction 3), mismatched `typ` rejected immediately. `verify_doc` defaults to `pkey-config+jws`; the manifest path requires `pkey-trust+jws`.                                                                                                                                    | `test_r2_10_*` (manifest-as-config rejected, v1 headers still accepted, config-as-manifest returns `False` instead of raising) + corpus `typ-missing`, `typ-wrong`, `trust-manifest-as-config`                                                                                                                                                                                                                                                       |
| R2-01 / R4-02 **(C2, CRITICAL)** | New `trust.py`: `merge_trust(pinned, discovered) = {**discovered, **pinned}` — pins terminal. A manifest presenting a pinned `kid` with different bytes is rejected **whole**. Manifests verify against the **pinned** set only, which also kills the self-perpetuation amplifier. The cache is no longer a key source at all.                                                | `test_c2_manifest_cannot_substitute_the_bytes_behind_a_pinned_kid`, `test_c2_cache_is_no_longer_a_key_source`, `test_c2_manifest_learned_key_cannot_sign_the_next_manifest` + corpus `trust-pinned-substitution`, `trust-pinned-kid-same-bytes`, `trust-signed-by-non-pinned-key`                                                                                                                                                                    |
| R2-02 **(C3 / H9)**              | `key.status` is read; exactly `revoked` is excluded (not an allow-list — a status we don't know must not silently drop a key the server still considers usable). The discovered set is **replaced** on each manifest, so absence is revocation; pins are never pruned. `TrustManifestDoc.schemaVersion` **is** allow-listed (`{1}`), unlike the config doc's catalog version. | `test_c3_revoked_key_is_refused_and_pruned`, `test_c3_usable_statuses_are_installed`, `test_c3_only_revoked_is_excluded_by_status`, `test_h9_absence_is_revocation_the_trust_set_is_pruned`, `test_h9_a_pinned_key_is_never_pruned_even_by_an_empty_manifest`, `test_trust_manifest_schema_version_is_allow_listed` + corpus `key-status-revoked`, `key-status-retired-and-staged-are-trusted`, `trust-prune-on-absence`, `trust-prune-to-pins-only` |
| R2-03 / R4-01 / R4-03            | `CacheRecord` is now `{v:2, configJws, trustJws, etag, lastSyncUnauthorized, blocked}`. `doc`, `trustedKeys`, `lastAcceptedIssuedAt`, `lastTrustIssuedAt` and `lastVerifiedAt` are **gone from disk** and re-derived by re-verifying the two JWS on every load. A `v:1` record is discarded, not migrated (§7.3).                                                             | `test_r4_01_hand_written_cache_grants_nothing`, `test_r4_01_cache_persists_the_jws_and_re_verifies_it_on_load`, `test_r4_01_a_doc_from_another_device_is_refused_on_load`, `test_r4_03_anti_replay_counter_is_derived_not_stored`, `test_r4_03_replaying_the_previous_doc_is_still_rejected`, `test_store_verify.py::test_v1_cache_record_is_discarded_not_migrated` (which also asserts none of the five removed keys appears on disk)              |
| R2-08                            | `verify_doc` enforces `typ`, `schemaVersion` shape, `aud`, `iss`, `deviceId`, monotonic `issuedAt`, `expiresAt <= graceUntil <= issuedAt + MAX_GRACE_SECONDS`, and — on the network path only — `issuedAt <= now + 300` / `expiresAt > now - 300`.                                                                                                                            | `test_r2_08_claim_checks` (8 cases), `test_r2_08_clock_skew_tolerance_is_300_seconds` + all 12 corpus `docCases`                                                                                                                                                                                                                                                                                                                                     |
| R4-04                            | The gate evaluates at `max(now, highWaterMark)` inside `license_state`, exactly as Node's `licenseState` does; the mark is re-derived at load from `configJws`.                                                                                                                                                                                                               | `test_r4_04_the_gate_evaluates_at_the_floor_not_the_wall_clock`, `test_r4_04_offline_reload_preserves_grace_but_still_clamps`                                                                                                                                                                                                                                                                                                                        |
| R2-11                            | A `304` past `expiresAt - REFRESH_MARGIN_SECONDS` (1800 s) escalates **once** to an unconditional re-request so the server re-signs the window; otherwise it refreshes `lastVerifiedAt` and clears the fail-closed hints.                                                                                                                                                     | `test_r2_11_a_continuously_online_client_never_drifts_into_grace` (36 polls over 6 h against a server that always 304s — status is `ok` throughout), `test_r2_11_a_304_inside_the_window_does_not_re_request`                                                                                                                                                                                                                                        |
| R4-13                            | `models.py` type-checks every field in `from_dict` (rejecting `bool` as an int), so a signed-but-malformed doc becomes "no document" via the existing `except Exception`. `license_state` additionally degrades to `needs-activation` on a non-int window rather than raising.                                                                                                | `test_r4_13_malformed_signed_doc_returns_none` (7 shapes incl. `"issuedAt": "5"`), `test_r4_13_license_state_never_raises_on_a_bad_window` (the `license.py:146` path), `test_r4_13_refresh_survives_a_malformed_signed_doc`                                                                                                                                                                                                                         |
| R4-07                            | All four CLI front ends default `--version` to `cli.core.DEFAULT_VERSION` (the installed package version), never the `0.0.0-dev` sentinel that short-circuits the Worker's build gate.                                                                                                                                                                                        | `test_r4_07_cli_no_longer_defaults_to_a_build_gate_bypassing_version`                                                                                                                                                                                                                                                                                                                                                                                |
| R12-13 / R4-16                   | `core.resolve_activation_key` resolves `--key-file` → `--key-stdin` → `$POLARIS_KEY_ACTIVATION_KEY` → positional (now optional, and it warns about shell history / `ps`) → TTY prompt. Wired into argparse/click/typer; the README documents the env var as the default.                                                                                                      | `test_r12_13_key_resolution_prefers_non_argv_sources`, `test_r12_13_argparse_activate_reads_the_env_var`                                                                                                                                                                                                                                                                                                                                             |
| R4-10                            | `getattr(os, "O_NOFOLLOW", 0)` is gone. `store.SYMLINK_GUARD` is `"O_NOFOLLOW"` or `"lstat-precheck"`, and on the no-`O_NOFOLLOW` path `_write_secure` raises `OSError(ELOOP)` rather than writing through a link. The fallback's TOCTOU weakness is documented, not papered over.                                                                                            | `test_r4_10_symlink_guard_is_declared_honestly`, `test_r4_10_lstat_precheck_refuses_a_symlink` (forces the Windows path and proves the symlink target is untouched)                                                                                                                                                                                                                                                                                  |

### Cross-implementation notes

The three §3.1 corrections were reached independently here before they landed in the
spec, and Python now matches the corrected text and the Node reference exactly:

- `schemaVersion` on a config doc is the per-product **catalog** version
  (`packages/worker/src/product.ts:114` ← `admin/repo.ts:96` `MAX(catalog_version)+1`), so
  it is shape-checked only. The **trust manifest's** `schemaVersion` is a real wire version
  and is allow-listed to `{1}` in `trust.py`.
- Freshness is asserted on the network path only. An earlier draft of this fix re-checked
  `expiresAt` on reload, which silently **deleted offline grace** — a cached document is
  by definition past its one-hour expiry. `check_freshness=False` on both reload paths;
  pinned by corpus `doc-expired-reload-path` and by
  `test_r4_04_offline_reload_preserves_grace_but_still_clamps`.
- `typ` absent is accepted during the rollout window; a wrong `typ` is rejected now.

Shared constants are byte-equal to `packages/sdk-node/src/claims.ts`:
`CLOCK_SKEW_SECONDS = 300`, `MAX_GRACE_SECONDS = 365 × 86400`,
`REFRESH_MARGIN_SECONDS = 1800`.

**One residual observation for the Lead.** §4.3's floor is _inert within a single client_
as specified. Recomputed from `configJws`, `highWaterMark` is always the current
document's own `issuedAt`, which is by construction below its own `graceUntil` — so it can
never keep an expired document expired. It only bites when something else has advanced the
mark. The cheapest fix, if the Lead wants the control to actually stop grace extension, is
to raise the mark from the **trust manifest's** `issuedAt` too: it is signed, bounded by
the same skew, refreshed on an independent schedule, and cached separately. That is a
one-line change in each SDK, but it is a behavioural divergence, so Python does **not**
do it unilaterally — flagged rather than improvised.

### Not fixed (out of scope, cross-referenced)

- **R4-08** transport hardening — no `https:` scheme assertion on `base_url`, no in-flight
  refresh guard. Python already sets a 30 s `httpx` timeout; the rest applies equally to
  Node/Swift and belongs in one coordinated change.
- **R4-05** `/config/report` still echoes the client's own projection. It is now derived
  from a re-verified document, so it can no longer be authored by a plain file write, but
  "report the authenticated state so the server can compare" is a Worker contract change.
- **R4-11** the keyring→plaintext-file downgrade is still silent. `store.SYMLINK_GUARD`
  sets the precedent for how to surface it (`store.token_backend`).
- The **server-side** half of R4-07 — `isDevBuild` short-circuiting the build gate on a
  client-asserted string — belongs to the Worker lane.

## Remediation (dual-KEK)

Closes **R2-09** — and with it residual risk #3 and the operational-resilience review's §2
(graded **F**: `kekId` advertised a rotation capability that did not exist, and the one env var
that appeared to enable it, `PLATFORM_KEK_ID`, was a silent platform-wide outage). Applied on
branch `lewd-owl` by the lane owning `keyvault.ts`, `env.ts`, `admin/handlers/products.ts`,
`migrations/**` and `docs/RUNBOOK.md`. Built to `docs/security/arch/operational-resilience.md`
§2; the three deviations from that spec are listed at the end.

### 1. The keyring — `keyvault.ts`

`importKek` (one key, one kid) is replaced by `resolveKeyring` + `loadKeyring` (N keys, one
active kid, memoised per isolate under a fingerprint of the literal secret material, so a
secret change is picked up by the next isolate with no restart hook).

```text
PLATFORM_KEK_KEYS   = {"k1":"<base64 of 32 bytes>","k2":"<base64 of 32 bytes>"}   # openable
PLATFORM_KEK_ACTIVE = "k2"                                                        # sealed under
```

`seal` writes `kekId: active` and never uses a secondary. `open`'s acceptance rule changes from
"the blob's kid **equals** the single configured kid" (`keyvault.ts:135-138`) to "the blob's kid
is **present in** the ring" — the whole fix. Everything else about the fail-closed posture is
unchanged, including the error string, so the pre-existing tests still assert the same thing.

Fails closed, with no fallback to the other shape, on: no configuration at all; malformed
`PLATFORM_KEK_KEYS` JSON; a non-object or empty map; a non-string or non-32-byte entry; an
active kid absent from the map; a blob whose kid the ring does not hold; a wrong AAD; a bad auth
tag. A half-parsed ring must never silently degrade into "seal everything under the legacy key",
so `PLATFORM_KEK` is not consulted at all once `PLATFORM_KEK_KEYS` is set.

**Backwards compatibility is structural, not best-effort.** With `PLATFORM_KEK_KEYS` absent the
ring is synthesised as `{ active: PLATFORM_KEK_ID ?? "default", keys: { <that kid>: PLATFORM_KEK } }`
— a one-entry ring that is byte-for-byte the old behaviour. Every existing blob carries
`kekId: "default"`, so deploying this against today's production secret set is a **no-op**: same
kid written, same kid accepted. That property is what makes it safe to land before it is needed,
which matters because there is no staging environment to try it on. `Sealed.v` stays **2** and
the AAD stays `pkey:v2:<product>:<kind>:<id>` with **no** `kekId` in it — had the AAD included
the kid, a re-seal would change its own binding and would have needed a `v: 3` plus a second
migration to escape the first one.

### 2. The re-seal sweep — `admin/handlers/products.ts`

AES-GCM is not expressible in SQLite, so the re-encryption pass cannot be a `.sql` migration. It
is an operator-invoked admin endpoint, platform-admin gated, CSRF-checked and rate-limited by
the existing dispatcher:

```text
GET  /manage/api/products/kek   → { active, kids, counts: {keys,secrets}, remaining, unopenable }
POST /manage/api/products/kek   { limit? }   (default 50, max 200)
                                → { resealed, skipped, failed, failures[], counts, remaining, unopenable }
```

Per row: `open` under whichever ring kid the blob names → `seal` under the active kid → **verify
the new envelope re-opens to the same bytes** → `UPDATE … WHERE <id> AND <blob> = <old blob>`.
The AAD is reconstructed from the row's own `(product, kind, id)`, so a re-seal cannot weaken or
move the slot binding — a blob still cannot be lifted between products, kinds or ids.

- **Idempotent** — the filter is "kid ≠ active", so a re-run is free.
- **Resumable / bounded** — `limit` caps one call; the operator loops until `remaining` is 0.
- **CAS** — the update is conditioned on the old ciphertext, so a racing `key.rotate` or
  `secret.set` wins and the row is picked up next pass instead of being clobbered with a stale
  plaintext (counted as `skipped`).
- **Never destructive** — a row that will not open is reported in `failures` with its table,
  product and id, and is not written. `resealed: 0, failed: n` is the "stuck" signal.
- **Observable** — `remaining` (not yet re-sealed) is deliberately distinct from `unopenable`
  (kid not in the ring at all: those products are dark _right now_). `remaining === 0` is the
  documented gate for deleting the old KEK; without it the operator is guessing.
- **Audited** — one `kek.reseal` row per product touched, in that tenant's own audit log.

The kid is read from the blob itself via `json_extract(<col>, '$.kekId')`, not from a
denormalised column, so it cannot disagree with the ciphertext it describes and no writer has to
maintain it. The `CASE WHEN json_valid(<col>)` guard around it is load-bearing and was verified
against the actual engine: an unguarded `json_extract` over a column holding **one** malformed
row raises `malformed JSON` for the **whole statement**, so a single corrupt blob would blind
the sweep to every other row.

**Three classes of sealed value, not two.** `product_keys` and `product_secrets` are whole
envelope columns. R12-02's catalog-declared managed secrets are envelopes **nested inside**
`profiles.payload_json` and `licenses.overrides_json`, so they get a second pass that parses the
payload, re-seals each sealed leaf under AAD `…:product-secret:managed:<key>` (unchanged, per
`admin/lib/managedSecrets.ts`), and CASes the whole column. Omitting them would have made step 8
of the runbook a silent data loss, because `openManagedValue` swallows a failed open and returns
`null` — the symptom would be a config document delivered with a missing secret, not an error.
Their "still needs work" filter is occurrence arithmetic in SQL over the JSON-escaped
`\"kekId\":\"` marker (an already-migrated row must not occupy the `LIMIT` and starve the rows
that do need work); the end-to-end test writes those rows through the real `sealManagedValue`,
so a change in how the payload is encoded fails the test rather than silently skipping rows.
This is also the Worker-side backfill mechanism R11-data.md §REPORTED asked for — for the
re-seal half. It does **not** seal legacy _plaintext_ managed values; that remains R12-02's lazy
migration on the next admin write.

### 3. Documentation

`docs/RUNBOOK.md` gains the keyring variable table (including `PLATFORM_KEK_ID`, which
previously appeared in **no** documentation — the review's finding #1), the nine-step rotation
procedure with its rollback boundary, the `wrangler secret bulk`-not-two-`secret put` warning,
the `wrangler rollback` un-rotation hazard, KEK-compromise containment, and a troubleshooting
entry for the platform-wide-404 signature. The old text — "Rotating it requires a deliberate
re-encryption migration; do not rotate it as a routine secret", which described a migration that
did not exist — is replaced.

### Tests

`packages/worker/test/keyvault.test.ts`, 8 → 23 (all 8 originals unchanged and passing, which is
the backwards-compatibility proof):

| Case                                                     | Assertion                                                             |
| -------------------------------------------------------- | --------------------------------------------------------------------- |
| legacy `PLATFORM_KEK` ≡ one-entry ring                   | blobs cross both ways; `describeKeyring` reports `default`            |
| `PLATFORM_KEK_ID` honoured — and its trap                | renaming the kid orphans a `default` blob                             |
| seal under primary only                                  | ring `{default,k2}` active `k2` ⇒ every new blob is `k2`              |
| **open under secondary**                                 | a `default` blob opens under an active-`k2` ring                      |
| unknown `kekId` fails closed                             | `unavailable KEK k2`; right kid + wrong bytes still rejects           |
| missing keyring fails closed                             | `seal`/`open`/`describeKeyring` all reject                            |
| 7 malformed rings fail closed                            | no fallback, even with a valid `PLATFORM_KEK` present                 |
| AAD preserved across a re-seal                           | wrong product / kind / id all still reject                            |
| full simulated rotation (add → promote → sweep → retire) | product loads + secrets open at **every** step; `remaining` 4 → 3 → 0 |
| sweep is bounded, resumable, idempotent                  | `limit:1` ⇒ 1; re-run ⇒ `resealed: 0`                                 |
| unopenable + corrupt rows                                | counted, reported, **not** written; other rows still re-sealed        |
| CAS: racing admin write                                  | `skipped: 1`, competitor's value survives                             |
| managed secrets in `profiles` / `licenses`               | re-sealed with the rest; still open after the old KEK is retired      |
| unusable ring                                            | `503` naming the variable, not a silent 404                           |
| authz                                                    | non-admin 403, missing CSRF 403, `DELETE` 405, bad `limit` 422        |

`packages/worker/test/keyvault.test.ts` 23/23 and `test/admin.test.ts` 22/22 green on Node 22.
`npx tsc --noEmit` clean and `prettier --check` clean for every file this lane touched. The full
worker suite was 736/737 at hand-off, the single failure being a source-text assertion in the
release lane's in-flight `linkRepo.ts` refactor (`R9-10`), untouched by and unrelated to this
change.

### Deviations from the §2 spec, and why

1. **No `kek_id` column, and therefore no migration.** §2.6 proposed
   `ALTER TABLE … ADD COLUMN kek_id`. Maintaining it would mean changing `repo.ts` writers
   (outside this lane), and a denormalised copy can drift from the blob; an expression index over
   `json_extract` was also rejected after testing, because it makes any future write of a
   non-JSON value to that column fail at INSERT. Reading the kid from the envelope is
   drift-proof and needs no schema change. Both tables are small enough that the scan is free.
   **No migration was added at all** — nothing about the schema needed to change.
2. **Route is `/manage/api/products/kek`, not `/manage/api/platform/kek/{status,reseal}`.** A
   new `/api/platform` family requires editing `admin/api.ts`, outside this lane. `kek` is a
   reserved one-segment action on the existing platform-admin-gated `/api/products` family, the
   same mechanism `link-repo` already uses (and with the same caveat: a product slug `kek` would
   be shadowed). `GET` = status, `POST` = sweep.
3. **`kek.reseal` is audited per product, not as a platform row.** The audit table is
   product-scoped (`audit.product REFERENCES products(slug)`); §6.4's platform-events table does
   not exist yet. One row per tenant touched is strictly more visible to whoever is looking at
   that product.

### Not fixed (out of lane)

- `wrangler.toml:93-96`'s required-secrets comment still lists only `PLATFORM_KEK`; it should
  name `PLATFORM_KEK_KEYS` / `PLATFORM_KEK_ACTIVE` too. `DEPLOYMENT.md` likewise.
- The admin SPA has no UI for the keyring; rotation is curl-only.
- No `kek.open.failed` telemetry (§6.3): a blob whose kid is missing is still only visible by
  polling `GET …/kek` for `unopenable > 0`. There is no logging anywhere in the worker to hang
  it on.
- Re-keying does not undo a leak: R2-02 (client-side revocation) still governs whether a signing
  key compromised via a leaked KEK can actually be retired from the installed base.
