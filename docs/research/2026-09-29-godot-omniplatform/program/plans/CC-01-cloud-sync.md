# Plan: Cloud Sync, actually built (records, files, multipart, delta, E2E) — 2026-10-24

> **Edited 2026-10-26 (L.0, plan-combined.md §6).** Approved by the owner on 2026-10-26 with the combined program. One cipher, AES-256-GCM (R-1); nearby approval and its code are R-2 and R-3; wraps travel in `KEYRING_WRAP`, mode `v` only (R-9); lifecycle subscription (R-7); wire amendments go into V5 §13 (R-8).

Planner for `plan-cloud-sync.md` in `linking-sync-contract.md` ("Planner split"). Scope: feature 3,
the "Cloud Sync files" positions, P-3 (the account key ring, in Core), and E2E versus
server-readable. Honours O-1 (E2E by default, opt-in server-readable), O-2 (tier quotas, hard caps,
Polaris Key's Cloudflare) and L-13 (key ring in Core; Cloud Sync E2E never needs Cloud Connect).
Read against staging `integ/next-stage` @`b03b279ce` (read-only). Line numbers are that commit's.

## 0. What exists, and corrections

**Status of U-05 (bookkeeping drift).** `workpackages.json:5532` says `todo`. The fact:

- All 22 slices are merged: U-05.1 `d2ee55c95` … U-05.17 `8219de72a` … U-05.22 `99ea8941a`
  (`git log --grep U-05`). They are on `origin/main` and in tag **v0.9.17** (2026-10-24 14:28),
  not in v0.9.16.
- `_lead/plans/U-05-slices.md:391` says: "`--set U-05 in-review` after .21 … U-19 then reviews
  before production."
- Two acceptance items are still open: the staging load-test summary (owner steps §8r item 3) and
  U-19.
- **U-05 should be `in-review`, not `done`.** U-19 is now overdue: the brief's "before any
  production deploy" (`wp/U-05:96`) was passed when v0.9.17 shipped. The mitigation that holds
  today is that every product has Cloud Sync off (owner steps §8r item 4). The lead confirms
  this read-only in production: no product has `sync` enabled, and `sync_directory` has 0 rows.
  It stays that way until U-19 passes.

Corrections to the survey, the briefs and U-01b (the code is the fact):

| #   | Claim                                                                                            | Fact                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | `ociUpload.ts` exports `createMultipartUpload`, `resumeMultipartUpload`, `uploadPart` (:325-412) | Its exports are `startUpload` :125, `readUpload` :151, `appendChunk` :292, `completeUpload` :365, `discardUpload` :405 and `uploadRange` :422. The R2 calls are inside `appendChunk` (:325-331). It is a **sequential** append with an etag-guarded state object in R2 (`staging/<owner>/oci-upload-<uuid>/state`, :30). Sync reuses its part rule (5 MiB min, 10,000 parts, :48-54) and `ByteSource` (:205), not its state store.                                            |
| C2  | `landUpload` verifies the upload, so files can use it                                            | `landUpload` (`core/assets/blobs.ts:513`) lands bytes at the **global** key `blobKey(sha256)` (:532) and deduplicates across tenants (`alreadyStored`). Per-person sync data must not use it, because of T1, T15 and the existence oracle. Reusable: `streamSha256` :191, `putVerified`'s R2 `sha256` put option :244, and `verifyStaged`'s streamed path :337.                                                                                                               |
| C3  | Bucket `SYNC_FILES` or `SYNC_SAVES`                                                              | `wp/U-10:12` says `SYNC_FILES`, but its 2026-10-05 amendment (`wp/U-10:19`) says `SYNC_SAVES`. U-01b.md:169 replaced `SYNC_SAVES` with `SYNC_FILES`. Neither is bound in `wrangler.toml` (only `BLOBS`, :206-208). The buckets are not created (owner steps §8g item 1). **Use `SYNC_FILES` only.**                                                                                                                                                                           |
| C4  | U-10: "multipart only above 100 MB"                                                              | Superseded (§1.2): single `PUT` up to 16 MiB, multipart above it. 100 MB is the zone's body limit, which bounds one request, not the choice of mode.                                                                                                                                                                                                                                                                                                                          |
| C5  | THREAT-MODEL rows T17 (open settings) and T19 (field policies) exist (U-01b §6.4)                | T17 landed as "a push cannot recreate erased data" (`THREAT-MODEL.md:8394`). The open-settings row never landed: the file has no "open setting" text. T19 is not written. T9 is "hostile JSON" for the push (:8369), and S-17's T9 "no public URLs" (`notes/S-17:1743`) is not yet applied to files. **New rows start at T20** (§4.4).                                                                                                                                        |
| C6  | PRIVACY.md:284 "the last device `platform` family"                                               | Since `dc7122f8c` the directory stores the device's own platform from a closed set, not the family. U-12 fixes the row.                                                                                                                                                                                                                                                                                                                                                       |
| C7  | Discovery is final                                                                               | `services/sync/index.ts:68-74` answers `settings: true` with no `encryption` member, so an SDK written against today's wire would push plaintext. No released SDK syncs (every `sync.*` parity row is `planned`), so no client in the field is affected.                                                                                                                                                                                                                      |
| C8  | CORS is ready                                                                                    | `CORS_ALLOW_METHODS` = `"GET, POST, PATCH, DELETE"` (`core/cors.ts:47`), with no `PUT`. `CORS_ALLOW_HEADERS` (:55-68) lacks `Content-Digest`.                                                                                                                                                                                                                                                                                                                                 |
| C9  | One `MAX_CHUNK_BYTES`                                                                            | There are two: `protocol/core.ts:58` (4 MiB, a pack chunk) and `ociUpload.ts:51` (100 MB, a request). New sync numbers are all `SYNC_*`.                                                                                                                                                                                                                                                                                                                                      |
| C10 | SDKs can chunk                                                                                   | The only chunker is the CLI's in-memory `fastcdc(buf, avg)` (`cli/src/packChunks.ts:110`; `fastcdc-2016-nc1`, min = avg/4, max = avg × 4). Every SDK applies chunks; none cuts them.                                                                                                                                                                                                                                                                                          |
| C11 | `pkey-patch/1` fits user files                                                                   | It describes a `files`-scope delta set over a tree (`client-core/src/packs/patch.ts:1`), built by CI from two plaintext releases. It cannot run on E2E ciphertext and does not apply to one file. Delta here is content-defined chunking (§1.3). Reused: the `pkey-chunks/1` binary conventions (LE, 64-byte header, 48-byte records, the u64 rule; `plans/P4-10.md` §2.3) and client-core's `ByteSource`/`ByteSink`/`Sha256Port`/`ZstdPort` and `chunkApply` resume journal. |
| C12 | Catalog migrations are mode-free                                                                 | `CloudSyncMigration.mapValues` (`shared-catalog/src/types.ts:176-183`) is a server-side value rewrite, which cannot run on ciphertext. Renames and drops act on declared names in clear and still work.                                                                                                                                                                                                                                                                       |
| C13 | U-09 and U-10 goals                                                                              | Their Goal text still says `ownerRead`/`server` access, `requiresFlag` and "unlicensed saves limits". These are superseded by U-01b D5–D7 (owner access only, the entitlement quota, `files: false`).                                                                                                                                                                                                                                                                         |
| C14 | DO schema                                                                                        | `sqlStore.ts:31` `SCHEMA_VERSION = 2`. U-09 takes v3, U-10 v4, U-37 v5.                                                                                                                                                                                                                                                                                                                                                                                                       |

## 1. Architecture

### 1.1 Stores and modes

- **The stores are unchanged:** settings (U-05, built) and records in declared collections, each
  of which may carry one file (U-09, U-10). There is still one `CloudSyncDO` per (product, pairwise
  subject).
- **The mode is per product**, set by the catalog's `cloudSync.encryption`:
  - `"e2e"` (default): the server stores and orders ciphertext;
  - `"server"`: today's U-05 wire, with server-side validation, merge and console values.
- **What the server sees in E2E mode:**
  - declared names in clear (catalog setting keys, collection names);
  - sizes, versions, HLCs, timestamps, policies, ciphertext SHA-256s, chunk counts and
    `kid`s;
  - every person-chosen name only blinded (open-setting keys, record ids, member and field names,
    union elements);
  - every value only as ciphertext.
- **Records and saves (U-09).** In E2E mode a record value is a sealed envelope (§2.6) and its
  `id` is blinded. The saves template's metadata (`playtime`, `progress`, `chapter`, `thumbnail`)
  is inside the envelope. The record's file pointer (version, size, ciphertext SHA-256, format)
  is server metadata.

### 1.2 Files (U-10): small, large, resumable

| Mode        | When                                                     | Bytes                                                                                                                                                                                                                                                                                            | Verified                                                                                                                                                 |
| ----------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `single`    | whole file ≤ `SYNC_SINGLE_PUT_MAX_BYTES` (16 MiB)        | one `PUT`, streamed to `u/<p>/<s>/o/<uploadId>` with R2's `sha256` option and `If-None-Match: *`                                                                                                                                                                                                 | by R2 at the `PUT` (a mismatch writes nothing)                                                                                                           |
| `multipart` | whole file > 16 MiB (≤ 1 GiB)                            | R2 multipart at `u/<p>/<s>/o/<uploadId>`. Parts are `partBytes` each: `max(8 MiB, ⌈size/9,999⌉ rounded up to 1 MiB)`, ≤ 64 MiB; the last part is shorter. Parts go in **any order and in parallel** (≤ 4 at a time). The state lives in the person's DO (`uploads`, `upload_parts`), never in R2 | each part's `Content-Digest` through a tee into `DigestStream`; at finalize, the whole object streamed through `streamSha256` (about 1 s of CPU per GiB) |
| `chunks`    | a collection with `files.delta: true` and a file ≥ 1 MiB | content-defined chunks (§1.3); only the chunks the person lacks are uploaded                                                                                                                                                                                                                     | each chunk by R2's `sha256` option; finalize checks that every declared chunk exists with its size                                                       |

- **Resume.** `GET …/upload/{uploadId}` answers `received` (part numbers) or `missing` (chunk ids).
  An upload lives `SYNC_UPLOAD_TTL_SECONDS` (86,400 s), and its quota reservation with it.
- **Expiry.** An expired upload is aborted by the DO alarm, which deletes the orphan object. An R2
  lifecycle rule aborts incomplete multipart uploads after a day (owner, §8).
- **The SHA-256 is of what is stored.** In E2E mode that is ciphertext; the server never sees a
  plaintext hash.
- **Downloads** go through the Worker, never a public or presigned URL (T9). The response is
  `application/octet-stream` with `Content-Disposition: attachment`, `nosniff`, `Range`/`206` and
  `ETag "<sha256>"`.

### 1.3 Patched (delta) files: `pkey-sync-cdc/1`

- **Chunker.** Cuts follow `fastcdc-2016-nc1` (the gear table of `packChunks.ts`, seeded
  `0x9e3779b9`) with avg 256 KiB, min 64 KiB and max 1 MiB, over the whole plaintext. It is a
  streaming port: cut points match the CLI's. Up to 16,384 chunks per file
  (`SYNC_MAX_CHUNKS_PER_FILE`, so 1 GiB at the minimum chunk size).
- **Chunk id = keyed hash:** `hex(HMAC-SHA256(K_cid(c), plainChunk))`.
  - Dedupe is per person and per collection, and never across people, because keys differ.
  - The server learns only which chunks repeat within one person's collection (T24).
  - In server mode the id is the plain SHA-256.
- **Chunk object** (`pkey-sync-chunk/1`): `0x01 ‖ codec ‖ AES-256-GCM(K_chunk, 0¹², aad=0x01‖codec‖id, body)`.
  - `K_chunk = HKDF(K_coll(c), salt=id, "pkey-sync/1 chunk")`, so each key is used for one
    plaintext only. Encryption is deterministic: the same chunk always gives the same bytes, which
    is what dedupe needs.
  - `codec`: 0 is raw and 1 is one zstd frame. Writers may compress; readers must decode (every
    SDK already decodes zstd for packs).
  - Chunk objects are create-only. Because the object describes itself, the reader takes its stored
    length from the object.
- **The file is its manifest**, `pkey-sync-chunks/1`, sealed as a `pkey-sync-file/1` stream:
  - a 64-byte LE header: `PKSYNCCH`, `version` u16 1, `recordSize` u16 48, `flags` u32 0,
    `chunkCount` u32, reserved u32, `plainSize` u64 (the u64 rule), `plainSha256`;
  - records `id[32] | plainLen u32 | flags u32 | reserved u64`, in file order.
- **What a new version costs.** The upload carries the changed chunks and the manifest; the
  download fetches only chunks missing from the local cache. Both directions are deltas.

### 1.4 The E2E key hierarchy (P-3; all HKDF-SHA256, RFC 5869)

```
R        root, 32 random bytes; ringId rg_<22 b64url>, epoch ≥ 1; one ring per (product, subject)
kid      = HKDF(R, ∅, "pkey-sync/1 kid", 16)                    (in every envelope header, in clear)
K_coll(c)= HKDF(R, ∅, "pkey-sync/1 coll\0" ‖ c, 32)             c = "$settings" or the concrete collection name
K_names  = HKDF(R, ∅, "pkey-sync/1 names", 32)                  blind(kind, ctx, n) = "x:" ‖ b64url(HMAC(K_names, kind‖0‖ctx‖0‖n))
K_cid(c) = HKDF(R, ∅, "pkey-sync/1 chunk-id\0" ‖ c, 32)
K_msg    = HKDF(K_coll(c), salt16, "pkey-sync/1 value", 32)     one per value (fresh 16-byte salt; zero nonce)
K_file   = HKDF(K_coll(c), salt32, "pkey-sync/1 file", 32)      one per file version (the "per-file key")
K_chunk  = HKDF(K_coll(c), chunkId, "pkey-sync/1 chunk", 32)
K_rec    = HKDF(code16, ringId, "pkey-sync/1 recovery", 32)
K_adopt  = HKDF(R, ∅, "pkey-sync/1 adopt", 32)                  wraps a foreign root after an account merge
```

- **One AEAD everywhere: AES-256-GCM.** It is native in WebCrypto, CryptoKit, JCA/Tink,
  node:crypto and Python's `cryptography`. Godot uses the native lanes (§3).
  - Per-message key derivation removes the nonce-reuse and message-count limits.
  - `blind` kinds are `setting`, `member`, `record`, `field` and `element`.
- **Wrap to a device** (`pkey-sync-wrap/1`): RFC 9180 HPKE `mode_base`, KEM 0x0020 (X25519), KDF
  0x0001, AEAD 0x0002 (AES-256-GCM).
  - `info = "pkey-sync/1 wrap\0" ‖ product ‖ 0 ‖ deviceId ‖ 0 ‖ ringId ‖ 0 ‖ u32be(epoch)`,
    `aad = kid`, `pt = R`.
  - The wrap carries `kem`, so a P-256 agreement key from P-1 changes one field (§10).
  - A device accepts a root only when `kid(R)` equals the ring's `rootKid`. Once it holds a root
    for (ringId, epoch), it never replaces it.
- **No `K_disc` from R** (L-13: the server delivers K_disc).

### 1.5 Recovery

- **Platform key backup**, on by default, with a developer opt-out (Q3): `R` is stored in a
  synchronizable item (§3).
  - Apple: an iCloud Keychain item, `kSecAttrSynchronizable`, service `pkey-sync:<product>`,
    account `<subject>:<ringId>`.
  - Android: Block Store, `setShouldBackupToCloud(true)` only when
    `isEndToEndEncryptionAvailable()`.
  - A new Apple device restores silently. An Android device restores at setup or restore. A sign-out on one device keeps this root backup item: deleting a synchronizable keychain item deletes it on every device of that Apple ID (R-11). Only Reset encryption, Start over or account deletion removes it.
- **Recovery code.** 16 random bytes and a 4-byte SHA-256 checksum make 32 Crockford-base32
  characters, shown as 8 groups of 4. The parser ignores case, spaces and hyphens, and maps I/L→1
  and O→0.
  - The server keeps `recoveryWrap = 0x01 ‖ n12 ‖ AES-GCM(K_rec, n, aad="pkey-sync/1 recovery"‖ringId‖u32be(epoch)‖kid, R)`.
  - 128 bits cannot be brute-forced, so the server learns nothing.
  - There is **one code per app**, because L-7 rules out a cross-product ring (Q2).
  - Fetching the wrap is rate-limited (5 a day per device), audited and emailed: "Recovery
    started on <device label>".
- **Nearby approval.** A signed-in device that holds R wraps it to the new device's agreement key,
  over the nearby channel (`KEYRING_WRAP`, 0x0030, mode `v` only, R-9) and PUTs the same wrap
  to `/devices/keyring/wraps/{D}`. M wraps to the agreeKey from the authenticated `VOUCH_REQ`. The
  code both screens show is R-3's commit-reveal channel code, not one derived from the agreeKey.
  There is no wrap path without the channel (T21), and **no remote approval in v1** (Q2 of the
  combined plan; was Q1). In v1 a browser unlocks only with the recovery code.
- **Start over** makes a new ring. The old ring is kept read-only for 30 days, and a device that
  still holds the old root can `adopt` it. After that the server deletes rows whose `kid` belongs
  to the abandoned ring. It is audited and emailed.
- **No automatic rotation in v1** (Q4). A removed device loses its wrap and its token, so it
  cannot fetch new ciphertext. "Reset encryption" (a new epoch and a new code) is a manual kit
  action after a device is lost.

### 1.6 Policies that need plaintext, in E2E mode

| Policy       | E2E behaviour                                                                                                                                                                                                                                                                                                                                     |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lastWrite`  | Server, unchanged: HLC order over ciphertext                                                                                                                                                                                                                                                                                                      |
| `merge`      | **Server**, per-member (or per-field) LWW on **blinded** member names, each member a sealed value. No plaintext is needed, so there is no client loop. This challenges the lead position "merge runs client-side", with the evidence that member LWW compares HLCs, not values (`engine/settings.ts:10`: "each member is its own lastWrite cell") |
| `union`      | Server OR-set on blinded element ids (`blind("element", c, canonicalJson(e))`)                                                                                                                                                                                                                                                                    |
| `revision`   | Server CAS, unchanged; it prompts (U-08)                                                                                                                                                                                                                                                                                                          |
| `max`, `min` | **Client.** The server keeps a CAS register: `set` carries `baseVersion`. On `conflict` the client opens the server copy, keeps the better value and re-pushes on the server's version with `origin: "merge"`. It never prompts. This amends U-01b R4 rule 1 ("the client never merges") for E2E only                                             |
| schema       | Client: `bad_request` on write, `invalid` on read (already in the machine, §11.5)                                                                                                                                                                                                                                                                 |
| `mapValues`  | Refused by the validator for an E2E catalog (§2.8)                                                                                                                                                                                                                                                                                                |
| budgets      | Charged on `envelopeBytes − SYNC_E2E_OVERHEAD_BYTES` (113: 49 bytes of envelope and at most 64 of padding), so the 256-key / 64 KiB / 8 KiB promises keep their meaning. The quota charges the full stored bytes                                                                                                                                  |

### 1.7 Quotas and hard caps (O-2)

"Product tier" is read as the product's own tiers: `pkey.cloudSync.bytes` per tier is the included
quota (Q6). Every limit below is a hard cap; none deletes data.

| Cap                                                             | Value                                                   | Where                                                  |
| --------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------ |
| Per person (all stores, revisions and uncommitted reservations) | the tier's `pkey.cloudSync.bytes`, clamped to ~1.06 GiB | `syncAccess`, `CLOUD_SYNC_CEILINGS.perPerson` (exists) |
| Per file                                                        | collection `files.maxBytes`, ≤ 1 GiB (default 32 MiB)   | exists                                                 |
| Per product                                                     | `cloudSync.ceiling.bytes` (50 GiB) and 100,000 people   | exists                                                 |
| No licence                                                      | 1 MiB, files refused                                    | exists                                                 |
| Open uploads per person                                         | 4 (`SYNC_MAX_OPEN_UPLOADS`)                             | new                                                    |
| File transfers per device                                       | 30 an hour (`begin` and whole-file `GET`)               | exists (`fileTransfersPerHour`)                        |
| Part and chunk requests per device                              | 600 a minute (`SYNC_CHUNK_REQUESTS_PER_MINUTE`)         | new                                                    |
| Chunks per file; part size                                      | 16,384; 8–64 MiB                                        | new                                                    |

`begin` (or the chunk plan) reserves bytes, `finalize` charges what was stored, and expiry releases
the reservation. The directory's `revision_bytes` counts kept versions.

### 1.8 Garbage collection and crypto-shredding

- **DO alarm.** It removes:
  - expired uploads (it aborts the multipart upload and deletes the object);
  - versions past `keepRevisions`;
  - chunks whose reference count has been 0 for an hour and that no open upload declares;
  - after 30 days, rows of an abandoned ring.
- **Erasure (person, product, account).** The DO deletes every R2 key it lists, in batches of
  1,000, then sweeps the prefixes `u/<p>/<s>/`. After an account merge that includes the absorbed
  subject's prefix: the DO keeps full keys, and the merge marker names that subject. Then
  `deleteAll`, then the key-ring rows.
- **E2E shredding.** Deleting the ring rows and the recovery wrap removes the last key material
  on the server. A device drops its local root on `account_required` after a deletion.
- **Server-mode shredding.** Files use R2 SSE-C (`ssecKey`) with a random per-principal key kept
  in the DO, so `deleteAll` shreds every R2 copy. U-10.1 first confirms that the binding and the
  multipart path accept `ssecKey`. If they do not, the fallback is to stream the bytes through
  `pkey-sync-file/1` sealed by that key.

## 2. Wire

### 2.1 Signed documents and counters

- **Nothing is signed by Sync.** There is no new `typ`, claim, header or signed shape of Sync's own. Version 5 belongs to Connect (CC-04.1, R-8); Sync adds no signed shape. `PROTOCOL_VERSION` is 5 after CC-04.1, `corpusVersion` 2, `DISCOVERY_VERSION` 2,
  `transcriptVersion` 1 and `CACHE_VERSION` 3.
- **Two client-table counters move:** `syncScenariosVersion` 2 → **3** (Q10), and the new
  `syncVectorsVersion` **1**.
- **WIRE-CONTRACT-V5.md §13** carries the amendments, written by U-33.1 after CC-04.1 (V5 restates V4; the section numbers below are V5's):
  - §13.2: new routes;
  - §13.3 and §13.4: E2E push and pull;
  - §13.8: rewritten for files;
  - new §13.10 (E2E) and §13.11 (key ring);
  - §13.9: new error codes;
  - §8: identifiers (`ringId`, `kid`, blinded `x:`, `uploadId`, chunk id, the Keychain service
    `pkey-sync:<product>`);
  - §9: the counters;
  - §11.5: the machine (locked, the encryption pin, the client policy).

### 2.2 Routes (service `sync`, device bearer, `cors: true`, all `no-store`)

| Route                                               | Body → answer                                                                                                                                                                                                                                                                                                                                                                | WP   |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| `POST /<p>/sync/files/{collection}/{id}/begin`      | `{size, sha256, format: "whole"\|"chunks", enc: "e2e"\|"none", baseVersion}` → `200 {uploadId, mode: "single"\|"multipart"\|"chunks", partBytes?, expiresAt}`. Refusals: `409 revision_conflict {server:{version}}`, `403 quota_exceeded {scope}`, `403 entitlement_required`, `413 file_too_large`, `400 encryption_mismatch`, `400 collection_unknown`, `429 rate_limited` | U-10 |
| `PUT …/{id}/upload/{uploadId}`                      | single: the bytes, with `Content-Length` and `Content-Digest: sha-256=:…:` → `204`. A digest or size mismatch is `400 upload_mismatch`; an expired upload is `410 upload_expired`                                                                                                                                                                                            | U-10 |
| `PUT …/{id}/upload/{uploadId}/parts/{n}`            | multipart part `n` (1…), exactly `partBytes` except the last, with `Content-Digest` → `204`. Resending a part replaces it                                                                                                                                                                                                                                                    | U-10 |
| `GET …/{id}/upload/{uploadId}`                      | → `{mode, size, partBytes?, received: [n…]?, missing: [chunkId…]?, expiresAt}`                                                                                                                                                                                                                                                                                               | U-10 |
| `DELETE …/{id}/upload/{uploadId}`                   | → `204` (aborts the upload and releases its reservation)                                                                                                                                                                                                                                                                                                                     | U-10 |
| `POST …/{id}/upload/{uploadId}/chunks`              | `{chunks: [[chunkId, storedBytes]…]}` (≤ 1,024 per call, accumulated in the DO) → `{missing: [chunkId…], present: [[chunkId, storedBytes]…]}`; reserves the missing bytes                                                                                                                                                                                                    | U-37 |
| `PUT …/{id}/upload/{uploadId}/chunks/{chunkId}`     | one chunk object with `Content-Digest`, create-only → `204`                                                                                                                                                                                                                                                                                                                  | U-37 |
| `POST …/{id}/finalize`                              | `{uploadId}` → `200 {version, size, sha256, format}`. Idempotent per `uploadId`. Refusals: `409 upload_incomplete {missing}`, `400 upload_mismatch` (the streamed check), `409 revision_conflict`, `410 upload_expired`                                                                                                                                                      | U-10 |
| `GET /<p>/sync/files/{collection}/{id}[?version=]`  | the stored file (whole ciphertext or the manifest), with `Range`/`206`, `ETag`, `Repr-Digest` and `attachment`                                                                                                                                                                                                                                                               | U-10 |
| `GET /<p>/sync/files/{collection}/{id}/revisions`   | → `{revisions: [{version, size, sha256, format, createdAt}]}`                                                                                                                                                                                                                                                                                                                | U-10 |
| `GET /<p>/sync/files/{collection}/chunks/{chunkId}` | one chunk object, only when the person's DO lists it for that collection                                                                                                                                                                                                                                                                                                     | U-37 |

Deleting a file is still its record's `delete` op. `{id}` is the blinded record id in E2E mode.

**Core key ring** (`publicRoutes.ts` `CORE_ROUTES`, kind `keyring`, device bearer, `cors: true`).
It answers `404` unless a contributed `keyring` hook says a service needs a ring for the product.
Cloud Sync answers true when it is on and in E2E mode; Cloud Connect may contribute later.

| Route                                       | Body → answer                                                                                                                                                                                                  |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /<p>/devices/keyring`                  | → `{ring: null \| {ringId, epoch, rootKid, state, createdAt, recovery: {set, createdAt}, adopted: [{ringId, epoch, kid, ct}], previous?: {ringId, kid, until}}, wrap: null \| {epoch, kid, kem, enc, ct, by}}` |
| `POST /<p>/devices/keyring`                 | create: `{ringId, rootKid, wrap: {kem, enc, ct}, recovery?: {ct}}` → `201`; `409 keyring_conflict` when a ring exists                                                                                          |
| `PUT /<p>/devices/keyring/wraps/{deviceId}` | `{epoch, kid, kem, enc, ct}` → `204`. The target must be a live device of the same subject. Create-only: `409 keyring_conflict` if a wrap exists. `DELETE` is allowed for the device's own wrap                |
| `GET`/`PUT /<p>/devices/keyring/recovery`   | `PUT {ct, epoch, kid}` → `204` (audited and emailed: "recovery code changed"). `GET` → `{ct, epoch, kid}` (5 a day per device, audited and emailed)                                                            |
| `POST /<p>/devices/keyring/adopt`           | `{fromRingId, epoch, kid, ct}` → `204` (a foreign or previous root sealed under `K_adopt`)                                                                                                                     |
| `POST /<p>/devices/keyring/reset`           | `{ringId, rootKid, wrap, recovery?}` → `201`. The old ring becomes `previous` for 30 days. Audited and emailed                                                                                                 |

**Discovery** (`services.sync`, U-09.1). It gains `encryption: "e2e" | "server"` and
`endpoints.keyring` (`<base>/devices/keyring`, E2E only). The member is absent on a Worker that
cannot take `ct` (an old Worker); an SDK that requires E2E then stays local with status
`unsupported`.

### 2.3 E2E push and pull (§13.3, §13.4)

```json
{"mutationId":42,"target":{"setting":"x:3q2…","scope":"user"},"op":"set","ct":"AQ…","editedHlc":"0190f3a2c1b4:0003"}
{"mutationId":43,"target":{"setting":"game.bestLap","scope":"user"},"op":"set","ct":"AQ…","baseVersion":7,"editedHlc":"…"}
{"mutationId":44,"target":{"record":["saves","x:Zk…"]},"op":"set","ct":"AQ…","baseVersion":3}
```

- **`ct` replaces `value`.** A `value` on an E2E product, or a `ct` on a server product, is
  `rejected/encryption_mismatch`. So is an undeclared setting key or a record id that is not
  blinded, because it would leak a name.
- **The server checks the envelope's shape:** canonical base64url, byte 0 = 1, and
  `(len − 49) % 64 == 0`, under the caps. It stores `kid`.
- **Members, fields and elements** use `setMember {member: "x:…", ct}`,
  `setField {field: "x:…", ct}` and `add {element: "x:…", ct}`.
- **Pull changes** carry `ct` in place of `value`, and members as `[{member, ct, editedHlc}]`.
  The pull gains `encryption` and `encryptionSince` (the store sequence from which every row is
  sealed). An E2E client reads a plaintext row only below `encryptionSince` (legacy rows), and
  re-seals it on its next write.

### 2.4 Formats and corpus

- **`pkey-sync-value/1`:** `0x01 ‖ kid(16) ‖ salt(16) ‖ AES-256-GCM(K_msg, 0¹², aad=first 33 bytes, P)`.
  - P is the UTF-8 canonical JSON `{"k": name, "v": value}`, padded `0x80 0x00…` to a multiple of 64.
  - The reader checks that `k` equals the expected name or an `aliases` source. Otherwise the
    value is `invalid`.
- **`pkey-sync-file/1`:** a 64-byte header (`PKSYNCF1`, version u16 1, flags u16, `segmentBytes`
  u32 = 1 MiB, `kid`[16], `salt`[32]), then segments.
  - Segment `i` is `AES-256-GCM(K_file, u8(last) ‖ 0³ ‖ u64be(i), aad=header, seg)`.
  - An empty file is one empty last segment.
  - Segments allow ranged downloads and resume.
- **New corpus family `sync-vectors.json`** (`syncVectorsVersion` 1). Driver
  `tools/corpus/syncVectors.ts`, with an independent reference in
  `tools/corpus/reference/syncVectors.ts` (node:crypto by hand). It is written through
  `sign-corpus.ts` and mirrored to `sdks/godot/tests/corpus/v2/`. Sections:
  - `hkdfCases`: every label above;
  - `envelopeCases`: seal with a given salt, open, tamper, wrong `k`, alias, padding;
  - `blindCases`;
  - `wrapCases`: fixed `skEm` and recipient key, with `sharedSecret`, `key` and `baseNonce` shown
    for debugging;
  - `recoveryCodeCases`: encode, parse, checksum, confusables, wrap;
  - `adoptCases`;
  - `cdcCases`: xorshift32-seeded inputs, cut points, plus edit cases showing which chunk ids
    change;
  - `chunkCases`: id, object bytes, both codecs;
  - `fileStreamCases`: including truncation and segment reorder;
  - `manifestCases`: parse errors in a fixed order, as `parseChunkIndex`'s are;
  - `transferPlanCases`: mode, `partBytes` and the part count from size and collection.
- **`sync-scenarios.json` v3.**
  - Init gains `encryption`.
  - New rules: `e2e-client-policy`, `e2e-locked`, `encryption-pinned`, `encryption-since`.
  - Scenarios: `e2e-max-conflict-remerged`, `e2e-min-server-wins`, `e2e-merge-member-cells`,
    `e2e-locked-keeps-journal`, `e2e-unlock-pushes`, `e2e-downgrade-refused`,
    `e2e-legacy-plain-below-since`, `server-mode-unchanged`.
  - The fake transport speaks plaintext. Sealing is the host codec's job, pinned by
    `sync-vectors.json`.
- **Edits that follow:** the AGENTS.md rule-1 list gains `sync-vectors.json`;
  `contribute/corpus.md` "The files" gains a row; `pnpm gen docs-reference` updates
  `reference/corpus.mdx`.

### 2.5 Transcripts (Worker scenario tests, then `pnpm gen transcripts`; Godot mirror)

- **Recording binary bodies.** Binary bodies are recorded as `bodyBase64`, an additive member
  (`transcriptVersion` stays 1). Only `sync.files` replayers read it.
- **U-10:**
  - `cloudsync-files-single` (begin, `PUT`, finalize, `GET`, `Range`);
  - `-multipart` (begin, parts out of order, status, finalize);
  - `-resume` (a lost part, status, resend);
  - `-mismatch` (a part digest; the finalize stream);
  - `-quota` (over quota at begin; `files: false`; the open-uploads cap);
  - `-conflict` (a stale `baseVersion` at begin and at finalize);
  - `-expired`, `-revisions`, `-cors` (`PUT` preflight).
- **U-37:** `cloudsync-chunks` (plan, missing/present, puts, incomplete, finalize) and
  `cloudsync-chunks-delta` (a second version uploads only what changed).
- **U-09.1:** `cloudsync-e2e-settings` (`ct` push and pull, `encryption_mismatch`, a `max` CAS
  re-merge, `encryptionSince`).
- **U-09:** the `cloudsync-records-*` set, and `cloudsync-quota` re-recorded with the
  `collection` scope.
- **U-36:** `keyring-create`, `keyring-wrap`, `keyring-recovery` (the rate limit), `keyring-conflict`
  and `keyring-reset`.

### 2.6 Error codes (`errors.json` first, then `gen constants`)

- **New wire codes:**
  - `encryption_mismatch` (a result, or `400` on begin);
  - `upload_expired` (410);
  - `upload_incomplete` (409, with `missing`);
  - `file_too_large` (413);
  - `keyring_conflict` (409).
- **New client codes:**
  - `sync-locked`: the device has no root;
  - `recovery-code-invalid`: the checksum or the unwrap failed;
  - `sync-encryption-pinned`: the app requires E2E and the Worker offers server mode.
- **Reused:** `upload_mismatch`, `revision_conflict`, `quota_exceeded`, `entitlement_required`,
  `collection_unknown`, `rate_limited`, `not_found` and `body_too_large`.
- **Each package registers the code it emits first:**
  - U-33.2 registers all of them up front, as U-05.2 did;
  - Help copy follows (`help/messages`, as `0a0e60609`).

### 2.7 `features.json` (family `sync`, `planned` in every manifest, U-33.4)

- **Kept:** `sync.saves` and `sync.conflict`.
- **New:**
  - `sync.records` (collections: put, update, CAS, union);
  - `sync.files` (single and multipart, resume, progress);
  - `sync.files.delta` (chunks);
  - `sync.e2e` (codec, ring, wrap, unwrap; proof: `sync-vectors.json` and transcripts);
  - `sync.e2e.recovery` (code and platform backup; `allowedNa` with reason `runtime` where no
    backup API exists, for the backup half only);
  - `sync.transfer.background` (`allowedNa` with reason `runtime` for web, Node, Python and JVM
    desktop).

### 2.8 Catalog and manifest (rule 9: mutation rows in `schema-parity.test.ts`)

| Key / rule                         | Change                                                                          | Schema  |
| ---------------------------------- | ------------------------------------------------------------------------------- | ------- |
| `cloudSync.encryption`             | `"e2e"` (default) or `"server"`; anything else is `invalid_cloud_sync`          | rejects |
| `collections[].files.delta`        | boolean. Default `true` for `saves`, `false` otherwise (`CLOUD_SYNC_TEMPLATES`) | rejects |
| `cloud_sync_reserved_prefix` (new) | a declared config key or collection name starting with `x:`                     | rejects |
| `cloud_sync_e2e_map_values` (new)  | `migrations[].mapValues` while `encryption` is not `"server"`                   | rejects |
| `syncedSettings(catalog)`          | each route carries `encryption`; `settingCases` gains E2E rows                  | —       |

The console's publish path shows a notice when a publish changes `encryption` on a product with
data. Neither direction rewrites anything (U-01b R4 rule 6). Gates: rule 9, `gen mirrors`,
`bundle:action --check`.

### 2.9 OpenAPI, surface, tables, R2 and CORS

- **OpenAPI and surface.** Every route above enters `openapi/polaris-key.v3.yaml` and is checked by
  `routeCoverage` (rule 10):
  - the sync routes are rows in `services/sync/routes.ts`, carried out by `SYNC_ROUTES.surface`;
  - the key ring is a `CORE_ROUTES` row in `publicRoutes.ts`.
- **DO tables** (`CloudSyncDO`, lazy migrations):
  - **v3 (U-09):** `records`, `record_fields` and `set_elements`; a `kid` column on `settings`,
    `setting_members` and `tombstones`; `meta.e2e_since`.
  - **v4 (U-10):**
    - `files (collection, record_id, version, object_key, format, enc, size, sha256, status live|revision, created_at, client_id)`;
    - `uploads (upload_id, collection, record_id, base_version, mode, format, enc, size, sha256, part_bytes, multipart_id, reserved_bytes, device_id, created_at, expires_at, state)`;
    - `upload_parts (upload_id, n, etag, bytes, sha256)`;
    - `meta.ssec_key` (server mode).
  - **v5 (U-37):** `chunks (collection, chunk_id, stored_bytes, refs, unref_at)`,
    `file_chunks (collection, record_id, version, chunk_id)` and
    `upload_chunks (upload_id, chunk_id, stored_bytes)`.
- **D1 tables** (U-36, `TABLE_OWNERS.core`, migration `00XX_keyrings.sql` with its `.down.sql`):
  - `keyrings (product, subject, ring_id, epoch, root_kid, state, recovery_ct, recovery_at, previous_ring_id, previous_kid, previous_until, created_by, created_at, updated_at)`,
    primary key `(product, subject)`;
  - `keyring_wraps (product, subject, device_id, ring_id, epoch, kid, kem, enc, ct, by_device, created_at)`,
    primary key `(product, subject, device_id, ring_id, epoch)`;
  - `keyring_adopted (product, subject, ring_id, epoch, kid, ct, created_at)`.
  - All three are claimed by a Core subject store, `core.keyring` (merge, delete, export), in
    `subjectHooks.ts` beside `core.entitlementEvents`.
  - Merge: the absorbed ring becomes a `keyring_adopted` candidate; a device that holds both roots
    seals the adoption.
  - Core's key ring subscribes inside Core to the lifecycle event (R-7, CC-03.3): it drops a removed device's wraps, and on a key change drops that device's wrap so it re-wraps to its new key. There is no separate "Core clearing hook".
  - The `tableCrossings` and `subjectStores` guards pass.
- **R2: one binding**, `SYNC_FILES` = `polaris-key-sync-files-{prod,staging,dev}`, repeated in
  every `[env.*]`. `SYNC_SAVES` is dropped everywhere. Keys are
  `u/<product>/<subject>/o/<uploadId>` and `u/<product>/<subject>/c/<chunkId>`. Then
  `gen platform-inventory --check`.
- **CORS:** `CORS_ALLOW_METHODS` gains `PUT`, `CORS_ALLOW_HEADERS` gains `Content-Digest`, and
  `CORS_EXPOSE_HEADERS` already has `Repr-Digest`, `Content-Range` and `Retry-After`. Then
  `publicRouteOracle` is re-recorded.

### 2.10 Clients and Workers already deployed

- **Clients.** No released SDK syncs, so making E2E the default costs nothing in the field.
- **Workers.** v0.9.17 serves only server-mode settings, and it serves them only when a product
  turns Cloud Sync on, which none has. A new SDK reads the absent `encryption` member as an old
  Worker and stays local.
- **Precondition for U-09.1's deploy** (lead, read-only): `sync_directory` holds 0 rows. If a
  product has data, its catalog is pinned to `encryption: "server"` (a P0-49 job), or the owner
  decides.
- **Rollback.** Pause writes first, then turn the switch off, then revert the code (U-01b §7). The
  DO and D1 tables stay, unread.

## 3. Per-SDK work (all seven)

| Area                  | client-core                                    | Node                                                        | React                                                                     | Python                            | Swift                                                                                              | Kotlin                                                                                                                      | Godot                                                                                                 |
| --------------------- | ---------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Settings transport    | machine v3 (U-35)                              | U-06                                                        | U-20                                                                      | U-06                              | U-07                                                                                               | U-07                                                                                                                        | U-21                                                                                                  |
| Conflict vocabulary   | —                                              | U-08                                                        | U-08                                                                      | U-08                              | U-08                                                                                               | U-08                                                                                                                        | U-08                                                                                                  |
| Records, saves, files | reference codecs (U-34)                        | U-22                                                        | U-22                                                                      | U-22                              | U-23                                                                                               | U-23                                                                                                                        | U-23                                                                                                  |
| E2E, ring, recovery   | U-34 (WebCrypto `SyncCryptoPort`)              | U-38 (client-core on node:crypto)                           | U-38 (client-core on WebCrypto)                                           | U-38 (port on `cryptography`)     | U-39 (CryptoKit, including `HPKE`)                                                                 | U-39 (JCA on JVM; Tink 1.23.0 HPKE on Android)                                                                              | U-40 (native lanes, GDScript fallback)                                                                |
| Root storage          | —                                              | OS keyring if configured, else a 0600 file beside the token | IndexedDB, a **non-extractable** HKDF key (Q8)                            | `keyring` extra, else a 0600 file | Keychain `…ThisDeviceOnly`, plus the synchronizable copy for backup                                | Android: sealed by a Keystore AES key (StrongBox where present); JVM: OS keyring or a 0600 file                             | `PKeyKeyringStore` (SP-27: macOS Keychain, Windows Credential Manager, else a 0600 file in `user://`) |
| Platform backup       | —                                              | N/A                                                         | N/A (passkey PRF is phase 5 with L-4)                                     | N/A                               | iCloud Keychain synchronizable                                                                     | Block Store (Play flavour only)                                                                                             | iOS and Android through the native lanes; desktop N/A                                                 |
| Background transfer   | upload and download planner and journal (U-34) | in-process, resumed at launch                               | in-tab with one writer tab (`navigator.locks`); resumed on the next visit | in-process, resumed               | `URLSession` background configuration (`pkey.sync.<product>`), file-backed parts and chunks (U-41) | WorkManager `CoroutineWorker` (network and battery constraints); UIDT jobs for user-started transfers on Android 14+ (U-41) | desktop in-process; mobile through `:platform` WorkManager and `pkey_apple` URLSession (U-41)         |

- **Upload and download clients** (U-22/U-23 on U-34's reference):
  - `cloudSync.saves.write(id, bytes | path, metadata, {onProgress})` returns a `Transfer`
    (`id`, `state`, `sentBytes`, `totalBytes`, `pause()`, `resume()`, `cancel()`);
  - `cloudSync.transfers()` lists the persisted transfers;
  - the events are `transferProgress`, `transferDone` and `transferFailed`;
  - downloads resume by `Range` (whole files) or from the chunk cache (delta).
- **Locked device.** With no root, the journal is kept, nothing is pushed, pulled values read as
  `invalid` (falling through to the document), and status is `locked`. The kit offers the unlock
  screen (U-42).
- **Encryption pin.** The SDK option `cloudSync.encryption` defaults to `"e2e"`. A Worker that
  answers `server` then gives `blocked` with reason `encryption` and the code
  `sync-encryption-pinned`. Server mode needs the app's explicit `"server"` (T26).
- **Godot (L-10).** Wraps and bulk AES-GCM go through:
  - Apple (macOS and iOS): CryptoKit ops on `PolarisKeyPlatformC`, with a binary entry point beside `pkp_call`;
  - Windows: `pkey_win.dll`, which gains BCrypt AES-GCM and HKDF (Monocypher only for the curves).
  - Both are built once, in CC-14b; U-40 depends on it (R-12);
  - Android: `:platform`;
  - web: WebCrypto over `JavaScriptBridge`.

  Linux desktop and the editor fall back to GDScript: AES through `AESContext` ECB for the
  counter blocks, GHASH in GDScript, and X25519 in GDScript, only after U-40's measured speed and
  constant-time check. Files are capped at 32 MiB on that lane until it is measured (Q9).

- **Dependencies.**
  - New: `com.google.android.gms:play-services-auth-blockstore`, Play flavour only. The pin moves to I-49 (R-11); U-39 reuses it.
  - None other. `cryptography`, Tink 1.23.0, zstd-jni, CryptoKit and WebCrypto already ship.
    WebCrypto X25519 is in every evergreen browser; SDKs feature-detect it and report
    `sync-locked` without it.

## 4. Console, docs, privacy, threat model

### 4.1 Console (U-11a amended; U-32 amended)

- **The Data tab for one subject, in E2E mode:**
  - declared settings by name, with size, updated time and platform;
  - open settings as a count and bytes;
  - each collection with record count, bytes, file count, file and revision bytes, and last
    write;
  - the ring: `kid`, created, recovery set yes or no, devices with a wrap (by label).
- **What E2E mode never shows:** a value, a record id or a file name.
- **Operator actions:** delete this person's Cloud Sync data (step-up, audited; T10).
- **Server mode:** values, plus a file download for operators (step-up, audited, T10).
- **Setup (U-32)** shows "Encryption: End-to-end / Readable by Polaris Key" from the active
  catalog, with the publish notice from §2.8.

### 4.2 Docs (U-15a amended) and Help

- **Developer pages** under `features/cloud-sync/`: `index`, `settings`, `saves-and-records`,
  `files` (single, multipart, delta, resume, background), `encryption` (what the server sees,
  recovery, the pin, server mode) and `limits`. Every number comes from generated constants.
- **Help is for end users and says "Polaris Locker":**
  - `help/sync.md`: "Synced data is encrypted on your devices. Polaris Locker can't read it."
  - new `help/sync-new-device.mdx`: approve on a nearby device, enter the recovery code, or start
    over. In v1 a new browser unlocks only with the recovery code;
  - new `help/recovery-code.mdx`, including "Polaris Locker never asks for your recovery code.
    Only type it into the app.";
  - messages for the new codes.

  The style guide applies (terse, each fact once).

### 4.3 Privacy (U-12 amended)

- **Cascade.** Export and delete cover records (U-09), files (U-10), chunks (U-37) and the key ring
  (U-36).
- **Portal export.** For E2E data it carries the metadata and ciphertext, and says the contents
  open only in the app. The SDK adds `cloudSync.export()`, which writes a plaintext archive on
  the device.
- **"Remove my data from this product"** deletes everything, the ring included.
- **New PRIVACY rows:**
  - records;
  - files and revisions (`SYNC_FILES` `u/<p>/<s>/…`);
  - upload sessions (24 h);
  - chunk metadata (keyed ids, sizes);
  - key-ring rows (wrapped roots, the recovery wrap, `kid`s; no key the server can open);
  - the fix for row 284 (C6).
- **No raw hardware value** is added (rule 7).

### 4.4 THREAT-MODEL rows (each lands with its package; U-19, U-43, U-44 and U-45 review them)

| Row                        | Content                                                                                                                                                                                                                                                                                                                                                                | WP           |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| T9 (amended)               | Files: octet-stream, `attachment`, `nosniff`; no public, presigned or `r2.dev` URL; bytes only through the Worker after the DO confirms ownership                                                                                                                                                                                                                      | U-10         |
| T11 (amended)              | Shredding: E2E removes the ring and recovery rows; server mode uses the SSE-C per-principal key; DO PITR is a 30-day residual                                                                                                                                                                                                                                          | U-10, U-36   |
| T19                        | Field policies are not anti-cheat; in E2E mode `max`/`min` are the client's                                                                                                                                                                                                                                                                                            | U-09         |
| T20                        | Open settings (U-01b's lost T17, C5)                                                                                                                                                                                                                                                                                                                                   | U-09.1       |
| T21 key substitution       | A malicious Worker can register a fake agreement key, so a server-relayed wrap would go to it. Mitigations: wraps go only through nearby approval with R-3's commit-reveal code, in mode `v` only (R-9),, the recovery code or platform backup; no remote approval; a held root is never replaced. Residual: the server's device directory is trusted for listing only | U-36, U-34   |
| T22 key loss               | All devices lost with no backup or code means the data cannot be recovered, by design. Start over is the 30-day previous ring; Help says so                                                                                                                                                                                                                            | U-36, U-42   |
| T23 recovery-code phishing | The code unlocks only with a signed-in device of that account. The fetch is rate-limited, audited and emailed. The copy says no one asks for it, and it is entered only in the app, never on a web page                                                                                                                                                                | U-36, U-42   |
| T24 metadata leakage       | Declared names, sizes (padded to 64 bytes for values), chunk equality within one person's collection, timing and `kid` are visible. Chunk ids are keyed, so no confirmation-of-file is possible from outside                                                                                                                                                           | U-34         |
| T25 file cost abuse        | Reservations, the open-uploads cap, request limits, the per-file and per-chunk caps, GC of orphans, the lifecycle rule, and both ceilings                                                                                                                                                                                                                              | U-10, U-37   |
| T26 downgrade              | The server claims server mode: the app pin defaults to `e2e`; a plaintext row is honoured only below `encryptionSince`                                                                                                                                                                                                                                                 | U-35, U-09.1 |
| T27 unscannable content    | E2E storage cannot be inspected. Bounds: quotas, owner access only, product data through declared collections, deletion per person and per product, and the terms (Q5)                                                                                                                                                                                                 | U-15a        |

## 5. Work packages

Statuses and sizes in engineer-weeks. ⚑ = plan mode (this plan).

| Id     | Title                                                                                                                                                                               | Deps                            | Role           | Size     | Change                                     |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | -------------- | -------- | ------------------------------------------ |
| U-05   | Cloud Sync service and routes                                                                                                                                                       | as is                           | implementer    | —        | status → `in-review`; `planRef` adds U-01b |
| U-19   | Security review of U-05 (overdue: shipped in v0.9.17)                                                                                                                               | U-05                            | implementer    | 0.4–0.55 | first in queue                             |
| U-33 ⚑ | E2E and files contract: WIRE-CONTRACT-V5 §13 amendments, `protocol/sync` types and numbers, errors, features, catalog and manifest (`encryption`, `files.delta`, `x:`, `mapValues`) | U-01b, U-05, CC-04.1            | implementer    | 0.8–1.1  | new; re-opens U-17's E2E half              |
| U-34 ⚑ | client-core E2E reference: crypto port, envelope, blinding, HPKE wrap, recovery code, CDC chunker, chunk, file stream and manifest formats, transfer planner, `sync-vectors.json`   | U-33                            | implementer    | 1.3–1.7  | new (corpus lane)                          |
| U-35 ⚑ | client-core machine v3: encryption mode and pin, `locked`, E2E client `max`/`min`, `encryptionSince`; `sync-scenarios.json` v3                                                      | U-33                            | implementer    | 0.5–0.7  | new (corpus lane)                          |
| U-36 ⚑ | Core key ring: D1 tables, `core.keyring` store, `/devices/keyring` routes, the lifecycle subscription, recovery audit and email, transcripts, T21–T23                               | U-33, U-19, CC-03               | implementer    | 0.9–1.2  | new; P-3                                   |
| U-09 ⚑ | Records store with the saves template, plus E2E values on both stores (`ct`, `kid`, blinded names, client CAS registers), discovery `encryption`                                    | U-01b, U-05, U-19, U-33         | implementer    | 1.5–2.0  | amended (was 1.2–1.7)                      |
| U-10 ⚑ | Files on records: single, multipart, resume, finalize verify, download, revisions, GC, SSE-C, `SYNC_FILES`, CORS                                                                    | U-09, U-33                      | implementer    | 1.5–2.0  | amended                                    |
| U-37 ⚑ | Delta files: the chunks mode on the Worker (plan, put, get, reference counts, GC, transcripts)                                                                                      | U-10, U-34                      | implementer    | 0.7–0.9  | new                                        |
| U-38   | E2E, ring and recovery client in Node, React and Python                                                                                                                             | U-34, U-36, CC-26.1–.3          | sdk-porter     | 1.0–1.3  | new                                        |
| U-39   | E2E, ring and recovery client in Swift and Kotlin, with iCloud Keychain and Block Store                                                                                             | U-34, U-36, CC-26.4–.5, I-49.1  | sdk-porter     | 1.1–1.5  | new                                        |
| U-40   | E2E, ring and recovery client in Godot (native lanes, measured GDScript fallback)                                                                                                   | U-34, U-36, CC-26.6–.7, CC-14b  | godot-engineer | 1.0–1.4  | new                                        |
| U-06   | Synced settings in Node and Python (+ E2E codec)                                                                                                                                    | add U-35, U-38                  | sdk-porter     | 1.2–1.6  | amended                                    |
| U-20   | Synced settings in React (+ E2E codec)                                                                                                                                              | add U-35, U-38                  | sdk-porter     | 1.2–1.6  | amended                                    |
| U-07   | Synced settings in Swift and Kotlin (+ E2E codec)                                                                                                                                   | add U-35, U-39                  | sdk-porter     | 1.6–2.1  | amended                                    |
| U-21   | Synced settings in Godot (+ E2E codec)                                                                                                                                              | add U-35, U-40                  | godot-engineer | 1.2–1.6  | amended                                    |
| U-08   | One conflict vocabulary and `MergeRequest` in six SDKs; E2E automatic `max`/`min`                                                                                                   | as is + U-35                    | sdk-porter     | 0.5–0.7  | amended                                    |
| U-22   | Saves and records SDK with file clients (whole, multipart, delta, progress, resume): Node, React, Python                                                                            | as is + U-10, U-37, U-38        | sdk-porter     | 1.4–1.9  | amended                                    |
| U-23   | The same in Swift, Kotlin and Godot                                                                                                                                                 | as is + U-10, U-37, U-39, U-40  | sdk-porter     | 1.7–2.3  | amended                                    |
| U-41   | Background transfers: URLSession background (Swift), WorkManager and UIDT (Kotlin), Godot mobile through native lanes                                                               | U-23                            | sdk-porter     | 0.8–1.1  | new                                        |
| U-42   | Kit screens (a browser unlocks only with the recovery code in v1): unlock sync (nearby, recovery code, start over), save your recovery code, locked status; four kits, UX review    | U-38, U-39, U-40, I-46.1, CC-15 | implementer    | 0.8–1.1  | new                                        |
| U-11a  | Data tab (absorbs U-11b, U-11c): E2E sizes and counts, server-mode values, files, ring                                                                                              | as is + U-36, U-37              | implementer    | 0.8–1.0  | amended                                    |
| U-12   | Privacy cascade: records, files, chunks, ring; portal export and delete; PRIVACY rows                                                                                               | as is + U-09, U-10, U-36        | implementer    | 1.0–1.3  | amended                                    |
| U-15a  | Developer docs (settings, saves, files, delta, encryption, limits) and Help                                                                                                         | as is + U-22, U-42              | implementer    | 0.6–0.8  | amended                                    |
| U-32   | Catalog templates and Cloud Sync page: the encryption row and the publish notice                                                                                                    | as is + U-33                    | implementer    | +0.1     | amended                                    |
| U-43   | Security review: E2E crypto, key ring, recovery, downgrade                                                                                                                          | U-34, U-35, U-36, U-38          | implementer    | 0.4–0.6  | new                                        |
| U-44   | Security review: files, multipart, delta, quotas, GC, CORS                                                                                                                          | U-10, U-37                      | implementer    | 0.4–0.5  | new                                        |
| U-45   | Security review: SDK key storage, backup items, background transfer                                                                                                                 | U-39, U-40, U-41                | implementer    | 0.3–0.4  | new                                        |

- **Unchanged:**
  - U-17 stays `dropped`: receipts and public collections are not re-opened, and U-33, U-34 and
    U-36 carry its E2E half.
  - U-14 (live pokes) stays parked.
  - U-16 serves `server`-mode products only (brief note).
- **Total new and amended work:** about 22–29 engineer-weeks, across lanes.

## 6. First wave (builder slices ≤ 60 min)

- **Can start now, before the plan is approved:** L.0 and U-19.
- **Starts on approval:** U-33.1–.4, U-34.1–.6, U-35.1–.2 and U-36.1–.4. U-36 moves to wave 2 (plan-combined.md §4); "can start now" keeps L.0 and U-19.
- **Lanes.**
  - Corpus lane: U-34.5–.6, then U-35.2.
  - Worker: U-36 runs in parallel with U-19.2, and U-36.2+ wait for U-19.2's merge.

| Slice  | Goal                                                                                                                                                                                     | Files                                                                                                                                          | Tests and gates                                                                           | Security, deps, size       |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------- |
| L.0    | Lead: U-05 → `in-review`; rows U-33–U-45 and the amendments in §5; brief sections "Approved plan (plan-cloud-sync.md)"; production read for §0                                           | `workpackages.json`, `wp/*.md`, INDEX                                                                                                          | `check.mjs`, `--write-index`, prettier                                                    | —, now, 30                 |
| U-19.1 | Review U-05 as built: T1–T3, T5, T6, T8, T13–T18; cross-tenant, cross-product and cross-account; CORS, the clamp, the quota, the purge flag                                              | read-only                                                                                                                                      | attack tests in `test/attack/` where a gap is found                                       | reviewer, now, 60          |
| U-19.2 | One fix round on U-19.1's findings                                                                                                                                                       | per finding                                                                                                                                    | the touched tests; `gen transcripts --check`                                              | builder, .1, 60            |
| U-33.1 | WIRE-CONTRACT-V5 §13 (after CC-04.1): header note, §8, §9, §11.5, §13.2–.4, §13.8 (rewritten), §13.9, new §13.10 and §13.11, all from §1–§2 here                                         | `docs/security/WIRE-CONTRACT-V5.md`                                                                                                            | prettier; docs `check:links`                                                              | no, approval, 60           |
| U-33.2 | `protocol/sync`: `SYNC_*` numbers (§1.2, §1.3, §1.7, `SYNC_E2E_OVERHEAD_BYTES` 113, `SYNC_FILE_SEGMENT_BYTES`), E2E, file and ring types; the 5 wire and 3 client codes in `errors.json` | `shared-protocol/src/sync.ts`, `conformance/parity/errors.json`                                                                                | `gen constants --check`; protocol tests                                                   | no, .1, 60                 |
| U-33.3 | Catalog and manifest: `encryption`, `files.delta`, `x:` prefix, `mapValues` rule; `syncedSettings` carries the mode; templates                                                           | `shared-catalog/src/{types,cloudSync}.ts`, `shared-manifest/src/cloudSync.ts`, `schemas/v1/schema.schema.json`, `test/schema-parity.test.ts`   | catalog and manifest tests; rule 9; `gen mirrors --check`; `bundle:action --check`        | no, .2, 60                 |
| U-33.4 | `features.json` ids (§2.7), parity regeneration; `contribute/corpus.md` row placeholders                                                                                                 | `conformance/parity/features.json`                                                                                                             | `pnpm gen parity --check`, `gen constants --check`                                        | no, .2, 45                 |
| U-34.1 | `SyncCryptoPort` (AES-GCM, HKDF, HMAC, X25519, SHA-256) on WebCrypto; HKDF labels; `pkey-sync-value/1` seal and open; `blind`                                                            | `client-core/src/sync/{crypto,envelope,blind}.ts`                                                                                              | client-core unit tests                                                                    | review in U-43, U-33.2, 60 |
| U-34.2 | HPKE base single-shot wrap and unwrap; recovery code encode, parse and wrap; adopt                                                                                                       | `client-core/src/sync/{hpke,recovery}.ts`                                                                                                      | unit tests; one cross-check against CryptoKit-shaped intermediates                        | U-43, .1, 60               |
| U-34.3 | Streaming `pkey-sync-cdc/1` chunker; chunk ids and objects; `pkey-sync-chunks/1` encode and parse                                                                                        | `client-core/src/sync/{cdc,chunks,manifest}.ts`                                                                                                | unit tests; cut points equal the CLI's `fastcdc` at the same params                       | U-43, .1, 60               |
| U-34.4 | `pkey-sync-file/1` segmented seal and open with ranges; the transfer planner                                                                                                             | `client-core/src/sync/{fileStream,transferPlan}.ts`                                                                                            | unit tests                                                                                | U-43, .1, 60               |
| U-34.5 | `sync-vectors.json` I: generator, independent reference, Node runner, Godot mirror; AGENTS.md rule-1 list                                                                                | `tools/corpus/syncVectors.ts`, `tools/corpus/reference/syncVectors.ts`, `tools/sign-corpus.ts`, `conformance/runners/node/syncVectors.test.ts` | `gen corpus --check`; `gen constants --check` (counter)                                   | corpus lane, .1–.4, 60     |
| U-34.6 | Vectors II: edit and delta cases, the browser runner, `reference/corpus.mdx`                                                                                                             | the same plus `conformance/runners/browser`                                                                                                    | `pnpm test:browser`; `docs gen:check`                                                     | lane, .5, 60               |
| U-35.1 | Machine: `encryption` init, `locked` status, the pin, `encryptionSince`                                                                                                                  | `client-core/src/cloud-sync.ts`                                                                                                                | client-core `cloudSync` tests                                                             | U-43, U-33.2, 60           |
| U-35.2 | Machine: E2E client `max`/`min` on CAS; `sync-scenarios.json` v3 (rules and the 8 scenarios)                                                                                             | `cloud-sync.ts`, `tools/sync-scenarios.ts`                                                                                                     | `conformance-node test syncScenarios`; `gen corpus --check`; `gen constants --check`      | lane, .1 + U-34.5, 60      |
| U-36.1 | Key ring D1: `00XX_keyrings.sql` (+ down), `TABLE_OWNERS.core`, `core/keyring/store.ts`, the `core.keyring` subject store; the lifecycle subscription (R-7) drops wraps                  | `worker/migrations/`, `src/db/owners.ts`, `src/core/keyring/`, `subjectHooks.ts`                                                               | the store test; `subjectStores`, `tableCrossings`, `boundaries`; `docs-reference --check` | U-43, U-33.2, 60           |
| U-36.2 | Routes I: `GET`, `POST` (create), wraps `PUT`/`DELETE`; `CORE_ROUTES` kind `keyring`; the contributed `keyring` hook (Sync answers on + e2e); OpenAPI                                    | `src/publicRoutes.ts`, `src/core/keyring/routes.ts`, `src/core/contributions.ts`, `services/sync/index.ts`, `openapi/polaris-key.v3.yaml`      | `routeCoverage`, `publicRouteOracle`, route tests                                         | U-43, .1 + U-19.2, 60      |
| U-36.3 | Routes II: recovery `GET`/`PUT` (5 a day, audit, email), adopt, reset (30-day previous ring); email templates                                                                            | the same plus `core/notify` templates                                                                                                          | route tests; `auditWriter`                                                                | U-43, .2, 60               |
| U-36.4 | `keyring-*` transcripts; THREAT-MODEL T21–T23; PRIVACY ring row                                                                                                                          | `worker/test/transcripts/`, `THREAT-MODEL.md`, `PRIVACY.md`                                                                                    | `gen transcripts --check`                                                                 | U-43, .3, 60               |

**Common to every slice:**

- Prefix every JS command with `mise exec node@22 --`.
- Run only the named test files: `pnpm --filter <pkg> exec vitest run <files>`. Run generators
  after `pnpm exec turbo run build --filter=<pkg>...`. Run prettier on the changed files.
- Plan-mode slices (U-33–U-36) stop and report if they need a signed shape, a new header or a
  `PROTOCOL_VERSION` change.
- Run `$PKEY_LEAD/gate.sh` once before hand-off, and rerun only a failed step (`GATE_ONLY=<n>`).
- Merge staging once, right before hand-off. Stop every background job.
- Report the changed files, the test results, and anything the lead must do (a migration number,
  regeneration).
- Security write-ups stay local, because the repo is public.

**Dispatch briefs:**

**L.0** — lead (Opus 5.5).

- Plan: §0, §5. No worktree; edit in `_merge`'s graph lane.
- Steps:
  1. `--set U-05 in-review`; U-05 `planRef` gains U-01b.
  2. Add rows U-33–U-45 and amend U-06, U-07, U-08, U-09, U-10, U-11a, U-12, U-15a, U-20, U-21,
     U-22, U-23 and U-32 per §5.
  3. Add a section "Approved plan (plan-cloud-sync.md, 2026-10-24)" to each brief;
     `--sync-briefs`, `--write-index`, prettier.
  4. Production read: Cloud Sync enabled products = 0, `sync_directory` = 0.
- Time box: 30 min.

**U-19.1** — security reviewer (Sonnet 5.5).

- Plan: §0, §7.
- Brief: `wp/U-19-security-review.md`. Worktree `/Users/vlad/Repos/pk-wt/U-19.1`, branch
  `wp/U-19.1-review` from `integ/next-stage`.
- Steps:
  1. Review U-05's merged diffs, `d2ee55c95^..99ea8941a`, plus `services/sync/` as it is now.
  2. Run the row checks and write attack tests for any gap.
  3. Write the findings as R-series rows, kept local.
- Out of scope: fixes. Time box: 60 min.
- Hand-off: a findings table (severity, file:line, fix).

**U-19.2** — pkey-implementer (Sonnet 5.5).

- Worktree `/Users/vlad/Repos/pk-wt/U-19.2`, branch `wp/U-19.2-fixes` after .1.
- Steps: one fix per finding, each with a test; re-record transcripts if a response changes;
  then `--set U-19 in-review`.
- Time box: 60 min.

**U-33.1** — pkey-implementer (Sonnet 5.5).

- Plan: §1, §2.1–§2.6. Worktree `/Users/vlad/Repos/pk-wt/U-33.1`, branch
  `wp/U-33.1-contract-text`.
- Steps:
  1. The header amendment line.
  2. §13 routes and bodies.
  3. §13.10 E2E and §13.11 key ring.
  4. §8, §9 and §11.5.
- Out of scope: code. Time box: 60 min.

**U-33.2** — pkey-implementer (Sonnet 5.5).

- Plan: §1.2–§1.7, §2.6. Worktree `/Users/vlad/Repos/pk-wt/U-33.2`, branch
  `wp/U-33.2-protocol-errors` after .1.
- Steps:
  1. Numbers and types.
  2. `errors.json` (8 codes).
  3. `pnpm gen constants`; regenerate the docs reference.
- Time box: 60 min.

**U-33.3** — pkey-implementer (Sonnet 5.5).

- Plan: §2.8. Worktree `/Users/vlad/Repos/pk-wt/U-33.3`, branch `wp/U-33.3-catalog-manifest`
  after .2.
- Steps:
  1. Types and templates.
  2. Validator rules and schema.
  3. Mutation rows.
  4. Mirrors and the Action bundle.
- Time box: 60 min.

**U-33.4** — pkey-implementer (Sonnet 5.5).

- Plan: §2.7. Branch `wp/U-33.4-features` after .2.
- Steps: the rows, `gen parity`, the `contribute/corpus.md` row.
- Time box: 45 min.

**U-34.1 … U-34.4** — pkey-implementer (Sonnet 5.5), one worktree each
(`/Users/vlad/Repos/pk-wt/U-34.N`), branches `wp/U-34.N-<module>` after U-33.2. .2–.4 run in
parallel after .1.

- Steps per §2.4 and §1.3–§1.5:
  1. The module.
  2. Unit tests with fixed randomness.
  3. Export from `@polaris-key/client-core/sync`.
- Out of scope: the corpus. Time box: 60 min each.
- Hand-off: the exported API.

**U-34.5** — pkey-implementer (Sonnet 5.5), corpus lane.

- Branch `wp/U-34.5-sync-vectors` after .1–.4.
- Steps:
  1. The independent reference.
  2. The driver and sections.
  3. The Node runner.
  4. `pnpm gen corpus`; the Godot mirror; AGENTS.md rule 1.
- Time box: 60 min. Hold the corpus lane until .6 merges.

**U-34.6** — the same role.

- Branch `wp/U-34.6-vectors-delta` after .5.
- Steps: edit cases, the browser runner, `docs gen`.
- Time box: 60 min.

**U-35.1, U-35.2** — pkey-implementer (Sonnet 5.5).

- Branches `wp/U-35.1-machine-e2e` and `wp/U-35.2-scenarios-v3`. .2 holds the corpus lane after
  U-34.6.
- Steps per §1.6 and §2.4: the machine change, scenario-backed unit tests, the v3 file.
- Time box: 60 min each.

**U-36.1 … U-36.4** — pkey-implementer (Sonnet 5.5).

- Worktrees `/Users/vlad/Repos/pk-wt/U-36.N`, branches `wp/U-36.1-keyring-store`,
  `.2-keyring-routes`, `.3-keyring-recovery`, `.4-keyring-transcripts`, in sequence.
- Steps per §2.2 and §2.9.
- Time box: 60 min each.
- Hand-off: the migration for numbering (.1), and the transcript list (.4). Then request U-43
  after U-34, U-35, U-36 and U-38.

## 7. Security reviews

One Sonnet 5.5 reviewer each, one fix round each. The red, blue and green roles follow
`feedback_security_team_roles`.

- **U-19** (now): U-05 as built. It gates turning Cloud Sync on in production at all.
- **U-43**, after U-34, U-35, U-36 and U-38: E2E crypto and the key ring.
  - HKDF label separation;
  - nonce and key uniqueness;
  - the AAD and `k` checks;
  - padding;
  - HPKE intermediates against CryptoKit and Tink;
  - the recovery-code entropy, checksum and rate limit;
  - root pinning and adopt;
  - the downgrade pin and `encryptionSince`;
  - blinding, including the dictionary risk for low-entropy names (T24);
  - key-ring routes: who may wrap, create-only, clearing on sign-out;
  - **Owner question Q7:** an external cryptographer as well.
- **U-44**, after U-10 and U-37: files.
  - verify before the pointer moves;
  - `Content-Digest` tee;
  - multipart races and parallel parts;
  - reservations, caps and request limits;
  - GC races with open uploads and the 1-hour grace;
  - cross-person chunk reads;
  - range and `ETag` behaviour, CORS `PUT`, T9, T25.
- **U-45**, after U-39, U-40 and U-41: SDK key storage.
  - Keychain and Keystore attributes;
  - iCloud and Block Store item scope;
  - logs and crash reports free of key material;
  - background-session temporary files (sealed only);
  - the Godot fallback's constant-time check.

## 8. Owner steps

_Superseded by plan-combined.md §3.2 (one list for all three plans)._

1. **R2 (before U-10.2):**
   - create `polaris-key-sync-files-prod`, `-staging` and `-dev`;
   - no bucket lock, public access off, no `r2.dev`, no custom domain, no bucket CORS (bytes go
     through the Worker);
   - a lifecycle rule on each: abort incomplete multipart uploads after 1 day;
   - no EU twin (residency is not offered).
2. **Cloudflare limits** (nothing to raise):
   - the zone body limit of 100 MB bounds one request, and the design's largest is 64 MiB;
   - Workers' paid CPU default (30 s) covers about 1 s of hashing per GiB at finalize;
   - DO storage is about 10 GB per object, against a person's ~1.06 GiB ceiling.
3. **Billing alerts:** R2 storage and Class A operations, and DO storage (owner steps §8r item 2
   extended).
4. **Production gate:** Cloud Sync stays off for every product until U-19 passes. E2E stays off
   (products keep the switch off) until U-43 and U-44 pass.
5. **Legal:** the counsel review already open (owner steps §8f item 2) adds E2E storage of
   unscannable content and the recovery-code loss warning (Q5).
6. **Staging load test** for U-05 (owner steps §8r item 3), unchanged.

## 9. Open decisions (recommended option in bold)

_Answered 2026-10-26, all as recommended, in plan-combined.md §3: Q1 goes into Q2; Q2, Q3 and Q4 go into Q8; Q5 becomes Q9; Q6 goes into Q7; Q7 becomes Q10; Q11 goes into Q12. Q8, Q9, Q10 and Q12 are resolved in R-16._

1. **Q1. Remote approval of a new device over the relay, without proximity.**
   - **No in v1.** Nearby approval, the recovery code and platform backup cover it. Remote
     approval fails I-37/R1-07, because an attacker who holds the password can talk the person
     into tapping.
   - Alternative: remote approval with a 6-digit code, as a product opt-in.
2. **Q2. Recovery code scope.**
   - **One code per app** (L-7).
   - Later (phase 5, with L-4): "one Polaris Locker recovery code" entered only on the Locker
     portal, which re-wraps each app's root in the browser.
3. **Q3. Platform key backup.**
   - **On by default, with a developer opt-out** (`cloudSync.keyBackup: false` in SDK options).
   - Alternative: off by default, so the recovery code is mandatory.
4. **Q4. Rotation when a device is removed.**
   - **No automatic rotation.** The wrap and the token go; "Reset encryption" is a manual
     action with a new code.
   - Alternative: rotate automatically and re-issue the code, which breaks every saved code.
5. **Q5. Unscannable E2E content on Polaris Key's Cloudflare.**
   - **Accept, bounded by quotas, owner-only access and deletion; add it to the terms review.**
   - Alternative: server mode by default, which reverses O-1.
6. **Q6. What "product tier" means in O-2.**
   - **The product's own tiers** (`pkey.cloudSync.bytes`). Polaris Key plans per product come
     later, through `cloudSync.ceiling.bytes`.
   - Alternative: introduce platform plans now.
7. **Q7. External cryptographic review before E2E reaches production.**
   - **Yes, one external reviewer** over §1.4–§2.4 and the vectors, after U-43.
   - Alternative: the Sonnet review alone.
8. **Q8. The browser root.**
   - **Non-extractable.** A browser device can create a ring and its code but cannot approve
     other devices.
   - Alternative: an extractable key in IndexedDB (XSS can export it).
9. **Q9. Godot on Linux desktop.**
   - **A measured GDScript fallback, with files capped at 32 MiB on that lane.**
   - Alternative: a Linux GDExtension (a new native build lane).
10. **Q10. `syncScenariosVersion`.**
    - **3**, because runners must implement the client policy and `locked`. Only the Node runner
      replays the file today.
    - Alternative: append to v2 with a capability flag.
11. **Q11. `merge` in E2E mode.**
    - **Server-side, on blinded member cells.** No plaintext is needed, and there is no client
      loop.
    - Alternative: client CAS, as the lead position says.
12. **Q12. Delta default.**
    - **`files.delta: true` for `saves`, false elsewhere.**
    - Alternative: always chunk files ≥ 1 MiB.

## 10. Interfaces

**From `plan-cloud-connect.md`:**

- **P-1 in Core `core/devices`.**
  - Per device: `agreeKey` (X25519 public; a P-256 key changes the wrap's `kem` to 0x0010) and
    `signKey`.
  - The SDK device-key module exposes `hpkeOpen(enc, ct, info, aad)`, or an X25519 shared secret,
    without exporting the private key.
  - U-38, U-39 and U-40 depend on their SDK's CC-26 slice; U-40 also depends on CC-14b and U-39 on I-49.1.
- **The vouch channel (P-4, P-5).** `VOUCH_RESULT` carries no wrap. `KEYRING_WRAP` (0x0030, mode `v` only; 0x0031–0x003F reserved) carries `{ringId, epoch, kid, kem, enc, ct}` (a `pkey-sync-wrap/1` to the agreeKey from the authenticated `VOUCH_REQ`), and the approver PUTs the same wrap through `PUT /devices/keyring/wraps/{deviceId}`. Mode `a` never carries key material (R-9).
- **Optional LAN transfer** (phase 5, L-8). The Sync SDK exposes a `SyncChunkPeerPort`: same-ring
  peers answer `chunk(collection, chunkId)` with the stored chunk object, and the downloader checks
  it by AEAD. R2 is the fallback.
- **The Core hook `keyring`:** Cloud Connect may contribute a consumer. Neither service imports the
  other (rule 6).

**To `plan-cloud-connect.md`:**

- the Core key-ring module and routes (§2.2);
- the wrap format;
- K_disc is not derived from R (L-13);
- device removal and key changes drop wraps through the lifecycle subscription (R-7).

**From `plan-auto-sign-in.md`:**

- **The server half of P-5.** After an approval, the approving device also wraps the root when the
  product is E2E and it holds one.
- **The code both screens show** is R-3's commit-reveal code (`SAS_COMMIT`, `SAS_NONCE`, `SAS_REVEAL`), so a man in the middle cannot grind a matching code (T21).
- **L-12 ladder.** The nearby vouch carries the root in the same step.

**To `plan-auto-sign-in.md`:**

- After a sign-in where a ring exists and the device has no wrap, the kit shows U-42's "Bring your
  synced data" (nearby, recovery code, later). It never blocks sign-in.
- O-5's link offer is unaffected.
- The first sign-in with no ring creates one lazily, at the first sealed write.
