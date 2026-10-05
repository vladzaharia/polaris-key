---
title: "The wire contract"
description: "PROTOCOL_VERSION 4 — the frozen JWS envelope and its strict verifier, the six type-separated documents, and where the normative spec and its conformance corpus live."
sidebar:
  order: 5
  label: "The wire contract"
---

Everything that crosses the wire or the disk boundary between the Polaris Key Worker and an
SDK is one thing: a **compact EdDSA JWS**. A license document, a config document, a trust
manifest, an offline activation bundle, a channel feed and a release record are the same
envelope with different `typ` values and different payloads. Learn the envelope once and all
six are the same artifact.

`PROTOCOL_VERSION` is **4**. It is exported from `@polaris-key/protocol/core` as
`core.PROTOCOL_VERSION`, and it is bumped on any wire-breaking change to a document shape or
to the HTTP contract that carries one.

This section teaches the contract for people integrating an SDK, building a fifth SDK, or
debugging a verification failure. The **normative** text is the in-repo spec — these pages
cite its section numbers rather than restating it, so when the two disagree the spec wins and
the page is a bug.

## What "frozen" means

The verification path is not an implementation detail that each SDK may tune. It is a fixed
construction that every SDK must agree on byte-for-byte, and "frozen" is the operating
rule that makes that possible:

- **The encoding cannot drift.** Protected-header key order, size caps, the base64url
  alphabet, and the _order_ in which checks run are all part of the artifact, not of a
  library. Two verifiers that disagree about any of them accept different sets of bytes.
- **Nothing is tolerated locally.** An implementation may not accept an artifact the contract
  rejects, and may not reject one it accepts. There is no "we are lenient about that field
  because our platform is different" — that is precisely the divergence class the corpus
  exists to catch (spec §10).
- **A change is a version step.** Altering a document shape or the transport around it means
  bumping `PROTOCOL_VERSION` and regenerating `conformance/corpus/v2/`. v4 added two documents
  and one stricter verifier without changing the four v3 documents' bytes (spec §9).
- **Every verifier is equally strict.** Ed25519 encodings (`S < L`, canonical and
  non-small-order keys and `R`), the JSON (well-formed UTF-8, no BOM, no lone surrogate, no
  U+0000 in a member name, numbers in binary64's range, at most 64 levels), and every integer
  claim decided from its token, not from the number a parser made of it (spec §1.1, §1.2,
  §3.1).
- **A divergence gets a corpus case before it gets a fix.** The corpus is the only automated
  cross-language enforcement there is, so an observed difference that is fixed without being
  pinned will come back.

The parts that are frozen _forever_, not merely until the next version step, are the
fingerprint hash domains — renaming `pkey-hw` or `pkey-device:` would orphan every enrolled
digest. See [Fingerprint constants](/docs/reference/fingerprint-constants/).

## The six documents

Domain separation is by `typ` in the protected header. Unknown or **missing** `typ` is
rejected outright; the v2 tolerance window for untyped artifacts is closed (spec §2). One
product signing key signs five of the kinds, so `typ` is the only thing standing between a
trust manifest and the call site that expects a license document. The sixth, the release
record, is signed in CI by a **release key** that the app pins separately and that is never a
product key.

| `typ`              | Artifact                  | Where a client gets it                                                     | Payload cap |
| ------------------ | ------------------------- | -------------------------------------------------------------------------- | ----------- |
| `pkey-license+jws` | License document          | `GET /<product>/license/document` (`application/jwt`)                      | 65 536 B    |
| `pkey-config+jws`  | Config document           | `GET /<product>/config/document` (`application/jwt`)                       | 65 536 B    |
| `pkey-trust+jws`   | Trust manifest            | `GET /<product>/.well-known/polaris-trust.jws` (`application/jose`)        | 65 536 B    |
| `pkey-bundle+jws`  | Offline activation bundle | A file, hand-carried; minted by `POST /manage/api/products/<slug>/bundles` | 262 144 B   |
| `pkey-feed+jws`    | Channel feed              | `GET /<product>/update/<channel>/feed.jws?platform=` (`application/jose`)  | 65 536 B    |
| `pkey-release+jws` | Release record            | `GET /<product>/release/records/<sha256>` (`application/jose`)             | 65 536 B    |

The license and config documents are fetched with `Authorization: Bearer pkeyt_…` and carry
per-document `ETag`/`If-None-Match`. The trust manifest is unauthenticated — it publishes
public keys, and it is verified against the caller's compiled-in pins, so serving it to
anyone costs nothing. The bundle has no client-facing fetch endpoint at all: it is a file an
operator carries to an air-gapped machine. The feed and record routes arrive with P3-03; a
feed pins each record by the SHA-256 of its exact bytes, which a client checks before any
signature work.

The full route table, including every non-document surface, is at
[Routes](/docs/reference/routes/).

## The six pages in this section

| Page                                                 | What it covers                                                                                                                              | Spec sections |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| [The envelope](/docs/build/wire/envelope/)           | Compact JWS mechanics, size caps, strict decoding, the verify-before-parse order, shared claims, constants, and the two validation profiles | §1, §2, §3    |
| [Trust](/docs/build/wire/trust/)                     | Pinned keys, the signed trust manifest, revocation by absence, and why the cache is never a key source                                      | §1, §2.3      |
| [Cache and clock](/docs/build/wire/cache-and-clock/) | The v3 cache record, the re-verify-everything load, and the monotonic clock floor                                                           | §4            |
| [Offline bundles](/docs/build/wire/bundles/)         | `pkey-bundle+jws`, its three time bounds, and the four ordered refusal steps                                                                | §7            |
| [Pack byte formats](/docs/build/wire/packs/)         | The files index, the patch descriptor, `treeDigest`, the path rules, the codec rules and the zstd window check                              | §2.6, §2.7    |
| [The conformance corpus](/docs/build/wire/corpus/)   | One generator, the language runners, and the CI drift gate that keeps them honest                                                           | §6, §10       |

## One client, end to end

Every SDK does the same six things in the same order. If you can follow this list you can read
any of them:

1. **Start from the pins.** The host application ships a compiled-in `kid → key` map. Nothing
   else is a root.
2. **Load the cache, re-verifying everything.** A record from another cache version is
   discarded; the trust manifest is re-verified against the pins; each document is re-verified
   against the resulting key set. Anything that fails is treated as absent.
3. **Derive, never read.** The anti-replay floors, the "last verified" timestamp and the
   monotonic clock floor are all computed from what just verified — not from fields in the
   file.
4. **Refresh trust on Core's own schedule**, independently of any service's document fetch.
   This is what keeps the signed clock advancing for every product shape.
5. **Fetch the documents this product actually uses**, with `Authorization: Bearer pkeyt_…`
   and per-document ETags, verifying each against the effective key set on the network profile.
6. **Run the gate** at `max(systemClock, highWaterMark)` and render the result.

An air-gapped install replaces steps 4 and 5 with a single bundle import, and everything else
is unchanged — which is the point of minting bundle documents in the ordinary shape.

## Three things that are commonly misread

- **`expiresAt` is not the offline window.** It is one hour, and it is a "should I refetch?"
  signal. The offline window is `graceUntil`, enforced by the gate.
- **A `304` is not proof of freshness forever.** The ETag excludes the timestamps, so a
  content-stable document returns `304` indefinitely; past the half-life the client must
  re-ask unconditionally or it will drift into `grace` while perfectly online.
- **`schemaVersion` on a config document is the product's catalog version**, not a wire
  version. Validate its shape, never allow-list its value.

## Version counters, and who owns them

Ten numbers travel in this system and they are deliberately independent. Confusing two of
them is the most common way to misread a document (spec §9).

| Counter                | Value | Owner / meaning                                                                                              |
| ---------------------- | ----- | ------------------------------------------------------------------------------------------------------------ |
| `PROTOCOL_VERSION`     | `4`   | The wire contract itself. `@polaris-key/protocol/core`.                                                      |
| `CACHE_VERSION` (`v`)  | `3`   | The on-disk cache record format. Any other value is discarded, never migrated.                               |
| `corpusVersion`        | `2`   | The conformance corpus at `conformance/corpus/v2/`.                                                          |
| `gateMatrixVersion`    | `2`   | The gate-transition matrix inside that corpus.                                                               |
| `fingerprintVersion`   | `1`   | The hardware-fingerprint formulas. Unchanged since v1.                                                       |
| `stageMatrixVersion`   | `3`   | The boot stage machine (client boot behaviour, outside this contract), owned by `client-core/src/stages.ts`. |
| `updateMatrixVersion`  | `1`   | The update decision (client behaviour, outside this contract), `update-matrix.json`.                         |
| `outletMatrixVersion`  | `1`   | Outlet capabilities and detection (client behaviour), `outlet-matrix.json`.                                  |
| `planMatrixVersion`    | `2`   | The install planner, variant selection and target mapping (client behaviour), `plan-matrix.json`.            |
| `contentCorpusVersion` | `2`   | The content corpus, `content/cases.json`: pack byte formats and appliers (spec §2.6).                        |

Two more `schemaVersion` fields exist and neither is a wire version:

- `TrustManifestDoc.schemaVersion` is the literal `1`, hardcoded by the Worker and
  allow-listed by clients — unknown values fail closed.
- `ConfigDoc.schemaVersion` is the **product's catalog version**. It increments on every
  catalog edit, is unbounded per product, and must be validated for _shape_ (an integer ≥ 1)
  rather than against an allow-list. An SDK that allow-lists it rejects every product that has
  ever revised its catalog.

## Identifiers you can rely on

The contract fixes a family of identifier strings (spec §8). The three an integrator touches
most:

- `iss` is always the literal `key.plrs.im`. It is **never** derived from the base URL or the
  serving host — an attacker-controlled host must not be able to name its own issuer. A
  client verifying against a self-hosted or staging origin still expects this exact string.
- Device tokens are `pkeyt_` + 43 base64url characters.
- Client metadata headers are `X-PKey-*`.

Spellings from interim drafts — `plrs.im` as an issuer, `plrst_` tokens, `X-Polaris-*`
headers, `plrs-*` type strings, a `.polaris/` manifest directory — were **withdrawn**, not
deprecated. No verifier, signer or store has ever accepted them.

## Where the truth lives, in-repo

The normative spec is repo-only by decision; it is not published on this site. If you are
reading these pages with a checkout in front of you:

| What                          | Path                                                                                                                                                                                   |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The normative spec            | `docs/security/WIRE-CONTRACT-V4.md`                                                                                                                                                    |
| Its predecessors (historical) | `docs/security/WIRE-CONTRACT-V3.md`, `docs/security/WIRE-CONTRACT-V2.md`                                                                                                               |
| The conformance corpus        | `conformance/corpus/v2/` — `cases.json`, `gate-matrix.json`, `fingerprint.json`, `stage-matrix.json`, `headers.json`, `config-matrix.json`, `update-matrix.json`, `outlet-matrix.json` |
| The corpus generator          | `tools/sign-corpus.ts`                                                                                                                                                                 |
| Frozen JWS encode/verify      | `packages/shared-jws/src/index.ts`                                                                                                                                                     |
| Wire types and constants      | `packages/shared-protocol/src/` — `core.ts`, `license.ts`, `config.ts`, `trust.ts`, `update.ts`, `release.ts`, `distribution.ts`                                                       |
| The reference client          | `packages/client-core/src/` — `verify.ts`, `trust.ts`, `bundle.ts`, `gate.ts`, `clock.ts`, `store.ts`, `stages.ts`                                                                     |
| The signer                    | `packages/worker/src/core/` — `signing.ts`, `trust.ts`, `bundles.ts`                                                                                                                   |

Case counts for the corpus, generated from the corpus files themselves, are at
[Conformance corpus v2](/docs/reference/corpus/).

:::note[The reference implementation is not the contract]
`@polaris-key/client-core` is a _correct_ implementation of these rules, not the definition of
them. When you port the contract to a fifth language, port it from the spec and prove it with
the corpus — reading TypeScript and matching its behaviour reproduces its accidents along with
its intent.
:::
