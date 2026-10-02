---
title: "Pack byte formats"
description: "The files index, the patch descriptor, treeDigest, the path rules, the codec rules and the zstd window check that every SDK applies to pack bytes, pinned by the content corpus."
sidebar:
  order: 10
---

A pack release is a signed `kind: pack` record (spec §2.5.1) plus side objects: the payload as
one `full` object, a files index, an optional gaps object, and deltas. The record is a JWS like
every other document; the side objects are not. Each is a blob of the product's blob store,
named by the SHA-256 of its stored bytes, and the record pins it with an **object ref**
`{sha256, bytes, size, codec}`: the stored hash and length, and the decoded length. A device
checks the stored hash and length before it decodes anything and the decoded length after.

This page is the map. The normative text is spec §2.6 and §2.7, with `plans/P4-01.md` §2.7 to
§2.9 as the long form; the content corpus (`conformance/corpus/v2/content/`) pins every rule
below byte for byte.

## The formats

| Format           | What it is                                                                                                                                                                                                                          | Refused as                               |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `pkey-files/1`   | The files index: `{format, layout, payload, files[]}`, one entry per file with its path, size, SHA-256 and the ref of its own blob, plus its offset in a `container` layout. At most 100,000 entries and 32 MiB decoded on a client | `files-index-invalid` and the path codes |
| `pkey-patch/1`   | A `files`-scope delta set's descriptor: one `delta` entry per changed file (a bare `zstd --patch-from` frame against the base file) and one `blob` entry per added file, all packed into one data object                            | `delta-artifact-mismatch`                |
| `pkey-marker/1`  | The marker beside an embedded pack (`X.pkey.json`, or `D/.pkey/pack.json` inside a tree): the pack id, the version and the pack record's JWS                                                                                        | `marker-rejected`                        |
| `pkey-content/1` | The content stamp a build embeds (`pkey-content.json`): the app record's `content`, so the running build knows its pins offline                                                                                                     | `content-stamp-invalid`                  |
| `pkey-chunks/1`  | The binary chunk index a variant's `chunks` ref names (below): one 48-byte record per content-defined chunk and per bundle, at most 16 MiB on a client                                                                              | the 13 `chunks-*` codes                  |

Side objects are parsed with the same strict JSON as a JWS payload (spec §1.2), and every integer
in them is decided by the token rule (spec §3.1).

## Two layouts

A **container** is one payload file (a Godot `.pck`): index entries carry offsets in
non-decreasing order, each starting at or after the end of the one before, and the bytes no
entry covers live in the gaps object, so the payload can be rebuilt from its files. A **tree**
is a directory: no offsets and no gaps, paths in strictly ascending byte order, and the payload's
`sha256` is the `treeDigest`, the SHA-256 of one line `<sha256> <size> <path>\n` per file, sorted
by path bytes.

## Path rules

Every path is 1 to 1,024 bytes of printable ASCII without `\ : * ? " < > |`; no segment is empty,
`.` or `..`, ends in a space or a dot, or is a Windows device name; and the first segment is never
`.pkey`, where a tree's marker lives. In index order, an exact duplicate, a case-insensitive
duplicate and a path that is a directory prefix of another are refused, naming the later path.
They run before any byte is written.

## Codecs and the window check

Every compressed object is exactly one zstd frame that declares its content size, or is stored
raw (`codec: "none"`). A delta is a bare `zstd --patch-from` frame, decoded with the whole base as
a raw-content prefix.

Before an applier decodes a delta frame it reads the frame header's window from the bytes alone
(`frameWindow`) and refuses the frame as `delta-apply-failed` when the window is unreadable or
above 2^`windowLogMax`, where `windowLogMax = max(10, min(P, ⌈log2(memBytes)⌉))`, computed in
integers (P is 31 for a 64-bit decoder and 30 for a 32-bit or wasm32 one). The check is the
applier's own, in every SDK, because libzstd enforces its own window limit only when it streams
through a small buffer: without the check, one verdict would depend on how each SDK buffers.

## The chunk index

A container variant of 4 MiB or more may carry `chunks`, an object ref
`{format, sha256, bytes, size, codec, params}` naming a binary `pkey-chunks/1` index (spec §2.5.1,
§2.6; `plans/P4-10.md` §2.2–§2.5). The claims refuse only a malformed one (`chunks` not an
object, a bad `format`, `params` not an object, or a bad object ref); an unknown `format` or
codec only makes the chunk strategy unusable, and other members are ignored.

The index is little-endian: a 64-byte header (`PKEYCHNK`, version 1, record size 48, flags with
bit 0 `fileAware`, the chunk and bundle counts, `payloadSize` and `payloadSha256`), then one record
per chunk in payload order (`id`, the SHA-256 of the uncompressed chunk, then `len`, `clen`,
`bundle` and `offset`), then one record per bundle (`sha256`, `size`, a zero `reserved`).
`clen == len` means the chunk is stored raw; `clen < len` means one zstd frame whose content size
is `len`. Every SDK reads a u64 as two u32 words, low first, saturated at 2^53, never with a
native 64-bit read, and reads through a `DataView` or an aligned copy.

`parseChunkIndex` returns the first failure in a fixed order: the stored object against its ref
(`chunks-ref-mismatch`, including a `size` above `MAX_CHUNK_INDEX_BYTES`, checked before anything
is decoded), then length, magic, version, record size, flags, the exact length, each bundle's
`reserved`, each chunk's `len`, `clen`, bundle reference and bundle range, the sum of the lengths
and, given the variant's payload, the binding (`chunks-payload-mismatch`). `planTarget` maps
`chunks` to inline records only when the index is usable and bound to the payload and no chunk
is longer than `MAX_CHUNK_BYTES` (4 MiB). Bundles are ordinary blobs, so a chunk is fetched with
a single-range request and hashed before use. Applying chunks (`applyChunk`, seeds and
`chunk-bundle-truncated` / `chunk-corrupt`) is P4-11's.

## What the content corpus pins

| Section            | Pins                                                                                                       |
| ------------------ | ---------------------------------------------------------------------------------------------------------- |
| `pathCases`        | The path rules                                                                                             |
| `filesIndexCases`  | `parseFilesIndex`, its five steps in order                                                                 |
| `chunkIndexCases`  | `parseChunkIndex`, every code in order, the u64 saturation and the exact-length rule (P4-10)               |
| `applyCases`       | Full, delta, file and (P4-10) chunk apply over a real v1 → v2 pair, with negatives and exact counters      |
| `packSetIdCases`   | `packSetId`, the identifier of a set of pack releases                                                      |
| `stampCases`       | The content stamp, and (P4-13) its `holds` read by `holdsOf`, compared only when a case has `expect.holds` |
| `frameWindowCases` | `frameWindow` over raw frame headers                                                                       |

`plan-matrix.json` pins the install planner, variant selection and target mapping beside it
(spec §11.4). How the blobs are kept and regenerated is on
[The conformance corpus](/docs/build/wire/corpus/).

## Content in the feed and revocations

P4-13 (spec §2.4.1, §2.5.3, §11.1) lets the channel feed carry content and lets CI revoke a pack
release. Nothing here is a new claim: each member is read beside the claims, so a malformed one
is unusable and never refuses the feed or the record, and the wire stays v4.

| Member or record          | What it carries                                                                                                                                                                                                                                         | Read by                                               |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `packSets`                | A release table keyed by record hash, sets keyed by `packSetId`, one row per resolution group (`contentApi`, platform, engine, variant) naming a set, and per-outlet `pinned` (packs that cannot float on that outlet) and `gates` (rollouts and halts) | `feedContent`, `selectPackRows`                       |
| `packFloors`              | The effective floor of each pack at each live level, with its version scheme. An entry with an unknown scheme is ignored                                                                                                                                | `feedContent`                                         |
| `revocations`             | The revocations in force: each revocation record's hash, the pack and the revoked release's hash, version and `seq` (at most 64)                                                                                                                        | `feedContent`                                         |
| `content.holds`           | An app release keeping a pack at one release; reaches a device in its content stamp                                                                                                                                                                     | `holdsOf`                                             |
| `kind: revocation` record | CI-signed with a release key: `revokes` (the target's record hash), an optional `replacement` of the same pack, and a 1–512-byte `reason`. Permanent; a later one may only change the replacement (newest `issuedAt` wins)                              | `revocationOf`, `verifyRevocation`, `newerRevocation` |

A device composes its set from one row per group, then its pins and holds: it resolves nothing.
A feed target never downgrades a pack. The Worker can withhold content but never condemn or
substitute it, because only a pinned release key verifies a revocation. A device refuses to
mount a revoked release (`pack-revoked`), embedded baselines included, and swaps in a usable
replacement. When a **required** pack is revoked with no usable replacement, the boot stops
(`blocked {revoked-content}`, boot `required`); a revoked optional pack is unmounted and play
continues. Floors (`content-floor`) are prompts and never stop play. The device keeps up to 256
revoked targets in a sibling `revocations.json` beside its pack state, so a Worker that later
withholds a revocation cannot bring the target back.

`cases.json` pins the members in `feedContentCases` and the record in `revocationCases`;
`update-matrix.json` pins the decision in `contentRows`.

## Delegated content keys and the data-only rule

P4-19 (spec §1, §2.5.4, §2.8, §3.5 steps 13 and 16) lets a product's release key delegate a
**content key** that may sign pack records of data-only types under one pack-id scope, so a content
team can publish events, localisation and data without code-release power. It stays inside v4: the
reserved record kind `delegation` is filled, a feed `revocations` entry may carry
`kind: "delegation"`, and nothing else changes.

| Piece                     | What it is                                                                                                                                                                                                                                                   | Read by                                                     |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| `kind: delegation` record | CI-signed with a pinned release key: `deliverable` is the scope root (a pack id), `delegate.publicKey` the content key, `types` (1–8; only `files.tree`, `data.json` and `l10n.table` count) and a signing window `issuedAt`–`expiresAt` of at most 366 days | `delegationOf`, `verifyDelegation`                          |
| The delegated kid         | A pack record signed by the content key carries `kid: pkd1-<the delegation's record hash>`; the device fetches that delegation from the record route                                                                                                         | `delegationHashOf`, `verifyReleaseRecord` with `delegation` |
| Scope (step 16)           | `kind: pack`; the pack id is the scope root or under it by whole segments (`djdl.events` covers `djdl.events.halloween`, never `djdl.eventsx`); the type is delegated; every variant is tree layout; the record's `issuedAt` is inside the window            | `verifyReleaseRecord` (`scope`)                             |
| Revocation                | P4-13's revocation record naming the delegation's hash; every release signed under it is then refused                                                                                                                                                        | `verifyRevocation`, `recordRevoked`                         |
| The data-only rule        | Every file of a delegated release: an already-normalised path, an extension on the allow-list, and no Godot, archive, native-code or script magic in its first 64 or last 65,557 bytes                                                                       | `dataOnlyRefusal`                                           |

A delegation verifies only against the **pinned release keys**, one level deep, so the Worker can
neither forge nor widen one, and a content key cannot re-delegate. The delegated path is allowed
only for a compatible or standalone pack's feed target and for the reload of a stored delegated
install; app records, pins, holds, revocations, replacements and embedded baselines never take it,
so a content-key signature fails there at `jws`. Devices check the record's `issuedAt` against the
window, never their own clock, so an installed release stays valid after the window closes; only a
revocation stops it. An SDK that predates P4-19 refuses a delegated record at step 13 and keeps
what it runs.

**The data-only rule** (spec §2.8). The extension allow-list is the real control: `json`, `csv`,
`tsv`, `po`, `txt`, `png`, `jpg`, `jpeg`, `webp`, `ogg`, `wav`, `mp3`, `ttf`, `otf`, compared after
the last `.` of the final segment, ASCII-lowercased. Godot picks its loader by extension, so `.tres`,
`.res`, `.gd`, `.translation`, `.import` and every other loader extension are refused because they
are not listed. A path that is not already normalised (an empty, `.` or `..` segment, a leading or
trailing `/`) is refused too, so Godot's `simplify_path()` never changes an admitted path. Two
sniffs, by content and never by extension, fail closed: the head (after a UTF-8 BOM and ASCII
whitespace) must not start with `RSRC`, `RSCC`, `GDPC`, `GDEC`, `GCPF`, `GDSC`, `[gd_`, a zip local
header, ELF, `MZ`, a Mach-O magic, `\0asm`, `#!`, `@tool`, `extends ` or `class_name `; and the tail
must not end with `GDPC` or hold a zip end record (`PK\x05\x06`), which catches a PNG or OGG with a
mountable archive appended. The device runs the extension rule over the files index before any
payload object is fetched and the sniffs as each file is written; a refusal is
`pack-not-data-only` with the path. No SDK or handler ever passes a delegated file to
`load_resource_pack`.

`cases.json` pins the chain in `delegationCases`; `content/cases.json` pins the rule in
`dataOnlyCases`.
