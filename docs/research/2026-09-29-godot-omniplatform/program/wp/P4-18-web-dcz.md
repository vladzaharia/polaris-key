# P4-18 Web deltas via Compression Dictionary Transport, with the WASM decoder fallback

| Field       | Value                                                                                                                                            |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase       | P4: Packs (v3)                                                                                                                                   |
| Size        | 1–1 engineer-weeks                                                                                                                               |
| Depends on  | [P4-11](P4-11-chunk-sync-sdks.md)                                                                                                                |
| Unblocks    | none                                                                                                                                             |
| Role        | `pkey-implementer`                                                                                                                               |
| Plan mode   | no: the stored artifact and the descriptor do not change; `dcz` framing is added at the edge                                                     |
| Gates       | none in the graph; in practice rule 10 (the payload URL is a new route: OpenAPI, `routeCoverage`, `routes.mdx`) and the Chromium runner (P1b-05) |
| Human input | none                                                                                                                                             |
| Repo        | `vladzaharia/polaris-key`                                                                                                                        |

## Goal

In Chromium, a pack update whose plan is a `zstd-patch-from` delta downloads only the delta.
Distribution serves the stored bare frame with `Content-Encoding: dcz` and a 40-byte header
derived from `from` whenever the browser advertises the installed payload as a dictionary. The
React SDK verifies the decoded payload's SHA-256 against the record. It falls back to
`@polaris-key/zstd-wasm` (P4-06's decoder-only libzstd, raw-content prefix) with the installed
payload from OPFS, and then down the plan, when `dcz` is not offered: the dictionary was evicted,
the payload was never fetched whole, it is over 100 MiB, it is gated, or the browser is Firefox
or Safari.

## Why

On the web the planner's cheapest candidate is often a delta, but JavaScript has no native zstd:
`DecompressionStream` offers only gzip, deflate and deflate-raw. notes/A7 showed Chromium decoding
the vectors' own `--patch-from` artifact natively and byte-identically through Compression
Dictionary Transport: 5.26 MB from 311,569 B, and 37.7 MB from 604,875 B in 612 ms
([notes/A7 §9.3](../../notes/A7-xlang-content.md#93-compression-dictionary-transport-applies-the-vector-delta-natively-m)).
That moves README P4 v3's "web Compression Dictionary Transport" from speculative to demonstrated
([CONTENT §10](../../CONTENT.md#10-client-pipeline-every-sdk), web).

## Read first

- `AGENTS.md` (rule 10), [README §3.5](../../README.md#35-storage-and-byte-delivery) (separate
  byte domain, `Repr-Digest`, caching, CORS) and [§3.11](../../README.md#311-web).
- [CONTENT §9](../../CONTENT.md#9-formats) (publish and decode rules: "the stored artifact is the
  bare frame; the browser's `dcz` framing is added at the edge") and
  [§10](../../CONTENT.md#10-client-pipeline-every-sdk) (web).
- [notes/A7](../../notes/A7-xlang-content.md): §3.2, §7.3 (a `dcz` body is not a portable zstd
  stream), §9.1–§9.5 (APIs, OPFS, the 100 MiB dictionary cap, the per-site budget, the serving
  recipe, the WASM build).
- [notes/E5 §4.1](../../notes/E5-frontier-tech.md#41-compression-dictionary-transport-rfc-9842)
  (RFC 9842, browser support, Cloudflare's passthrough mode).
- Reference code: `docs/research/2026-09-29-godot-omniplatform/prototype/content/runners/browser/`
  (`server.mjs`, `cdtcap.mjs`, `worker.mjs`, `zstddec-prefix.mjs`) and `prototype/content/wasm/zdec.c`.
- The distribution blob route (P4-05, P2b-04) and its tests; the React SDK's pack wiring and OPFS
  worker (P4-06, P4-11); the per-product CORS allowlist (P0-05); the Chromium job (P1b-05).

## Scope

**In:**

- Worker (distribution), a **payload URL** per (pack, variant, payload SHA-256) beside the
  hash-addressed blob route:
  - it serves the _decoded_ payload to browsers by streaming the stored `full` object (one zstd
    frame) with `Content-Encoding: zstd`, only when `Accept-Encoding` includes `zstd`; otherwise it
    refuses (`406`) and the SDK uses the blob route and the WASM decoder;
  - for ungated payloads of at most 100 MiB it adds `Use-As-Dictionary` with a per-(pack, variant)
    `match` pattern;
  - when `Available-Dictionary` equals the SHA-256 of the `from` of a published `zstd-patch-from`
    delta to the requested payload, it answers `Content-Encoding: dcz` with the body
    `5E 2A 4D 18 20 00 00 00 ‖ from (32 bytes) ‖ artifact` streamed from R2, and
    `Vary: Accept-Encoding, Available-Dictionary`;
  - rule 10: the new path gets an OpenAPI entry and a `routeCoverage` entry; `routes.mdx` is
    regenerated.
- React SDK: the `dcz` path for a planned `delta`, output verification, and the fallback chain.
- Playwright tests in the Chromium job; docs for adopters on what the web gets.

**Out** (and where it belongs instead):

- Generating deltas (CI: P4-03; lazy: [P4-17](P4-17-lazy-deltas.md)).
- `dcb` (Brotli dictionaries): there is no second codec (README decision 21).
- Firefox and Safari: they do not implement CDT, so the WASM path is their delta route. A WebKit
  run belongs to S-04 and PARITY §11 Q4 before React claims `packs.apply.delta` everywhere.
- Hosting web builds (→ P6-04).

## Design notes

- **The header is derivable from `from` alone**: the 8-byte `dcz` magic followed by the 32-byte
  SHA-256 of the dictionary (A7 §9.3). No base bytes are read, and the stored artifact stays the
  portable bare frame (A7 §7.3: most decoders mishandle a `dcz` body).
- **Why a separate payload URL.** The browser's dictionary is the response body _after_ content
  decoding, and a `--patch-from` delta's base is the decoded payload (`from` is its SHA-256).
  P4-05 serves every stored object on the blob route as opaque bytes with no `Content-Encoding`
  (so `Range` and hashes stay intact), which would make the dictionary the compressed frame, not
  the payload. The payload URL is full-body only (no `Range`), `no-transform`, and leaves the blob
  route unchanged. A7 §9.1: a full blob served with `Content-Encoding: zstd` needs no WASM in
  Chromium, which is a second win.
- **Match patterns must be specific.** RFC 9842 has the browser pick the dictionary with the
  longest matching `match` pattern, then the most recent. A product-wide pattern would advertise
  another pack's payload. Put the pack and variant in the payload URL's path (proposed
  `…/distribution/packs/<packId>/<variant>/payload/<sha256>`) and match on that prefix.
- **Only fetched payloads are dictionaries.** A payload assembled by chunk sync in OPFS was never
  fetched whole, so the browser has no dictionary for it. `dcz` helps when the installed payload
  was a `full` fetch through the payload URL still in the HTTP cache, which is also the Godot-web
  pattern (CONTENT §10: fetch large packs each session from immutable URLs). The dictionary lives
  in the evictable HTTP cache, so always verify SHA-256(output) = `to` in JavaScript (A7 §9.3).
  CONTENT §11 and A7 §9.3 put `dcz` on the blob or delta route; the payload URL is this brief's
  refinement, for the reason above.
- **Limits.** Dictionaries over 100 MiB are never offered (Chromium's `kDictionarySizeLimit`), and
  a per-site budget evicts dictionaries (A7 §9.3); do not send `Use-As-Dictionary` above 100 MiB.
  RFC 9842 requires secure contexts and same-origin matching; the bytes are on a separate
  registrable domain (README §3.5), so the page fetches cross-origin under the product's CORS
  allowlist. Confirm in Playwright that a CORS-mode fetch uses the dictionary.
- **Avoid a silent full download on a miss.** If the browser does not send
  `Available-Dictionary`, the target URL returns the full payload, which costs more than planned.
  Proposed guard: the SDK adds a query marker (for example `?via=dcz`) and the Worker answers
  `409` with no body when the header is absent or names another base; the SDK then takes the WASM
  path. Confirm in Playwright that the marked URL still matches the `match` pattern; if not, drop
  the guard and account for the miss in the plan's fallback.
- **Workers details.** Send the pre-encoded body with `encodeBody: "manual"` so the runtime does
  not re-encode it. Cloudflare's shared-dictionary support is passthrough: it forwards the headers
  and varies the cache but never computes deltas (E5 §4.1). Gated responses stay
  `private, no-store`, which a browser cannot keep as a dictionary, so gated packs use the WASM
  path; say so in the adopter docs.
- **WASM fallback.** Reuse `@polaris-key/zstd-wasm` from P4-06 (the decoder-only libzstd 1.5.7
  build of A7 §9.5: 68,949 B, 24,110 B gzipped, `ZSTD_DCtx_refPrefix` with an explicit window
  limit, immune to the magic-base trap). If P4-06 shipped a different decoder, stop and raise it
  rather than vendoring a second one here.
- **Planner.** `dcz` is how the `delta` strategy executes in Chromium, not a new strategy. Bytes
  are the artifact plus 40; the request count is 1. The fallback order after a failed `dcz`
  attempt is WASM delta, then the plan's remaining candidates.

## Steps

1. Worker: the payload URL (rule 10), `Content-Encoding: zstd` streaming, `Use-As-Dictionary`,
   `dcz` on matching requests, the optional `409` guard, headers and caching; Worker tests.
2. React SDK: `full` via the payload URL when available, the `dcz` path in the OPFS worker,
   verification, fallback chain.
3. Playwright tests: dictionary offered and used; evicted or absent dictionary falls back; over
   100 MiB never offered; gated payload never offered; cross-origin with CORS.
4. Adopter docs; the green gate.

## Acceptance criteria

- [ ] Worker tests: the payload URL streams the stored frame with `Content-Encoding: zstd` and
      `Use-As-Dictionary` (the per-(pack, variant) pattern; none above 100 MiB or for gated
      packs); a request with a matching `Available-Dictionary` returns `Content-Encoding: dcz`,
      the 40-byte header and the stored artifact, with `Vary: Accept-Encoding, Available-Dictionary`;
      a non-matching header returns the plain payload; the blob route's responses are unchanged.
- [ ] In the Chromium job, the React SDK updates A7's v1 → v2 vector via `dcz`, downloading
      artifact + 40 bytes and producing v2's SHA-256; with the dictionary cleared it falls back to
      the WASM delta; with a corrupted artifact it falls back further and reports the failure.
- [ ] `routeCoverage.test.ts` and the OpenAPI spec cover the payload URL, and
      `pnpm --filter @polaris-key/docs gen:check` passes.
- [ ] The green gate passes (`AGENTS.md`), including the workerd smoke job.
- [ ] `parity.json` manifests are updated for every SDK this changes (once P1b-01 has landed).

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- distribution
mise exec node@22 -- pnpm --filter @polaris-key/react test
mise exec node@22 -- pnpm --filter @polaris-key/worker test:workerd
# the Chromium (Playwright) job P1b-05 added, over the React SDK and client-core
```

## Hand-off

- Godot web builds fetch through the browser, so they get `dcz` transparently when they request
  the target payload URL; a Godot web runner can confirm it later.
- The `Use-As-Dictionary` path scheme is what any later web SDK (Blazor, X-01) relies on.

Set the status in the PR that completes the work:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P4-18 done`.
