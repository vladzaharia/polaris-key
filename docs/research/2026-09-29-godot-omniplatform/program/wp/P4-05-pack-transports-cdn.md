# P4-05 Distribution: CDN and embedded transports for packs, availability and gated delivery

| Field       | Value                                                                                                                                                   |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | P4: Packs (v1)                                                                                                                                          |
| Size        | 0.75–1 engineer-weeks                                                                                                                                   |
| Depends on  | [P4-02](P4-02-pack-deliverables.md), [P2b-04](P2b-04-rollouts-delivery.md), [P2b-03](P2b-03-availability-keys.md)                                       |
| Unblocks    | [P4-11](P4-11-chunk-sync-sdks.md), [P4-18](P4-18-web-dcz.md), [D-04](D-04-diceroll-after-p4.md)                                                         |
| Role        | `pkey-implementer`                                                                                                                                      |
| Plan mode   | no                                                                                                                                                      |
| Gates       | rule 10 (OpenAPI + `routeCoverage` for any new path or method; `routes.mdx` via `docs gen:check`); migration + `TABLE_OWNERS` only if a column is added |
| Human input | none (uses the R2 buckets and byte domain P2-01 provisioned; local tests use the R2 mock)                                                               |
| Repo        | `vladzaharia/polaris-key`                                                                                                                               |

## Goal

A published pack release reaches devices through distribution. Every object a pack record names
(full blob, files index, gaps blob, file blobs, delta artifacts) is served from the byte domain by
hash with `Range`, `If-Range`, a strong `ETag` equal to the SHA-256, `Repr-Digest` and immutable
caching, and with CORS for the `web` transport. Objects of an entitled pack deliverable live under
the gated prefix and are served only to a device whose licence carries that entitlement flag, never
cached publicly. Distribution records availability for pack releases: `pkey-cdn`/`web` go `live`
once all of a release's objects are in the blob store, and `embedded` is ready by construction for
every build whose record lists the pack in `embeds`.

## Why

Transports are distribution's, and a pack uses one transport per outlet
([CONTENT §7](../../CONTENT.md#7-transports), [README §3.8](../../README.md#38-distribution-distribution-service)).
v1 needs only the two that ship everywhere: the R2 CDN (the universal fallback) and embedded
baselines (offline-ready, store-safe, the seed for patching;
[CONTENT §6.6](../../CONTENT.md#66-transport-imposed-binding-per-outlet)). Gated packs must be
authorised per request because a hash is never a secret
([README §3.5](../../README.md#35-storage-and-byte-delivery),
[CONTENT §12](../../CONTENT.md#12-security)).

## Read first

- `AGENTS.md` (rules 6 and 10); [README §3.5](../../README.md#35-storage-and-byte-delivery),
  [§3.8](../../README.md#38-distribution-distribution-service) (data model, routes);
  [CONTENT §6.4](../../CONTENT.md#64-publishing-checks-in-both-directions) ("outlet readiness":
  embedded is ready by construction, `pkey-cdn` when its blobs are published),
  [§7](../../CONTENT.md#7-transports), [§11](../../CONTENT.md#11-server-side-by-service),
  [§12](../../CONTENT.md#12-security).
- The briefs this builds on: [P2-01](P2-01-blob-store.md) (blob store, gated prefix, byte domain),
  [P2-02](P2-02-trusted-publisher.md) (upload tickets), [P2b-02](P2b-02-distribution-manifest.md)
  (`.pkey/distribution` transports), [P2b-03](P2b-03-availability-keys.md) (`dist_availability`),
  [P2b-04](P2b-04-rollouts-delivery.md) (byte serving and `dist_access` move to distribution),
  [P4-02](P4-02-pack-deliverables.md) (the release descriptor hook's pack data; README §3.2 calls
  it `releaseCatalog`, but use the name P2b-01 landed).
- The S-02 spike note on R2 `Range`/`If-Range`/cold-miss behaviour, if it has landed.
- Code: `packages/worker/openapi/polaris-key.v3.yaml`, `test/routeCoverage.test.ts`
  (`SERVICE_PATHS` at line 63), `test/boundaries.test.ts`, the distribution service directory
  P2b-01 created, and the CORS allowlist from P0-05.

## Scope

**In:**

- **Transports.** Resolve `.pkey/distribution` `transports` for pack deliverables into
  `dist_transports` rows per (deliverable, outlet). v1 acts on `pkey-cdn`, `web` and `embedded`;
  any other transport is stored, shown as "not supported yet" and left to the device, whose
  planner answers `plan.transport_unsupported` (never a silent CDN fallback).
- **Availability.** `dist_availability` rows for pack releases: `pkey-cdn`/`web` `live` when every
  object of the release is present with matching size and hash (checked through Core's blob refs);
  `embedded` per (app release, outlet) from the builds' `embeds`, read through the hook.
- **Byte serving** of every pack object role through P2b-04's blob route: `GET` and `HEAD`, single
  `Range` (a multi-range request gets the full 200; clients never send one, S-02), `If-Range` on
  the strong `ETag` evaluated by the Worker, `Repr-Digest: sha-256=:…:` (RFC 9530),
  `Cache-Control: public, max-age=31536000, immutable, no-transform` for ungated objects, and CORS
  for `web`. CORS is P0-05's, not new code:
  - bytes-host CORS is `core/cors.ts`, applied by `dispatchBytesHost` (`core/bytesHost.ts`
    answers `OPTIONS` through `corsPreflight`). Its allow list already includes `Range`,
    `If-Range` and `If-None-Match`, next to `Authorization` and the `X-PKey-*` headers that gated
    delivery needs. Its expose list already has `ETag`, `Content-Range`, `Accept-Ranges`,
    `Content-Length` and `Repr-Digest`. Keep both as they are.
  - `Access-Control-Max-Age` stays `600`, chosen so that removing an origin takes effect soon.
    Raise it only for the bytes host and only on purpose, recording the origin-removal
    trade-off and that WebKit caps the preflight cache at 600 s anyway (Chromium at 7200 s).

  A single `Range` is CORS-safelisted, but `If-Range` is not. Chromium 145 and WebKit 26
  preflight every such request ([notes/S-02](../../notes/S-02.md) §4.4, §6 point 1).

- **Gated delivery.** `dist_access` for a pack deliverable with `entitlement`: its objects are
  uploaded to and served from the gated prefix only; each request is authorised by device token
  and the licence's entitlement flag; responses are `private, no-store`. The public path never
  reads the gated prefix. Upload tickets for a gated deliverable are scoped to the gated prefix.
- **Rule 10.** If P2b-04's route lacks `HEAD` or a gated variant, add it with an OpenAPI entry and
  a `routeCoverage` entry; regenerate `routes.mdx`.

**Out** (and where it belongs instead):

- Platform transports (`apple-ba`, `play-pad`, `steam-depot`, …) and their markers' CI steps
  (→ P5-08).
- Per-outlet pack rollouts and halts, outlet readiness holds, server GC (→ P4-14).
- `dcz` delta serving (→ P4-18); chunk bundles (→ P4-10: the route is hash-generic, so bundles
  need only their role and the gated-prefix rule).
- Pack fields in the channel feed (→ P4-12, P4-13); store-sourced entitlements (→ P6-01).

## Design notes

- **No `Content-Encoding` on zstd objects.** They are opaque bytes the client decodes; serving them
  with `Content-Encoding: zstd` would let a browser or proxy decode them and break `Range` and
  hashes. Serve `application/octet-stream` (or `application/zstd`) with `no-transform`, and never
  let the edge recompress. On Godot, `HTTPRequest` must also disable `accept_gzip` for `Range`
  (the prototype's HTTP probe, `prototype/README.md`).
- **Identity is the hash.** `ETag` is the stored object's SHA-256, which matches what P4-01's blob
  refs pin, so a client can check `Repr-Digest` against the record before it decodes anything.
- **Gated and free never share bytes by accident.** Dedupe only within a prefix. The rule that
  matters most, "never share chunk bundles between gated and free packs", becomes enforceable in
  v2 because bundles are already per prefix.
- **Distribution reads release through the hook,** never by import (rule 6; the chain is
  release ← distribution ← update).
- **Embedded availability needs no device report.** The build's signed record says what it
  carries; the SDK still verifies the marker and hash on the device (P4-06 to P4-08).

## Steps

1. Extend distribution's transport resolution and availability writer for pack deliverables.
2. Serve pack roles through the blob route with the headers above; add `HEAD` if missing.
3. Gated prefix: upload scoping, per-request authorisation, `no-store`.
4. OpenAPI and `routeCoverage` if the route set changed; regenerate `routes.mdx`.
5. Tests, including a gated request without the flag and a public request for a gated hash.

## Acceptance criteria

- [ ] A fixture pack release becomes `live` on `pkey-cdn` only after its last object is uploaded;
      removing one object's ref keeps it not live.
- [ ] `embedded` availability appears for each (app release, outlet) whose build `embeds` the pack.
- [ ] `GET` with `Range: bytes=100-199` returns 206 with the right bytes; `If-Range` with a wrong
      `ETag` returns the full object; `HEAD` returns size, `ETag` and `Repr-Digest`; no response
      carries `Content-Encoding`.
- [ ] A multi-range request returns the full 200. A cross-origin `OPTIONS` preflight asking for
      `range, if-range` returns 204 with those headers allowed.
- [ ] A gated object: 401 without a device token, 403 without the flag, 200 with it and
      `Cache-Control: private, no-store`; the same hash on the public path returns 404.
- [ ] A transport other than the three v1 ones is stored and reported unsupported.
- [ ] `routeCoverage.test.ts` and `pnpm --filter @polaris-key/docs gen:check` pass.
- [ ] The green gate passes, including `test:workerd`.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- distribution routeCoverage boundaries
mise exec node@22 -- pnpm --filter @polaris-key/docs gen:check
mise exec node@22 -- pnpm --filter @polaris-key/worker typecheck:workerd
mise exec node@22 -- pnpm --filter @polaris-key/worker test:workerd
```

## Hand-off

The SDK packages rely on the byte route's headers (`ETag` = SHA-256, `Repr-Digest`, `Range`,
`If-Range`) and on the gated authorisation contract. P4-14 adds pack rollouts, halts, readiness and
GC on top of these availability rows; P5-08 adds platform transports beside them. Then
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P4-05 done`.
