# P2-01 Core blob store on R2: content-addressed, bucket-locked, on a bytes host (dl.plrs.im)

| Field       | Value                                                                                                                                                                                                                                                                                                      |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | P2: Release truth and publishing                                                                                                                                                                                                                                                                           |
| Size        | 1–1.5 engineer-weeks                                                                                                                                                                                                                                                                                       |
| Depends on  | none                                                                                                                                                                                                                                                                                                       |
| Unblocks    | [P2-02](P2-02-trusted-publisher.md), [P2-05](P2-05-release-routes.md), [P6-04](P6-04-hosted-web.md), [A-18d](A-18d-listing-asset-derivation.md)                                                                                                                                                            |
| Role        | `pkey-implementer`                                                                                                                                                                                                                                                                                         |
| Plan mode   | no                                                                                                                                                                                                                                                                                                         |
| Gates       | threat model (`docs/security/THREAT-MODEL.md`); `wrangler.toml` bindings and routes; D1 migration + `TABLE_OWNERS` (two Core tables; not in the graph's gates); `test:workerd` (new R2 lane); `docs/DEPLOYMENT.md`                                                                                         |
| Human input | ✋ Cloudflare R2 buckets per environment (prod, staging, dev) with the lock and lifecycle rules below; the bytes host `dl.plrs.im` (owner decision: same-site with the console, compensating controls; not a separate registrable domain) with custom-domain routes; `wrangler deploy` of the new bindings |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                                                                  |

> **Corrections from implementation (2026-09-30).** The code is the fact; where this brief and
> the branch disagree, the branch wins.
>
> - **The bytes host is `dl.plrs.im`, same-site with the console (owner decision).** It is a
>   `plrs.im` sibling, not a separate registrable domain, which deviates from "Why" and from
>   README §3.5. It is a Worker custom-domain route (`dl.plrs.im`, `dl-staging.plrs.im`,
>   `dl-dev.plrs.im`), never an R2 domain. Compensations, recorded in
>   `docs/security/THREAT-MODEL.md` §3 and pinned in `test/bytesHost.test.ts`: every
>   bytes-host response sets `X-Content-Type-Options: nosniff` and `Content-Security-Policy:
sandbox; …`; no HTML, XHTML, SVG, XML, JS or `text/*` type is ever served there, and JSON only as the platform error body at status >= 400;
>   `Content-Disposition: attachment` unless the type is allowlisted and the route asks for
>   `inline`; no cookie is read or set on the host; console session cookies are host-only.
> - **Real resources exist.** Buckets `polaris-key-blobs-prod|-staging|-dev` were created with
>   the 180-day age locks and the 1-day `staging/` expiry, `r2.dev` disabled; `wrangler.toml`
>   binds them by name (no `REPLACE_ME`). `BLOB_ORIGIN` is set per environment.
> - **`blobResponse(req, bucket, key, opts)`**, not `(req, object, opts)`. R2's native
>   `onlyIf`/`range` handling compares R2's own etag, while this response's ETag is the
>   SHA-256, so the builder evaluates `If-None-Match`/`If-Range`/`Range` itself and asks R2
>   only for the resulting byte range. `opts.host` is `"console" | "bytes"`.
> - **`promote(bucket, stagingKey, targetKey, {sha256, size}, {db, now})`** takes the D1 handle,
>   because it records the `blob_objects` row. The binding has no server-side copy, so promote
>   streams `get` (pinned to the verified etag) into `putVerified`.
> - `deltaKey` takes an optional `{gated}` like the other builders; `storedKeys(db, keys)` is
>   added beside `isStored` for P2-02's bulk question; `recordObject` is exported.
> - The migration is `0026_blob_store.sql` (number pre-assigned). `blob_refs.storage_key` is a
>   foreign key into `blob_objects`; `blob_refs.product` references `products` without
>   `ON DELETE`, as every non-portal table does (R11-01). `blob_objects` is exempt from the
>   product-first-PK rule (R11-05) because objects are shared across products; tenancy is in
>   `blob_refs`.
> - P0-05 landed first, so the bytes host applies CORS through `core/cors.ts` directly (no
>   TODO): a byte route's `match` returns `{product, params}`, `dispatchBytesHost(req, env, db)`
>   loads that product, answers `OPTIONS` with `corsPreflight` before the route runs and wraps
>   the route's answer in `withCors`, then hardens it. Unknown products answer not-found.
> - Host isolation lives in `core/bytesHost.ts`, called from `dispatch.ts` (main moved dispatch
>   out of `index.ts`), which passes the allowlist `BYTE_ROUTES` from `mount.ts` (empty). It
>   sits beside `SERVICES` in the composition root because byte routes are service code and
>   Core must not import services. The host match ignores case and trailing dots
>   (`dl.plrs.im.` is the same host, and the edge keeps the dot in `req.url`).
> - **The bytes host gates on service enablement itself.** It does not go through
>   `dispatchService`, so it repeats that function's check: every `ByteRoute` names its
>   `service`, and after the `OPTIONS` preflight (which cannot probe enablement, as on the
>   console) a route whose service is off for the product never runs and answers the same
>   not-found as an unknown product. A product that turns Release or Distribution off stops
>   serving bytes on `dl.plrs.im` at once, as P2-05 and P2b-04 assume.
> - The same-site compensations are enforced by the **dispatcher** for every route answer, not
>   only by `blobResponse`: a non-error answer needs a `BYTES_HOST_TYPES` type (a body with no
>   type is refused), `Content-Disposition` is forced to `attachment` unless the route asked for
>   `inline` on an allowlisted type, an error body may be only the platform JSON or an
>   allowlisted type, and a route's own `Access-Control-*` headers are dropped.
> - **Refs are earned, not looked up.** `referencedKeys(db, product, keys)` is added beside
>   `storedKeys`: P2-02's `present` must come from it (the keys this product already
>   references), never from `blob_objects` alone, and a product gets a ref only by promoting a
>   verified upload from its own `staging/<product>/…` prefix or for a key it already
>   references (THREAT-MODEL §3). Delta-key squatting is recorded there as a residual risk.
> - **No hosted web builds on the bytes host.** This package did not set up a separate
>   registrable domain, so P6-04 cannot build on one "P2-01 set up". Web builds need HTML and
>   script, which `dl.plrs.im` refuses by design; P6-04 must obtain its own separate registrable
>   domain (a human input, THREAT-MODEL §3) and may reuse `core/blobs.ts`, never the bytes host.

## Goal

The Worker has an R2 binding `BLOBS` in every environment and a Core module,
`packages/worker/src/core/blobs.ts`, that writes, verifies, promotes and serves content-addressed
objects under the key layout below. Nothing lands under a locked prefix until its SHA-256 has been
checked against the hash it is stored under, and D1 records which objects exist and which product
references each. A byte response carries `Accept-Ranges`, a strong `ETag` equal to the SHA-256 and
`Repr-Digest`, and honours `Range`, `If-Range` and `If-None-Match`. Requests to the separate bytes
host reach nothing but byte routes. No route is added here; P2-05 adds the first ones.

## Why

Every download today streams from GitHub through one GitHub App installation quota of about
5,000 calls an hour, shared by every product on the installation, and every Range chunk re-resolves
the release ([§9.1](../../README.md#91-polaris-key-worth-fixing-regardless-of-godot) issue #3,
[notes/A1 §4](../../notes/A1-release-update.md#4-byte-hosting-model)). Decision 4
([§11](../../README.md#11-decisions-needed)) is R2, content-addressed, bucket-locked, on a separate
registrable domain. The domain must not be a `*.plrs.im` sibling: that is same-site with the
console's cookies ([notes/A3 §7.2](../../notes/A3-admin-dx.md#72-web-builds-and-cors)). Publishing
(P2-02) writes into this store and distribution (P2b-04) serves from it
([§3.5](../../README.md#35-storage-and-byte-delivery)).

## Read first

- `AGENTS.md` (Node 22, the green gate, rules 6 and 11) and `CLAUDE.md`.
- [README §3.5](../../README.md#35-storage-and-byte-delivery) (the key layout, the headers, gating,
  the separate domain), [§3.2](../../README.md#32-service-model-release-distribution-and-update-across-everything-delivered)
  ("Core gains: the blob store"), [§11](../../README.md#11-decisions-needed) decision 4.
- [notes/A3 §7.1–§7.2](../../notes/A3-admin-dx.md#71-serving-large-binaries-and-packs);
  [notes/E5 §4.2–§4.5](../../notes/E5-frontier-tech.md#42-range-resume-integrity-headers) (RFC 9530,
  R2 limits, temporary credentials, bucket locks, the upload flow);
  [notes/E7 §7.1](../../notes/E7-server-ci-tools.md#71-cloudflare-r2-v-unless-tagged).
- Code: `packages/worker/wrangler.toml` (per-environment bindings; no R2 today),
  `packages/worker/src/env.ts:7-80`, `packages/worker/src/index.ts` (host and route dispatch),
  `packages/worker/src/http.ts:54-70` (`isAllowedStorageHost`, R6-12),
  `packages/worker/src/services/release/github.ts:182-245` (`streamAsset`: the header allowlist and
  forced `application/octet-stream`, R6-04), `packages/worker/test/kvMock.ts` (the fake pattern),
  `packages/worker/vitest.workers.config.ts` (the workerd lane's miniflare options).
- `docs/DEPLOYMENT.md` ("Cloudflare resources") and `docs/security/THREAT-MODEL.md` §2, §3, §9.

## Scope

**In:**

- `wrangler.toml`: an `[[env.<env>.r2_buckets]]` block with `binding = "BLOBS"` for prod, staging
  and dev (bucket names proposed: `polaris-key-blobs-prod`, `-staging`, `-dev`); a custom-domain
  route for the bytes host in each environment; a `BLOB_ORIGIN` var (for example
  `https://dl.<bytes-domain>`). `Env` gains `BLOBS?: R2Bucket` and `BLOB_ORIGIN?: string`.
- `core/blobs.ts`:
  - key builders `blobKey(sha256, {gated})`, `bundleKey(sha256, {gated})`,
    `deltaKey(fromSha256, toSha256, method)`, `stagingKey(product, ticketId, sha256)`;
  - `putVerified(bucket, key, body, {sha256, size})`: an R2 `put` with the `sha256` checksum option
    and `onlyIf` so an existing object is never overwritten;
  - `verifyStaged(bucket, stagingKey, {sha256, size})`: uses R2's stored `checksums.sha256` when
    present, else streams through `crypto.DigestStream("SHA-256")`;
  - `promote(bucket, stagingKey, targetKey, {sha256, size})`: verify, then write the target;
  - `blobResponse(req, object, {sha256, gated, host, contentType, filename})`: the response
    builder described in Design notes.
- **Two Core tables** (migration; `TABLE_OWNERS` under `core`; names proposed, and P4-02 and
  P4-14 already build on them):
  - `blob_objects(storage_key PK, sha256, size, kind blob|bundle|delta, gated, verified_at, created_at)`,
    written by `promote`. It answers "is this object already stored?" in one query, which P2-02's
    upload tickets need for thousands of pack file blobs (P4-03);
  - `blob_refs(product, storage_key, ref_kind, ref_id, created_at)`, PK over all four. P2-04
    writes `artifact` refs, P4-02 pack-object refs. A byte route serves a key only if **this**
    product holds a ref to it, and P4-14's garbage collector deletes only unreferenced objects.
- Host isolation in `index.ts`: a request whose host is `BLOB_ORIGIN`'s host is dispatched only to
  routes that declare themselves byte routes (an allowlist P2-05 and P2b-04 fill); everything else
  on that host, including `/manage`, `/docs`, the portal and discovery, gets the not-found answer.
  No cookie is read or set on that host.
- Tests: `test/r2Mock.ts` (an in-memory `R2Bucket` fake with `get` + `range`/`onlyIf`, `head`,
  `put` + checksum, `delete`, `list`), `test/blobs.test.ts`, and a workerd case
  `test-workerd/blobs.test.ts` with `r2Buckets: ["BLOBS"]` added to `vitest.workers.config.ts`.
- `docs/DEPLOYMENT.md`: creating the buckets, the lock and lifecycle rules, disabling `r2.dev`, the
  custom domain. `docs/security/THREAT-MODEL.md`: the new asset, boundary and invariants.

**Out** (and where it belongs instead):

- Upload tickets, R2 temporary credentials for CI and the submit path (→ [P2-02](P2-02-trusted-publisher.md)).
- Any public route that serves a blob, and GitHub resolution caching (→ [P2-05](P2-05-release-routes.md)).
- Access gating per deliverable and moving byte serving into distribution (→ [P2b-04](P2b-04-rollouts-delivery.md)).
- CORS itself (→ P0-05's `core/cors.ts`, applied centrally in `dispatch`). The bytes-host path
  must pass through that same step, as P0-05's hand-off asks; if P0-05 has not landed, leave a
  test-pinned TODO at that point.
- Garbage collection of unreferenced objects (→ P4-14). Hosted web builds (→ [P6-04](P6-04-hosted-web.md)).
- Mirroring GitHub assets into R2 by cron or Queue (README §3.5 "optionally"; no work package owns it yet).

## Design notes

- **Key layout** (README §3.5, verbatim): `blobs/sha256/<hex>`, `bundles/sha256/<hex>`,
  `deltas/<from>/<to>.<method>`. Gated content uses the same layout under `gated/` (proposed:
  `gated/blobs/sha256/<hex>`). CI uploads land in `staging/<product>/<ticketId>/<hex>`, which is
  the only prefix CI credentials can reach (P2-02). `<hex>` is lowercase SHA-256.
- **Bucket locks.** Lock `blobs/`, `bundles/`, `deltas/` and `gated/` by **age**, not
  indefinitely (proposed 180 days). An indefinite lock would make P4-14's garbage collection
  impossible; record this trade-off in the threat model. `staging/` is not locked and has a
  lifecycle rule deleting objects after 1 day.
- **Verify before lock.** A wrong object stored under a hash name would be locked in place. So CI
  never writes a locked prefix: only the Worker's binding does, and only after `verifyStaged`.
  R2 stores a SHA-256 when the uploader sends `x-amz-checksum-sha256` on a single-part PUT; the
  fallback re-hash streams, and never buffers an object in the 128 MB isolate (today's Sparkle
  verifier does, issue #11). Prefer a server-side copy for `promote` where the binding allows it;
  otherwise stream `get` into `put` with the checksum option so R2 rejects a mismatch.
- **Every read goes through the Worker.** Never attach an R2 public domain or `r2.dev` to the
  bucket: a direct R2 domain cannot set `ETag` to the SHA-256, add `Repr-Digest`, or enforce access.
  S-02 confirmed this ([notes/S-02](../../notes/S-02.md) §5.1). R2's own ETag is the MD5, or
  `md5(part md5s)-N` for a multipart upload. The edge compares `If-Range` with that cached value,
  so an SDK's `If-Range: "<sha256>"` would turn every chunk request into a full 200.
- **`blobResponse`** sets `Accept-Ranges: bytes`, `ETag: "<hex>"`, `Repr-Digest: sha-256=:<base64>:`
  (RFC 9530, the whole representation even on a 206), `X-Content-Type-Options: nosniff`, and:
  - ungated: `Cache-Control: public, max-age=31536000, immutable, no-transform` (no edge
    recompression: hashes and `Range` depend on the stored bytes); gated: `private, no-store, no-transform`
    (corrected by P2-05: the edge must not recompress a private `application/wasm` either);
  - `HEAD` returns the same headers without a body;
  - `Range` → 206 with `Content-Range`; a start at or past the size, or `bytes=-0`, → 416 with
    `Content-Range: bytes */<size>`; an end past the size is shortened; a multi-range, unparseable
    or non-`bytes` header → the full 200. `If-Range` not matching the ETag exactly and strongly
    (weak tags, dates and R2's MD5 all count as mismatches) → the full 200. `If-None-Match`
    matching → 304, with no body read (one `head()` checks the stored hash first).
  - **The Worker parses `Range` and evaluates `If-Range` itself**, then calls `get(key, { range:
{offset, length} | {suffix} })`. Never pass the request `Headers` as `range` or `onlyIf`. R2
    ignores `If-Range` ("all conditional headers aside from `If-Range` are supported"), so it
    would splice a stale resume. In the emulator, header ranges it cannot satisfy (multi,
    inverted, `bytes=-0`, past the end) came back as the whole object (S-02 §2, §4.1). The S-02
    probe Worker (`prototype/r2-range/worker/`) is a reference for this logic.
  - Serve `application/octet-stream` with no `Content-Encoding`. Cloudflare never compresses that
    type or a 206, and `no-transform` keeps the strong ETag from being weakened on 200s.
  - On the console host (`key.plrs.im`) the type is always `application/octet-stream` with
    `Content-Disposition: attachment`, as `streamAsset` does today (R6-04). Only on the bytes host
    may a route pass a real type from an allowlist (`application/vnd.android.package-archive`,
    `application/wasm`, `application/zip`, …) or an inline disposition.
- **Graceful absence.** Until the human creates the buckets, `env.BLOBS` is unbound. Every caller
  treats that as "no blob store" (the future routes answer not-found), so the Worker deploys and
  runs exactly as today. Tests run against the fake and miniflare's local R2.
- **Why Core.** Publishing (release) writes and distribution serves, and a service may not import
  a sibling (`test/boundaries.test.ts`), so the store is substrate like `keyvault.ts`.
- The dependency on P0-09 is not technical: nothing here reads the service table.

## Steps

1. Add `env.ts` fields and the `wrangler.toml` blocks with `REPLACE_ME` placeholders where a
   human-created name or domain is missing, following the D1/KV precedent in that file.
2. Write `test/r2Mock.ts` and the unit tests first (key builders, checksum refusal, overwrite
   refusal, staged verification both ways, every header and status above).
3. Implement `core/blobs.ts` against the fake; then add the workerd lane case against miniflare R2
   (Range, `DigestStream` over a multi-MiB object, conditional put).
4. The migration for `blob_objects` and `blob_refs` (numbered on rebase), `TABLE_OWNERS`,
   `pnpm --filter @polaris-key/docs gen`; `recordRef`, `hasRef` and `isStored` helpers with tests.
5. Add host isolation in `index.ts` with a test: `/manage`, `/docs`, `/`, a portal path and
   discovery on the bytes host all return the not-found body; the console host is unchanged.
6. Update `docs/DEPLOYMENT.md` and the threat model (asset: the bucket and its write paths;
   boundary: the bytes host; invariants: verify-before-lock, Worker-only reads, no cookies).

## Acceptance criteria

- [x] `test/blobs.test.ts` covers: a put whose bytes do not match the key's hash is refused; a
      second put to an existing key is refused; `verifyStaged` accepts R2's stored checksum and
      falls back to a streamed hash; `promote` never writes the target when verification fails.
- [x] Header tests: 200 with `ETag`, `Repr-Digest`, `Accept-Ranges`, immutable caching; 206 with
      `Content-Range`; 416; `If-Range` mismatch returns 200; `If-None-Match` returns 304; gated
      responses are `private, no-store, no-transform` (P2-05); console-host responses are always octet-stream attachments.
- [x] `test-workerd/blobs.test.ts` passes on miniflare R2, including a streamed hash of an object
      larger than 16 MiB.
- [x] `promote` records a `blob_objects` row only after verification; `hasRef(db, product, key)`
      is false for another product's ref; `docs gen:check` lists both tables under Core.
- [x] Host isolation test passes; with `BLOB_ORIGIN` unset, routing is byte-identical to today.
- [x] `wrangler deploy --dry-run` (`pnpm --filter @polaris-key/worker dryrun`) parses the config.
- [x] `docs/DEPLOYMENT.md` and `docs/security/THREAT-MODEL.md` are updated; the lock duration and
      the GC trade-off are recorded.
- [x] The green gate passes (`AGENTS.md`), including `typecheck:workerd` and `test:workerd`.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- blobs
mise exec node@22 -- pnpm --filter @polaris-key/worker typecheck:workerd
mise exec node@22 -- pnpm --filter @polaris-key/worker test:workerd
mise exec node@22 -- pnpm --filter @polaris-key/worker dryrun
mise exec node@22 -- pnpm --filter @polaris-key/docs gen:check
mise exec node@22 -- pnpm typecheck
```

## Hand-off

- P2-02 uses `stagingKey`, `verifyStaged`, `promote` and `referencedKeys` (for `present`, which
  must be per product, never `isStored`/`storedKeys`); it adds the R2 parent credentials that
  mint CI's temporary credentials. P2-04 writes `blob_refs` for artifacts, P4-02 for pack
  objects, and both grant a ref only under the THREAT-MODEL §3 rule: a verified promote from
  the product's own `staging/<product>/…` prefix, or a key the product already references.
  P4-14 collects unreferenced objects. P2-05 and P2b-04 use `blobResponse` and
  `hasRef`, and register their byte routes in `mount.ts` `BYTE_ROUTES`, each naming its
  `service` (`release` for P2-05; P2b-04's distribution service slug). The bytes host bypasses
  `dispatchService`, so that `service` field is what keeps a disabled service's bytes from
  answering; a route must name the service that owns it, never a default-on one. P6-04 must **not** host web
  builds on `dl.plrs.im`: web builds serve HTML and script, which the bytes host refuses, so
  they need their own separate registrable domain (a human input), per THREAT-MODEL §3. P6-04
  may reuse `core/blobs.ts` for storage, but not the bytes host.
- The key layout, the `gated/` prefix and the lock duration are fixed here; P4-05 and P4-14 rely
  on them.
- Record in the PR which human inputs arrived (bucket names, domain, deploy). Then set the status:
  `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P2-01 done`.
