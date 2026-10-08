# P2-02 Trusted publishing: GitHub OIDC verification, publisher policy, scoped upload tickets

| Field       | Value                                                                                                                                                                                                    |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | P2: Release truth, publishing and release tracks                                                                                                                                                         |
| Size        | 1–1.5 engineer-weeks                                                                                                                                                                                     |
| Depends on  | [P2-01](P2-01-blob-store.md), [P2-04](P2-04-release-descriptor.md)                                                                                                                                       |
| Unblocks    | [P2-06](P2-06-publish-cli-action.md)                                                                                                                                                                     |
| Role        | `pkey-implementer`                                                                                                                                                                                       |
| Plan mode   | no                                                                                                                                                                                                       |
| Gates       | threat model; rule 9 (`publishing.trustedPublisher`); rule 10 (three routes); D1 migration + `TABLE_OWNERS` (not listed in the graph, but required); required-index assertion for the replay index       |
| Human input | none in the graph; in practice an **R2 API token** per environment (the parent of CI's temporary credentials) set as Worker secrets. Until then the uploads route answers not-found and tests use a fake |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                |

## Goal

A GitHub Actions job whose OIDC token satisfies its product's publisher policy exchanges that
token for a short-lived, scoped `pkeyci_` token. With it, the job obtains an upload ticket and R2
temporary credentials that can write only `staging/<product>/<ticketId>/`, and submits a release
descriptor whose staged objects the Worker verifies and promotes into the blob store. There is no
long-lived secret in the product's repository. A non-GitHub CI can use an operator-issued,
hashed, expiring `pkeyci_` token instead.

## Why

CI cannot authenticate to Polaris Key at all today: the admin API has one credential, the
platform-admin browser session ([notes/A3 §4.2](../../notes/A3-admin-dx.md#42-how-ci-can-authenticate-to-pkey-today)).
The research adopts the npm/PyPI trusted-publishing model
([§3.4 Publishing](../../README.md#34-release-the-record-of-everything-that-exists),
[notes/E5 §2.2](../../notes/E5-frontier-tech.md#22-github-actions-oidc-as-the-ci-polaris-credential),
[notes/A3 §4.5](../../notes/A3-admin-dx.md#45-credential-design-recommendation)). Binaries never
transit the Worker (request bodies cap at 100 MB), so CI uploads to R2 directly and the Worker
only verifies ([notes/E7 §0](../../notes/E7-server-ci-tools.md) item 2).

## Read first

- `AGENTS.md` (rules 6, 9, 10), `CLAUDE.md`, and the `authoring-pkey-manifests` skill.
- [README §3.4](../../README.md#34-release-the-record-of-everything-that-exists) "Publishing",
  [§3.2](../../README.md#32-service-model-release-distribution-and-update-across-everything-delivered)
  ("Core gains: trusted-publisher auth").
- [notes/E5 §2.1–§2.3 and §4.5](../../notes/E5-frontier-tech.md#22-github-actions-oidc-as-the-ci-polaris-credential)
  (the claim list, the verification recipe, immutable releases, the upload flow);
  [notes/E7 §6](../../notes/E7-server-ci-tools.md#6-godot-ci-tooling-and-whether-to-ship-polaris-keypublish).
- [P2-01](P2-01-blob-store.md) hand-off: `stagingKey`, `verifyStaged`, `promote` and `referencedKeys(db, product, keys)` (landed, `core/blobs.ts`). `present` comes from `referencedKeys`, never from `isStored`, `storedKeys` or `blob_objects`: a ref is earned per product (THREAT-MODEL §3).
- Code: `packages/worker/src/admin/auth.ts:16` and `services/identity/oidc.ts:23` (existing `jose`
  JWKS use), `src/githubWebhook.ts` (KV replay guard pattern), `src/crypto.ts:107` (`hashKey`
  with `KEY_HASH_PEPPER`, as `pkeyt_` tokens use it at `src/core/devices.ts:383`),
  `src/core/rateLimit.ts`, `src/core/errors.ts:14-30`,
  `src/services/release/linkRepo.ts` (installation discovery), `migrations/0018_index_assertion.sql`
  and `src/scheduled.ts` `REQUIRED_INDEXES`.
- `packages/shared-manifest/src/index.ts` (release rules at `:875-1060`),
  `schemas/v1/release.schema.json`, `test/schema-parity.test.ts`.

## Scope

**In:**

- **Core verification** in `packages/worker/src/core/publisher.ts`: GitHub OIDC JWT verification
  and the policy check; `pkeyci_` token issue, hashing and lookup with scopes; upload tickets.
- **Tables** (migration; names proposed, `TABLE_OWNERS` under `core`):
  - `ci_publishers(product PK, provider, repository_id, repository_owner_id, workflow, environment, scopes_json, source, created_at, modified_at)`;
  - `ci_tokens(token_hash PK, product, kind oidc|static, scopes_json, subject, jti, issued_at, expires_at, revoked_at, created_by)` with a unique index on `jti`;
  - `ci_upload_tickets(ticket_hash PK, product, token_hash, objects_json, issued_at, expires_at, redeemed_at)`.
- **Routes** (rule 10: OpenAPI + `SERVICE_PATHS` in `test/routeCoverage.test.ts`), in the release
  namespace because publishing is "into release":
  - `POST /{product}/release/publish/token`: GitHub OIDC JWT in → `{token, expiresAt, scopes}`;
  - `POST /{product}/release/publish/uploads`: `pkeyci_` token with `release:publish`, body
    `{objects: [{sha256, size}]}` → `{ticket, expiresAt, credentials: {endpoint, bucket, accessKeyId, secretAccessKey, sessionToken}, prefix, objects: [{sha256, key, present}], nextSeq: {<deliverable>: n}}`;
  - `POST /{product}/release/publish/submit`: token + ticket + descriptor → verify each staged
    object, promote it, then call P2-04's `ingestReleaseDescriptor`; `dryRun: true` validates only.
- **Manifest (rule 9):** `.pkey/release` `publishing.trustedPublisher: {workflow, environment}`
  (README §3.12). Validator codes (proposed) `invalid_trusted_publisher_workflow`,
  `invalid_trusted_publisher_environment`; mutation-table entries; `release.schema.json`;
  regenerated `reference/validation-codes.mdx`; the skill and `build/manifest/authoring.md`.
- **Ingest:** link and resync write `ci_publishers` while `source = 'manifest'`, resolving
  `repository_id` and `repository_owner_id` from GitHub (`GET /repos/{owner}/{repo}`) with the
  installation token, never from the manifest.
- **Operator path** (admin API, narrative-only): read and claim the policy (`source = 'admin'`),
  edit `scopes_json`, and issue, list and revoke static `pkeyci_` tokens (shown once, expiring at
  most 90 days out). Audited.
- Threat model: CI OIDC claims as a semi-trusted input (§5), `pkeyci_` tokens and R2 temporary
  credentials as assets (§2), a new AT-3 branch ("publish through a trusted publisher").
- **Wave-1 sync:** **Ticket credential scope.** CI's temporary R2 credentials must be read-write on `staging/<product>/<ticketId>/` only, with no copy source outside that prefix and no read on any locked or other-product prefix. `promote`'s stored-checksum path never re-hashes staged bytes, so a CopyObject from `gated/…` into the ticket prefix would carry another product's checksum across (THREAT-MODEL §3); add this to the threat-model text.
- **Wave-1 sync:** **Earn-a-ref product check.** `promote` takes no product. Compare `parseKey(from).product` to the ticket's product before calling it, or add an expected-product parameter to `core/blobs.ts` `promote` that refuses a mismatch with `bad_key` (small Core change, in scope).
- **Wave-1 sync:** **Never surface `alreadyStored` to CI.** It and the short-circuit timing are a cross-tenant existence oracle for files held by other tenants; record it in THREAT-MODEL §3 as a residual risk and answer tickets and submits the same whether or not the object existed.
- **Wave-1 sync:** **Multipart checksums.** `verifyStaged` trusts `checksums.sha256` whenever present. Confirm against real R2 what the binding exposes for multipart uploads (the AWS CLI goes multipart above 8 MB). If it is a composite hash-of-parts, valid uploads fail closed with `digest_mismatch`; then require single-part uploads or verify by streaming.
- **Wave-1 sync:** **Real-binding coverage.** The `alreadyStored` promote path runs only against the Node fake; add a `test:workerd` case (in workerd `src.body` is locked by `pipeThrough(FixedLengthStream)`).

**Out** (and where it belongs instead):

- The descriptor shape, its validation against the artifact map, and the rows it writes
  (→ [P2-04](P2-04-release-descriptor.md)).
- The CLI and the `polaris-key/publish` Action (→ [P2-06](P2-06-publish-cli-action.md)).
- Channel promote/pin/yank routes that accept these tokens (→ [P2-05](P2-05-release-routes.md));
  `distribution:report` routes (→ [P2b-03](P2b-03-availability-keys.md)).
- Console UI for the policy and static tokens. README §6.1 step 4 ("the console shows the exact
  policy to paste") has no owning work package; see the report. Sigstore/attestation checks
  (README §3.4 "later"; no owner).

## Design notes

- **Verification** (README §3.4, E5 §2.2): `alg` RS256 only; `iss` exactly
  `https://token.actions.githubusercontent.com`; JWKS from `/.well-known/jwks`, cached in KV `HOT`
  for about an hour and refetched at most once a minute on an unknown `kid`; `exp`/`nbf` with 60 s
  skew. The `aud` is custom and product-bound: `<origin>/<product>/release/publish` (proposed).
  Make the JWKS fetcher injectable for tests; never make the issuer configurable.
- **Policy checks**, all required: numeric `repository_id` and `repository_owner_id` equal the
  linked repo's (E5: pin the numbers, not `sub`, against name recycling); `job_workflow_ref`
  starts with `<owner>/<repo>/<workflow>@` for the declared workflow; `environment` equals the
  declared environment (default `release`); `ref_protected == "true"`;
  `runner_environment == "github-hosted"`; `event_name` in `push`, `release`, `workflow_dispatch`.
  The last three are platform-fixed and not configurable from the manifest. `ref_protected` is
  true only when a branch or tag ruleset covers the ref, so a tag-triggered release needs a tag
  ruleset; P2-06's `build/ci.md` must say so.
- **The repo must not be able to weaken its own control** (the R6-03 precedent,
  `release/config.ts:89-96`). A manifest may only name the workflow and environment. Once an
  operator claims the policy, resync skips it, as `services_source` does. A resync that changes a
  manifest-owned policy is audited.
- **Replay.** The token exchange is single-use: insert `ci_tokens` with the OIDC `jti` under a
  unique index, so a replay fails in D1 atomically. Add that index to the required-index list
  (`0018` and `REQUIRED_INDEXES`, in a new migration).
- **Tokens.** Format `pkeyci_<random>`; only the peppered hash is stored. OIDC-minted tokens live
  30 minutes. Scopes (a string set; later work packages add theirs, P2b-04
  `distribution:rollout` and P2b-05 `distribution:feeds`): `release:publish`, `release:promote`,
  `release:yank`, `distribution:report`. Default grant: `release:publish`, `release:promote`,
  `distribution:report`; `release:yank` is opt-in.
- **Tickets and R2 credentials.** Temporary credentials are minted from the parent R2 token
  (Worker secrets, proposed `R2_ACCOUNT_ID`, `R2_PARENT_ACCESS_KEY_ID`,
  `R2_PARENT_SECRET_ACCESS_KEY`), scoped to `staging/<product>/<ticketId>/` with object read-write
  and expiring with the token. Cloudflare supports minting them locally by signing a JWT with the
  parent secret. `present: true` marks objects this product already references (one
  `referencedKeys(db, product, keys)` query over `blob_refs`, not `blob_objects` and not an R2 `head`
  per object), so CI skips them (P4-03 relies on this). A ticket
  is redeemed once.
- **`nextSeq`** is the deliverable's current highest `seq` + 1 at issue time. P3-01's plan
  recommends that CI assigns `seq` from the ticket; P2-04 enforces monotonicity.
- **Errors.** Reuse `ErrorCode` (`unauthorized`, `forbidden`, `bad_request`, `not_found`) with a
  machine-readable `reason`. A new `PolarisErrorCode` would be a `shared-protocol` change (plan
  mode) and nothing but the CLI reads these routes.
- **Enablement.** The routes live in the release namespace, so a product with Release off does not
  expose them. Per-IP and per-product rate limits on `publish/token`. (As built: the per-product
  budget is charged only after the token passes signature, audience and policy, so no outsider
  can exhaust it; THREAT-MODEL §3.)
- **Ordering with P2-04.** Everything up to and including promotion is independent of P2-04. If
  P2-04 is not `done`, land token, policy, uploads and ticket redemption first, and `submit` in a
  second PR after P2-04.

## Corrections from the code (recorded during implementation)

- **The CI-token seam already existed.** P2-05 shipped `core/ciScope.ts` (`requireCiScope`,
  `ciActor`) and `core/ciTokens.ts` with a `lookupCiToken` that answered "unknown" for every
  token. P2-02 fills it: `core/ciTokens.ts` re-exports `lookupCiToken` from `core/publisher.ts`,
  and the token prefix, scope vocabulary and `CiPrincipal` moved to a leaf module,
  `core/ciVocabulary.ts` (so the guard, the seam and the store import no one another for a
  constant). Later packages add scopes there.
- **R2 temporary credentials are scoped by action, not only by prefix.** Cloudflare's local
  signing supports an `actions` claim, so the ticket's credentials grant exactly `PutObject` and
  `HeadObject` on `staging/<product>/<ticketId>/`: no read, list, copy or multipart. That closes
  the wave-1 "ticket credential scope" item (no copy source exists) and the "multipart checksums"
  item (multipart is not granted, so CI uploads one PUT with `x-amz-checksum-sha256`) by
  construction. Confirming the behaviour against a real bucket is an operator check
  (`docs/DEPLOYMENT.md`).
- **One more var.** The S3 API names a bucket and the `BLOBS` binding does not, so each
  environment gains a `[vars]` `BLOBS_BUCKET_NAME` beside the three proposed secrets.
- **Columns beyond the proposal.** `ci_publishers.repository` (`owner/repo`, the
  `job_workflow_ref` prefix) and `modified_by`; `ci_tokens.token_id` (the id the operator lists
  and revokes by; the hash is never shown) and `label`; `ci_upload_tickets.ticket_id` (the public
  id in the staging prefix, distinct from the redeemable `pkeyup_` ticket). Migrations are
  `0035_a_ci_publishing.sql` and `0035_b_index_assertion.sql`.
- **Shapes as built.** `/publish/token` takes `{"token": "<jwt>"}`; release ids are
  `<deliverable>@<version>` (`app@1.3.0`, P2-04's format); the operator paths are
  `/manage/api/products/<slug>/ci-publisher` (GET, PUT) and `/ci-tokens[/<tokenId>]`
  (GET, POST, DELETE).
- **P2-04 hand-offs, decided.** (a) The lost-race `release_exists` carries `retryable: true`;
  every other refusal is final. (b) GitHub owns `title`/`notes`/`published_at` wherever a GitHub
  release with the same tag exists (every sync rewrites them); a CI-only release keeps the
  descriptor's values — documented on the Artifacts page. (c) Submit takes exactly one
  descriptor, so no batch planning arises. (d) `promote` takes the product it promotes for and
  refuses another product's staging key with `bad_key`.

## Steps

1. Migration, `TABLE_OWNERS` entries, `docs gen`; the replay index in the required-index list.
2. `core/publisher.ts` with tests: a locally generated RSA key signs fake GitHub tokens; one test
   per claim check, expiry, wrong `aud`, wrong `iss`, unknown `kid` refetch, and replay.
3. Validator rules, mutation entries, schema; ingest of `ci_publishers` in link and resync.
4. The three routes, OpenAPI entries, `routeCoverage` rows; `docs gen` for `routes.mdx`.
5. Admin endpoints for the policy and static tokens, with audit rows.
6. Threat-model update; `docs/DEPLOYMENT.md` (R2 parent token secrets); a docs page section on
   trusted publishing under `services/release/`.

## Acceptance criteria

- [x] Worker tests prove each policy check refuses: wrong `repository_id`, wrong owner id, other
      workflow or ref, other environment, `ref_protected` false, self-hosted runner, disallowed
      event, wrong `aud`, expired token, replayed `jti`.
- [x] A token without `release:publish` cannot obtain a ticket; a revoked or expired `pkeyci_`
      token is refused; a ticket cannot be redeemed twice or by another product's token.
- [x] Submit refuses a descriptor whose staged object is missing or whose SHA-256 or size differs,
      and promotes nothing in that case (tests against the R2 fake).
- [x] A resync cannot change an operator-claimed publisher policy.
- [x] Rule 9: new codes have mutation entries; `pnpm --filter @polaris-key/manifest test` passes.
- [x] Rule 10: `routeCoverage` passes with the three paths; `docs gen:check` is clean.
- [x] The threat model lists the new input, assets and attack branch.
- [x] The green gate passes (`AGENTS.md`).
- [x] Upload-credential tests show the minted credentials cannot read or copy from any prefix outside `staging/<product>/<ticketId>/`, and a promote from another product's staging key is refused with `bad_key`.
- [x] A resubmit of an already-stored object answers CI identically to a first submit (no `alreadyStored` or timing signal).

Implementation notes on the last two rows: the credential test asserts the minted claims and
models R2's documented authorisation rules (no R2 account exists here; the real-bucket check is
listed in `docs/DEPLOYMENT.md` and in the hand-off). The response body is identical with or
without a prior copy and `alreadyStored` is never surfaced; the residual **timing** difference of
the skipped copy is recorded in THREAT-MODEL §3 as the wave-1 note asks.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- publisher routeCoverage boundaries
mise exec node@22 -- pnpm --filter @polaris-key/manifest test
mise exec node@22 -- pnpm --filter @polaris-key/docs gen:check
mise exec node@22 -- pnpm typecheck
```

## Hand-off

- P2-06 calls the three routes; the request and response shapes above are its contract, and the
  `aud` rule tells it what audience to request.
- P2-05, P2b-03, P2b-04 and P2b-05 accept `pkeyci_` tokens through `core/publisher.ts`
  (`requireCiScope(req, product, scope)`, name proposed) and add their scopes to the vocabulary.
- P3-03 extends `submit` to accept CI-signed `pkey-release+jws` records.
- Set the status: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P2-02 done`.
