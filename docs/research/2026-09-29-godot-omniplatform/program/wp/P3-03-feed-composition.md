# P3-03 Worker: ingest CI-signed release records and compose the signed channel feed

| Field       | Value                                                                                                                                                |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | P3: Signed feed, decision, feeds (wire v4)                                                                                                           |
| Size        | 1.5–2 engineer-weeks                                                                                                                                 |
| Depends on  | [P3-02](P3-02-wire-v4-contract-corpus.md), [P2b-04](P2b-04-rollouts-delivery.md), [P2-06](P2-06-publish-cli-action.md)                               |
| Unblocks    | [P3-09](P3-09-updater-feeds.md), [P4-02](P4-02-pack-deliverables.md), [P6-03](P6-03-update-funnel-autohalt.md)                                       |
| Role        | `pkey-implementer` (see `.claude/agents/`)                                                                                                           |
| Plan mode   | no: the shapes, routes and checks are fixed by the approved `plans/P3-01.md`                                                                         |
| Gates       | rule 10 (OpenAPI + `routeCoverage`); threat model; also D1 migrations with `TABLE_OWNERS`, and rule 9 if `releaseKeys` lands here (see Design notes) |
| Human input | none. Production release keys stay in each product's CI; tests use the corpus test keys                                                              |
| Repo        | `vladzaharia/polaris-key`                                                                                                                            |

## Goal

The Worker does both halves of the two-signer model, and the CLI signs. **Sign and ingest:**
`pkey release publish` signs the release record with the CI-held release key through P2-06's
`signRecord` seam, and submits it with the descriptor; the Worker checks it
against the product's declared release keys and the release descriptor, stores it immutably and
serves it by its hash. **Compose:** for each channel, the Worker builds the device-less channel
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
- The distribution hooks and tables from [P2b-01](P2b-01-distribution-service.md) and
  [P2b-04](P2b-04-rollouts-delivery.md) (`dist_rollouts`, `dist_availability`).
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
  key helper (proposed `pkey release keys generate`) prints the public half for `.pkey/release`.
- **Record ingest** through P2-02's `submit` route and P2-04's ingest: accept the compact JWS
  beside the descriptor and refuse the publish unless `typ` is `pkey-release+jws`, `kid` is one of the
  product's declared release keys, the signature verifies, `aud` is the product, `deliverable`,
  `kind`, `version` and `seq` match the descriptor, every build's `sha256` and `size` match the
  artifact records, and `seq` is greater than the deliverable's previous `seq`. Each refusal has
  an error code in the registry (`reference/error-codes.mdx` regenerates).
- **Storage** that never rewrites a record (proposed table `release_records` with `product`,
  `deliverable_id`, `release_id`, `seq`, `record_sha256`, `kid`, `jws`, `ingested_at`; or the
  blob store, if the plan chose it), a migration and a `TABLE_OWNERS` entry for `release`.
- **Record route** (plan name, proposed `GET /{product}/release/records/{sha256}`): the stored
  bytes exactly, `application/jose`, immutable caching, release metadata access mode, 404 for an
  unknown hash.
- **Feed route** (plan name, proposed `GET /{product}/update/feed/{channel}`): compose the
  `ChannelFeedDoc` from release (direct import) and distribution (hooks only), sign it with
  `signDoc(…, "pkey-feed+jws")`, cache it per (product, channel, selector) for the plan's TTL.
- **Feed `seq` state**: proposed Update-owned table `update_feed_state` (`product`, `channel`,
  `selector_key`, `seq`, `content_sha256`, `signed_at`). Bump `seq` only when the content hash
  changes, in one conditional write so concurrent requests cannot reuse or skip a number.
- **Discovery**: `endpoints.feed` in Update's fragment (`services/update/index.ts:39`) and
  `endpoints.record` in Release's, as the plan names them.
- **`.pkey/release` `releaseKeys`**, if P2-04 has not added it: validator rule, mutation-table
  entry, JSON schema, the authoring docs and skill. Record release-key fingerprints in the key
  inventory (`dist_keys`) with purpose `release` if [P2b-03](P2b-03-availability-keys.md) has
  landed; it is not a graph dependency.
- **Threat model**: rewrite AT-3 for the two-signer model and add what a compromised Worker can
  still do (withhold, delay, re-target among signed releases, freeze until `expiresAt`).
- **Tests** in `packages/worker/test/` with the corpus test keys (see Acceptance criteria).

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
- **Route words.** The core router matches service namespaces before the channel-appcast alias,
  so a channel cannot shadow a service (`src/router.ts:164-183`). Inside Update's own sub-router
  (`services/update/routes.ts`), `/update/feed/appcast.xml` could read as either the feed of a
  channel called `appcast.xml` (refused by the `CHANNEL` pattern) or the appcast of a channel
  called `feed`. Pin the intended reading, reserve the new path words if needed, and add tests.
- **Gates not in the graph.** This package adds tables (migration, `TABLE_OWNERS`) and may add a
  manifest field (rule 9). Both are required even though `workpackages.json` lists only rule 10
  and the threat model.
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

- [ ] `pkey release publish` with a test release key produces a record that verifies against that
      key with `typ` `pkey-release+jws`, and whose builds equal the descriptor's; `--dry-run`
      signs nothing; the private key never appears in logs or in any request body.
- [ ] A publish with a valid record stores it; a wrong `kid`, bad signature, hash or size
      mismatch, non-increasing `seq` or wrong `aud` is refused with its documented code, and
      nothing is stored.
- [ ] `GET` on the record route returns bytes whose SHA-256 equals the path, as
      `application/jose` with immutable caching; an unknown hash is 404; the access mode applies.
- [ ] `GET` on the feed route returns a `pkey-feed+jws` that verifies against the product's trust
      manifest keys, with exactly the plan's fields; two requests with no state change return the
      same `seq`; a pointer move, floor change, rollout change or halt raises `seq` by one.
- [ ] A halted outlet, a partial rollout and an outlet still serving an older release each appear
      in the feed as the plan specifies (tests over P2b-04 fixtures).
- [ ] Once P3-05 has landed, a test verifies a composed feed and record with `client-core`
      (`verifyFeed`, `verifyReleaseRecord`) end to end.
- [ ] OpenAPI and `routeCoverage` updated; `reference/routes.mdx`, `data-model.mdx` and
      `error-codes.mdx` regenerated.
- [ ] `boundaries.test.ts` passes with no new cross-service import.
- [ ] `docs/security/THREAT-MODEL.md` describes the two-signer property and its limits.
- [ ] The green gate passes (`AGENTS.md`), including `typecheck:workerd` and `test:workerd`.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm --filter @polaris-key/worker typecheck:workerd
mise exec node@22 -- pnpm --filter @polaris-key/worker test:workerd
mise exec node@22 -- pnpm --filter @polaris-key/docs gen:check
mise exec node@22 -- pnpm typecheck
```

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
