# Content delivery: many versioned packs, many types, whatever transport is available

**Date:** 2026-09-30 · **Status:** research and proposal. Nothing here is implemented. ·
**Extends:** [README §3.7](README.md#37-content-packs-content-service), which this document
replaces in detail.

The main report treats content as "Godot packs". This document generalises that into a
**product-agnostic content delivery system** built into Polaris Key:

- **Many packs.** A product can ship any number of content packs.
- **Different types.** Godot PCKs, file trees, archives, audio banks, localisation tables, data,
  ML models, Unity Addressables later.
- **Independent versions and channels.** Each pack has its own version line and release channels.
- **Constraints.** Packs carry dependencies, compatibility constraints and entitlements.
- **Best available delivery and patching.** Each pack is delivered and patched through whatever the
  platform offers: Apple Background Assets, Play Asset Delivery, Steam depots, MSIX optional
  packages, the browser, or Godot's own delta packs. Polaris Key's R2 CDN, chunk-level patching and
  full downloads are the fallbacks.

It is built on four research tracks:

- `notes/E8`: how Riot, Blizzard, Epic, Steam, itch, casync/desync, OSTree, OCI, Unity, Unreal,
  Godot and the platform transports version and patch content, with schema sketches.
- `notes/A6`: what a pure-GDScript client can actually patch on Godot 4.7.2, measured.
- `notes/E5 §3, §6` and `notes/E1 §E`: deltas and content data models; Background Assets.

---

## 0. Summary

**Seven principles:**

1. **A pack's identity is its signed manifest, not its transport.** A pack release is
   `(packId, version)`, and a CI-signed record pins its payload and file/chunk indexes by SHA-256.
   Whatever delivered the bytes (our CDN, Apple, Google, Steam, the browser, the app bundle),
   they must verify against that record.
2. **Everything below the channel pointer is immutable and content-addressed.** Only the
   Worker-signed **content index** per channel is mutable. It is short-lived, device-less and
   edge-cacheable.
3. **Chunk boundaries are computed only in CI.** The client needs SHA-256, zstd and HTTP Range, all
   native in Godot and every other SDK. Content-defined chunking runs at publish time.
4. **Types are plugins.** Type, transport, patch strategy and activation are orthogonal axes. Each
   SDK ships handlers for the types it supports and advertises them.
5. **The server resolves; the client plans.**
   - Version ranges and dependencies are resolved at publish time into signed **pack sets**
     (lockfiles).
   - The client picks the cheapest valid **patch strategy** from a signed menu.
   - Planning is a pure function, so it is conformance-tested across SDKs.
6. **Stage, verify, then switch a pointer atomically.** The previous set is kept until a
   confirmed boot, and rollback is re-pointing.
7. **Nothing trusted is ever implied by transport or name.** Every file and chunk is pinned by
   SHA-256 in a signed index. Platform-delivered packs carry a signed marker. Gated packs never
   share bytes with free ones.

**What this buys:**

- Diceroll's six packs become first-class, independently versioned units, as do future seasonal
  events, supporter skins, music packs and localisations.
- Store builds stay data-only and store-compliant.
- A typical update downloads only changed chunks. The industry reports 85%+ chunk reuse between
  versions; the synthetic Godot numbers are in §7.3.
- The same model serves the Swift, Node/Electron, Python, React/web and a future Kotlin or Unity
  SDK.

**Cost.** Phased so v1 is small. v1 (single-file packs, full + one delta, type registry, transport
bindings) is about 6–8 engineer-weeks. v2 (chunk sync, content channels with pack sets, GC) adds
5–7. v3 (more types, lazy deltas, content-key delegation) adds 4–6. See §15.

---

## 1. Requirements

**Functional:**

| #   | Requirement                                                                                                                                                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| F1  | A product declares **any number of packs**, each with a **type**                                                                                                                                             |
| F2  | Each pack has an **independent version line** (semver + a monotonic `seq`) and can be published to **content channels** (`stable`, `beta`, event or custom) independently of app releases                    |
| F3  | Packs declare **compatibility**: engine, pack format, the app's content API level, platform/arch, GPU features (texture family), locale, and **dependencies** on other packs (semver ranges), plus conflicts |
| F4  | Packs may have **variants**: texture family, locale, quality tier                                                                                                                                            |
| F5  | Packs have a **delivery policy** (`essential` / `prefetch` / `onDemand`), a **required** flag and an activation mode (`hot` / `restart`)                                                                     |
| F6  | Packs may be **entitlement-gated** (a licence `flag`); on store outlets the entitlement originates from store commerce (README §3.10)                                                                        |
| F7  | Each pack is delivered through the **best transport available on the outlet**: platform-native where it exists or is mandatory, Polaris Key CDN elsewhere, embedded where shipped with the build             |
| F8  | Updates are **patched** with the cheapest strategy the client supports, falling back to a full download                                                                                                      |
| F9  | Code builds can **pin** exact pack releases; live content can **float** on a channel between code releases                                                                                                   |
| F10 | **Rollout, halt, floor and yank** per content channel, with the same machinery as release channels (README §3.9)                                                                                             |
| F11 | **Offline:** installed and embedded packs work with no network; required-set checks are local                                                                                                                |
| F12 | **Rollback** to the previous pack set after a failed boot or smoke check                                                                                                                                     |
| F13 | **Garbage collection** on client and server                                                                                                                                                                  |
| F14 | **Telemetry**: strategy used, bytes, duration, failures, to find hot patch pairs and auto-halt                                                                                                               |

**Non-functional:** data-only content on store builds; signed and verifiable offline; resumable;
atomic; anonymous and cacheable index; low client CPU; **workable in pure GDScript** (no native
extension required); within mobile and web storage limits.

---

## 2. Vocabulary

These nouns extend README §3.1 and avoid the reserved words ("catalog" is the config catalog,
"bundle" is the offline bundle, "surface" and "route" are Worker terms, "profile" is taken twice).
Where a borrowed industry term collides, it is renamed.

| Term                  | Meaning                                                                                                                                                                               |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **pack**              | a named, independently versioned unit of content (`diceroll.foes`)                                                                                                                    |
| **pack type**         | the payload format and its handler: `godot.pck`, `files.tree`, `archive.zip`, `audio.bank`, `l10n.table`, `data.json`, `ml.model`, `custom.<name>`, …                                 |
| **handler**           | the SDK component implementing a type's lifecycle (stage, verify, activate, …)                                                                                                        |
| **pack release**      | one immutable version of one pack (and variant), CI-signed (`pkey-pack+jws`)                                                                                                          |
| **variant**           | a release axis within a pack: texture family, locale, quality tier                                                                                                                    |
| **payload**           | the materialised bytes of a release: one file, or a file tree                                                                                                                         |
| **files index**       | per-file path, size and SHA-256 of a payload (`pkey-files/1`)                                                                                                                         |
| **chunk index**       | the CI-computed chunking of a payload: chunk id (SHA-256), length, compressed length, bundle and offset (`pkey-chunks/1`, binary)                                                     |
| **chunk bundle**      | an immutable 4–16 MiB container of compressed chunks in file order, fetched by Range. It is named "chunk bundle" and never bare "bundle", which is the offline bundle                 |
| **content channel**   | a channel for content; same semantics as release channels (pointer, rollout, halt, floor)                                                                                             |
| **pack set**          | a resolved, locked list of exact pack releases that satisfies all constraints for one selector (channel × `contentApi` × platform × variant)                                          |
| **content index**     | the Worker-signed, device-less, short-lived document per content channel listing pack sets, rollout, halts, floors, per-outlet availability and available deltas (`pkey-content+jws`) |
| **`contentApi`**      | an integer an app build declares for the content shape its code expects; bumped when code and content must change together                                                            |
| **transport**         | how a release's bytes reach the device: `embedded`, `pkey-cdn`, `apple-ba`, `play-pad`, `steam-depot`, `msix-optional`, `flatpak-ext`, `web`                                          |
| **transport binding** | the platform's identity for a release on an outlet (Apple asset pack id + version, Steam depot/manifest, PAD pack + versionCode, …) and its state                                     |
| **patch strategy**    | how an update is obtained: `noop`, `platform`, `chunk`, `delta`, `engine-delta`, `full`                                                                                               |
| **install plan**      | the client's chosen strategy, byte/request/disk estimates and fallbacks for one pack update                                                                                           |
| **seed**              | any verified local payload whose chunk index is known, and which can therefore supply reusable chunks. Embedded packs and every installed pack are seeds                              |
| **marker**            | a signed `.pkey/pack.json` inside platform-delivered payloads, binding them to a pack release                                                                                         |
| **activation**        | `hot` (usable immediately) or `restart` (takes effect next boot; e.g. Godot PCKs cannot be unmounted)                                                                                 |

---

## 3. Object model

```text
Product
 ├─ PackDefinition        .pkey/content.yaml → D1 content_packs (operator-owned fields guarded)
 │    id, type, variants, compat axes, policy, entitlement, transports per outlet, patch config
 │
 ├─ PackRelease           CI-signed pkey-pack+jws, immutable, fetched by hash
 │    ├─ payload           blobs/sha256/<h>             (single-file types; full-download object)
 │    ├─ files index       blobs/sha256/<h>             pkey-files/1
 │    ├─ chunk index       blobs/sha256/<h>             pkey-chunks/1 (binary, 48-byte records)
 │    ├─ chunk bundles     bundles/sha256/<h>           4–16 MiB, file order, immutable
 │    ├─ deltas[]          deltas/<from>/<to>.<method>  optional, added lazily for hot pairs
 │    └─ requires/depends  engine, format, contentApi, features, platform, locale, packs, conflicts
 │
 ├─ TransportBinding      D1 content_bindings: release × outlet → platform ids + state
 │                        (fed by CI reports and connectors, e.g. ASC BACKGROUND_ASSET_* webhooks)
 │
 ├─ PackSet               resolved lock per (channel, contentApi, platform, variant)
 │
 └─ ContentIndex          Worker-signed pkey-content+jws per content channel:
                          seq, expiresAt, sets[], rollout, halted, floors, availability, deltas
```

**Two ways to consume content.**

- **Locked:** an app build's release manifest (`pkey-release+jws`, README §3.3) pins exact pack
  releases. This is deterministic, like Steam's "build = set of depot manifests" and Unity's
  catalog per player build.
- **Floating:** the build follows a content channel. The content index hands it the pack set for
  its `contentApi`, which lets content ship between code releases (seasonal events, balance data,
  new cosmetics).

A build can mix the two: core packs locked, event packs floating.

---

## 4. Pack types and handlers

### 4.1 Handler contract (every SDK)

| Hook                            | Contract                                                                                                                                    |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `formats()`                     | the `(type, formatVersion)` pairs it can install and activate (e.g. `godot.pck` v2–v4 on 4.7)                                               |
| `plan(installed, target, caps)` | type-specific strategy preferences and cost inputs                                                                                          |
| `stage(plan)`                   | write into `staging/<planId>/`; resumable and journaled                                                                                     |
| `verify(staged)`                | chunk SHA-256 while writing; per-file SHA-256; payload SHA-256; type checks (PCK header engine ≤ running; data-only file list; path safety) |
| `activate(staged)`              | move to `store/`, swap the active-set pointer atomically. `hot` activates now; `restart` at next boot                                       |
| `deactivate(release)`           | hot types only                                                                                                                              |
| `rollback()`                    | re-point to `previous`                                                                                                                      |
| `uninstall(release)`            | remove if not a GC root; platform-owned payloads go through the platform's API                                                              |
| `roots()`                       | what must survive GC                                                                                                                        |

**Custom types.** A product may declare `type: custom.<name>`. The server treats the payload
opaquely (a file or a tree), and the game registers the handler with the SDK
(`PolarisKey.content.register_handler("custom.dialogue", MyHandler.new())`). Transport, patching,
signing and GC come for free; only activation is the game's.

### 4.2 Initial type registry

| Type                          | Payload                                                                                                                                                        | Activation                                                     | Preferred strategies (`full` always last)                                                                         | Type-specific verify / compat                                                                                                                 |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `godot.pck`                   | one `.pck`, **uncompressed entries** for chunkability                                                                                                          | restart (mount in `mountOrder` at boot, `replace_files=false`) | platform → chunk → `engine-delta` (Godot delta PCK layered over its exact base) → full. See §7.3 for measurements | `engine`, `pckFormat`, texture feature; data-only list at publish and at mount; no `uid://` into packs                                        |
| `godot.zip`                   | a zip mounted by `load_resource_pack` (stored entries)                                                                                                         | restart                                                        | as `godot.pck`                                                                                                    | as `godot.pck`                                                                                                                                |
| `files.tree`                  | a directory tree                                                                                                                                               | hot (versioned dir + pointer swap)                             | file-level reuse → chunk for large files → full                                                                   | path safety (no `..`, absolute paths or symlink escapes), modes                                                                               |
| `archive.zip` / `archive.tar` | archive as a **build input**, delivered and installed as `files.tree` unless the consumer needs the archive itself (then stored entries, deterministic re-zip) | as `files.tree`                                                | as `files.tree`                                                                                                   | zip-slip checks                                                                                                                               |
| `audio.bank`                  | FMOD `.bank`, Wwise `.bnk`, or a Godot audio pack                                                                                                              | hot if the middleware can reload, else restart                 | chunk → full                                                                                                      | middleware version                                                                                                                            |
| `l10n.table`                  | `.translation`, PO, CSV or JSON (small)                                                                                                                        | hot (`TranslationServer`)                                      | full (compressed transfer) → delta for large tables                                                               | BCP-47 locale, key-schema version                                                                                                             |
| `data.json`                   | JSON documents (balance tables, event definitions)                                                                                                             | hot                                                            | full                                                                                                              | JSON Schema version. Tiny, frequently tuned values belong in **managed config** (signed config document, enforced/default states), not a pack |
| `ml.model`                    | GGUF, ONNX or safetensors                                                                                                                                      | hot (swap path after a load test)                              | chunk (larger average chunk) → full                                                                               | runtime, quantisation, RAM/VRAM needs                                                                                                         |
| `unity.addressables` (later)  | an Addressables catalog + bundles as a tree                                                                                                                    | Addressables custom provider                                   | file-level reuse                                                                                                  | Unity version, player content version                                                                                                         |
| `custom.<name>`               | file or tree                                                                                                                                                   | game-registered                                                | as file or tree                                                                                                   | game-registered                                                                                                                               |

---

## 5. Versioning, channels, compatibility, dependencies

- **Versions:** each pack has semver `version` plus monotonic `seq`. Releases are immutable; a fix
  is a new release.
- **Channels:** content channels mirror release channels: a pointer per channel, optional
  `includes` (beta ⊇ stable), rollout basis points with salt, halt, floor (minimum version), and
  yank (resolvable only by explicit pin). The policy is operator-owned and survives resync.
- **Compatibility axes:** `engine` (range), type `formatVersion`, `contentApi` (range), `features`
  (e.g. `astc`), `platform`/`arch`, `locale`, `packs` (dependency ranges), `conflicts`.
- **Resolution happens on the server, at publish.**
  - When a release is published or a channel pointer moves, CI or a Worker job resolves one
    **pack set** per selector: the highest version of each pack satisfying every constraint, ties
    broken by `seq`.
  - Unsatisfiable selectors fail the publish; they never reach clients.
  - Clients verify pack sets but never solve them, which keeps the SDKs small and identical.
- **Atomic sets:** a device never runs a mixed set. The whole set pointer switches. Restart types
  apply at the next boot; hot types apply now.
- **Apple Background Assets special case:**
  - A newly live asset-pack version is used by **every installed app version**.
  - So the `contentApi` level is part of the asset-pack _identity_ (`foes.c3`), and resolution
    emits one Apple asset pack per supported `contentApi`.
- **Play Asset Delivery special case:**
  - PAD packs change only with a new `versionCode`.
  - They therefore act as a locked, embedded-like transport.
  - Floating content on Play arrives through `pkey-cdn` (data-only), subject to store policy.

---

## 6. Transports

A pack's transport is chosen per outlet in `.pkey/content.yaml` (`transports: {app-store: apple-ba, default: pkey-cdn}`).
A pack uses **one transport per outlet**, never a mix for the same pack on the same install.

| Transport       | Used on                                                                                        | Hosts the bytes                                                                    | Versioning and patching done by                         | How Polaris Key knows the installed version                                                                    | Notes                                                                                              |
| --------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `embedded`      | any build that ships content inside the app/depot/APK/IPA                                      | the build                                                                          | the build's own update                                  | the build stamp + marker                                                                                       | read-only baseline; also a **seed** for chunk patching of newer CDN releases                       |
| `pkey-cdn`      | direct desktop, sideload, Android direct/F-Droid, web, floating content anywhere policy allows | R2 via the gateway (Range, `Repr-Digest`, immutable caching; gated via the Worker) | Polaris Key (chunk / delta / full)                      | local install state                                                                                            | the universal fallback                                                                             |
| `apple-ba`      | App Store, TestFlight (Apple-hosted managed packs, OS 26+)                                     | Apple                                                                              | Apple (no documented differential; plan for whole-pack) | `AssetPackManager.localVersion`, the marker, and ASC `BACKGROUND_ASSET_VERSION_*` webhooks → transport binding | independent of app versions; Apple-reviewed; pack id carries `contentApi`; paid packs gated at use |
| `play-pad`      | Google Play                                                                                    | Google                                                                             | Google (asset patches with the app update)              | pack location + marker; versionCode                                                                            | tied to versionCode; fast-follow/on-demand need a plugin                                           |
| `steam-depot`   | Steam                                                                                          | Valve                                                                              | SteamPipe (1 MB chunk deltas)                           | depot manifest via GodotSteam; marker                                                                          | never write into the install dir; DLC depots for paid packs                                        |
| `msix-optional` | Windows App Installer / Store                                                                  | the package host                                                                   | MSIX block map (64 KB)                                  | package family + version                                                                                       | optional packages are serviced independently of the main app                                       |
| `flatpak-ext`   | Flathub                                                                                        | Flathub                                                                            | OSTree                                                  | ref + marker                                                                                                   | extensions as content                                                                              |
| `web`           | browser builds                                                                                 | R2 via the gateway                                                                 | Polaris Key (chunk / full) into OPFS or IndexedDB       | local state                                                                                                    | `Cache.put` rejects 206 responses; quotas and eviction; request `persist()`                        |

**Layering rule.** Wherever we author the pack contents, the platform-delivered payload contains
`.pkey/pack.json`: pack id, version, release hash and files-index hash, with a detached JWS. After
the platform says "installed", the SDK verifies the marker, then hashes files against the signed
files index before activation (lazily for very large packs, always before mount). The platform
handles transfer; Polaris Key keeps identity, compatibility, entitlement and activation.

---

## 7. Patching

### 7.1 The strategy ladder and planner

```text
plan(target, installed, seeds, caps):
  if installed payload == target payload                  → noop
  if pack is bound to a platform transport on this outlet → platform   (ask the OS/store, then verify)
  candidates:
    chunk        if caps ∋ chunk/1 and target has a chunk index and any seed exists
                 bytes = Σ compressed length of chunks missing from all seeds
                 requests = contiguous runs of missing chunks per chunk bundle
    delta        for each published delta with from == installed payload and caps ∋ method
                 and memory need ≤ caps.memBudget
    engine-delta Godot delta PCK layered over the exact installed base (max stack depth 2)
    full         payload (or its compressed blob)
  cost = bytes + α·requests + β·peakDisk + γ·cpu(strategy)
  choose the minimum-cost feasible strategy; the fallbacks are the rest by cost, full last
  if peakDisk > freeDisk: offer "replace in place" (loses rollback), only with consent
```

- **Deterministic.** The planner is a pure function of (content index, installed state, seed
  indexes, capabilities). It becomes the corpus file `plan-matrix.json` (like `gate-matrix.json`
  and README §3.6's `update-matrix.json`), so every SDK chooses identically.
- **First install:** take the single full blob, then _record its chunk index as a seed_, so the
  next update is incremental without ever having downloaded chunks.
- **Cross-pack seeds:** a chunk can come from any installed pack or the embedded baseline. Moving
  assets between packs costs nothing.
- **Telemetry** of `{strategy, bytes, duration, fallbackUsed, failureStage}` finds hot `(from, to)`
  pairs. CI then generates deltas for those pairs only (Epic's A→B optimisation, butler's rediff).

### 7.2 What works best for which payload shape

| Payload shape                                                                    | Best strategy                                                        | Why                                                                             |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Container with **per-entry** compression (Godot PCK, Unreal IoStore, stored zip) | chunk (content-defined)                                              | resynchronises right after an edit; any old version → latest                    |
| Container with **whole-container** compression (deflated zip, `.tar.gz`, LZMA)   | fix the container: per-entry compression, or deliver as `files.tree` | defeats chunking _and_ deltas (Blizzard patches decoded content and re-encodes) |
| Directory tree                                                                   | file-level reuse by hash, then chunk inside large changed files      | cheapest, no container rebuild                                                  |
| Single large file                                                                | chunk (any old → latest); a delta only for hot pairs                 | deltas are pairwise and hold whole files in RAM                                 |
| Small file (under 4 MiB)                                                         | full                                                                 | request overhead dominates                                                      |
| Pack delivered by a platform                                                     | platform                                                             | the platform owns transfer and patching                                         |

Rule of thumb: full under 4 MiB; full plus one delta for small packs that change every release;
chunk sync from about 16 MiB up.

### 7.3 Godot, measured (pure GDScript, 4.7.2)

_Pending: the measurements from `notes/A6` (a re-run was interrupted by a container restart) will be summarised here._

---

## 8. Formats

Full JSON sketches are in `notes/E8 §5.4`. The essentials:

- **Pack definition** (`.pkey/content.yaml` → D1):
  - `packId`, `type`, `variants`, `contentApi`;
  - handler options (`mountOrder`, `prefixes`, `activation`);
  - policy (`required`, `delivery`, `cellular`, `keepPrevious`), `entitlement`, `channels`;
  - `transports` per outlet;
  - patch config (strategies, chunking parameters, delta bases);
  - `contentPolicy.dataOnly`.
- **Pack release** (`pkey-pack+jws`, CI release key or a delegated content key):
  - `packId`, `version`, `seq`, `type`, `variant`;
  - `payload {size, sha256, blob}`, `files {format, sha256}`, `chunks {format, sha256, params}`;
  - `deltas[]`, `requires`, `conflicts`, `entitlement`, `marker`, `provenance`.
  - Platform ids are **not** in here, because platforms assign them after signing. They live in
    transport bindings and the content index.
- **Files index** (`pkey-files/1`, JSON): `{path, size, sha256, mode, chunks[]}` per file.
- **Chunk index** (`pkey-chunks/1`, binary):
  - a 64-byte header, then fixed 48-byte little-endian records
    `id[32] | len u32 | clen u32 | bundle u32 | offset u32`;
  - parseable in GDScript with `PackedByteArray.decode_u32`;
  - ids are SHA-256 of **uncompressed** bytes; `clen == len` means stored raw.
- **Patch descriptor** (`pkey-patch/1`):
  - `from`/`to` hashes, `method` (`zstd-patch-from` | `hdiffpatch` | `bsdiff` |
    `godot-delta-pck`), `artifact`;
  - apply needs (`memBytes`, `tmpDiskBytes`, `minSdk`);
  - `layerOver` and `maxStack` for Godot delta PCKs.
- **Content index** (`pkey-content+jws`, Worker-signed, device-less):
  - `product`, `channel`, `seq`, `issuedAt`, `expiresAt`;
  - `sets[] {select, packs[] {id, version, release}, rollout}`;
  - `availability` per release per outlet (platform ids and state), `halted`, `floors`, `deltas`.
- **Client capabilities** (local; sent only to gated mints and telemetry, never needed by the
  public feed):
  - SDK, engine, platform, arch, outlet, `contentApi`;
  - `types`, `features`, `patchMethods`, `transports`;
  - HTTP abilities; free disk, memory budget, metered, background.
- **Install state** (`user://pkey/content/state.json`, temp + rename): `active`, `previous`,
  `inflight` (journal), `observed` (platform transports), `confirmedBootSeq`.

---

## 9. Client pipeline (every SDK)

1. **Preflight:**
   - Verify the chain content index → pack release (by hash) → files/chunk indexes (by hash).
   - Check type/format/compat and entitlement.
   - Check `freeDisk ≥ peakDisk` (Godot: `DirAccess.get_space_left()`) and the memory budget.
   - Disclose size (Apple 4.2.3(ii)) and ask on cellular where policy says so.
2. **Journal:** write `staging/<planId>/journal.json` with the strategy, targets and a completion
   bitmap.
3. **Fetch and copy:**
   - Copy reusable ranges from seeds, verifying each chunk.
   - Fetch missing runs by Range with `If-Range` on the chunk bundle's hash.
   - Decompress per chunk (zstd), verify, and write at the target offset into a pre-allocated
     `.part` file.
   - Checkpoint periodically.
4. **Verify:** per-file SHA-256, payload SHA-256, then type verification.
5. **Commit:** rename `.part` → `store/<sha>` on the same volume; write the new state by temp +
   rename.
6. **Activate:** hot types now; restart types at next boot (mount in order, `replace_files=false`).
7. **Confirm:** after a successful boot or smoke check, mark confirmed and GC. After N failed
   boots, roll back to `previous` and report it, so the channel can auto-halt.
8. **Resume:** on relaunch, the journal says what's done; completed ranges are re-hashed cheaply.

**Mobile.**

- GDScript `HTTPRequest` pauses with the app.
- Long downloads need a platform path (Background Assets; iOS background `URLSession` and Android
  WorkManager via the native plugins) or foreground UX with pause and resume.
- `essential` packs block boot; `prefetch` packs download in the background after boot; `onDemand`
  packs download on `content.ensure()`.

**Web.**

- Write partial data to OPFS or IndexedDB, not the Cache API (it rejects 206).
- Request `persist()` after engagement.
- Plan from scratch if storage was evicted.
- The whole pack set counts against the quota, and Godot keeps mounted `user://` files in memory,
  so keep web pack sets lean.

---

## 10. Server side

**Worker routes** (all new routes need an OpenAPI spec entry and a `routeCoverage` entry, rule 10):

| Route                                  | Purpose                                                                                                                                                       |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /<p>/content/<channel>/index.jws` | content index; public, edge-cached, short TTL                                                                                                                 |
| `GET /<p>/content/release/<sha>`       | pack release                                                                                                                                                  |
| `GET /<p>/content/blob/<sha>`          | indexes, payloads, chunk bundles, deltas: Range-capable, immutable, with `Repr-Digest`. Gated packs are served from a gated prefix and authorised per request |
| `POST /<p>/content/publish/*`          | trusted-publisher (GitHub OIDC) upload tickets, finalize (verify size and SHA-256), submit pack releases, move channel pointers                               |
| webhook ingestion                      | transport bindings (ASC `BACKGROUND_ASSET_VERSION_*`; CI reports for PAD/Steam/MSIX)                                                                          |
| `POST /<p>/devices/report`             | content telemetry (allowlisted keys)                                                                                                                          |

**D1:**

- `content_packs(product, pack_id, type, def_json, def_source)`
- `content_releases(product, pack_id, version, seq, release_sha256, payload_sha256, files_sha256, chunks_sha256, variant_json, requires_json, created_at, yanked)`
- `content_objects(hash, kind, size, created_at)` and `content_object_refs(release_sha256, hash)`
- `content_bindings(release_sha256, outlet, platform_ref_json, state, since, detail_json)`
- `content_sets(product, channel, select_json, set_json, rollout_bp, rollout_salt, halted, source)`

**R2:** `blobs/sha256/…`, `bundles/sha256/…`, `deltas/<from>/<to>.<method>`, bucket locks, plus a
separate gated prefix.

**GC:**

- An object is collectable when no release at or above the channel floors, and no pinned code
  release, references it (plus a grace period).
- Chunk bundles below about 50% live data are repacked into the next release's bundles, and the
  old bundle ages out.
- Deltas are disposable caches outside the hot-pair policy.

**CI tooling** (`pkey pack …` and the `polaris-key/publish` Action):

- `pkey pack build` builds the files index, content-defined chunks (FastCDC), chunk bundles and
  optional deltas against the last _N_ releases. It records the chunker version and parameters and
  never re-chunks history.
- `pkey pack verify` lints each type (data-only list for `godot.pck`, stored entries for zips, path
  safety) and signs with the release key or a delegated content key.
- Upload: new objects only (dedupe by hash).
- Per-transport steps:
  - `xcrun ba-package` + ASC Background Assets upload;
  - AAB asset-pack modules for PAD;
  - Steam depot build scripts;
  - MSIX optional packages.

  Each writes the marker and reports the binding.

---

## 11. Security

- **Signing** (README §3.3 unchanged):
  - The CI release key signs pack releases.
  - Optionally, the release key **delegates** a content key restricted to data-only types and a
    pack-id prefix, so a content team can publish without code-release power.
  - Types that can carry scripts (`godot.pck`, `godot.zip`) always need the release key, and
    data-only is enforced at publish and at mount.
- **What a compromise buys:**
  - The Worker signs only content indexes, so a compromise can choose only among CI-signed releases.
  - The CDN, Apple, Google or Valve can only withhold or corrupt bytes, which verification catches.
- **Hashes:** SHA-256 everywhere. Never inherit the weak hashes of the formats we wrap (Godot's
  per-file MD5, Steam/Epic SHA-1, Blizzard MD5, Riot 64-bit ids).
- **Entitlements:**
  - Gated packs' chunk bundles live under a gated prefix.
  - **Never share chunk bundles between gated and free packs** (a Range would leak content).
  - Use `private, no-store` or tokenised cache keys.
- **Paths:** tree handlers refuse `..`, absolute paths and symlink escapes; zip-slip checks.

---

## 12. Per-SDK integration

| SDK                        | Types (v1 → v3)                                                                             | Transports                                                                                          | Patch strategies                                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **Godot**                  | `godot.pck`, `godot.zip`, `files.tree`, `l10n.table`, `data.json`, `audio.bank`, `custom.*` | embedded, pkey-cdn, web; apple-ba (iOS plugin), play-pad (Android plugin), steam-depot (GodotSteam) | noop, platform, chunk (pure GDScript), engine-delta, full; zstd delta only via an optional native accelerator (§7.3) |
| **Swift** (macOS/iOS apps) | `files.tree`, `ml.model`, `data.json`, `l10n.table`                                         | apple-ba (native), pkey-cdn                                                                         | chunk, delta (native zstd), full                                                                                     |
| **Node / Electron**        | `files.tree`, `archive.*`, `ml.model`                                                       | pkey-cdn                                                                                            | chunk, delta (zstd/HDiffPatch), full                                                                                 |
| **Python** (tools, ML)     | `files.tree`, `ml.model`, `data.json`                                                       | pkey-cdn                                                                                            | chunk, delta, full                                                                                                   |
| **React / web**            | `files.tree`, `data.json`, `l10n.table`                                                     | web                                                                                                 | chunk (OPFS), full                                                                                                   |
| **Kotlin** (proposed)      | `files.tree`, `ml.model`                                                                    | play-pad, pkey-cdn                                                                                  | chunk, delta, full                                                                                                   |
| **Unity** (later)          | `unity.addressables`                                                                        | pkey-cdn (custom provider)                                                                          | file-level reuse                                                                                                     |

`client-core` gains the shared pieces:

- index verification;
- the planner (`plan-matrix.json`);
- chunk-index parsing (`chunkIndexCases`);
- the install-state machine.

Per-type handlers stay per SDK.

---

## 13. Experiences

- **Developer:**
  - `.pkey/content.yaml` declares packs.
  - `pkey pack build|verify|publish|promote|yank` runs locally or in the Action.
  - The Godot export plugin lists packs per preset (embedded / lean) and sets transports per outlet.
  - In code, `PolarisKey.content.ensure(["event.halloween"])` returns progress signals and a
    result, and `PolarisKey.content.is_available(id)` backs UI badges.
- **Administrator.** The console's Content section shows:
  - packs → releases (size, dedupe ratio against the previous release, types, variants);
  - channels and pack sets (per selector), rollout/halt/floor/yank;
  - transport states per outlet (e.g. "App Store asset pack `foes.c3` v7: in review");
  - hot delta pairs and generated deltas;
  - failure and fallback rates.
- **Player:**
  - Required packs load inside `PKeyBoot` (README §5.8) with size disclosure and cellular choice.
  - Optional packs stream in the background, with per-item "downloading" badges.
  - Offline play works with the installed set.
  - Updates are mostly small (chunk reuse).
  - Content never blocks play once the required set is present.

---

## 14. Diceroll mapping

| Pack                                                 | Type                                  | Transport (App Store / Play / Steam / direct / web)                     | Notes                                                                               |
| ---------------------------------------------------- | ------------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `diceroll.ui`                                        | `godot.pck`                           | embedded / embedded / embedded / pkey-cdn / pkey-cdn                    | fonts, UI sfx, rendered icons                                                       |
| `diceroll.core3d`                                    | `godot.pck`                           | embedded (v1) → apple-ba / embedded / steam-depot / pkey-cdn / pkey-cdn | required                                                                            |
| `diceroll.audio`                                     | `godot.pck` or `audio.bank`           | apple-ba / embedded / steam-depot / pkey-cdn / pkey-cdn                 | prefetch; music could become `files.tree` of `.ogg` loaded at runtime               |
| `diceroll.foes`, `diceroll.nature`, `diceroll.extra` | `godot.pck`                           | as `core3d`                                                             | per-texture-family variants (`s3tc`, `etc2`/`astc`) fix today's S3TC-on-arm64 issue |
| `diceroll.l10n.<locale>` (future)                    | `l10n.table`                          | pkey-cdn everywhere (hot)                                               | ship new languages between app releases                                             |
| `diceroll.events.<name>` (future)                    | `godot.pck` (data-only) + `data.json` | apple-ba / pkey-cdn / …                                                 | floating on an `events` content channel, `contentApi`-gated                         |
| `diceroll.supporter.skins` (future)                  | `godot.pck`                           | pkey-cdn (gated) direct; IAP-gated on stores                            | entitlement `extras.diceSkins` via the commerce bridge                              |

Diceroll keeps `packs.gd` and `needs.gd` (content id → packs) and its `Content.available()` gating.
They read `PolarisKey.content` state instead of a hand-rolled store.

---

## 15. Phasing and effort

| Phase  | Ships                                                                                                                                                                                                                                                                                                         | Size   | Wire / corpus impact (plan mode)                                                                                                                                   |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **v1** | `content` service skeleton; pack definitions; single-file packs (`godot.pck`, `files.tree` as a tar/zip build input); full downloads + one zstd N−1 delta for native SDKs; type registry and handler contract; transport bindings; marker file; install-state DB; locked consumption via the release manifest | 6–8 wk | `pkey-pack+jws`; corpus `packReleaseCases`, marker vectors                                                                                                         |
| **v2** | chunk indexes + chunk bundles on R2; chunk sync from seeds (pure GDScript); content channels with server-resolved pack sets (`pkey-content+jws`); floating consumption; rollout/halt/floor/yank for content; server GC and chunk-bundle repacking; `engine-delta` fallback                                    | 5–7 wk | `pkey-content+jws`; corpus `contentIndexCases`, `chunkIndexCases`, `plan-matrix.json`, `applyCases` (tampered chunk, wrong base, truncated chunk bundle); all SDKs |
| **v3** | more types (`l10n.table`, `data.json`, `audio.bank`, `ml.model`, `custom.*`, `unity.addressables`); lazy delta generation for hot pairs (R2 events → Queue → Workflow → Container); Compression Dictionary Transport on web; content-key delegation                                                           | 4–6 wk | delegation record; per-type verify vectors                                                                                                                         |

This replaces README P4's 7–9 weeks with **15–21 weeks across three increments**. v1 alone
unblocks Diceroll's content-streaming phases 1–2. v2 brings the small-update win.

---

## 16. Open questions and spikes

1. Are Apple asset-pack updates differential in practice? Measure in TestFlight.
2. Does Cloudflare's origin Range handling cover R2 custom-domain objects on our plan? Measure
   cold-miss behaviour and multi-range requests.
3. Chunk size for real Diceroll PCK history (32, 64 or 128 KiB), measured against zstd deltas.
4. GDScript SHA-256 and zstd throughput on low-end Android and in browsers.
5. Load-time cost of Godot delta PCK layers at stack depth 1–2 on mobile.
6. Which Steamworks calls expose installed depot manifests on the device?
7. Can a Unity custom resource provider enforce verification before bundles load?
