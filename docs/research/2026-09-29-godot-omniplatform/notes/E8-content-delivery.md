> Research note for [Godot on Polaris Key](../README.md), 2026-09-29.

# E8 - A general content delivery system: many packs, many types, every transport

Researched 2026-09-29. Scope: extend the `content` service sketched in README §3.7 / §5.7 (Godot `.pck`
packs pinned per code build) into a general system: many independently versioned **packs** of different
**types** (Godot PCK, plain files, directory trees, zip/tar, audio banks, localization tables, JSON data,
ML models, later Unity AssetBundles), each with its own version line, channels, dependencies,
compatibility constraints and entitlement gate, delivered and patched through whatever each platform
offers (Apple Background Assets, Play Asset Delivery, Steam depots, MSIX, our R2 CDN, browsers,
Godot's own patch PCKs). This note builds on README §3.3 (two signers), §3.5 (blob store), §3.7 and
§5.7, and on notes/E5 §3 (delta survey) and §6 (engine patterns); it does not repeat them.

Confidence legend: **[V]** read on the primary source or in the source code this session;
**[S]** from a search summary, secondary or community source (re-verify before building);
**[I]** inference or design recommendation.

---

## 0. Executive summary

1. **Every production launcher studied uses the same core shape** [V]: a signed (or TLS-trusted)
   manifest lists files; each file is a list of content-addressed chunk references; chunks are stored
   compressed and individually verifiable; the client diffs _manifests_ (old vs new), never bytes, and
   downloads only chunk IDs it does not already hold. Riot RMAN (FastCDC ~64 KB chunks, zstd-19 per
   chunk, packed into bundles fetched by HTTP Range), Epic BuildPatchServices (1 MiB windows, GUID +
   rolling hash + SHA-1), Steam (≈1 MB chunks, SHA-1 IDs, per-depot protobuf manifests plus optional
   chunk-to-chunk deltas), Blizzard TACT (per-file MD5 content keys, BLTE block encoding, ZBSDIFF
   per-file patches) and itch wharf (64 KiB rsync blocks plus lazily-computed bsdiff) all fit it.
2. **The rolling hash lives in CI, not on the client** [V]. Because the manifest of the _installed_
   version records every chunk boundary, a client can locate reusable bytes in its local files by
   offset, verify them with SHA-256 and fetch the rest by Range. RMAN, Epic, Steam, TACT, MSIX block
   maps, desync (seeding from the old _index_), zchunk and zstd:chunked all work this way. Only zsync
   and bita (scanning a seed without its index) and rsync need a client-side rolling hash. **A
   pure-GDScript client (SHA-256 via `HashingContext`, zstd via `PackedByteArray.decompress`, HTTP
   Range) can therefore do chunk-level patching** [V APIs, I design].
3. **Content-defined chunking (CDC) beats fixed blocks and binary deltas for "any old version to
   latest"; binary deltas win only for the exact N−1→N pair** [V/I]. Riot measured a 10× patch-speed
   gain and >85% bundle reuse between versions; desync's six-build example serves every starting
   version from one store (110–168 MB updates vs 292 MB full); a Godot-specific CDC tool (CAVS, July 2026) reports the Godot TPS demo update shrinking from 247.60 MiB to 1.64 MiB at 64 KiB chunks.
   zstd `--patch-from` stays the best single-pair delta for small, hot packs.
4. **Compressed containers are the main pitfall** [V]. Whole-container compression (LZMA bundles,
   deflated zips, `.tar.gz`) changes every byte on any edit and defeats both chunking and deltas.
   The fixes are known: compress per entry or per chunk (RMAN, Steam, zchunk, UE IoStore's 64 KiB
   blocks), or patch the decoded form and re-encode deterministically (Blizzard's ESpec, Google's
   archive patching). Godot PCKs are uncompressed containers of per-file resources, so they chunk
   well. The offset shifts that break Steam's 1 MB fixed chunks do not affect CDC.
5. **Godot 4.6+ delta patch PCKs are applied in memory, per file, on every load** [V source].
   `FileAccessPatched` reads the whole base file, applies each stacked `GDDL` zstd patch in order,
   and keeps the result in RAM (zstd content checksum on, so a wrong base fails rather than
   corrupts). Scripts cannot call the delta decoder, but a GDScript client _can_ reach it by mounting
   a Polaris-built delta patch PCK over the exact base bytes it holds. That makes it a usable
   fallback delta route, with the known load-time and stacking costs.
6. **Platform transports differ in the one property that matters for us: who controls the version
   switch** [V]. Apple-hosted Background Assets packs update independently and switch _all_
   installed app versions when a pack version goes live. Play asset packs update only with a new
   versionCode, and Play applies the asset patch. Steam depots move with builds and branches. MSIX
   optional packages service independently, and related sets enforce version sets. Our CDN and the
   web are fully ours. No platform documents differential updates for Apple asset packs (treat as
   whole-pack re-download [I]).
7. **One pack identity, many representations** [I]. A pack _release_ is defined by its signed
   file/chunk manifest, whatever the transport. Platform-native IDs (ASC asset-pack version numbers,
   Steam manifest GIDs, PAD versionCodes, MSIX version quads) are assigned _after_ signing, so they
   live in D1 and in the Worker-signed content index, not in the CI-signed pack release. Ship a
   signed marker file (`.pkey/pack.json`) inside every platform-delivered pack so the client can
   prove which release the platform installed.
8. **Negotiation should be client-side selection from a signed menu** [I]. The feed must stay
   device-less and edge-cacheable (README §3.3). The pack release therefore advertises every
   representation (full blob, chunk index, deltas from specific bases, platform bindings), and the
   client plans the cheapest route it can execute: `noop → platform → chunk → delta → full`. Only
   the entitlement-gated URL mint sees the device.
9. **Resolve ranges on the server, ship locks to the client** [I]. Code releases pin exact pack
   hashes (lock, as today). Live content channels may declare semver ranges and a `contentApi`
   window, but CI or the Worker resolves them into concrete, signed **pack sets** per
   `(channel, contentApi, platform variant)`. Clients never run a solver.
10. **Serving facts that shape the chunk design** [V]. Cloudflare's cache honours multi-range
    requests (2–300 ranges, multipart 206) only when Origin Range Requests applies. A cold miss
    fetches the whole object from origin. Encoded responses have Range ignored. The Service Worker
    `Cache.put` rejects 206 responses. So: moderate immutable bundles (4–16 MiB), one Range per
    contiguous run over HTTP/2, no `Content-Encoding` on bundles, and browser storage in OPFS or
    IndexedDB rather than the Cache API for partial data.
11. **Recommended phasing** [I]. v1 keeps README §3.7's single-file packs (full download plus an
    optional zstd N−1 delta) and adds the type registry, transport bindings, install-state DB and
    marker file. v2 adds the `pkey-chunks/1` index and immutable bundles on R2, chunk-sync from the
    installed seed (pure GDScript) and server GC. v3 adds tree, archive, audio, l10n, ML-model and
    Unity handlers, lazily optimised deltas for hot pairs (butler's "cheap now, optimal later"), and
    Compression Dictionary Transport for web.

---

## 1. How production launchers version and patch many content units

### 1.1 Riot Games: RMAN manifests, chunks and bundles (League of Legends, Riot Client)

Primary: Riot engineering blog "Supercharging Data Delivery: The New League Patcher", Javier
Blazquez, **2019-07-30** [V]; open-source parser `moonshadow565/rman` (C++ source read) [V]; Rust
crates `rman` 0.3.0 (2023-09-01) and `cdragon-rman` (2026-08-28) [V].

**Build side** [V blog]:

- Content-defined chunking **based on FastCDC** ("over 1 GB/s per core"). It splits "wherever the
  hash value ends with 16 zero bits" for **~64 KB average** chunks.
- Each chunk is hashed and compressed with **zstd level 19**. Chunks are grouped into bundles:
  "over 300,000 chunks" in "less than 5,000 bundles". A bundle's name derives from its chunk IDs,
  so "two bundles with the same contents will have the same name". "Each version of League shares
  over 85% of the bundles" with the previous one. Intra-release dedupe saves about 10%.
- A **~8 MB release manifest** in FlatBuffers lists all files, chunks and bundles. The pipeline is
  multithreaded and uploads by multipart POST. Deploys dropped from about five hours to under a
  minute.

**Manifest data model** [V source, `lib/rlib/rmanifest.cpp`, `rchunk.hpp`, `rbundle.hpp`, `rcdn.cpp`]:

- File layout: a 28-byte header (magic `RMAN`, `version_major == 2`, flags, body offset/length,
  64-bit manifest ID, decompressed length), a zstd-compressed FlatBuffers body, then a signature.
- Body tables:
  - `bundles[] {bundleId u64, chunks[] {chunkId u64, compressed_size, uncompressed_size}}`. A
    chunk's offset inside its bundle is the running sum of compressed sizes.
  - `languages[] {id u8, name}`.
  - `files[] {fileId, dirId, size, name, locale_flags (bitmask), chunk_ids[], link (symlink), params_index, permissions}`.
  - `directories[] {id, parent, name}`.
  - `params[] {hash_type, max_uncompressed, …}`.
- Chunk IDs are **64-bit truncations** of SHA-256, SHA-512, BLAKE3 or a Riot HKDF-over-SHA-256
  construction, selected per file by `params.hash_type`. Maximum chunk size is 256 MiB − 1.
- Transport: `GET {cdn}/bundles/{bundleId:016X}.bundle` with
  `Range: bytes={firstChunkOffset}-{lastChunkEnd}`, so contiguous missing chunks go out as one
  request. A bundle ends in an `RBUN` footer with a chunk table.

**Client** [V blog]:

- A local **SQLite database** holds `files(path_id, path, size, timestamp, permissions, symlink, chunking_version, min/chunk/max_chunk_size, …)`
  and `chunks(path_id, offset, id, size)`.
- The client "compare[s] the list of chunks that you have with the list of chunks that you need",
  then downloads by multipart Range over **8 concurrent HTTP/1.1 connections**, spread across CDN
  edges, with aggressive retries and a 128 MB buffer.
- It applies **in place**, in "slices" of up to 64 MB aligned to chunk boundaries. Each slice is
  sourced from the CDN or "reused … from existing files on disk". The DB is updated after every
  slice, so cancellation is safe.
- Verification is about 100 ms (size and timestamp). A partial repair re-chunks only inconsistent
  files. A full repair re-chunks everything (under two minutes on average).
- Patch 9.9 downloaded 83 MB vs 68 MB with the old binary-delta system (RADS), yet finished in
  under 40 s instead of over 8 minutes. Failures fell from 2.2% to 0.3%.

**Many units:** languages are file-level locale bitmasks inside one manifest. Riot Client products
and patchlines each get their own manifests over a shared bundle store [S].

**Take-aways for Polaris** [I]:

- Chunk-ID diffing against the local DB gives "any version to latest" with zero server work.
- Bundling keeps the object count and request count sane.
- In-place slice application is fast but gives up atomic rollback. We prefer staging (§5.9).
- Riot's 64-bit truncated IDs are unsafe under our compromised-CDN threat model. Use full 256-bit
  IDs.

### 1.2 Blizzard: TACT/NGDP and CASC (Battle.net)

Primary: wowdev wiki pages `TACT` and `BLTE` (community reverse-engineering, maintained through
2025-02 changes) [V].

**Keys**:

- **CKey** = MD5 of the decoded file content.
- **EKey** = MD5 of the encoded file. For chunked BLTE it covers only the header and chunk table,
  because that table carries a per-block hash.
- One CKey may map to several EKeys (encrypted and unencrypted encodings, for example).

**Per build**: a _build config_ names the content hashes of these manifests:

- **root**: file-data-ID or name hash → CKey, with locale and content flags (platform, arch,
  low-violence, encrypted, …);
- **encoding**: paged tables CKey → EKeys, and EKey → **ESpec**;
- **install**: files needed on disk, with tag bitmasks;
- **download**: every EKey with size, priority 0–2 and tag bitmasks;
- **size** and **patch**.

A _CDN config_ lists **archives**: about 256 MB blobs of concatenated BLTE fragments with `.index`
files (EKey → size and offset, 4 KB pages, MD5-checked TOC). The client assembles the combined
`archive-group` index itself. Files larger than about 2 MB, and the key manifests, are stored loose.
CDN paths are `/tpr/<product>/(config|data|patch)/<ab>/<cd>/<hash>`. Version discovery goes through
the Ribbit/versions service. [V]

**BLTE** [V]:

- A file is a sequence of blocks, each carrying its own compressed and logical size and an MD5.
- Block modes: `N` raw, `Z` zlib, `4` LZ4HC, `E` encrypted (Salsa20/ARC4 with a named key), and `F`
  recursive (deprecated since 2025-02).
- An **ESpec** string (e.g. `b:{164=z,16K*565=z,1656=z,140164=z}`) is a _recipe_ "for the patcher to
  produce a binary-identical encoded output file (as patching operates on the unencoded data)".

**Patching** [V]:

- A _patch config_ `patch-entry` lists, for each key manifest (install, download, encoding, size),
  old EKeys paired with a **ZBSDIFF1** patch "applied to the BLTE decoded contents".
- A **patch manifest** (`PA`) maps each target CKey to up to 16 source EKeys, each with a patch EKey
  and an application ordinal.
- Clients therefore patch _decoded_ content and re-encode with the ESpec to reproduce the exact
  EKey.

**What to download:** resolve root → CKey → EKey, subtract EKeys already present in local CASC,
then fetch by archive index offset and size (Range), prioritised by the download manifest.

**Many units:** one build is one versioned unit. Optional subsets are selected by tags (locale,
platform, region, speech). Since 8.1, **shared storage** lets several products share one CASC `Data`
folder, deduplicated by EKey [V].

**Lesson** [I]: separating the _content identity_ (CKey) from the _encoded bytes_ (EKey) plus a
re-encoding recipe is how you patch compressed containers without losing byte-exact verification.
Don't copy the MD5 hashing, which is acceptable only because of TLS and the key hierarchy.

### 1.3 Epic: BuildPatchServices (Epic Games Store, Fortnite)

Primary: `derrod/legendary` source (`models/manifest.py`, `models/chunk.py`, `core.py`) [V]; Epic
BuildPatch Tool docs 1.6.0/1.7.0 [V via extract]; UE API reference for `OptimiseChunkDelta` and
`PackageChunkData` [S].

**Manifest** [V source]:

- Magic `0x44BEC00C`, zlib-compressed body, SHA-1 of the body. Feature levels up to about 24.
- **Chunk data list**: 128-bit GUID, **64-bit rolling hash**, SHA-1, group number
  (`crc32(guid) % 100`), uncompressed "window" size (**1 MiB default**) and compressed file size.
  From v22 it adds a secret GUID and an AES-GCM tag for encrypted chunks.
- **File manifest list**: filename, SHA-1, flags, install tags, symlink target, optional
  MD5/SHA-256 and MIME, and `chunk_parts[] {guid, offset, size}`, so one file is a concatenation of
  slices of 1 MiB chunks.
- Chunk objects live at `ChunksV4/<group>/<hash>_<guid>.chunk` (v22+:
  `ChunksV5/<secret|plain>/…`). Header magic `0xB1FE3AA2`; `stored_as` flags for compressed and
  encrypted; `hash_type` rolling, SHA or both.

**Deltas** [V docs]:

- BuildPatchTool's general system "allows the Epic Games store to update any version of your
  binary on a user's machine to any other version".
- `-mode=BinaryDeltaOptimise` builds extra **A-to-B** patch data for a specific pair: "Final unknown
  compressed bytes … Improvement: 60%" in Epic's example. `DiffAbortThreshold` (≥1 GB) skips pairs
  that are hopeless, and Epic advises running it days before release against the current live
  build.
- Clients fetch an optional `Deltas/<newBuildId>/<oldBuildId>.delta` manifest and overlay it on the
  new manifest (legendary `apply_delta_manifest`) [V].
- `PackageChunkData` packs a manifest's chunks into size-capped **chunkdb** files for offline media
  and installers [S].

**Many units:** each app, DLC or artifact has its own manifest per build. Install tags select
optional components. Chunks live in a per-product cloud directory, so later builds reuse earlier
chunk GUIDs [V/I].

**Fortnite**:

- Uses **IoStore On-Demand** to stream cosmetics during play. Launcher option "Pre-download
  Streamed Assets". Surfaced errors: `IoStoreOnDemand.ChunkMissingError` and
  `IoStoreOnDemand.HttpError` [S, Epic player-support pages].
- The engine API is `IOnDemandIoStore` in module `IoStoreOnDemandCore` [S]. Epic calls the feature
  experimental for licensees (forum, 2025-09) [S].

### 1.4 Valve: SteamPipe depots

Primary: Steamworks "Uploading to Steam" [V]; `SteamDatabase/Protobufs` `content_manifest.proto`
[V]; SteamKit2 `CDN/Client.cs` and `DepotChunk.cs` [V].

**Build** [V]:

- "SteamPipe initially splits each file into roughly one megabyte (MB) chunks." For an update it
  "searches to find any such chunks that match the previous build". Chunks are "compressed and
  encrypted" and stay so until the client.
- Each depot version gets a manifest "identified by a unique 64-bit manifest ID".
- Valve's guidance:
  - keep asset changes localized and **avoid shuffling** inside pack files;
  - keep pack files to about 1–2 GB;
  - don't compress or encrypt pack files, since Steam compresses anyway;
  - for Unreal, set padding alignment to 1,048,576 so shifts don't cascade.

**Manifest protobuf** [V]:

- `FileMapping {filename, size, flags, sha_filename, sha_content, chunks[] {sha, crc, offset, cb_original, cb_compressed}, linktarget}`.
- `ContentManifestMetadata {depot_id, gid_manifest, creation_time, filenames_encrypted, cb_disk_original, cb_disk_compressed, unique_chunks, crc_*}`.
- `ContentManifestSignature`.
- **`ContentDeltaChunks {depot_id, manifest_id_source, manifest_id_target, deltaChunks[] {sha_source, sha_target, size_original, patch_method, chunk, size_delta}}`**:
  chunk-to-chunk binary deltas per manifest pair. That matches the docs' "patching algorithm based
  on binary deltas".

**Transport** [V SteamKit]:

- `depot/<id>/manifest/<gid>/5/<requestCode>`. Manifest request codes gate access.
- `depot/<id>/chunk/<shaHex>`: chunk = AES-256 (ECB-encrypted IV + CBC). The payload is VZip
  (LZMA), VSZa (zstd) or PKZip; the check is Adler-32 of the output against the manifest.

**Apply** [V docs]: "SteamPipe builds the new version alongside the old version. When all new files
are built, it then 'commits' the update by deleting old files and moving the new files in." So "to
update a 25 GB pack file, SteamPipe will always build a new, 25 GB file." Staging costs disk space
equal to the changed files.

**Many units:** an app has depots per OS, language and DLC, plus shared depots across apps. A
**build** is a set of depot manifests. **Branches** (default, betas, optional password) point at
builds; `SetLive` works for non-default branches. DLC is a depot of the base game gated by
ownership [V].

### 1.5 itch.io: wharf and butler

Primary: wharf specification (itch.io/docs/wharf: terminology, diff, apply, patch format) and
`pwr/pwr.proto` [V via extract]; butler pushing docs (notes/E5 §3.1) [V].

**Formats:**

- A **container** lists files, dirs and symlinks with modes and sizes.
- A **signature** is a container plus one `BlockHash {weakHash u32, strongHash}` per **64 kB** block.
  The spec prose calls the strong hash MD5 and also says 32 bytes; check the implementation.
- A **patch** (`.pwr`) is compressed, with old and new containers, then per-file `SyncHeader {RSYNC | BSDIFF}`
  and `SyncOp {BLOCK_RANGE(fileIndex, blockIndex, blockSpan) | DATA(≤4 MB)}`.

**Diff:** rsync-style. The new container is scanned with a rolling weak hash, candidates are
confirmed by the strong hash, and a "preferred file index" (same path in old) keeps no-op patches
recognisable.

**Apply**: "applying a patch should be atomic: if it can't be applied cleanly … no changes must be
committed". Rebuild changed files in a **staging folder**, compare with the signature, then merge
and run the post-steps; on mismatch, erase staging [V].

**Butler** pushes a cheap rsync patch immediately. The server later regenerates an optimised
bsdiff+brotli patch ("rediff") [V, E5].

**Take-away** [I]: wharf patches are _pairwise_ (from a specific old build). The rolling hash runs
on the uploader and server, never on the client. Staging-then-merge is the safe-apply template.

### 1.6 Roblox (community-documented only)

Each client deployment `version-<guid>` publishes `rbxPkgManifest.txt`: zip packages with MD5,
compressed and decompressed sizes, and a `rbxManifest.txt` of extracted files with MD5. Bootstrappers
redownload changed packages whole [S, community tooling such as Roblox-Client-Watch]. No Roblox
engineering source on chunking or delta patching was found; treat it as package-level
replacement [S].

### 1.7 Cross-cutting comparison

| System          | Unit of change                          | Chunking                                  | IDs / hashes                                  | Per-chunk codec                | "What to download"                                  | Apply                                 | Many units                                     |
| --------------- | --------------------------------------- | ----------------------------------------- | --------------------------------------------- | ------------------------------ | --------------------------------------------------- | ------------------------------------- | ---------------------------------------------- |
| Riot RMAN       | chunk (in bundles)                      | FastCDC ~64 KB avg                        | 64-bit trunc. SHA-256/BLAKE3; manifest signed | zstd-19                        | local chunk DB − manifest chunks; Range into bundle | in place, 64 MB slices, DB checkpoint | locale bitmask; manifest per product/patchline |
| Blizzard TACT   | file (+ZBSDIFF patches)                 | none across files; BLTE blocks in file    | MD5 CKey/EKey; per-block MD5                  | zlib/LZ4/enc per block (ESpec) | EKeys missing from local CASC; Range into archives  | patch decoded, re-encode by ESpec     | tags (locale/OS/region); shared storage        |
| Epic BPS        | 1 MiB chunk window (file = chunk parts) | fixed window, rolling-hash match on build | GUID + 64-bit rolling + SHA-1                 | zlib (±AES-GCM)                | chunk GUIDs missing; old files as source            | staged install (launcher)             | manifest per app/DLC; install tags             |
| Steam           | ~1 MB chunk (+chunk deltas)             | fixed ~1 MB, matched vs previous build    | SHA-1 chunk ID, Adler-32; signed manifest     | LZMA/zstd + AES-256            | chunk SHAs missing; optional delta chunks           | build alongside, then commit          | depots per OS/lang/DLC; build = depot set      |
| itch wharf      | 64 kB block ops / bsdiff                | rsync blocks (pairwise)                   | weak u32 + strong hash                        | whole patch compressed         | pairwise patch old→new                              | staging, verify, merge                | channels per platform                          |
| Unity CCD       | bundle file                             | none                                      | MD5 per entry; CRC in catalog                 | bundle's own (LZ4/LZMA)        | catalog hash change → new bundle names              | Addressables cache                    | buckets/releases/badges                        |
| Godot 4.6 patch | file inside patch PCK                   | none; zstd patch-from per file            | MD5 per file in PCK dir                       | zstd                           | CI decides; whole patch PCK                         | mount order; patched in RAM per load  | load-order stacking                            |

(TACT, Steam and Epic rows [V]; Unity and Godot rows detailed in §3 [V].)

**Common answers to the four questions:**

- **Data model**: manifest → files → ordered chunk refs `{id, offset, size}`; a chunk table
  `{id, rawSize, encSize, location}`; optional bundles or archives as transport containers.
  Signatures cover the manifest; hashes cover chunks.
- **What to download**: set difference of chunk IDs between the target manifest and the local
  index. The local index comes from the _installed manifest_, so no client rolling hash is needed.
- **Safe apply**: stage then commit (Steam, wharf), or in place with a checkpointed DB (Riot).
  Verify every chunk and file before commit, and keep a repair path that re-verifies against the
  manifest.
- **Many independent units**: in practice most systems version a _set_ (Steam build, Blizzard build
  config, Epic build manifest, Addressables catalog) and rely on dedupe so unchanged units cost
  nothing. Truly independent unit lines appear in Apple BA, MSIX optional packages, Flatpak
  extensions and Unity CCD badges (§4).

---

## 2. Generic content-addressed and chunked delivery

### 2.1 Survey

| Tool / format                        | Model                                                                                                                                                                                                 | Server needs                            | Client needs                                                                                                                 | Notes                                                                                                                                                                                                                         |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **casync / desync**                  | CDC chunks (default **min 16 KB / avg 64 KB / max 256 KB**), ID = SHA512/256 (desync also SHA-256) of uncompressed data, stored as zstd `.cacnk`; `.caibx` (blob) / `.caidx` (tree via `catar`) index | any static host, S3, OCI registry, SFTP | index of target; **seed file plus its index** (desync reuses the seed's index, so no re-chunking); or re-chunk seed (casync) | [V desync README/concepts] Debian 12 image, six builds: 292.2 MB fresh vs 109.8 MB (2 days old) … 167.8 MB (1 year old); store holds all six in 832 MB vs 1,753 MB. "A compressed or encrypted payload … changes throughout". |
| **zchunk**                           | one file = header (lead, preface, **chunk index with per-chunk checksums**, signatures) + independently zstd-compressed chunks; optional shared zstd dictionary                                       | any server with Range                   | old `.zck` (or its detached header) + Range                                                                                  | [V] SHA-256 option; "If the dictionary changes, none of the chunks will match". Used by Fedora repo metadata [S].                                                                                                             |
| **bita**                             | CDC (~64 KiB avg, RollSum/BuzHash), blake2, brotli; archive = dictionary + chunks                                                                                                                     | Range                                   | **scans seeds with the rolling hash** (thick); fetches adjacent chunks in one request; can reorganise output in place        | [V]                                                                                                                                                                                                                           |
| **zsync / zsync2 (AppImage)**        | `.zsync` = block checksums of the target                                                                                                                                                              | Range                                   | **rolling checksum over local file** (thick)                                                                                 | [S]                                                                                                                                                                                                                           |
| **OSTree / Flatpak**                 | git-like: SHA-256 objects (commit, dirtree, dirmeta, content); `archive` mode compresses each content object; refs = branches                                                                         | static host                             | fetch missing objects; optional **static deltas** `from-to` (and from-scratch) with bsdiff parts and fallback objects        | [V ostree formats] Signing: GPG, or ed25519 via `ostree sign` (libsodium) [S man page].                                                                                                                                       |
| **OCI zstd:chunked / eStargz**       | layer = concatenated zstd frames (per file / chunk) + **TOC in a skippable frame** (per-file SHA-256 digest, offsets; chunk entries by rolling checksum) + tar-split                                  | registry with Range                     | TOC digest from the (signed) image manifest annotation; files already present by digest; **multi-range** fetch of the rest   | [V containers/storage docs, zstd-chunked-rs format, PR #1084] Client merges ranges and halves on HTTP 400. Fedora 33 pull: "deduplicated: 54.0 MiB = 78.87%". Partial pulls need tar-split for byte-identical `diff_id`.      |
| **Nix binary cache**                 | store paths addressed by input hash; `narinfo` (URL, Compression, FileHash, FileSize, NarHash, NarSize, References, **Sig** ed25519) → compressed NAR                                                 | static host                             | whole-NAR substitution, no deltas                                                                                            | [S; the cache-store settings page was read [V]: xz/zstd/…, `want-mass-query`, `priority`]                                                                                                                                     |
| **Hugging Face Xet**                 | ~64 KB CDC chunks; new chunks grouped into **64 MB blocks** (xorbs) in a CAS; global dedupe query                                                                                                     | CAS service                             | reconstruction terms (byte ranges of blocks)                                                                                 | [V HF docs] same bundle idea as Riot.                                                                                                                                                                                         |
| **CAVS** (Godot-oriented, July 2026) | BLAKE3 chunks, Merkle root, per-file SHA-256, optional Ed25519; packfiles; static-tree mode "with no cavs-server"                                                                                     | static CDN (v1.4.0)                     | plans locally, concurrent Range; `.part` → verify → atomic rename                                                            | [V forum + README; vendor claims] TPS demo 247.60 → 1.64 MiB at 64 KiB chunks; RAM 1.1 GiB → 7 MiB streaming; "not always smaller than xdelta/bsdiff for a single exact v1->v2 patch".                                        |

### 2.2 CDC parameters and measured dedupe

- **FastCDC** (Xia et al., USENIX ATC 2016; improved "rolling two bytes" version in IEEE TPDS 2020) uses a gear hash with normalized chunking. Implementations take `(min, avg, max)`, e.g.
  fastcdc-rs `v2020::FastCDC::new(data, 16384, 32768, 65536)`. **Different FastCDC versions produce
  different cut points** (fastcdc-rs README), so the chunker algorithm and version must be recorded
  in the manifest, as RMAN does with `chunking_version` and min/avg/max per file [V].
- Deployed averages cluster at **~64 KB**: Riot (16 zero bits), casync/desync defaults (16/64/256
  KB), bita (~64 KiB), Hugging Face Xet (~64 KB) and CAVS (64 KiB best on its Godot tests). The
  fixed-block systems use **1 MiB** (Steam ≈1 MB, Epic 1 MiB windows), MSIX 64 KB blocks, and wharf
  64 kB blocks [V].
- Measured reuse:
  - Riot: >85% of bundles shared between consecutive releases; about 10% intra-release dedupe [V].
  - desync Debian image: 66% (2 days old) down to 48% (1 year old) of target chunks reused from the seed [V].
  - zstd:chunked Fedora: 79% of a layer deduplicated against local storage [V].
  - CAVS on Godot demos: Marble 6.55 → 0.19 MiB, GDQuest demo 27.61 → 13.27 MiB, TPS demo
    247.60 → 1.64 MiB [V vendor].
- Trade-off [I]:
  - Smaller chunks give better reuse but a bigger index and more ranges. At 64 KiB and about 48
    bytes per record, a 1 GiB pack means 16,384 chunks and roughly 0.8 MB of binary index, or about
    3 MB as JSON. That is why Riot uses FlatBuffers and CAVS moved to a binary manifest (~75% smaller
    than JSON).
  - Recommendation: **64 KiB average (16/64/256 KiB)** by default, 256 KiB average for packs over
    4 GiB (ML models), and no chunking for packs under 4 MiB.

### 2.3 The thin-client test

The question: can a client with **only SHA-256, zstd decompression and HTTP Range** (no rolling
hash) rebuild version N from any older installed version plus downloads?

| Approach                                | Thin-client OK?      | Why                                                                                                                 |
| --------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------- |
| RMAN-style manifest + bundles           | **Yes**              | installed manifest gives boundaries; chunk IDs diff; Range into bundles [V]                                         |
| Epic BPS / Steam depots                 | **Yes**              | file → chunk parts with hashes in both manifests; builder did the rolling-hash matching [V]                         |
| Blizzard TACT                           | **Yes**              | per-file keys; patches are pairwise ZBSDIFF over decoded content (client needs bspatch + zlib/LZ4 to re-encode) [V] |
| MSIX block map                          | **Yes**              | fixed 64 KB blocks per file, SHA-256 per block [V schema; S blog]                                                   |
| desync / casync with seed **index**     | **Yes**              | seed index lists the seed's chunks and offsets; verify by hash [V]                                                  |
| zchunk                                  | **Yes**              | old file's header lists chunk checksums [V]                                                                         |
| zstd:chunked                            | **Yes** (file level) | per-file digest + offsets in the TOC [V]                                                                            |
| OSTree objects / static deltas          | **Yes**              | object-level set difference; deltas are pairwise programs [V]                                                       |
| wharf patch apply                       | **Yes, pairwise**    | ops reference blocks of the exact old build [V]                                                                     |
| zstd `--patch-from`, HDiffPatch, bsdiff | **Yes, pairwise**    | needs the exact base bytes; zstd needs base-sized memory; not exposed to GDScript (§3.3)                            |
| zsync, bita (seed without index), rsync | **No**               | client scans local data with a rolling hash [V/S]                                                                   |

**Design consequence** [I]: the client must **keep the verified manifest of every installed pack
release**. That manifest is the "seed index": `chunkId → (localPath, offset, len)`. With it,
verification and reuse are offset reads plus SHA-256. Repair is the same operation (hash every
listed range), so the client never needs FastCDC.

### 2.4 Chunk-sync vs binary deltas, by payload shape

**(a) Compressed game packs where small edits shuffle bytes** (Godot PCK, UE pak/IoStore, Unity
bundles):

- _Container of per-entry-compressed resources, container itself uncompressed_ (Godot PCK: files
  back-to-back, 32-byte default alignment for `PCKPacker`, directory at `dir_offset` [V]; IoStore:
  64 KiB compression blocks with logical offsets quantised to the block size [V]):
  - An edit changes one entry, shifts later offsets and rewrites the directory.
  - **CDC** re-synchronises right after the edit, so new chunks ≈ changed entries + directory + about
    two boundary chunks per edited region.
  - **Fixed blocks** (Steam 1 MB, MSIX 64 KB) misalign everything after the first size change
    unless entries are padded to the block size. Hence Valve's "align to 1 MB" and "don't
    shuffle".
  - **zstd `--patch-from`** finds moved content at any offset and compresses the delta. It is
    usually smallest for N−1→N but useless from N−3 unless you also publish N−3→N, and it needs the
    old pack in RAM (§3.3).
- _Whole-container compression_ (LZMA Unity bundles, deflated zip, `.tar.gz`): every byte after an
  edit changes, and **both CDC and deltas degrade to a full download**. Remedies:
  - compress per entry or per chunk instead (zchunk, RMAN, zstd:chunked, UE IoStore blocks, Unity
    LZ4 "chunk-based" bundles [S]);
  - or diff the _decoded_ stream and re-encode deterministically on the client (Blizzard ESpec
    [V]; Google Play archive patching [S, E5]).
  - For our CI: never ship packs wrapped in general-purpose compression. Let chunk codecs and HTTP
    do it (Godot docs also recommend disabling compression on patched assets [V]).
- _Non-deterministic export_ (Godot re-exports can differ [V docs]) turns unchanged resources into
  changed bytes for every method. CI must build each release **once**, store it by hash and diff
  stored artifacts, never re-exports.

**(b) Directory trees of many files** (loose files, mods, localization folders, sparse PCK):

- Address by **file hash first**. Unchanged files and renames cost nothing (OSTree objects, TACT
  CKeys, zstd:chunked digests, Steam `sha_content`).
- Then CDC _within_ large changed files. Optionally add per-file zstd patch-from for hot big files
  (TACT's per-file ZBSDIFF, Velopack's per-file zstd deltas).
- A single delta over a tarball of the tree is the worst option: order changes and tar headers
  shift everything.

**(c) Single large files** (ML models, audio banks, video, huge PCKs):

- **CDC wins operationally**: any-version→latest, no pairwise precompute, a store deduplicated
  across versions (desync, Xet, CAVS).
- Binary deltas win in bytes only for the exact previous version and cost CI time and memory:
  a zstd window above 128 MiB needs `--long` and the matching `windowLog` on decode [V E5].
- Tensor-heavy models change broadly after fine-tuning, so expect near-full downloads either way.
  Architecture-preserving updates (quantisation tables, adapters) dedupe well [I].

**Rule of thumb** [I]:

- ≤ 4 MiB: full download.
- 4–64 MiB and hot (every release): full, plus one zstd delta from N−1 when it saves at least 30%
  and 1 MB (README §3.7).
- ≥ 16 MiB or cold (any-version audience): chunk-sync.
- Offer both where both exist and let the client planner pick (§5.5).

### 2.5 Cloudflare and R2 facts that constrain the chunk transport

- **R2 binding** `get(key, {range})` supports offset/length and suffix ranges (one range per call)
  [V R2 Workers API].
- **Cloudflare cache** [V "Range Requests", updated 2026-09-14]:
  - Multi-range (2–300 ascending, non-overlapping ranges → multipart 206) applies "when Origin
    Range Requests applies". Serving a complete cached file without it yields single-range
    behaviour.
  - More than 300 ranges → 200 full body.
  - On a cold miss "the first origin request also omits `Range`".
  - "If Cloudflare must decompress a complete encoded response, it ignores `Range`."
  - `If-Range` must match the cached ETag exactly.
- **Service Worker Cache API**: `put` rejects a `206` response with `TypeError` (Service Worker
  spec) [V]. The Workers Cache API has the same limit (E5 §4.2).
- Design implications [I]:
  1. **Bundles of 4–16 MiB** (not 256 MB archives), so a cold-miss full fetch into the edge is
     cheap.
  2. **One Range per contiguous run**, many in parallel over HTTP/2. Use multi-range only after a
     capability probe.
  3. Chunk bundles are `application/octet-stream` **without** `Content-Encoding`. Chunks are
     already zstd.
  4. Order chunks inside a release's new bundles in **file order**, so an update's missing chunks
     are mostly contiguous (Riot's range coalescing depends on this).
  5. Keep full-blob keys `blobs/sha256/<hash>` (README §3.5) for first installs and platform
     uploads; bundles are an extra representation.

---

## 3. Engine content systems

### 3.1 Unity Addressables and Cloud Content Delivery

**Addressables** (manual versions 1.17 through 4.0.2 read) [V]:

- Groups build to AssetBundles. A **catalog** maps addresses to locations, with a `.hash` companion.
  Remote catalogs are named `catalog_{timestamp or Player Version Override}.json|.hash` (4.x also
  has binary `catalog.bin`).
  - "The application loads the hash file at runtime to decide if a new catalog is available."
  - "Building an application generates a unique app content version string, which identifies what
    content catalog each app should load."
- **Content update builds** use `addressables_content_state.bin`, which must be "save[d] … for each
  published full application release on every platform".
  - Groups are _Cannot/Can Change Post Release_ (later "Prevent Updates"). The _Check for Content
    Update Restrictions_ tool moves changed assets out of static groups into new remote groups.
  - _Update a Previous Build_ produces a catalog that loads unchanged assets from original bundles
    and changed ones from new bundles with new names. Unchanged bundles keep names and "will
    overwrite them".
  - _Unique Bundle IDs_ allows hot-swapping mid-session at the cost of rebuilding dependents.
- Compatibility caveats [V]:
  - "Addressables can only distribute content, not code … you must analyze whether the type trees
    in the existing AssetBundles are compatible with your new code."
  - Same content built by two Unity versions gives the same hash but a different CRC, so the new
    bundle overwrites the old name and old players fail the CRC check. Branch content per player
    build.
- Weakness: catalog hash and CRC are integrity/cache checks, not authenticated signatures (E5 §6).

**CCD** [V docs]:

- Project → environments → **buckets** (open, or "Promotion only") → **entries** (files; MD5 shown)
  → immutable **releases** → mutable **badges** (`latest` is automatic; "A badge can only ever point
  to a single release within a bucket, but you can move badges").
- Promotion copies a release between buckets and environments.
- Client URL pattern:
  `https://<project>.client-api.unity3dusercontent.com/client_api/v1/buckets/<bucket>/release_by_badge/<badge>/entry_by_path/content/?path=…`,
  with no auth for client reads. The Management API offers "changed entries between releases".
- For Polaris [I]: CCD's bucket/release/badge triad maps cleanly onto content channel → pack set →
  release, and "promotion only" onto CI-only publishing.

**Version/compat metadata carried:** player content version string, catalog hash, per-bundle hash
and CRC, Unity version (implicit in CRC and type trees).

### 3.2 Unreal Engine

- **Pak patching** [S docs "How to create a patch"]:
  - Build with `-createreleaseversion=<n>`, then `-generatepatch -basedonreleaseversion=<n>`.
  - "The smallest piece of content is a single package", so a changed package ships whole in the
    patch pak.
  - The `_P` filename suffix gives mount priority. A community IoStore packer confirmed
    experimentally that `_P` also makes override containers win [V mjolnircore note, 2026-08].
- **IoStore** (`.utoc` + `.ucas`) [V format parsers UEcastoc, UnrealReZen, mjolnircore]:
  - `.utoc` holds:
    - a 144-byte header (entry count, compression block size, container ID, flags
      Compressed/Encrypted/Signed/Indexed, partition size);
    - chunk IDs (12 bytes: 64-bit package ID, index, type);
    - packed offsets/lengths and perfect-hash seeds;
    - compression blocks (12 bytes each);
    - method names;
    - a directory index;
    - per-chunk metadata with a hash (SHA-1, "IoHash" since TOC v8).
  - `.ucas` holds chunk data in **64 KiB compression blocks** (Oodle/zlib/LZ4). Logical offsets are
    quantised to block size, which is friendly to block and CDC diffing.
  - "we don't support mount points with I/O store": package IDs are hashes of package names fixed
    at cook (Epic staff, forum 2025) [V forum].
  - A stub `.pak` sibling is needed for discovery; AssetRegistry lives in the `.pak` [V].
- **ChunkDownloader** (plugin):
  - `BuildManifest-<platform>.txt` lists pak files with size, version string, chunk ID and relative
    path, under a per-`ContentBuildID` folder on the CDN.
  - The game downloads, then `MountChunks`.
  - Weakness: no content hash in the manifest (E5 §6) [V].
- **IoStore On-Demand** streams chunks from a CDN (Fortnite cosmetics). It is experimental for
  licensees [S].
- **BuildPatchServices** as in §1.3; UE's mobile patching utility uses BPS manifests [S].

**Version/compat metadata:** release version (cooked asset registry of the base), BuildID and
ContentBuildID, pak mount order and `_P`, container ID, TOC version, engine version (cook
compatibility).

### 3.3 Godot 4.4–4.7 [V source unless marked]

**PCK format**:

- Header: magic `GDPC`, `PACK_FORMAT_VERSION` **4** on master (v2 and v3 also accepted), engine
  `major.minor.patch`, and pack flags `DIR_ENCRYPTED`, `REL_FILEBASE`, `SPARSE_BUNDLE`. Then the
  file base, then `dir_offset`.
- Directory entries: `{path, offset, size, md5[16], flags ENCRYPTED|REMOVAL|DELTA}`.
- **Loading refuses packs created by a newer engine `major.minor`** ("Pack created with a newer
  version of the engine").
- `PACK_FILE_REMOVAL` entries delete paths: 4.4 patch PCKs can remove files.
- A **sparse PCK** (PR #105984, Android-focused and enabled by default there) stores only header and
  directory in `*.sparsepck`, with each file stored separately (named by SHA-256 of path + salt).
  Load time fell from 8,570 ms to 10 ms in the PR's test [V PR]. This is effectively a directory-tree
  pack with a Godot index.

**Runtime API** [V class XML]:

- `ProjectSettings.load_resource_pack(pack, replace_files=true, offset=0)` "Loads the contents of the
  .pck or **.zip** file". `offset` works only for `.pck`. There is no unload.
- `PCKPacker.pck_start(path, alignment=32, key, encrypt_directory)`, `add_file`,
  `add_file_from_buffer`, `add_file_removal`, `flush`. PCKPacker can assemble packs on device, for
  example a merged pack.
- Scripts get `PackedByteArray.decompress(buffer_size, COMPRESSION_ZSTD)` (known output size, **no
  dictionary parameter**) and `HashingContext` SHA-256. The delta decoder (`DeltaEncoding`) is
  **not** exposed to scripts.

**Patch PCKs (4.4) and delta encoding (4.6, PR #112011, merged 2025-11-26)** [V]:

- Export _Patching_ tab: "Base Packs" plus "Export as Patch" exports only changed files. CLI:
  `--export-patch <preset> <path> --patches a.pck,b.pck`.
- Delta mode stores `PACK_FILE_DELTA` entries: header `GDDL` + version 1 + a zstd frame compressed
  with the base file as prefix (`ZSTD_CCtx_refPrefix`, level 19 default, content-size and
  **checksum flags on**). Export options:
  - `patch_delta_encoding`;
  - `patch_delta_compression_level_zstd` (19);
  - `patch_delta_min_reduction` (10%);
  - include/exclude filters.
- **`FileAccessPatched::_apply_patch`**:
  - on first read, it loads the entire base file into memory;
  - it applies _every_ delta patch registered for that path in load order (stacked);
  - it keeps the patched bytes in RAM and opens a memory-backed `FileAccess`.
  - There is no on-disk cache, so the patch cost recurs on every load (the PR measured ~66 µs mean,
    13 µs median, 1,858 µs worst per patch on desktop).
  - There is **no base-hash check**. A wrong base is caught only by zstd's content checksum or a
    size mismatch.
- DOGWALK: 8.55 → 2.11 MiB and 14.64 → 5.03 MiB patches [V PR].
- Docs [V]: base packs "must be the exact same files that are loaded by the game at runtime, in the
  exact order"; re-exports may differ (non-determinism); each stacked patch adds load time;
  compressed resources "diff poorly".
- Docs security advice: "store the public key in the main PCK, and sign patch or expansion PCK
  files with the private key" [V].

**Implications for Polaris** [I]:

- (1) Prefer transport-level chunk-sync or delta that reconstructs the **full** pack and verifies its
  SHA-256 (README §3.7 already says so).
- (2) A GDScript-only client _can_ still use a delta: CI builds a Godot delta patch PCK against the
  exact base bytes the client holds. That base is identified by SHA-256 in our manifest, not by
  re-export, so the determinism caveat disappears. The client mounts base then patch. Cap the stack
  at 1–2 and rebase to a full or chunk-synced pack at the next opportunity.
- (3) Because the engine rejects newer-engine packs and PCK format versions move (v2 → v4), the
  pack release must carry `engine` and `pckFormat` constraints.
- (4) The sparse-PCK layout suggests a future `godot.sparsepck` tree type with per-file dedupe.

### 3.4 Version and compat metadata the engines carry

| Engine / system    | Content identity                          | Build/compat keys                                                        | Patch granularity            | Authenticated?         |
| ------------------ | ----------------------------------------- | ------------------------------------------------------------------------ | ---------------------------- | ---------------------- |
| Unity Addressables | bundle name (hash), CRC                   | player content version string, catalog hash, Unity version, type trees   | bundle                       | no (hash/CRC only)     |
| Unity CCD          | entry MD5, release #                      | bucket, badge                                                            | entry                        | transport (HTTPS) only |
| Unreal pak/IoStore | package / chunk ID (hash of package name) | release version, BuildID/ContentBuildID, TOC version, container ID, `_P` | package / 64 KiB block       | optional pak signing   |
| Godot PCK          | path + MD5 per file                       | engine major.minor.patch, PCK format version, load order, flags          | file (delta per file in 4.6) | no (docs suggest DIY)  |

---

## 4. Platform-native transports: versioning, patching, layering

### 4.1 Summary table

| Transport                           | Who versions                                             | Updates independent of app?                                                     | Differential?                                                                 | Can a third-party content layer ride on it?                   | What Polaris must track                                                                                                       |
| ----------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **Apple-hosted Background Assets**  | Apple assigns increasing integer versions per asset pack | **yes**, and a newly live version applies to **all** installed app versions     | not documented (assume whole pack) [I]                                        | yes: we author the pack contents                              | `assetPackIdentifier`, ASC version id/number, review state (webhooks), device `localVersion(ofAssetPackWithID:)`, marker file |
| Self-hosted managed / unmanaged BA  | us (manifest at `BAManifestURL` or managed manifest)     | yes                                                                             | ours (whatever we serve)                                                      | yes; managed self-hosted protocol undocumented (E1)           | our install DB; allowance keys                                                                                                |
| **Play Asset Delivery**             | tied to app **versionCode**                              | **no**                                                                          | yes, Play patches asset packs as part of the app update                       | yes, as data inside packs                                     | pack name ↔ versionCode; `AssetPackState`/location; marker file                                                               |
| **Steam depots**                    | Steam build (set of depot manifest GIDs) on branches     | per build/branch; DLC depots ship with app builds                               | yes: ~1 MB chunk dedupe + chunk-to-chunk deltas                               | yes, as data inside depots                                    | depotId, manifest GID, buildId, branch; client `GetAppBuildId` / installed depots [S]; marker file                            |
| **MSIX (Store / App Installer)**    | package Version quad                                     | optional packages are serviced independently; related sets enforce version sets | yes: block map, SHA-256 per 64 KB block                                       | yes, content-only optional packages; package dir is read-only | Package Family Name, version quad, related-set membership                                                                     |
| **Flatpak / OSTree**                | commit per ref (branch)                                  | extensions can update separately [S]                                            | yes: object-level + static deltas                                             | yes (extension or extra-data)                                 | ref, commit checksum                                                                                                          |
| **Web (our origin)**                | us                                                       | yes                                                                             | ours (chunks; HTTP compression; Compression Dictionary Transport on Chromium) | n/a, it's ours                                                | IndexedDB install DB; storage persistence; quota                                                                              |
| **Godot patch PCK (engine-native)** | our CI                                                   | yes (if the outlet allows downloaded content)                                   | per-file zstd, applied at load                                                | n/a                                                           | exact base SHA-256 list + order                                                                                               |
| **Polaris CDN (R2)**                | us                                                       | yes                                                                             | chunk-sync / zstd delta                                                       | n/a                                                           | full install DB                                                                                                               |

### 4.2 Apple Background Assets (managed, Apple-hosted; iOS/macOS/tvOS/visionOS 26+)

Sources: WWDC25 session 325 [V], ASC Help overview [V], ASC API "Uploading and versioning Apple
hosted background assets" [V via mirror], unmanaged configuration doc [V], Xcode 26.4 b2 API diff
[S]; notes/E1 §E has the full API survey.

- **Versioning** [V]:
  - Uploading new content to the same asset pack gives "a higher version number". It replaces the
    internal-testing version first, then external TestFlight and App Store after review.
  - "Once you have live app versions and asset packs … you can also update either the app binary or
    the asset pack content."
  - When pack v2 goes live, "App Store will automatically be switched over to using asset pack
    version 2, **including older versions that are still installed**".
  - A new app build "continues to work with the asset pack versions that are live". To pair a build
    with a new pack, submit both.
- **Update triggers** [V/S]:
  - The system keeps downloaded packs up to date in the background.
  - `checkForUpdates()` returns `(updatingIDs, removedIDs)`.
  - `ensureLocalAvailability(of:requireLatestVersion:)` (26.4; waits for a pending update when
    `true`).
  - `status` flags `upToDate`/`outOfDate`/`updateAvailable`/`obsolete`.
  - `shouldDownload(_:)` in the extension can veto packs "if some of your asset packs have specific
    compatibility requirements".
  - The unmanaged extension fires on install, update and periodically, subject to Low Power Mode and
    Background App Refresh.
- **Differential updates**: neither the WWDC session nor ASC docs describe byte- or file-level
  deltas for pack updates; "the system automatically manages downloads, updates, and compression".
  Treat an update as a full pack download [I]. Mitigation: split packs by volatility.
- **Layering Polaris on top** [I]:
  - (1) Put a signed **marker** `.pkey/pack.json` inside each asset pack:
    `{packId, version, releaseSha256, filesIndexSha256}` plus a detached JWS by the release key. The
    client reads it with `AssetPackManager.contents(at:searchingInAssetPackWithID:)`, maps Apple's
    integer `localVersion` to our release, and verifies files against our file index.
  - (2) Because every installed app version switches at once, encode the **content ABI** in the
    pack identity (`foes.c3`) and bump it on breaking changes, as E1 recommends. Keep old IDs live
    for old app builds, which costs quota (Apple charges the maximum size across versions per pack
    against 200 GB).
  - (3) ASC webhooks drive `release_availability` (README §3.7).
  - (4) Entitlement gating is impossible on Apple-hosted packs (anyone with the app can download).
    Paid content must be gated at use time via StoreKit, or served from our CDN.

### 4.3 Play Asset Delivery

Sources: developer.android.com asset-delivery guide [V]; notes/E2 §A3.

- Delivery modes: install-time (split APKs; needs about 2× total pack size free), fast-follow and
  on-demand (archives expanded to internal storage). "Treat them as read-only since asset pack
  patches depend on file integrity."
- **Update flow for fast-follow/on-demand** [V]:
  1. The patch for the app, including all assets, is downloaded.
  2. The binary updates.
  3. Previously downloaded packs are invalidated.
  4. The asset patch is applied in internal storage.

  The app "may already be updated but asset patching may still be in progress", so it needs "Update
  in progress" UX. Packs cannot update without an app update.

- Texture Compression Format Targeting delivers the best format per device; size limits apply per
  format [V].
- **Layering** [I]:
  - Use PAD for large, stable base content. Pack identity = (packName, versionCode); our marker file
    maps it to a Polaris release.
  - Ship live content through Polaris CDN packs (data-only; Play policy on downloaded code, E2).

### 4.4 Steam

- Covered in §1.4. Steam decides timing and bytes; our SDK must not write into the install
  directory, since Steam verifies it.
- Live content outside depots goes to the user data dir and must be data-only per outlet policy
  (README §3.7, E3).
- **Metadata** [I/S]: record `depotId → packId` and, per Steam build, `manifestGid` per depot and
  `buildId` per branch. That data comes from `steamcmd` build output (the `pkey submission report`
  path). On device, compare `ISteamApps::GetAppBuildId()` [S] with the marker files in the depot.
- DLC packs map to DLC depots; ownership comes from `BIsDlcInstalled` / `CheckAppOwnership` (E3).

### 4.5 MSIX

- The block map is `AppxBlockMap.xml` with a SHA-256 per 64 KB block per file; updates fetch
  changed blocks. It needs Range and correct MIME (E3) [V schema/S blog].
- **Optional packages** "contain content that can be integrated with a main package … useful for
  downloadable content (DLC)". **Related sets** "won't allow the latest version of any package to
  be used until all of the related set packages … are installed". Content-only optional packages
  can be removed without restart if marked not-in-use. Store submission needs permission [V, page
  updated 2026-04-15].
- **Layering** [I]: a Polaris pack can be emitted as a content-only optional package, with identity
  = Package Family Name + Version quad. Otherwise keep Polaris packs in `LocalState`, since the
  package directory is read-only.

### 4.6 Flatpak / OSTree

- OSTree repositories are static (R2-hostable); refs act as channels; per-object dedupe plus
  optional static deltas; signing by GPG or ed25519 [V/S].
- Flathub specifics and the External Data Checker are in E3.
- Polaris packs on Linux sandboxed builds live in `~/.var/app/<id>/` (user data), or ship as a
  Flatpak extension for store-managed content [S].

### 4.7 Browsers

- **Storage** [V MDN, 2026-01-05]:
  - Quotas: Chrome/Edge 60% of disk per origin. Firefox best-effort min(10% disk, 10 GiB group
    limit); persistent up to 50%. Safari 17+: ~60% (browser apps and Home Screen web apps), ~15%
    (embedded WebViews).
  - **Eviction is all-or-nothing per origin, LRU.** Safari deletes script-writable storage after 7
    days without user interaction.
  - `navigator.storage.persist()` is auto-granted or denied by engagement in Chromium and Safari,
    and prompts in Firefox.
- **Cache API**: good for immutable full responses (`blobs/sha256/*`, bundles). It cannot store 206
  responses [V spec], so chunk reconstruction writes into **OPFS** (sync access handles in a worker)
  or IndexedDB.
- **Godot web**: `user://` is IndexedDB (E3). The pack must be written where `load_resource_pack`
  can read it (`user://…`). Bridging from OPFS into Godot's FS is unverified (E3 prototype item) [I].
- **HTTP**: content-addressed immutable URLs (`Cache-Control: immutable`), `Repr-Digest`, and for
  Chromium, Compression Dictionary Transport with the previous version as dictionary for text-like
  packs (l10n, JSON). Cloudflare passes `dcb`/`dcz` through; the origin must produce them (E5 §4.1).
- **Metadata**: our own install DB in IndexedDB. After eviction everything is gone, so the client
  must detect an empty DB and re-plan from scratch.

---

## 5. Design recommendations for a multi-type pack system

### 5.1 Principles [I]

1. **Identity is the signed manifest, not the transport.** A pack release = `(packId, version)` →
   CI-signed record → payload SHA-256 and file/chunk index SHA-256. Every transport delivers bytes
   that must verify against it.
2. **Immutable, content-addressed everything below the pointer.** Only channel indexes are mutable
   (Worker-signed, short TTL), as in README §3.3.
3. **Rolling hash in CI only.** Clients use offsets, SHA-256, zstd and Range.
4. **Stage, verify, then atomically switch a pointer.** Keep the previous set until a confirmed boot.
5. **The client picks the route from a signed menu.** The server never needs to know what a device
   has, so feeds stay cacheable.
6. **Types are plugins.** Transport, patch method and activation are orthogonal axes declared per
   type.
7. **Server-side resolution.** Clients receive locked sets, never ranges to solve.

### 5.2 Object model

```
Product
 ├─ PackDefinition (packId, type, policy, transports, compat axes)       ← .pkey/content.yaml → D1
 │    └─ PackRelease (packId@version, seq)  ── CI-signed "pkey-pack"      ← immutable
 │         ├─ payload: full blob  blobs/sha256/<h>                         (file-typed packs)
 │         ├─ files index         blobs/sha256/<h>  "pkey-files/1"         (per-file sha256, modes)
 │         ├─ chunk index         blobs/sha256/<h>  "pkey-chunks/1"        (binary, chunk→bundle)
 │         ├─ bundles             bundles/sha256/<h>                       (4–16 MiB, immutable)
 │         ├─ deltas[]            deltas/<from>/<to>.<method>              (optional, lazily added)
 │         └─ variants            (texture family, locale, quality tier) → separate releases
 ├─ TransportBinding (release × outlet → platform ids/state)              ← D1, connectors/webhooks
 ├─ PackSet (resolved lock: [release…]) per (channel, contentApi, variant) ← CI or Worker resolves
 └─ ContentIndex  "pkey-content+jws" per channel (Worker-signed: seq, exp, sets, rollout, halts,
                  floors, availability)
```

Code releases (`pkey-release+jws`, README §3.3) keep pinning exact pack release hashes (lock), which
is option (a) of README §3.7. Content channels (option (b)) point at PackSets.

### 5.3 Pack type registry and handler contract

Every type registers a handler implementing the same lifecycle. The client SDK ships the handlers
it supports and advertises them (§5.5).

| Hook                      | Contract                                                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `formats()`               | list of `(type, formatVersion)` it can install/activate (e.g. `godot.pck` v2–v4 on 4.7)                                               |
| `plan(installed, target)` | type-specific preferences (e.g. trees prefer file-level reuse; PCK prefers whole-file reconstruct)                                    |
| `stage(route)`            | write into `staging/<planId>/`; resumable; journaled                                                                                  |
| `verify(staged)`          | per-chunk SHA-256 during write; per-file SHA-256; payload SHA-256; type checks (e.g. PCK header engine ≤ running, data-only prefixes) |
| `activate(staged)`        | move into `store/`, update the active-set pointer atomically; `activation: hot` (can swap now) or `restart` (next boot)               |
| `deactivate(version)`     | hot types only (PCK cannot unload)                                                                                                    |
| `rollback()`              | re-point to `previous`                                                                                                                |
| `uninstall(version)`      | delete from store if not a GC root                                                                                                    |
| `roots()`                 | paths/hashes that must survive GC                                                                                                     |

Initial registry (preferred route first; `full` is always the final fallback) [I]:

| Type id                       | Payload                                                                                                                                               | Activation                                                     | Preferred routes                                                                            | Type-specific verify/compat                                                                     |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `godot.pck`                   | single `.pck`                                                                                                                                         | restart (mount in `mountOrder` at boot, `replace_files=false`) | chunk-sync (≥16 MiB) → zstd delta (native SDKs) → `godot-delta-pck` layer (GDScript) → full | `engine`, `pckFormat`, texture feature; data-only list check at publish and mount (README §3.7) |
| `godot.sparsepck`             | index + per-file blobs                                                                                                                                | restart                                                        | file-level reuse → per-file chunk-sync                                                      | as above                                                                                        |
| `files.tree`                  | directory tree                                                                                                                                        | hot (atomic dir swap `versions/<sha>` + pointer)               | file-level reuse → chunk-sync for large files → per-file delta                              | path safety (no `..`, no absolute, no symlink escape), modes                                    |
| `archive.zip` / `archive.tar` | archive **as build input**, delivered as `files.tree` unless the consumer needs the archive itself; then deterministic, stored (uncompressed) entries | as `files.tree`                                                | as `files.tree`; if kept as archive: chunk-sync                                             | zip-slip checks; deterministic re-zip in CI                                                     |
| `audio.bank`                  | FMOD `.bank` / Wwise `.bnk` (single file)                                                                                                             | hot if middleware can unload/reload bank, else restart         | chunk-sync → full                                                                           | middleware version compat                                                                       |
| `l10n.table`                  | `.translation`/PO/CSV/JSON, small                                                                                                                     | hot (`TranslationServer`)                                      | full (HTTP br/zstd) → zstd delta for large tables → CDT on web                              | locale tag (BCP-47), string-key schema version                                                  |
| `data.json`                   | small JSON documents                                                                                                                                  | hot                                                            | full                                                                                        | JSON Schema version; consider the existing signed-config catalog instead for tiny data          |
| `ml.model`                    | GGUF/ONNX/safetensors (large)                                                                                                                         | hot (swap path after load test)                                | chunk-sync (256 KiB avg for >4 GiB) → full                                                  | runtime, quantisation, RAM/VRAM requirements                                                    |
| `unity.addressables` (later)  | Addressables catalog + bundles as `files.tree`                                                                                                        | handled by Addressables (custom provider / URL transform)      | file-level reuse                                                                            | player content version; Unity version; signed catalog via Polaris                               |

Transports (`pkey-cdn`, `apple-ba`, `play-pad`, `steam-depot`, `msix-optional`, `flatpak-ext`,
`embedded`, `web`) are a separate axis from types.

### 5.4 Schemas (JSON sketches)

**(1) Pack definition** (`.pkey/content.yaml` → D1 `content_packs`; operator-owned fields guarded
like README §3.4 `*_source`):

```json
{
  "packId": "diceroll.foes",
  "type": "godot.pck",
  "title": "Foes",
  "versionScheme": "semver",
  "contentApi": { "current": 3 },
  "variants": { "texture": ["s3tc", "etc2", "astc"] },
  "handler": {
    "mountOrder": 4,
    "replaceFiles": false,
    "prefixes": ["res://foes/"],
    "activation": "restart"
  },
  "policy": {
    "required": true,
    "delivery": "essential",
    "cellular": "ask",
    "keepPrevious": true
  },
  "entitlement": null,
  "channels": ["stable", "beta"],
  "transports": {
    "app-store": "apple-ba",
    "play": "embedded",
    "steam": "steam-depot",
    "web": "web",
    "default": "pkey-cdn"
  },
  "patch": {
    "methods": ["chunk/1", "zstd-patch-from", "godot-delta-pck"],
    "chunking": {
      "alg": "fastcdc-2020",
      "min": 16384,
      "avg": 65536,
      "max": 262144
    },
    "deltaBases": "last-2"
  },
  "contentPolicy": { "dataOnly": true },
  "signer": "release"
}
```

**(2) Pack release** (CI-signed body, e.g. `typ: pkey-pack+jws`, fetched by hash; platform IDs are
_not_ in here because they're assigned later):

```json
{
  "typ": "pkey-pack/1",
  "product": "diceroll",
  "packId": "diceroll.foes",
  "version": "1.4.0",
  "seq": 17,
  "type": "godot.pck",
  "variant": { "texture": "astc" },
  "payload": {
    "kind": "file",
    "name": "foes-astc.pck",
    "size": 52428800,
    "sha256": "9f2c…",
    "blob": "blobs/sha256/9f2c…"
  },
  "files": { "format": "pkey-files/1", "sha256": "4b1e…", "size": 2210 },
  "chunks": {
    "format": "pkey-chunks/1",
    "sha256": "c07a…",
    "size": 45872,
    "params": {
      "alg": "fastcdc-2020",
      "min": 16384,
      "avg": 65536,
      "max": 262144,
      "id": "sha256",
      "codec": "zstd"
    }
  },
  "deltas": [
    {
      "descriptor": "sha256:77aa…",
      "from": "sha256:1d0e…",
      "method": "zstd-patch-from",
      "size": 3145728
    }
  ],
  "requires": {
    "engine": ">=4.7.0 <4.8.0",
    "pckFormat": [3, 4],
    "contentApi": ">=3 <4",
    "features": ["astc"],
    "packs": [{ "id": "diceroll.core3d", "range": "^1.2.0" }]
  },
  "conflicts": [],
  "entitlement": null,
  "marker": ".pkey/pack.json",
  "provenance": {
    "sourceCommit": "a1b2…",
    "builder": "github-actions",
    "attestation": null
  },
  "createdAt": "2026-09-29T12:00:00Z"
}
```

**(3a) Files index `pkey-files/1`** (for trees and for multi-file verification after platform
installs):

```json
{
  "format": "pkey-files/1",
  "root": "res://",
  "files": [
    {
      "path": "foes/goblin.scn",
      "size": 18234,
      "sha256": "…",
      "mode": 420,
      "chunks": [0, 1]
    },
    {
      "path": "foes/orc.ctex",
      "size": 1048576,
      "sha256": "…",
      "mode": 420,
      "chunks": [2, 3, 4]
    }
  ],
  "dirs": ["foes"],
  "symlinks": []
}
```

**(3b) Chunk index `pkey-chunks/1`** (binary; JSON shown for readability). Binary layout
suggestion: a 64-byte header, then fixed 48-byte records `id[32] | len u32 | clen u32 | bundle u32 | offset u32`,
little-endian. That is easy to parse in GDScript with `PackedByteArray.decode_u32` and slicing:

```json
{
  "format": "pkey-chunks/1",
  "params": {
    "alg": "fastcdc-2020",
    "min": 16384,
    "avg": 65536,
    "max": 262144,
    "id": "sha256",
    "codec": "zstd",
    "level": 19
  },
  "bundles": [{ "sha256": "e3b0…", "size": 8388608 }],
  "chunks": [
    { "id": "a4f1…", "len": 61234, "clen": 40211, "bundle": 0, "offset": 0 }
  ],
  "layout": [{ "file": 0, "chunks": [0, 1, 2] }]
}
```

Rules [I]:

- IDs are SHA-256 of **uncompressed** chunk bytes. Compressed bytes may differ across zstd versions
  without changing identity.
- `clen == len` means stored raw (incompressible chunks).
- A bundle is `concat(compressed chunks)` in file order. Bundles are untrusted transport containers;
  trust comes from chunk IDs listed in a signed index.

**(4) Patch descriptor** (content-addressed, referenced from the pack release; can be added later
without re-signing if you choose to list deltas in the Worker-signed index instead; see §5.8):

```json
{
  "format": "pkey-patch/1",
  "packId": "diceroll.foes",
  "scope": "payload",
  "from": { "sha256": "1d0e…", "size": 51380224 },
  "to": { "sha256": "9f2c…", "size": 52428800 },
  "method": "zstd-patch-from",
  "params": { "level": 19, "windowLog": 27, "long": true },
  "artifact": {
    "key": "deltas/1d0e…/9f2c….zst",
    "sha256": "5c3d…",
    "size": 3145728
  },
  "apply": {
    "memBytes": 60000000,
    "tmpDiskBytes": 52428800,
    "minSdk": { "godot": "native" }
  }
}
```

`method` ∈ `zstd-patch-from` | `hdiffpatch` | `bsdiff` | `godot-delta-pck` (then
`artifact` is a PCK and `apply` adds `{ "layerOver": ["sha256:1d0e…"], "maxStack": 2 }`).

**(5) Content channel index** (Worker-signed `pkey-content+jws`, device-less, edge-cacheable):

```json
{
  "typ": "pkey-content/1",
  "product": "diceroll",
  "channel": "stable",
  "seq": 42,
  "issuedAt": "2026-09-29T12:00:00Z",
  "expiresAt": "2026-09-30T12:00:00Z",
  "sets": [
    {
      "select": { "contentApi": 3, "platform": "android", "texture": "astc" },
      "packs": [
        { "id": "diceroll.core3d", "version": "1.2.3", "release": "sha256:…" },
        { "id": "diceroll.foes", "version": "1.4.0", "release": "sha256:…" }
      ],
      "rollout": { "bp": 2500, "salt": "b64…" }
    }
  ],
  "availability": {
    "diceroll.foes@1.4.0": {
      "app-store": {
        "state": "live",
        "assetPackId": "foes.c3",
        "appleVersion": 7
      },
      "steam": {
        "state": "live",
        "depotId": 4012345,
        "manifestGid": "7340…",
        "branch": "public"
      }
    }
  },
  "halted": [],
  "floors": { "diceroll.foes": "1.3.0" },
  "deltas": [{ "packId": "diceroll.foes", "descriptor": "sha256:77aa…" }]
}
```

**(6) Client capabilities** (computed locally; sent only to the gated mint and to telemetry, never
to the public feed):

```json
{
  "sdk": "godot/0.3.0",
  "engine": "4.7.1",
  "platform": "android",
  "arch": "arm64",
  "outlet": "play",
  "contentApi": 3,
  "types": { "godot.pck": [2, 3, 4], "files.tree": [1], "l10n.table": [1] },
  "features": ["etc2", "astc"],
  "patchMethods": ["chunk/1", "godot-delta-pck/1"],
  "transports": ["pkey-cdn", "play-pad"],
  "http": { "range": true, "multiRange": false, "maxConcurrent": 4 },
  "limits": {
    "freeDiskBytes": 2147483648,
    "memBudgetBytes": 268435456,
    "metered": true,
    "background": false
  }
}
```

**(7) Install plan** (client output; also a conformance vector):

```json
{
  "pack": "diceroll.foes",
  "from": "1.3.2",
  "to": "1.4.0",
  "route": "chunk/1",
  "downloadBytes": 1720320,
  "requests": 6,
  "peakDiskBytes": 54525952,
  "peakMemBytes": 1048576,
  "fallbacks": ["full"]
}
```

**(8) Local install state** (`user://pkey/content/state.json`, written by temp + rename):

```json
{
  "active": {
    "diceroll.foes": {
      "version": "1.4.0",
      "release": "sha256:…",
      "payload": "sha256:9f2c…",
      "transport": "pkey-cdn",
      "path": "user://pkey/store/9f/9f2c….pck",
      "verifiedAt": "…"
    }
  },
  "previous": {
    "diceroll.foes": { "version": "1.3.2", "payload": "sha256:1d0e…" }
  },
  "inflight": {
    "planId": "…",
    "journal": "user://pkey/staging/…/journal.json"
  },
  "observed": {
    "apple-ba": { "foes.c3": { "localVersion": 7, "marker": "sha256:…" } }
  },
  "confirmedBootSeq": 17
}
```

**D1 sketch** (new tables need `TABLE_OWNERS` entries, README §3.4):

- `content_packs(product, pack_id, type, def_json, def_source)`;
- `content_releases(product, pack_id, version, seq, release_sha256, payload_sha256, files_sha256, chunks_sha256, variant_json, requires_json, created_at, yanked)`;
- `content_objects(hash, kind blob|bundle|delta|index, size, created_at)`;
- `content_object_refs(release_sha256, hash)`;
- `content_bindings(release_sha256, outlet, platform_ref_json, state, since, detail_json)`;
- `content_sets(product, channel, select_json, set_json, rollout_bp, rollout_salt, halted, source)`.

### 5.5 Capability negotiation and route selection

The **server publishes a menu; the client plans** [I]:

```
routes(target, installed, caps):
  if active payload == target.payload           → noop
  if pack bound to a platform transport on this outlet
       → platform (ask the OS/store; verify marker + files index); never mix with other routes
  candidates = []
  if caps has chunk/1 and target.chunks and seedIndex(installed) exists
       → chunk: bytes = Σ clen(missing chunks); requests = runs(missing, bundle order)
  for d in target.deltas where d.from == installed.payload and caps has d.method
       and d.apply.memBytes ≤ caps.memBudgetBytes
       → delta: bytes = d.size
  → full: bytes = payload.size (or compressed blob size)
  cost = bytes + α·requests + β·peakDisk + γ·cpu(method)   (α≈64 KiB-equivalent per request)
  pick min-cost feasible route; fallback order = remaining routes by cost, `full` last
  infeasible if peakDisk > freeDisk → offer "replace in place" (lose rollback) with consent
```

Notes [I]:

- **First install**: prefer the single full blob (one request, whole-file compression). Then
  _record the release's chunk index as the seed index_, so the next update is incremental without
  ever having downloaded chunks (CAVS's "dual route").
- **Multiple seeds**: a tree pack can reuse chunks from _any_ installed pack (the global local
  index), like Riot and desync. That covers moving assets between packs.
- **Determinism**: planning is a pure function of `(menu, installed indexes, caps)`, so it becomes
  a conformance matrix (`plan-matrix.json`) for all SDKs, like README §3.6's `update-matrix.json`.
- **Telemetry**: report `{route, bytes, duration, fallbackUsed, failureStage}` to find hot
  `(from,to)` pairs, then generate deltas lazily for those pairs only (Epic's A-to-B optimisation,
  butler's rediff).

### 5.6 Dependencies and compatibility

- **Axes** [I]:
  - `engine` (semver range);
  - `pckFormat` / type format version;
  - `contentApi` (an integer the app build declares, bumped when code expects a different content
    shape: new node types, renamed resources, changed save schema);
  - `features` (texture family, GPU tier);
  - `platform`/`arch`;
  - `locale`;
  - `packs` (dependencies with semver ranges);
  - `conflicts`.
- **Pinned vs ranged**:
  - _Code releases_ pin exact pack releases (lock). This is Steam's build = set of depot manifests
    and Addressables' catalog per player build.
  - _Live content channels_ publish packs with ranges. At publish, CI (or a Worker job) resolves one
    **PackSet** per `select` tuple that satisfies all constraints, and the Worker signs it in the
    content index. Resolution is deterministic: highest version satisfying all constraints, ties
    broken by `seq`.
  - Clients verify but don't solve.
- **Apple BA special case**: platform versions switch for all app builds, so `contentApi` must be
  encoded in the asset pack _identity_ (`foes.c3`). Resolution produces one Apple asset pack per
  supported `contentApi`.
- **Floors and yanks**: `floors` (minimum pack version per channel) and yanked releases resolve only
  by explicit pin, mirroring README §3.4 rules.
- **Atomic sets**: never mount a mixed set (E5 §6 pitfall 1). Activation swaps the whole set
  pointer; for restart-activated types the new set applies at next boot.

### 5.7 Storage layout and garbage collection

**Client** [I]:

- `user://pkey/store/<ab>/<sha256>.<ext>` for file payloads; `user://pkey/trees/<sha256>/…` for tree
  releases; `user://pkey/index/<sha256>` for verified files and chunk indexes (the seed indexes);
  `user://pkey/staging/<planId>/` for work in progress; `user://pkey/content/state.json` as the
  pointer.
- **No separate chunk cache.** Reusable chunks are read from installed payloads at known offsets
  (Riot and desync "seed"), so disk use stays about 1× plus staging.
- **GC roots**: active set, previous set, in-flight plan, user-pinned offline packs, and
  platform-owned packs (never delete BA/PAD/Steam files ourselves; use the platform's remove API,
  e.g. `AssetPackManager.remove`).
- Sweep after a **confirmed boot** of the new set (README §5.7).

**Server** [I]:

- Objects are referenced by releases (`content_object_refs`). An object is collectable when no
  release at or above the channel floors (`min_supported`) and no pinned code release references it,
  plus a grace period.
- R2 bucket locks (E5 §4.3) enforce a minimum age.
- **Bundle repacking**: when a bundle's live-chunk ratio drops below about 50%, rewrite the live
  chunks into a new bundle for the _next_ release and let the old bundle age out. This is
  Blizzard's "convert still-used files to loose so the archive can be purged", in bundle form.
- Deltas are disposable caches: delete anything outside the hot-pair policy.

### 5.8 Signing and trust

- **Unchanged backbone** (README §3.3): CI-signed immutable records plus Worker-signed freshness.
  - Pack releases are CI-signed with the **release key**, or a delegated **content key** scoped to
    data-only types (TUF-style delegation: the release key signs a delegation `{keyid, packIdPrefix, types:["files.tree","l10n.table",…], dataOnly:true}`).
    That lets a content team publish without code-release power. `godot.pck` packs that could carry
    scripts always need the release key.
  - Content channel indexes are Worker-signed (freshness, rollout, halts, availability).
- **What a compromise buys**: a compromised Worker can only choose among CI-signed pack releases. A
  compromised CDN can only withhold (every chunk and file is SHA-256-pinned by a signed index). Keep
  the invariant "clients verify the final payload SHA-256 against the signed release" even after
  chunk verification: it also catches planner bugs.
- **Hashes**: full SHA-256 everywhere (not RMAN's 64-bit, TACT's MD5, Steam/Epic SHA-1 or Godot's
  MD5 directory hashes).
- **Deltas and bundles** need no signature (E5 §3.2). A bad artifact fails the verification of what
  it produces, then the client falls back.
- **Platform-delivered packs** carry the marker `.pkey/pack.json` with a detached JWS. The client
  verifies the marker, then hashes files against the files index. For Apple BA use memory-mapped
  reads; hash lazily at first use for big packs, but always before `load_resource_pack`.
- **Entitlement**: gated packs are minted per request (README §3.5, E5 §4.4). Chunk bundles of
  gated packs must live under a gated prefix too, and **do not share bundles between gated and free
  packs**, since a shared bundle leaks content by Range.

### 5.9 Apply pipeline (per plan)

1. **Preflight**: verify content index → pack release (by hash) → indexes (by hash). Check type,
   format and compat. Check `freeDiskBytes ≥ peakDisk` and memory against the route.
2. **Journal**: write `staging/<planId>/journal.json` with the route, target hashes, and a
   per-chunk or per-file completion bitmap.
3. **Fetch and copy**: copy reusable ranges from seeds, verifying each chunk. Fetch missing runs by
   Range with `If-Range: "<bundle sha>"`. Decompress per chunk (`decompress(len, ZSTD)`), verify the
   ID and write at the target offset (pre-allocated `.part`). Checkpoint the journal every N MiB.
4. **Verify**: per-file SHA-256, payload SHA-256, and type verification (PCK header, data-only
   list).
5. **Commit**: rename `.part` → `store/<sha>` (same volume), then write the new `state.json` by
   temp + rename. Restart-activated types take effect next boot; hot types activate now.
6. **Confirm**: after the next successful boot (restart types) or smoke check (hot types), mark
   confirmed and GC. On a crash loop (N failed boots), roll back to `previous`.
7. **Resume**: on relaunch, the journal says what's done. Re-verify completed ranges cheaply
   (hash), then continue. Idempotent by construction.

### 5.10 Pitfalls checklist

- **Compressed containers**: forbid whole-pack compression in CI for chunkable types; lint zips for
  deflate and prefer stored entries or tree delivery (§2.4).
- **Determinism**: build once and store by hash. Record the chunker version and parameters in the
  index, and never re-chunk old releases with new parameters (it breaks dedupe but not
  correctness). Godot delta patches must be generated against the stored base bytes, never a
  re-export.
- **Offset cascades in fixed-block transports** (Steam 1 MB, MSIX 64 KB): for packs shipped through
  those, consider aligning PCK entries (`PCKPacker` alignment, UE's 1 MiB padding advice) and keep
  pack files ≤ 1–2 GB.
- **Partial installs**: journaled staging; never write into the active payload; payload SHA-256
  before commit; platform packs may be mid-patch (PAD's "Update in progress").
- **Disk space**: staging needs about +1× the changed payload (Steam builds alongside; PAD
  install-time needs 2×). Check with `DirAccess.get_space_left()` before planning. Offer in-place
  replacement only with consent (it loses rollback).
- **Memory**: zstd patch-from and Godot's `FileAccessPatched` hold whole files in RAM, so cap by
  `memBudgetBytes`. The chunk route streams in O(chunk) memory.
- **Mobile background limits**: GDScript `HTTPRequest` pauses with the app. Long downloads need a
  platform path (BA; iOS background `URLSession`; Android WorkManager / user-initiated data transfer
  jobs [S]) or foreground UX with pause and resume (README §5.7).
- **Web storage**: quotas and all-or-nothing eviction (Safari 7-day rule). `Cache.put` rejects 206,
  so write into OPFS or IndexedDB. Request `persist()` after engagement. Re-plan from scratch when
  the DB is empty.
- **Platform version skew**: Apple BA switches all app versions (encode `contentApi` in the ID);
  PAD needs a new versionCode; Steam branches pin builds. Keep `availability` per outlet so
  `Content.ensure()` can say "not yet live on this outlet".
- **Request explosion**: 64 KiB chunks mean thousands of objects. Bundling plus contiguous runs keep
  requests near "changed regions + a few". Watch R2 Class B cost on cache misses and prefer the
  cached custom-domain path for public bundles.
- **Engine specifics**: no PCK unload, Android `load_resource_pack` stall, `uid://` into packs
  unsupported, newer-engine PCK rejected (README §5.7, §3.3 here).
- **Hash truncation and weak hashes**: never inherit MD5, SHA-1 or 64-bit IDs from the formats you
  wrap.
- **Gated-content leakage**: separate bundles per entitlement class; `private, no-store` or tokenised
  cache keys (E5 §4.4).

### 5.11 Phasing and wire impact

| Phase  | Ships                                                                                                                                                                                                                         | Wire / corpus impact (plan-mode change, see README §3.3)                                                                                                                                                                                           |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **v1** | README §3.7 as designed (single-file packs, full + one zstd N−1 delta for native SDKs), plus: type registry with `godot.pck` only, `content_bindings`, install-state DB, marker file in platform packs                        | `pkey-release+jws` carries pack releases inline (option (a)); corpus `packReleaseCases`, marker-file vectors                                                                                                                                       |
| **v2** | `pkey-chunks/1` + bundles on R2; chunk-sync from seed indexes (pure GDScript); `pkey-content+jws` content channels with resolved PackSets; server GC and bundle repacking; `godot-delta-pck` fallback                         | new `typ` `pkey-content+jws` (+ `pkey-pack+jws` if pack releases are detached); corpus `contentIndexCases`, `chunkIndexCases` (binary parse), `plan-matrix.json`, `applyCases` (tampered chunk, wrong base, truncated bundle); all six SDKs follow |
| **v3** | `files.tree`, `archive.*`, `audio.bank`, `l10n.table`, `ml.model`, `unity.addressables` handlers; lazy delta generation for hot pairs (R2 events → Queue → Workflow → Container, E5 §3.2); CDT on web; content-key delegation | delegation record type; per-type verify vectors                                                                                                                                                                                                    |

---

## 6. Open questions to verify before building

1. Apple BA: are pack updates differential in practice? Measure with two versions in TestFlight
   (Settings storage deltas, network logs). Can `contents(at:)` read `.pkey/pack.json` before
   `ensureLocalAvailability` returns for prefetch packs?
2. Cloudflare: does "Origin Range Requests" apply to R2 custom-domain objects on our plan? Measure
   cold-miss behaviour for 8 MiB bundles, and multi-range support end to end.
3. Godot: does `PackedByteArray.decompress(len, COMPRESSION_ZSTD)` accept frames from `zstd -19`
   with our window (Godot sets a `windowLogMax` project setting)? What does it cost at 64 KiB?
   Benchmark GDScript SHA-256 throughput on low-end Android for verifying 50–500 MB packs.
4. Godot: a delta patch PCK mounted over a PCK that was _chunk-reconstructed_ (byte-identical, so it
   should work) is untested. Measure load-time overhead at stack depth 1 and 2 on mobile.
5. Steam: confirm the exact Steamworks calls for installed depot manifests and whether depot
   manifest GIDs are observable client-side, or rely on marker files only.
6. Chunking parameters on real Diceroll PCKs across 5–10 historical builds: 32/64/128 KiB averages
   vs zstd patch-from sizes (CAVS `analyze godot-pck` and `bench` can serve as an independent
   baseline).
7. Unity `unity.addressables`: whether a custom `IResourceProvider` plus Polaris-signed catalog can
   enforce verification before bundle load, and the LZ4 vs LZMA implications for chunk-sync.

---

## 7. Sources

Launchers:

- Riot, "Supercharging Data Delivery: The New League Patcher" (2019-07-30):
  https://www.riotgames.com/en/news/supercharging-data-delivery-new-league-patcher
- moonshadow565/rman (RMAN/RBUN tools; `lib/rlib/rmanifest.cpp`, `rchunk.hpp`, `rbundle.hpp`,
  `rcdn.cpp`): https://github.com/moonshadow565/rman ; crates https://docs.rs/crate/rman/latest ,
  https://docs.rs/cdragon-rman
- wowdev wiki TACT https://wowdev.wiki/TACT and BLTE https://wowdev.wiki/BLTE
- legendary (Epic manifest/chunk parsers):
  https://github.com/derrod/legendary/blob/master/legendary/models/manifest.py ,
  https://github.com/derrod/legendary/blob/master/legendary/models/chunk.py ,
  https://github.com/derrod/legendary/blob/master/legendary/core.py
- Epic BuildPatch Tool 1.7.0:
  https://dev.epicgames.com/docs/epic-games-store/publishing-tools/uploading-binaries/bpt-instructions-170 ;
  interface https://dev.epicgames.com/docs/epic-games-store/publishing-tools/uploading-binaries/buildpatch-tool-interface ;
  API `OptimiseChunkDelta`
  https://dev.epicgames.com/documentation/unreal-engine/API/Runtime/BuildPatchServices/IBuildPatchServicesModule/OptimiseChunkDelta
- Fortnite IoStoreOnDemand player-support pages (e.g.
  https://www.epicgames.com/help/fortnite-battle-royale-c-202300000001636/gameplay-c-202300000001721/why-do-i-get-the-iostoreondemand-chunkmissingerror-error-when-trying-to-equip-certain-cosmetic-items-in-fortnite-a202300000081958 );
  `IOnDemandIoStore`
  https://dev.epicgames.com/documentation/unreal-engine/API/Runtime/IoStoreOnDemandCore/IOnDemandIoStore
- Steamworks "Uploading to Steam": https://partner.steamgames.com/doc/sdk/uploading ;
  content manifest protobuf https://github.com/SteamDatabase/Protobufs/blob/master/steam/content_manifest.proto ;
  SteamKit2 CDN client https://github.com/SteamRE/SteamKit/blob/master/SteamKit2/SteamKit2/Steam/CDN/Client.cs
  and `DepotChunk.cs`
- itch wharf spec https://itch.io/docs/wharf/ (diff: https://itch.io/docs/wharf/algorithms/diff.html ;
  apply: https://itch.io/docs/wharf/algorithms/apply.html ); `pwr.proto`
  https://github.com/itchio/wharf/blob/master/pwr/pwr.proto
- Roblox deployment manifests (community): https://github.com/CloneTrooper1019/Roblox-Client-Watch

Generic chunking:

- desync https://github.com/folbricht/desync (README, `docs/concepts.md`); casync
  https://github.com/systemd/casync
- zchunk https://github.com/zchunk/zchunk (README, `zchunk_format.txt`)
- bita https://github.com/oll3/bita
- OSTree formats https://ostreedev.github.io/ostree/formats/ ; `ostree sign`
  https://man.archlinux.org/man/ostree-sign.1.en
- zstd:chunked https://github.com/containers/storage/blob/main/docs/containers-storage-zstd-chunked.md ;
  format notes https://github.com/containers/zstd-chunked-rs/blob/main/docs/format.md ;
  containers/image PR https://github.com/containers/image/pull/1084
- Nix HTTP binary cache store settings https://nix.dev/manual/nix/2.28/store/types/http-binary-cache-store
- Hugging Face Xet deduplication https://huggingface.co/docs/hub/xet/deduplication
- FastCDC paper https://www.usenix.org/system/files/conference/atc16/atc16-paper-xia.pdf ;
  fastcdc-rs https://github.com/nlfiedler/fastcdc-rs
- CAVS forum post (2026-07-05)
  https://forum.godotengine.org/t/i-open-sourced-cavs-tiny-verified-updates-for-godot-pck-games/141254 ;
  repo https://github.com/orelvis15/cavs

Engines:

- Unity Addressables content update overview (2.8)
  https://docs.unity3d.com/Packages/com.unity.addressables@2.8/manual/content-update-builds-overview.html ;
  build artifacts (4.0)
  https://docs.unity3d.com/Packages/com.unity.addressables@4.0/manual/build-artifacts-included.html ;
  update settings (3.0)
  https://docs.unity3d.com/Packages/com.unity.addressables@3.0/manual/content-update-build-settings.html ;
  workflow (1.17) https://docs.unity3d.com/Packages/com.unity.addressables@1.17/manual/ContentUpdateWorkflow.html
- Unity CCD https://docs.unity.com/en-us/ccd/cli-walkthrough , https://docs.unity.com/en-us/ccd/dashboard ,
  https://docs.unity.com/en-us/ccd/faq
- Unreal patching https://dev.epicgames.com/documentation/en-us/unreal-engine/how-to-create-a-patch-in-unreal-engine ;
  ChunkDownloader https://docs.unrealengine.com/4.27/en-US/SharingAndReleasing/Patching/ChunkDownloader/Quickstart/ ;
  IoStore format https://github.com/gitMenv/UEcastoc/blob/master/utoc.go ,
  https://mjolnircore.com/docs/notes/iostore-packaging ; IoStore forum answer
  https://forums.unrealengine.com/t/external-pak-files-and-use-io-store-option/2137290 and
  https://forums.unrealengine.com/t/paking-cooked-assets-of-multiple-projects-into-a-single-pakfile-with-iostore/2643569
- Godot: delta patches PR https://github.com/godotengine/godot/pull/112011 ; sparse PCK PR
  https://github.com/godotengine/godot/pull/105984 ; source `core/io/file_access_patched.cpp`,
  `core/io/delta_encoding.cpp`, `core/io/file_access_pack.{h,cpp}`,
  `doc/classes/{ProjectSettings,PackedByteArray,HashingContext}.xml` at
  https://github.com/godotengine/godot ; docs
  https://docs.godotengine.org/en/latest/tutorials/export/exporting_pcks.html ,
  https://docs.godotengine.org/en/latest/classes/class_pckpacker.html

Platforms and web:

- Apple WWDC25 "Discover Apple-Hosted Background Assets" https://developer.apple.com/videos/play/wwdc2025/325/ ;
  ASC Help https://developer.apple.com/help/app-store-connect/manage-asset-packs/overview-of-apple-hosted-asset-packs ;
  ASC API https://developer.apple.com/documentation/appstoreconnectapi/managing-apple-hosted-background-assets ;
  unmanaged BA https://developer.apple.com/documentation/backgroundassets/configuring-an-unmanaged-background-assets-project ;
  Xcode 26.4 API diff https://github.com/dotnet/macios/wiki/BackgroundAssets-iOS-xcode26.4-b2
- Play Asset Delivery https://developer.android.com/guide/playcore/asset-delivery
- MSIX optional packages https://learn.microsoft.com/en-us/windows/msix/package/optional-packages ;
  block map https://learn.microsoft.com/en-us/uwp/schemas/blockmapschema/app-package-block-map ;
  differential updates blog https://learn.microsoft.com/en-us/archive/blogs/appinstaller/differential-updates-for-uwp-apps
- MDN storage quotas https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria ;
  Service Worker spec (Cache.put 206) https://w3c.github.io/ServiceWorker/
- Cloudflare cache Range behaviour https://developers.cloudflare.com/cache/reference/range-requests/ ;
  R2 Workers API ranged reads https://developers.cloudflare.com/r2/api/workers/workers-api-reference/
