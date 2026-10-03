# P3-03 Worker: ingest CI-signed release records and compose the signed channel feed

| Field       | Value                                                                                                                                                                                                                                            |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase       | P3: Signed feed, decision, feeds (wire v4)                                                                                                                                                                                                       |
| Size        | 2.75–3.25 engineer-weeks                                                                                                                                                                                                                         |
| Depends on  | [P3-02](P3-02-wire-v4-contract-corpus.md), [P2b-04](P2b-04-rollouts-delivery.md), [P2-06](P2-06-publish-cli-action.md), [P2b-03](P2b-03-availability-keys.md)                                                                                    |
| Unblocks    | [P3-09](P3-09-updater-feeds.md), [P4-02](P4-02-pack-deliverables.md), [P4-03](P4-03-ci-patch-artifacts.md), [P4-17](P4-17-lazy-deltas.md), [P6-03](P6-03-update-funnel-autohalt.md)                                                              |
| Role        | `pkey-implementer`                                                                                                                                                                                                                               |
| Plan mode   | no: the shapes, routes and checks are fixed by the approved `plans/P3-01.md`                                                                                                                                                                     |
| Gates       | rule 10 (OpenAPI, `routeCoverage`, `CORS_SERVICE_PATHS`); threat model; D1 migrations with `TABLE_OWNERS` and `data-model.mdx`; rule 9 (`releaseKeys`, `testflight.publicLink`); the parity gate for its two transcripts; the Action-bundle gate |
| Human input | none. Production release keys stay in each product's CI; tests use the corpus test keys                                                                                                                                                          |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                        |

## Goal

The Worker does both halves of the two-signer model, and the CLI signs. **Sign and ingest:**
`pkey release publish` signs the release record with the CI-held release key through P2-06's
`signRecord` seam and submits it with the descriptor; the Worker checks it against the product's
declared release keys and the descriptor, stores it immutably and serves it by its hash. **Compose:** for each channel, the Worker builds the device-less channel
feed from release's pointer, floor and `critical` and from distribution's per-outlet availability,
rollout and halts, signs it with the product key as `pkey-feed+jws`, and advertises both routes
in discovery. An SDK from the wave can fetch the feed, fetch the pinned record, verify both and
decide.

## Why

The Worker signs _which and when_; CI signs _what exists_
([README §3.3](../../README.md#33-trust-model-two-signers-two-documents)). Today Update serves an
unsigned `{version, tag, url}` and has no rollout, floor, halt or kill switch
([notes/A1 §7](../../notes/A1-release-update.md)). The feed is composed from release and
distribution ([README §3.6](../../README.md#36-update-what-an-installed-app-should-do-next),
[§3.9](../../README.md#39-rollouts-halts-and-telemetry)), and it is the input for every SDK's
update decision and for the app-updater feeds of [P3-09](P3-09-updater-feeds.md).

## Read first

- `AGENTS.md` rules 5, 6, 9 and 10; the green gate, including the workerd smoke job.
- `plans/P3-01.md` (approved): payloads, route names, ingest checks, feed TTL, `seq` rules.
- [README §3.2](../../README.md#32-service-model-release-distribution-and-update-across-everything-delivered)
  (descriptor hooks; `update → release` is the only import),
  [§3.8](../../README.md#38-distribution-distribution-service),
  [notes/E5 §1.4](../../notes/E5-frontier-tech.md) (what each compromise can and cannot do).
- Update today: `packages/worker/src/services/update/{index,routes,feed,eligibility}.ts`. Note
  `index.ts:6-11`: Update owns no tables yet.
- Release: `services/release/gateway.ts` (the shared pipeline, edge cache, access), `channels.ts`,
  `store.ts`, `config.ts`, `access.ts`, and what [P2-03](P2-03-release-data-model.md),
  [P2-04](P2-04-release-descriptor.md), P2-05 and [P2-06](P2-06-publish-cli-action.md) added
  (descriptor ingest and its fields, channel policy with `min_supported` and `critical`, `seq`,
  the `signRecord` seam), and [P2-02](P2-02-trusted-publisher.md)'s `submit` route and
  `nextSeq` ticket.
- Core: `core/signing.ts` (`signDoc`), `core/trust.ts:58-120` (the device-less signed document to
  copy: `application/jose`, `public, max-age`), `core/discovery.ts`, `core/registry.ts:121-134`
  (the hook pattern), `core/entitledAccess.ts`.
- The distribution hooks and tables: [P2b-01](P2b-01-distribution-service.md) (the hooks),
  [P2b-04](P2b-04-rollouts-delivery.md) (`dist_rollouts` with `rollout_bp` and `rollout_salt`,
  `delivery.rollout()`, the halt path) and [P2b-03](P2b-03-availability-keys.md)
  (`dist_availability`, `dist_keys` with purpose `release`). P2b-03 is not a graph dependency;
  without it the feed carries no availability, and says so.
- Gates: `packages/worker/openapi/polaris-key.v3.yaml`, `test/routeCoverage.test.ts:63-88`
  (`SERVICE_PATHS`), `test/boundaries.test.ts`, `packages/docs/scripts/gen-reference.mjs:248`
  (`TABLE_OWNERS`), `docs/security/THREAT-MODEL.md` (AT-3 at `:160-170`; §9 names a wire version
  increment as a review trigger).

## Scope

**In:**

- **CLI signing** in `packages/cli`: implement P2-06's `signRecord` seam. Build the record
  payload from the descriptor (P2-04 aligned its fields with README §3.3 so the record moves
  rather than reshapes), sign it as `pkey-release+jws` with an Ed25519 key read from the CI
  environment (a GitHub Environment secret; KMS later, README §11 decision 3), and add the
  matching `polaris-key/publish` Action input. `--dry-run` prints the record unsigned. A small
  key helper (proposed `pkey release keys generate`) creates a key pair, prints the public key and
  `kid` for `.pkey/release`, and writes the private key to a file for the CI secret.
- **Record ingest** through P2-02's `submit` route and P2-04's ingest: accept the compact JWS
  beside the descriptor and refuse the publish unless `typ` is `pkey-release+jws`, `kid` is one
  of the product's declared release keys, that key is not a product signing key, the signature
  verifies through `shared-jws`, `releaseRecordClaims` (given `verifyJws`'s `nonWireIntegers`)
  accepts the payload, the record's `version` parses under the deliverable's scheme (SemVer 2.0's
  grammar for `semver`), the record equals the descriptor under the plan's §2.4 mapping, `seq`
  follows P2-04's rule, and `record_sha256` is new. One code, `release_record_rejected`, with
  the reasons `typ`, `kid`, `product-key`, `signature`, `claims`, `scheme`,
  `descriptor-mismatch` and `seq` (`reference/error-codes.mdx` regenerates).
- **Storage** that never rewrites a record: table `release_records` (`product`,
  `deliverable_id`, `release_id`, `seq`, `kind`, `record_sha256`, `kid`, `jws`, `ingested_at`;
  PK `(product, record_sha256)`, unique `(product, deliverable_id, seq)`), a migration and a
  `TABLE_OWNERS` entry for `release`.
- **Record route** `GET /{product}/release/records/{sha256}` (and `HEAD`): the stored bytes
  exactly, `application/jose`, `ETag` and `304`; the release `metadata` mode, and under
  `entitled` P2-05's blob rule applied to the record's own release; `public, max-age=31536000,
immutable, no-transform` when public, the gated blob's `private, no-store, no-transform`
  otherwise; the plain 404 for an unknown hash (plan §6).
- **Feed route** `GET /{product}/update/{channel}/feed.jws?platform={platform}` (not
  `/update/feed/{channel}`): compose the `ChannelFeedDoc` from release (direct import) and
  distribution (hooks only) and sign it with `signDoc(…, "pkey-feed+jws")`. The signed documents
  are stored in `update_feed_docs` per (product, canonical channel, selector key) and served to
  every data centre; a request re-signs only when the content's SHA-256 changed or the stored
  copy is 450 s old. Under the release `metadata` mode; under `entitled` the check goes by the
  canonical channel. The feed's `channel` claim is the canonical channel `classifyChannel`
  resolves, never the requested spelling.
- **Feed `seq` state**: Update-owned `update_feed_state` (`product`, `channel`, `seq`,
  `content_sha256`), keyed per (product, canonical channel), not per selector. Bump `seq` only
  when the content hash changes, in one conditional write, to `min(seq + 1, MAX_WIRE_INTEGER)`.
  A new row starts at `seq` 1, or at `MAX_WIRE_INTEGER` when the product's ceiling flag
  (`update_feed_ceiling`) is set (plan §2.3, §6).
- **The `seq` ceiling recovery**: `update_feed_ceiling(product, set_at)`, and the product-wide
  `feed:seq-ceiling` script (`--product <slug>`, no per-channel option), which sets the flag,
  raises every existing row to `MAX_WIRE_INTEGER` and deletes the product's stored documents;
  its local-D1 test covers a channel with a row and a manual channel with none; the RUNBOOK
  section "Recovering the update feeds after a signer compromise".
- **The composer rules** (plan §6): `app.versionScheme` from `versioning.scheme`; outlet entries
  keyed by outlet id with `kind`; `listingUrl` composed from P2b-02's identities and checked
  against the listing prefixes and §2.3's `listingUrl` rule; the per-target floor from
  `min_supported` and the pinned record's `minSupportedSeq`, clipped to the target's own
  version; versions that do not parse left out; empty outlet entries without a hook; the
  self-check with `feedClaims` and `scanStrictJson` before signing (`500 feed_not_composable`).
- **One ordering.** `@polaris-key/client-core` becomes a Worker runtime dependency, importing only
  the four functions P3-02 lands (`parseVersion`, `compareVersions`, `feedClaims`,
  `releaseRecordClaims`); `services/release/resolve.ts` uses client-core's `compareVersions`; fix
  `versionSchemeOf` to read `versioning.scheme` (and `test/resolve.test.ts:392-398`).
- **The release's `seq` before signing.** Extend P2-02's upload request with
  `releases: [{deliverable, version}]` and its answer with `seqs: [{deliverable, version, seq}]`
  (P2-02, done, did not add them); move P2-06's `signRecord` call after the upload answer and
  retype it `(record) => Promise<string>`, so the submit carries the JWS as `record` beside the
  descriptor; the CLI verifies its own record with `verifyJws` and `releaseRecordClaims` before
  publishing; regenerate the Action bundle.
- **Transcripts**: `update-feed-rollback` (requests `latest`) and `update-record-by-hash`, with
  `action: "updateDecide"`, hand-written `expect` blocks carrying `channel`, the
  `initial.update` format in `format.ts`, and `{kind: "transcript", wp: "P3-03"}` on the
  `update.feed`, `release.record` and `update.decide` registry entries (plan §6).
- **CORS**: both routes in `CORS_SERVICE_PATHS`.
- **`ed25519Stream.ts`**: refuse a small-order `R`, the one plan §2.2 rule it lacks.
- **Discovery**: `endpoints.feed: "<base>/update/{channel}/feed.jws"` in Update's fragment and
  `endpoints.record: "<base>/release/records/{sha256}"` plus `releaseKeyFingerprints` in
  Release's.
- **`.pkey/release` `releaseKeys`** as `{kid, publicKey}`, with `release_key_reused` and the
  sync's `release_key_is_product_key`: validator rule, mutation-table entry, JSON schema, the
  authoring docs and skill. `testflight.publicLink` in `.pkey/distribution` (P2b-02, done, did not
  add it). Record release-key fingerprints in the key
  inventory (`dist_keys`) with purpose `release` if [P2b-03](P2b-03-availability-keys.md) has
  landed; it is not a graph dependency.
- **Threat model**: P3-02 writes AT-3's two-signer branch; this package adds the record and feed
  routes with their access modes, the four tables, the ingest refusals, the composer self-check
  and the `seq` ceiling script (plan §6).
- **Operator docs** say a floor prompts and never blocks; a hard stop is License's compatibility
  window.
- **Tests** in `packages/worker/test/` with the corpus test keys (see Acceptance criteria).
- **Wave-1 sync:** **Close the Sparkle verification residuals (P0-10 follow-ups).** Verification at publish time removes the unauthenticated appcast's DoS residual (up to 2 GiB upstream read per cache-missing `GET /<p>/appcast.xml`, no single-flight, aborted requests never memoise). If the appcast still verifies at request time before this lands, run the stream tail and memo write under `ctx.waitUntil` as a stopgap.
- **Wave-1 sync:** **Harden the verifier's edges in `services/release/sparkle.ts` / `ed25519Stream.ts`:** pass the release listing's `dmg.size` through and return `incomplete` (never memoised) when the streamed total differs, so a truncated clean EOF or a wrong-but-2xx body cannot pin a `"0"` verdict for 24 h and drop a security update from the appcast; run the S >= L, point-decode and small-order checks before `fetchAssetStream` so a malformed key or signature opens no GitHub download; wrap both `env.HOT.put` memo writes in `.catch(() => undefined)` (the contract says the verifier never throws); write the literal NUL bytes in the cache-key template (`sparkle.ts` ~line 69) as `\u0000` so git diffs the file as text.
- **Wave-1 sync:** **R10-dos wording.** Cross-reference R10-04b in the the R10 audit findings addendum: the "~60 GiB/min" bound is per address, and `clientIp` has no IPv6 /64 grouping, so the residual is not bounded per attacker.

**Out** (and where it belongs instead):

- Sparkle, WinSparkle, Velopack, `.appinstaller`, zsync and extended `/version` renderers
  (→ [P3-09](P3-09-updater-feeds.md)).
- Pack records, pack sets, pack floors and revocations in the feed
  (→ [P4-02](P4-02-pack-deliverables.md), [P4-12](P4-12-compat-resolution.md),
  [P4-13](P4-13-revocation-floors-decision.md)).
- Update funnel and auto-halt (→ [P6-03](P6-03-update-funnel-autohalt.md)); rollout and halt
  controls themselves (→ [P2b-04](P2b-04-rollouts-delivery.md)).
- SDK verification (→ [P3-04](P3-04-v4-node.md) to [P3-08](P3-08-v4-godot.md)).
- Content-key signing for data-only packs (→ [P4-19](P4-19-content-key-delegation.md)); pack
  records and patch artifacts in the CLI (→ [P4-03](P4-03-ci-patch-artifacts.md)).

## Design notes

- **Never hold or accept a private release key.** Ingest verification is defence in depth;
  clients trust only the release keys pinned in their binaries. A record that failed ingest must
  never be served, and the Worker must never mint one.
- **Nothing device-specific in the feed.** No device id, bucket or licence state: every caller of
  a channel gets identical bytes, so the edge cache key is (product, channel, selector) only.
  Rollout is evaluated on the client (`rolloutBucket`). The `entitled` access check still runs per
  request (`core/entitledAccess.ts`), before the cached body is returned.
- **Boundaries.** Update imports release; distribution is reached only through the P2b-01 hooks.
  The research names them inconsistently (README §3.2: `releaseCatalog`, `delivery`,
  `outletCapabilities`; README §10: `buildCatalog`, `availability`); use what P2b-01 landed. With
  distribution disabled, compose a feed with no per-outlet state and say so in the payload as the
  plan specifies; never fail open.
- **Operator-owned values stay operator-owned.** Floors, `critical`, rollout and halts come from
  their `*_source`-guarded rows; a manifest resync must not change a signed feed's meaning.
- **Size.** Refuse to sign a feed over the 64 KiB payload cap (a clear 5xx and a test), rather than
  emit a document every SDK will reject.
- **Route words.** `rest = [channel, "feed.jws"]` sits beside `[channel, "appcast.xml"]` in
  `services/update/routes.ts`. No channel name can contain a dot (`CHANNEL_NAME_PATTERN`), and
  `records` is a fixed word under `release`, so no new word needs reserving (plan §6).
- **Shared with P3-12.** [P3-12](P3-12-worker-representability.md) adds the signer guards and
  write checks in the same worker lane; the two rebase on each other, and the composer's own
  `scanStrictJson` keeps the feed safe whichever lands first.
- **Gates not in the graph.** This package adds tables (migration, `TABLE_OWNERS`), may add a
  manifest field (rule 9), and changes the CLI, whose Action bundle is generated and checked
  (P2-06). All are required even though `workpackages.json` lists only rule 10 and the threat
  model.
- **Existing surfaces are untouched.** `/update/version`, the appcasts and `/release/dl` keep their
  behaviour; P3-09 extends them.

## Steps

1. Confirm P3-02, P2b-04 and P2-06 are `done`; branch `wp/P3-03-feed-composition`.
2. Migration for record storage and feed state; `TABLE_OWNERS`; regenerate `data-model.mdx`.
3. `releaseKeys` in the manifest (if needed), with rule 9's three parts.
4. CLI signing through `signRecord`, the Action input and the key helper; then the ingest
   checks in `submit`, with a test per refusal.
5. The record route; the feed composer and signer; `seq` handling; caching.
6. Discovery, OpenAPI, `SERVICE_PATHS`; regenerate `routes.mdx`.
7. Threat model. Green gate, including workerd. Set `in-review`.

## Acceptance criteria

- [x] `pkey release publish` with a test release key produces a record that verifies against that
      key with `typ` `pkey-release+jws`, and whose builds equal the descriptor's; `--dry-run`
      signs nothing; the private key never appears in logs or in any request body.
- [x] A publish with a valid record stores it; a wrong `kid`, bad signature, hash or size
      mismatch, non-increasing `seq` or wrong `aud` is refused with its documented code, and
      nothing is stored.
- [x] `GET` on the record route returns bytes whose SHA-256 equals the path, as
      `application/jose` with immutable caching; an unknown hash is 404; the access mode applies.
- [x] `GET` on the feed route returns a `pkey-feed+jws` that verifies against the product's trust
      manifest keys, with exactly the plan's fields; two requests with no state change return the
      same `seq`; a pointer move, floor change, rollout change or halt raises `seq` by one.
- [x] A halted outlet, a partial rollout and an outlet still serving an older release each appear
      in the feed as the plan specifies (tests over P2b-04 fixtures).
- [ ] (Open: P3-05 has not landed on `main`; the ceiling test checks `verifyJws`, `feedClaims` and step 8 directly.) Once P3-05 has landed, a test verifies a composed feed and record with `client-core`
      (`verifyFeed`, `verifyReleaseRecord`) end to end, and the `seq` ceiling recovery with
      `verifyFeed`.
- [x] `feed:seq-ceiling` against a local D1: the next feed of a channel that had a row, and the
      first feed of a manual channel that had none, both carry `seq` 9007199254740991 and pass
      `verifyJws`, `feedClaims` and §2.5 step 8 against the old floor.
- [x] The feed's `channel` claim is the canonical channel (`latest` → `stable`); the two
      transcripts pass `parity:check`.
- [x] OpenAPI and `routeCoverage` updated; `reference/routes.mdx`, `data-model.mdx` and
      `error-codes.mdx` regenerated.
- [x] `boundaries.test.ts` passes with no new cross-service import.
- [x] `docs/security/THREAT-MODEL.md` describes the two-signer property and its limits.
- [x] The green gate passes (`AGENTS.md`), including `typecheck:workerd` and `test:workerd`.
- [x] Sparkle verification: a body shorter or longer than the listed asset size answers `incomplete` and writes no memo; a malformed key or signature makes no upstream fetch; a failing KV `put` does not turn a completed verification into a 500.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/cli test
mise exec node@22 -- pnpm --filter @polaris-key/cli bundle:action -- --check   # P2-06's generated Action bundle
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm --filter @polaris-key/worker typecheck:workerd
mise exec node@22 -- pnpm --filter @polaris-key/worker test:workerd
mise exec node@22 -- pnpm --filter @polaris-key/docs gen:check
mise exec node@22 -- pnpm typecheck
```

## Corrections from implementation

Where the code disagreed with the text above, the code won; recorded here (P3-03's branch):

- **`release_config.release_keys_json`** (migration 0044) persists the declared `releaseKeys`;
  the plan's table list did not name it. `update_feed_docs` also stores `content_sha256`, so a
  change of content at the `seq` ceiling (where `seq` cannot move) still re-signs.
- **The composer's "logs it"** at the ceiling is an audit row (`update.feed.ceiling`): the Worker
  has no log sink (`test/attack/R12-secrets.test.ts` refuses `console.*`).
- **Distribution reached through hooks only** needed a read-only `delivery.outlets()` (id, kind,
  identity, narrowed): no existing hook listed the outlets with their identities.
- **`live`** is the newest release at or below the target's `seq` (looking back at most 16) that
  `delivery.availability` reports `live` on the outlet for the platform: a self-updating outlet
  is offered only when `live.seq` is the target's, so a newer release on another channel must not
  count.
- **Record ingest of a re-run** keeps the release's first record (`record.stored: false`) rather
  than refusing it on `record_sha256`/`seq` uniqueness: records are never rewritten, and a CI
  re-run stays idempotent. A descriptor submitted with a record must carry the record's `seq`
  explicitly (`descriptor-mismatch` otherwise), so two publishes racing for one new `seq` are
  refused by P2-04's explicit-seq guard (`seq_not_increasing`, or the retryable
  `release_exists`) with nothing stored and the ticket given back. Should a release still be
  stored without its record, it is audited and the generation bumped before the answer,
  `409 release_record_rejected {seq}`, `retryable`.
- **The feed of an unused channel** (no target and no `update_feed_state` row: an unused `pr-<n>`
  or manual channel, or a product with no app release) is signed at the starting `seq` and
  nothing is stored, so unauthenticated requests naming channels cannot grow D1.
- **The CLI** requires a release key when `.pkey/release` declares `releaseKeys` (`--no-record`
  opts out), finds the `kid` from the declared key matching `PKEY_RELEASE_KEY`, and adds
  `--release-key-file`, `--min-supported-seq` and the Action inputs `release-key` and
  `min-supported-seq`. It never `::add-mask::`es the key (that would print it; a GitHub secret is
  masked by the runner).
- **Release-key fingerprints in `dist_keys`** are written by Distribution's `manifestIngest` as
  `release`-purpose OBSERVATIONS (`source = 'ci'`), never inventory entries, so a repo declaring a
  key flags it for the operator.
- **Verification at publish time** for the Sparkle appcast was not built (the appcast still
  verifies at request time): the brief's stopgap is in — the stream tail and memo write run under
  `ctx.waitUntil`.
- **Feed and record routes** carry per-IP rate limits (60/min, `updateFeed`, `releaseRecord`).

## Hand-off

- The `signRecord` implementation and the key helper, which [P4-03](P4-03-ci-patch-artifacts.md)
  reuses for `kind: pack` records (its brief assumes signing exists; it is here, not in P2-06).
- Route paths and discovery keys for the feed and the record, which the SDK wave calls and
  [P3-09](P3-09-updater-feeds.md) reuses. The composer's per-outlet view (target release, rollout,
  halt, availability) as a function P3-09's renderers call rather than re-deriving.
- Record storage keyed by hash and deliverable, which [P4-02](P4-02-pack-deliverables.md) extends
  to `kind: pack`; the feed's reserved `packSets` and revocation slots, filled by
  [P4-12](P4-12-compat-resolution.md) and [P4-13](P4-13-revocation-floors-decision.md).
- `update_feed_state` and the composer, which [P6-03](P6-03-update-funnel-autohalt.md) reads when
  it halts a rollout.
- `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P3-03 done` in the PR
  that completes the work.
