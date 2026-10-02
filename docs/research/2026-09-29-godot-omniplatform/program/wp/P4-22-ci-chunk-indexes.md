# P4-22 CI chunk indexes and bundles: chunker, shared bundles, lints and cache in `pkey release publish`; Worker ingest of `chunks`; the `chunk` patch strategy

| Field       | Value                                                                                                                                                                                 |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | P4: Packs                                                                                                                                                                             |
| Size        | 1.25–1.75 engineer-weeks                                                                                                                                                              |
| Depends on  | [P4-10](P4-10-chunk-indexes.md), [P4-02](P4-02-pack-deliverables.md), [P4-03](P4-03-ci-patch-artifacts.md)                                                                            |
| Unblocks    | [P4-17](P4-17-lazy-deltas.md)                                                                                                                                                         |
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

- [ ] The plan's §9 P4-22 block passes.
- [ ] A bundle holding only another pack's ref is refused at ingest (workerd test).
- [ ] An index over 8 MiB makes the CLI omit `chunks` with a warning.
- [ ] The full green gate passes.
