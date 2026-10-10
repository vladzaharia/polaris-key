# P4-22 CI chunk indexes and bundles: chunker, shared bundles, lints and cache in `pkey release publish`; Worker ingest of `chunks`; the `chunk` patch strategy

| Field       | Value                                                                                                                                                                                 |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | P4: Packs                                                                                                                                                                             |
| Size        | 1.25–1.75 engineer-weeks                                                                                                                                                              |
| Depends on  | [P4-10](P4-10-chunk-indexes.md), [P4-02](P4-02-pack-deliverables.md), [P4-03](P4-03-ci-patch-artifacts.md)                                                                            |
| Unblocks    | [P4-17](P4-17-lazy-deltas.md), [P4-27](P4-27-rscc-scan.md)                                                                                                                            |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                                                                                                                 |
| Plan mode   | yes: execute the approved `plans/P4-10.md` (its P4-22 parts); the plan's approval is this package's plan-mode gate, as for P4-21                                                      |
| Gates       | plan mode; rule 9 (`PACK_PATCH_STRATEGIES` gains `chunk`, schema enum, mutation, validation-codes); drift gates (transcripts); Action rebundle; workerd; threat model; generated docs |
| Human input | none                                                                                                                                                                                  |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                             |

## Goal

Make `pkey release publish` emit a `pkey-chunks/1` chunk index and shared chunk bundles for every
container pack variant of 4 MiB or more, and make the Worker ingest and serve them, as
`plans/P4-10.md` specifies. P4-10 lands the format, claims, parser and corpus; this package lands
the CLI and Worker sides.

## Read first

- `AGENTS.md` rules 3, 9 and 10 and the green gate.
- **`docs/research/2026-09-29-godot-omniplatform/program/plans/P4-10.md`**: §2.4, §2.6's P4-22
  rows, §3, §6, §8.1 decisions (especially 4, 5, 15, 16), §8.5's P4-22 bullet and §9's P4-22
  acceptance block. Where it and this brief differ, the plan wins.
- `packages/cli/src/packPublish.ts`, `packArtifacts.ts`, `pck.ts` (P4-03), the Worker pack ingest
  (P4-02), the blob route (P4-05), and client-core's `parseChunkIndex` (P4-10).

## Scope

**In:** the P4-22 rows of the plan's §2.6, §2.4, §3 and §6:

- The CLI chunker (FastCDC NC1, file-aware, `padMerge`), shared bundles along one chain
  (deliverable, variant key, gating class; never mixing gated and free), the CLI lints, the
  `--out`/`--bases` index cache, and omitting `chunks` with a warning when an index exceeds
  `MAX_PUBLISHED_INDEX_BYTES`.
- Worker ingest of `chunks`: the index bound before reading, and the bundle check requiring a
  `pack-upload` ref **held by this pack** under the matching prefix (a ref held by another pack or
  release does not count), with a workerd test.
- Discovery `release.chunks` and the regenerated transcripts.
- Rule 9: `PACK_PATCH_STRATEGIES` and its default gain `chunk`; the schema enum; the
  `invalid_pack_patch` mutation moves from `["chunk"]` to `["bsdiff"]`; `validation-codes.mdx`.
- If P4-14 has landed first, implement the `packChunks(releaseId, variantKey)` hook and wire it into
  the collector with a test that every bundle a live index names is kept (decision 16).
- Docs: `services/release/packs.md`; `start/concepts.md`'s glossary gains `chunk-index` (a pack
  object) and notes `chunk-bundle` is an app artifact role only. Threat model.

**Out:** the format, claims, parser and corpus (P4-10); device-side chunk apply (P4-11); the chunk
transport (P4-17).

## Steps

1. Branch `wp/P4-22-ci-chunk-indexes` from `main` after P4-10 has merged.
2. Implement the scope; run the green gate, stopping at the first failure.
3. Report to the lead; the lead reviews, merges and sets the status.

## Acceptance

- [x] The plan's §9 P4-22 block passes.
- [x] A bundle holding only another pack's ref is refused at ingest (workerd test).
- [x] An index over 8 MiB makes the CLI omit `chunks` with a warning.
- [x] The full green gate passes.

## Corrections from implementation

Where the brief or the plan and the code disagreed, the code was the fact:

1. **No index is exactly 8 MiB.** A `pkey-chunks/1` index is 64 + 48 × (records + bundles)
   bytes, which never equals 8,388,608. So the workerd cases are: the largest valid index under
   the bound (8,388,592 bytes, 174,760 records and one bundle) parsed and its bundle checked
   inside the isolate; an index of exactly 8,388,608 bytes, read and parsed (it fails
   `chunks-bad-length`, which proves the bound is inclusive and the read happened); and one a byte
   over, refused before any read.
2. **The CLI test of the 8 MiB omission lowers the bound.** An index over 8 MiB needs about
   175,000 chunks (≈ 10 GiB of payload), so `PackPublishOptions` gains two test-only options,
   `chunkMinPayloadBytes` and `maxChunkIndexBytes` (not CLI flags). The default path uses
   `CHUNK_MIN_PAYLOAD_BYTES` (4 MiB) and `MAX_PUBLISHED_INDEX_BYTES`.
3. **The chunker mirrors the generator rather than importing it.** `tools/gen-content-chunks.ts`
   imports nothing it checks (P3-02's rule) and `tools` is not a CLI dependency, so
   `packages/cli/src/packChunks.ts` restates `fastcdc`, `containerSegments`, `chunkPayload`,
   `layoutChunks` and `writeChunkIndex`. The corpus test (`packCorpus.test.ts`) pins it to
   `chunks/v1.pkc` and `chunks/v2.pkc` id for id and length for length.
4. **The chunk lints decode with `@polaris-key/zstd-wasm`, so the Action inlines it.** Its Node
   entry reads `zdec.wasm` beside itself, which a one-file bundle lacks; `bundle-action.mjs`
   resolves the package to the same decoder over the committed `zdec.wasm`, inlined with esbuild's
   `binary` loader (the bundle grows by about 118 KB).
5. **P4-14's hook point assumed `bundles/` keys.** `CatalogPackChunk.bundleKey` was documented
   as `bundles/sha256/<hex>`, and the collector protected only `bundles/` keys while `packChunks`
   was absent. Pack bundles are blobs (plans/P4-10.md decision 4), so a pack bundle under
   `blobs/` was not protected at all. The doc now says `blobKey`. The collector now reads a chunk
   index only for a variant whose record names one (a `chunk-index` object), and an index that
   cannot be read, or a catalog without `packChunks`, makes the plan incomplete (no `pack-upload`
   drops); P4-14 called `packChunks` for every variant and ignored a null answer.
6. **The bundle live-data view.** `bundleLiveness` read only `blob_objects.kind = 'bundle'`,
   which packs never write. It now also lists the blob-keyed bundles that live indexes name.
   A bundle no live index names any more is not listed, because nothing marks a blob as a bundle
   (proposed follow-up below).
7. **Content admission.** The publish lint (`packLint.ts`, P4-03) chose the data-only scan by
   extension. On the lead's instruction it now chooses it by the content's head first: any
   `RSRC` entry gets the binary scan, any `RSCC` entry is refused, and any `[gd_scene` or
   `[gd_resource` head gets the text scan, whatever the file is called. Chunks and bundles are cut
   only after the whole payload passes the lint, and a bundle carries no path. Superseded at the merge of P4-08:
   its `packLint.ts` (content sniff with a BOM strip) and its `ci.md` text were taken, and the
   P4-22 test now asserts P4-08's messages.
8. **The chain base and the presence check.** The plan's "latest proven cached release" is read
   as the newest proven cached release whose record gives this variant a chunk index of the same
   gating class (a gate change skips releases of the other class). `--bases` is now read when
   deltas are off but `chunk` is on. Presence is asked through upload tickets for the base
   index's bundles before the layout (unredeemed tickets expire). A dry run without a credential
   assumes the cached bundles are stored, with a warning, and takes the gating class from the
   manifest's assertion.
9. **Ingest's stricter check covers the index too.** The chunk index object, not only its
   bundles, must hold a `pack-upload` ref of this pack. It is left out of P4-02's generic
   named-object check and checked by the new `missingHeldObjects` (one `json_each` batch, the
   pack id as one more parameter). A dry run also lists an index neither stored nor staged.
10. **No transcript or validation-codes change.** The recorded transcripts do not carry
    Release's discovery fragment, so `gen transcripts --check` stays fresh, and the
    discovery golden fixture, `surfaces.test.ts` and the OpenAPI example gain `chunks: true`.
    `validation-codes.mdx` renders `invalid_pack_patch`'s message template literally, so
    `docs gen` leaves it unchanged.
11. **A pack's `present` is the pack's own uploads (review S1).** Upload-ticket and stage-round
    `present` was product-wide (`referencedKeys`), while ingest requires a chunk index and its
    bundles to hold a `pack-upload` ref of THIS pack, so a renamed pack, or two packs sharing a
    variant's bytes, would never upload its bundles and would be refused `pack-object` on every
    retry. `POST …/release/publish/uploads` gains an optional `deliverable` (a declared pack id,
    else `unknown_pack_deliverable`); with it, `present` means a `pack-upload` ref of that pack
    (`packUploadedKeys`, this product's refs only). The stage round (and a submit's own ticket)
    uses the same rule, so an object another pack holds is uploaded to staging again and promoted
    through `promote`'s already-stored path, which mints this pack's ref without rewriting the
    stored bytes. A staged copy is still required: `promote` verifies from staging, and a ref is
    earned only by promoting a verified upload (P2-01's rule a). The CLI sends `deliverable` on
    every pack ticket; a Worker before P4-22 ignores it. OpenAPI documents the field (no new
    route; no transcript records this route).
12. **The chain falls back.** `chunkChainBase` now tries the next older proven cached release
    when the newest one's cached index is missing or mismatched.
