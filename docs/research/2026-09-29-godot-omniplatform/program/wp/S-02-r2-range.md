# S-02 Spike: Range, If-Range and cold-miss behaviour of R2 behind a custom domain

| Field       | Value                                                                                                                                                                                                                                                                                   |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | S: Spikes                                                                                                                                                                                                                                                                               |
| Size        | 0.5 engineer-weeks                                                                                                                                                                                                                                                                      |
| Depends on  | none                                                                                                                                                                                                                                                                                    |
| Unblocks    | [P4-10](P4-10-chunk-indexes.md), [P4-11](P4-11-chunk-sync-sdks.md)                                                                                                                                                                                                                      |
| Role        | `pkey-spike-runner`                                                                                                                                                                                                                                                                     |
| Plan mode   | no                                                                                                                                                                                                                                                                                      |
| Gates       | none beyond `pnpm format` on the files it adds; no change to `packages/worker`                                                                                                                                                                                                          |
| Human input | Cloudflare account with R2. Also needed, not in the graph: a zone on that account for temporary hostnames (an R2 custom domain for path A and two probe Worker domains; not `dl-dev.plrs.im`, which is P2-01's bytes host), a throwaway bucket, and a wrangler API token scoped to them |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                                               |

## Goal

A research note, [`notes/S-02.md`](../../notes/S-02.md), gives measured behaviour of R2 objects served three
ways, and a serving recommendation:

- **A.** An R2 custom domain bound directly to the bucket, with caching on.
- **B.** A small Worker gateway reading the R2 binding (`env.BUCKET.get(key, { range, onlyIf })`),
  with and without the Cache API for full responses.
- **C.** `r2.dev`, as a reference only.

For each path it covers: single `Range` on a cold miss and on a warm hit; multi-range; `If-Range`
with a matching and a mismatching validator; the `ETag` format; `HEAD`; compression; objects
above the cacheable size limit; and time to first byte and throughput by object size.

## Why

The design serves every artifact with `Accept-Ranges`, `If-Range`, a strong `ETag` equal to the
SHA-256, `Repr-Digest` and immutable caching ([README §3.5](../../README.md#35-storage-and-byte-delivery)),
and the client fetches missing chunk runs "by Range with `If-Range` on the chunk bundle's hash"
([CONTENT §10](../../CONTENT.md#10-client-pipeline-every-sdk)). Cloudflare's documentation says
multi-range works only "when Origin Range Requests applies", that on a cold miss "the first origin
request also omits `Range`", that `Range` is ignored when Cloudflare must decompress, and that
`If-Range` must match the cached `ETag` exactly
([notes/E8 §2.5](../../notes/E8-content-delivery.md#25-cloudflare-and-r2-facts-that-constrain-the-chunk-transport)).
Whether this holds for R2 custom-domain objects on our plan is open
([CONTENT §17](../../CONTENT.md#17-open-questions-and-spikes) Q2;
[notes/E5 §9](../../notes/E5-frontier-tech.md#9-open-questions--items-to-re-verify-before-building)).
Nothing in the repo answers it yet: `packages/worker/wrangler.toml` has no R2 binding, and today's
GitHub asset stream passes `Range` and `If-None-Match` but not `If-Range`
(`packages/worker/src/services/release/github.ts:192-195`). The answer fixes the serving path for
P2-01 and P2b-04 and the chunk-bundle size for P4-10.

## Read first

- `AGENTS.md` and `.claude/agents/pkey-spike-runner.md`.
- [README §3.5](../../README.md#35-storage-and-byte-delivery) and [§11](../../README.md#11-decisions-needed) decision 4 (R2, content-addressed; P2-01 landed the bytes host as `dl.plrs.im`, same-site, not a separate registrable domain).
- [CONTENT §10](../../CONTENT.md#10-client-pipeline-every-sdk) (fetch, resume, web: `Cache.put` rejects 206) and [§11](../../CONTENT.md#11-server-side-by-service) (the `distribution/blob/<sha>` route).
- [notes/E5 §4.2–§4.4](../../notes/E5-frontier-tech.md#42-range-resume-integrity-headers) (Range, `Repr-Digest`, R2 limits, presigned URLs only on the S3 endpoint, WAF token auth, serving design).
- [notes/E8 §2.5](../../notes/E8-content-delivery.md#25-cloudflare-and-r2-facts-that-constrain-the-chunk-transport).
- [notes/A7 §8–§9](../../notes/A7-xlang-content.md#8-throughput) (chunk sync over HTTP `Range`: 29 requests for the 37 MB case on localhost).
- `packages/worker/src/services/release/github.ts` (`streamAsset`) and `gateway.ts` for today's header handling.

## Scope

**In:**

- A bucket with test objects under content-addressed keys (`blobs/sha256/<hash>`), each uploaded
  with `Cache-Control: public, max-age=31536000, immutable` as HTTP metadata.
- Objects of 1, 4, 8, 16 and 64 MiB of incompressible random bytes; one object above the zone's
  cacheable file-size limit (read the limit for the plan from Cloudflare's docs first); one real
  chunk bundle built by `prototype/content/gen/gen.py large`.
- A probe script, `prototype/r2-range/probe.mjs` (Node 22 `fetch`, plus `curl -v` spot checks).
- A minimal Worker under `prototype/r2-range/worker/` that implements the README §3.5 headers: a
  strong `ETag: "<sha256hex>"`, `Repr-Digest: sha-256=:<b64>:`, `Accept-Ranges: bytes`, `If-Range`
  evaluation, 206 through `get(key, { range })`, and optional `caches.default.match` of full 200
  responses (the Cache API cannot `put` a 206; notes/E5 §4.2).

**Out** (and where it belongs instead):

- The production blob store, bucket locks and upload credentials (→ P2-01, P2-02).
- Production byte-serving routes, gating and WAF token rules (→ P2b-04, P4-05).
- Chunk bundles in CI (→ P4-10); client chunk sync (→ P4-11); web build hosting (→ P6-04).

## Design notes

- **Cold versus warm.** Make every cold trial cold by uploading a fresh random object under a new
  key, rather than purging, so edge state cannot leak between trials.
- **Record per request:** status, `content-range`, `content-length`, `etag`, `accept-ranges`,
  `content-encoding`, `cf-cache-status`, `age`, `cf-ray` (the colo), time to first byte, total time
  and bytes read. Send `Accept-Encoding: identity`, and repeat key cases with
  `gzip, br, zstd` to see whether compression switches `Range` off.
- **Multi-range:** 2, 10, 300 and 301 ranges, ascending and non-overlapping; then an overlapping
  set. Expect multipart `206`, or a `200` full body above 300 ranges (notes/E8 §2.5).
- **`If-Range`:** with R2's own `ETag` on path A and with the SHA-256 `ETag` on path B; then with a
  stale validator (expect a full `200`, which is what stops a resumed download from splicing two
  versions). Record R2's native `ETag` format for single-part and multipart uploads; the design
  assumes the SHA-256 is the `ETag`, which path A may not give.
- **Vantage points:** at least two (for example a workstation and a GitHub Actions runner), with the
  colo recorded. Record the zone's plan and whether Tiered Cache or Cache Reserve is on; Cache
  Reserve is not eligible for `Range` requests (notes/E5 §4.2).
- The whole spike fits in R2's free tier. Delete the bucket afterwards unless the human wants it
  kept for P2-01.

## Status of the inputs (2026-09-30)

- The dev bucket `polaris-key-blobs-dev` exists (ENAM, no custom domain, `r2.dev` off), and every
  zone on the account is on the Free plan.
- The first run could not create the custom domain or deploy the probe Worker. So it measured the
  Worker and R2-binding logic on miniflare, measured clients (Godot, Chromium, WebKit) for real,
  and took edge behaviour from Cloudflare's docs.
- The live rows are hand-off rows H1–H10 in the note (§8). They run against a throwaway bucket,
  `pk-s02-probe`, with temporary hostnames, never `polaris-key-blobs-dev` or `dl-dev.plrs.im`:
  path A would publish the whole dev bucket, and `dl-dev.plrs.im` is already P2-01's bytes host.
  The probe Worker refuses keys outside `s02/` whichever bucket it binds. Teardown is deleting
  the bucket, its custom domain and the probe Workers (a third, gateway-form one for H10).

## Steps

1. With the human: pick the zone and bucket names; create a scoped API token.
2. Create the bucket, bind the custom domain, upload the objects with `wrangler r2 object put`.
3. Deploy the probe Worker from `prototype/r2-range/worker/` to a `workers.dev` route or a test
   route on the zone.
4. Run the probe matrix on paths A, B and C from both vantage points, three times each.
5. Write the note: one table per behaviour, with raw numbers in an appendix or a committed CSV
   (formatted or git-ignored as `prototype/patching/out/` is).
6. Tear down, or hand the bucket to P2-01.

## Acceptance criteria

- [ ] `notes/S-02.md` exists with the provenance blockquote, question, short answer,
      method, environment (plan, colos, dates), results, recommendation, affected briefs and
      sources, with evidence tags.
- [ ] A table answers, per path: single `Range` cold and warm (status, bytes fetched, TTFB),
      multi-range at each count, `If-Range` match and mismatch, `ETag` format, `HEAD`, behaviour with
      compression requested, and behaviour above the cacheable size limit.
- [ ] The recommendation states: the path for ungated blobs; whether clients may ever send
      multi-range (and if so behind which capability probe); the chunk-bundle size range
      (confirming or changing 4–16 MiB); the `ETag`/`If-Range` rule SDKs must follow; and whether
      bundles need a compression-off rule.
- [ ] `prototype/r2-range/` holds the probe and Worker with a README; no account ids or tokens are
      committed.

## Verify

```sh
node docs/research/2026-09-29-godot-omniplatform/program/check.mjs
mise exec node@22 -- pnpm format
# Re-run one row of the matrix against the deployed probe Worker:
node docs/research/2026-09-29-godot-omniplatform/prototype/r2-range/probe.mjs --path B --size 8MiB --cold
```

## Hand-off

P2-01 and P2b-04 take the serving-path decision and the header rules; P4-10 takes the chunk-bundle
size and the multi-range decision; P4-11 and the SDK HTTP layers take the `If-Range` rule (which
`ETag` to send). If path A cannot give a SHA-256 `ETag`, the note must say whether the design's
"strong `ETag` equal to the SHA-256" needs path B for every byte, and propose the README §3.5 edit.
Set the status with `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set S-02 done`.
