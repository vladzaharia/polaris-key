# HA-01 Hosted-asset core: `hosted_assets` table, `core/safeFetch.ts` guard, `core/hostedAssets.ts` ingest (cap, sniff, SHA-256, put, ref) and Content-Type on every R2 put

| Field       | Value                                                                                                                               |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | HA: Hosted assets: Polaris Key hosts every file it serves (S-20) (phase 1: substrate)                                               |
| Size        | 1–1.5 engineer-weeks                                                                                                                |
| Depends on  | none                                                                                                                                |
| Unblocks    | [HA-02](HA-02-media-host.md), [HA-03](HA-03-image-variants.md), [HA-05](HA-05-pull-on-sync.md), [HA-08](HA-08-release-mirroring.md) |
| Role        | `pkey-implementer`                                                                                                                  |
| Plan mode   | no                                                                                                                                  |
| Gates       | migration; table owners; THREAT-MODEL; workerd lane                                                                                 |
| Human input | none                                                                                                                                |
| Repo        | `vladzaharia/polaris-key`                                                                                                           |

## Goal

One Core ingest path turns a stream, or a guarded pull of a URL, into a content-addressed copy at `blobs/sha256/<hex>`. It records the copy in a new `hosted_assets` row with a `hosted-asset` ref in `blob_refs`, and every R2 put now stores the sniffed Content-Type.

## Why

S-20 found that Polaris Key has no way to copy a developer's file into its own store, short of CI uploading a local file ([S-20 §4.1–§4.2](../../notes/S-20-hosted-assets.md#41-product-presentation)). Every later HA package builds on this one substrate. The same work fixes the missing Content-Type on puts, which very likely breaks Play image pushes today ([S-20 §4.6](../../notes/S-20-hosted-assets.md#46-defects-found-along-the-way) #1).

## Read first

- AGENTS.md (always) and CLAUDE.md.
- [notes/S-20](../../notes/S-20-hosted-assets.md). Its owner-decisions header (delegated, 2026-10-05) wins over the sections below it.
- S-20 owner decisions header, §6.2, §6.3 and §4.6.
- `packages/worker/src/core/blobs.ts` (`putVerified`, `DigestStream`, key scheme), `src/services/identity/portal/media.ts` (today's guard and sniff, to generalise), `src/core/readCapped.ts`.
- [`prototype/hosted-assets/pull.mjs`](../../prototype/hosted-assets/pull.mjs): the reference guard and its self-test table.

## Scope

**In:**

- Migration: `hosted_assets` exactly as S-20 §6.2. Add `hosted-asset` to the ref kinds the collector knows. Update `table-owners`.
- `core/safeFetch.ts`: S-20 §6.3 step 1. https, port 443, no userinfo, no IP literal, no single label, deny `plrs.im`/`*.plrs.im` and `.local`/`.internal`/`.localhost`/`.home.arpa`. Manual redirects (≤ 3), each re-guarded. 30 s timeout. Byte cap on `Content-Length`, then while streaming. `If-None-Match`.
- `core/hostedAssets.ts` `ingest(product, slot, input)`: per-slot caps as code constants, magic-number sniff (PNG, JPEG, WebP, GIF, AVIF, MP4; never SVG or HTML), SHA-256 while streaming, optional expected hash, `putVerified` with `httpMetadata.contentType`, Images `.info()` dimensions when `env.IMAGES` is bound, then one D1 batch writing the row and its refs. Audit action `assets.ingest`.
- `putVerified` and promote set `httpMetadata.contentType` for every caller. `playImageFromListingAsset` sniffs when the metadata is absent (objects stored before this change).
- Move the portal media proxy's guard onto `safeFetch`. No behaviour change: it keeps its GitHub-only host check until HA-07.

**Out** (and where it belongs instead):

- Queue, manifest resolution, repo paths (→ HA-05). Serving (→ HA-02). Variants (→ HA-03). Release files (→ HA-08).

## Design notes

- Reason codes, as stable strings stored in `hosted_assets.error`: `guard:<reason>`, `status:<n>`, `too-large`, `not-an-image`, `sha256-mismatch`, `timeout`, `quota` (HA-10 enforces it later).
- Ingest that hits an existing object adds the ref only. The key is content-addressed, so a re-ingest is idempotent.
- The guard table in `pull.mjs --self-test` is the unit test's table. Keep the two identical.

## Steps

1. Migration and table owners.
2. `safeFetch` with the guard table test.
3. `ingest` with unit tests (workerd and Node lanes).
4. Content-Type on puts; Play read fallback; regression test that a pushed PNG reports `image/png`.

## Acceptance criteria

- [ ] The `safeFetch` guard table matches `pull.mjs --self-test` case for case (test).
- [ ] An ingest of a PNG writes the row, the ref and an object whose `httpMetadata.contentType` is `image/png`. An SVG, an HTML file or an over-cap stream is refused with its reason code (tests).
- [ ] A redirect to a denied host is refused at the hop (test).
- [ ] THREAT-MODEL gains the outbound-fetcher row from S-20 §6.12.
- [ ] The green gate passes (AGENTS.md), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
```

## Hand-off

HA-02, HA-03, HA-05 and HA-08 call `ingest`. PX-W16 reuses `safeFetch` with an `avatar` slot space.

The role agent sets `--set HA-01 in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set HA-01 done`.
