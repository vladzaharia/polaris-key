# Content packs: many versioned packs, many types, delivered through whatever is available

**Date:** 2026-09-30 · **Status:** research and proposal. Nothing here is implemented. ·
**Extends:** [README §3.7](README.md#37-content-packs-across-release-distribution-and-update),
which this document expands.

The main report first treated content as "Godot packs". This document generalises that into a
**product-agnostic content model**. Packs are handled **exactly like the application itself**,
across the same three services:

- **Release** records what exists: every pack is a release _deliverable_ with its own versions,
  channels, requirements, dependencies, CI-signed release records, patch artifacts and yanks.
- **Distribution** delivers it: our CDN, embedded, Apple Background Assets, Play Asset Delivery,
  Steam depots, MSIX optional packages, Flatpak or the browser. It also tracks availability,
  rollouts and halts per outlet.
- **Update** decides what an installed app should do: which pack set to have, and how to patch to
  it.

What this document covers:

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

**Eight principles:**

1. **A pack's identity is its signed manifest, not its transport.** A pack release is
   `(packId, version)`, and a CI-signed record pins its payload and file/chunk indexes by SHA-256.
   Whatever delivered the bytes (our CDN, Apple, Google, Steam, the browser, the app bundle),
   they must verify against that record.
2. **Everything below the channel pointer is immutable and content-addressed.** Only update's
   Worker-signed **channel feed** is mutable. It is short-lived, device-less and edge-cacheable, and
   it carries the app's release _and_ the resolved pack set.
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
8. **Every pack declares how it binds to the app.** `pinned` packs change only with an app
   release, `compatible` packs follow the app's `contentApi`, and `standalone` packs depend only on
   their own format. A transport can narrow a binding but never widen it, and publishing checks
   compatibility in both directions (§6).

**What this buys:**

- Diceroll's six packs become first-class, independently versioned units, as do future seasonal
  events, supporter skins, music packs and localisations.
- Store builds stay data-only and store-compliant.
- A typical update downloads only what changed. On a synthetic 36 MiB Godot pack, a v1→v2
  update is 0.60 MB via per-entry deltas (−94%) or 1.05 MB via chunk sync from any older version
  (−89%), all in pure GDScript (§8.3). The industry reports 85%+ chunk reuse between versions.
- The same model serves the Swift, Node/Electron, Python, React/web and a future Kotlin or Unity
  SDK.

**Cost.** There is no new service and no new document type: packs ride release, distribution and
update, and wire v4's two documents. Phased so v1 is small:

- v1 (pack deliverables, `pinned` packs and embedded baselines, full + file + per-entry delta, the
  handler contract, transports) is about 5–7 engineer-weeks.
- v2 (chunk sync, `compatible` and `standalone` packs resolved per live `contentApi`, pack
  floors, revocation, outlet readiness, GC) adds 6–8.
- v3 (more types, lazy deltas, content-key delegation) adds 4–6.

See §16.

---

## 1. Requirements

**Functional:**

| #   | Requirement                                                                                                                                                                                                                                                                                                              |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| F1  | A product declares **any number of packs**, each with a **type**                                                                                                                                                                                                                                                         |
| F2  | Each pack is a release **deliverable** with an **independent version line** (semver + a monotonic `seq`) and its own **channels** (`stable`, `beta`, event or custom), published independently of app releases                                                                                                           |
| F3  | Packs declare **compatibility**: engine, pack format, the app's content API level, platform/arch, GPU features (texture family), locale, and **dependencies** on other packs (semver ranges), plus conflicts                                                                                                             |
| F4  | Packs may have **variants**: texture family, locale, quality tier                                                                                                                                                                                                                                                        |
| F5  | Packs have a **delivery policy** (`essential` / `prefetch` / `onDemand`), a **required** flag and an activation mode (`hot` / `restart`)                                                                                                                                                                                 |
| F6  | Packs may be **entitlement-gated** (a licence `flag`); on store outlets the entitlement originates from store commerce (README §3.10)                                                                                                                                                                                    |
| F7  | Each pack is delivered through the **best transport available on the outlet**: platform-native where it exists or is mandatory, Polaris Key CDN elsewhere, embedded where shipped with the build                                                                                                                         |
| F8  | Updates are **patched** with the cheapest strategy the client supports, falling back to a full download                                                                                                                                                                                                                  |
| F9  | Each pack declares a **binding** to the app: `pinned` (the exact release is in the app's record), `compatible` (any release supporting the app's `contentApi`, so content ships between app releases) or `standalone` (depends only on its type's format). App releases may **hold** a compatible pack at a release (§6) |
| F10 | **Channel pointer, floor and yank** per pack (release), and **rollout and halt** per pack per outlet (distribution): the same machinery as the app (README §3.9)                                                                                                                                                         |
| F11 | **Offline:** installed and embedded packs work with no network; required-set checks are local                                                                                                                                                                                                                            |
| F12 | **Rollback** to the previous pack set after a failed boot or smoke check                                                                                                                                                                                                                                                 |
| F13 | **Garbage collection** on client and server                                                                                                                                                                                                                                                                              |
| F14 | **Telemetry**: strategy used, bytes, duration, failures, and the active `packSetId`, to find hot patch pairs, auto-halt and reproduce any device's content                                                                                                                                                               |
| F15 | **Lifecycle across app versions:** several live `contentApi` levels during store lag, pack floors and maintenance lines per level, revocation of dangerous content, content pre-staged with an app update, save compatibility (§6.7)                                                                                     |

**Non-functional:** data-only content on store builds; signed and verifiable offline; resumable;
atomic; anonymous and cacheable index; low client CPU; **workable in pure GDScript** (no native
extension required); within mobile and web storage limits.

---

## 2. Vocabulary

These nouns extend README §3.1 and avoid the reserved words ("catalog" is the config catalog,
"bundle" is the offline bundle, "surface" and "route" are Worker terms, "profile" is taken twice).
Where a borrowed industry term collides, it is renamed.

| Term                  | Meaning                                                                                                                                                                                                                                                                                  |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **pack**              | a release **deliverable** of kind `pack`: a named, independently versioned unit of content (`diceroll.foes`). The app is the deliverable of kind `app`                                                                                                                                   |
| **pack type**         | the payload format and its handler: `godot.pck`, `files.tree`, `archive.zip`, `audio.bank`, `l10n.table`, `data.json`, `ml.model`, `custom.<name>`, …                                                                                                                                    |
| **handler**           | the SDK component implementing a type's lifecycle (stage, verify, activate, …)                                                                                                                                                                                                           |
| **pack release**      | one release of a pack deliverable (and variant): an ordinary **release record** (`pkey-release+jws`) with `kind: pack`, signed by the CI release key or a delegated content key                                                                                                          |
| **variant**           | a release axis within a pack: texture family, locale, quality tier                                                                                                                                                                                                                       |
| **payload**           | the materialised bytes of a release: one file, or a file tree                                                                                                                                                                                                                            |
| **files index**       | per-file path, size and SHA-256 of a payload (`pkey-files/1`)                                                                                                                                                                                                                            |
| **chunk index**       | the CI-computed chunking of a payload: chunk id (SHA-256), length, compressed length, bundle and offset (`pkey-chunks/1`, binary)                                                                                                                                                        |
| **chunk bundle**      | an immutable 4–16 MiB container of compressed chunks in file order, fetched by Range. It is named "chunk bundle" and never bare "bundle", which is the offline bundle                                                                                                                    |
| **channel**           | a pack's release channels: pointer, `includes`, floor and yank in release; rollout and halt per outlet in distribution. "Content channel" just means a channel of pack deliverables, e.g. `events`                                                                                       |
| **pack set**          | a resolved, locked list of exact pack releases that satisfies all constraints for one selector (channel × app × `contentApi` × platform × variant), identified by a content-addressed **`packSetId`**. A device's _active_ pack set is its app record's pinned packs plus the feed's set |
| **binding**           | how a pack's version relates to the app's: `pinned`, `compatible` or `standalone` (§6.1). Transports can narrow it on an outlet (§6.6)                                                                                                                                                   |
| **channel feed**      | update's Worker-signed, device-less, short-lived feed per channel (`pkey-feed+jws`). For packs it lists the resolved pack sets, plus distribution's per-outlet availability, rollout and halts, and the delta menu. There is no separate content document                                |
| **`contentApi`**      | an integer each app release declares for the content shape its code expects, bumped when code and content must change together. `compatible` packs declare the range they support (§6.2)                                                                                                 |
| **hold**              | an app release's override that keeps a `compatible` pack at one release, signed in the app's record                                                                                                                                                                                      |
| **revocation**        | a CI-signed record (`kind: revocation`) marking a release unusable and naming a replacement. Unlike a yank, devices that already have it stop using it                                                                                                                                   |
| **transport**         | how a release's bytes reach the device: `embedded`, `pkey-cdn`, `apple-ba`, `play-pad`, `steam-depot`, `msix-optional`, `flatpak-ext`, `web`                                                                                                                                             |
| **transport binding** | the platform's identity for a release on an outlet (Apple asset pack id + version, Steam depot/manifest, PAD pack + versionCode, …) and its state; an availability record owned by the **distribution** service (README §3.8)                                                            |
| **patch strategy**    | how an update is obtained: `noop`, `platform`, `delta`, `chunk`, `file`, `full` (§8)                                                                                                                                                                                                     |
| **install plan**      | the client's chosen strategy, byte/request/disk estimates and fallbacks for one pack update                                                                                                                                                                                              |
| **seed**              | any verified local payload whose chunk index is known, and which can therefore supply reusable chunks. Embedded packs and every installed pack are seeds                                                                                                                                 |
| **marker**            | a signed `.pkey/pack.json` inside platform-delivered payloads, binding them to a pack release                                                                                                                                                                                            |
| **activation**        | `hot` (usable immediately) or `restart` (takes effect next boot; e.g. Godot PCKs cannot be unmounted)                                                                                                                                                                                    |

---

## 3. Where packs live across the three services

```text
Product
 ├─ RELEASE — what exists
 │   ├─ Deliverable app                    kind app
 │   └─ Deliverable <packId> …             kind pack, pack type, variants, requirements, policy,
 │        │                                entitlement  (.pkey/release → release_deliverables)
 │        └─ Release (version, seq)        CI-signed pkey-release+jws, immutable, fetched by hash
 │             ├─ variant payload           artifact role payload        → blobs/sha256/<h>
 │             ├─ files index               artifact role files-index    → pkey-files/1
 │             ├─ chunk index               artifact role chunk-index    → pkey-chunks/1 (binary)
 │             ├─ chunk bundles             artifact role chunk-bundle   → bundles/sha256/<h>
 │             ├─ deltas[]                  artifact role delta          → deltas/<from>/<to>.<m>
 │             └─ requires/depends          engine, format, contentApi, features, platform, locale,
 │                                          packs, conflicts
 │   ├─ Channel policy per deliverable      pointer, includes, floor (per contentApi for packs), critical, yank
 │   ├─ Holds and revocations               per app release / CI-signed revocation records
 │   └─ Pack sets                           resolved lock per (channel, app, contentApi, platform, variant)
 │                                          → packSetId
 │
 ├─ DISTRIBUTION — how it reaches devices and outlets
 │   ├─ Transports per deliverable/outlet  pkey-cdn · embedded · apple-ba · play-pad · steam-depot
 │   │                                     · msix-optional · flatpak-ext · web
 │   ├─ Availability per release/outlet    platform ids + state (e.g. ASC BACKGROUND_ASSET_* webhooks)
 │   ├─ Rollout / halt per outlet
 │   ├─ Readiness per app release/outlet   holds an app release until its required packs are live there
 │   ├─ Delivery access (entitlement gating) and byte serving (Range, gated prefix, CORS)
 │   └─ Storefront listings where a storefront supports packs
 │
 └─ UPDATE — what the installed app should do
     ├─ Channel feed pkey-feed+jws          app release + pack set + availability/rollout/halts +
     │                                      floors + revocations + delta menu, per selector; bindings
     │                                      narrowed per outlet by transport
     ├─ Update decision (update-matrix)     app: none | packs | code-ready | binary | store | …
     └─ Pack install planning (plan-matrix) per pack: noop | platform | delta | chunk | file | full
```

**Three bindings** (full model in §6):

- **`pinned`:** an app release record (`pkey-release+jws`, README §3.3) names the exact pack
  release. This is deterministic, like Steam's "build = set of depot manifests" and Unity's
  catalog per player build, and the pack changes only with the app.
- **`compatible`:** the app release declares a `contentApi`; the channel feed hands it the
  release-resolved pack set for that level. Content ships between app releases (fixes, seasonal
  events, cosmetics).
- **`standalone`:** the pack depends only on its type's format (localisation tables, models), so
  every app with a handler gets it.

A build mixes them. The common pattern is an **embedded pinned baseline** with `compatible`
releases above it: offline-ready, store-safe, and still fast to fix.

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
(`PolarisKey.update.packs.register_handler("custom.dialogue", MyHandler.new())`). Transport, patching,
signing and GC come for free; only activation is the game's.

### 4.2 Initial type registry

| Type                          | Payload                                                                                                                                                        | Activation                                                                                                                         | Preferred strategies (`full` always last)                                                                                                                                                         | Type-specific verify / compat                                                                                                                                                                                   |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `godot.pck`                   | one `.pck`, **uncompressed entries** (compress on the wire or per chunk, never at rest)                                                                        | restart: mount in `mountOrder` at boot, from a new content-addressed path, after a directory check; never overwrite a mounted pack | platform → `delta` (per-entry `zstd --patch-from`, decoded by Godot's own engine and baked into a full pack) → `chunk` (file-aware) → `file` (changed entries + rebuild) → full. Measured in §8.3 | `engine`, `pckFormat`, texture feature; the whole-pack SHA-256 (Godot never checks its per-file MD5s); a **directory check before mount** (declared prefixes only; no scripts, `project.binary` or class cache) |
| `godot.zip`                   | a zip mounted by `load_resource_pack`                                                                                                                          | restart                                                                                                                            | full; `chunk` only for stored entries                                                                                                                                                             | as `godot.pck`, but avoid for updates: zips cannot express removals, ignore `replace_files` and cannot be mounted at an offset. Accept only when a third party requires it                                      |
| `files.tree`                  | a directory tree                                                                                                                                               | hot (versioned dir + pointer swap)                                                                                                 | file-level reuse → chunk for large files → full                                                                                                                                                   | path safety (no `..`, absolute paths or symlink escapes), modes                                                                                                                                                 |
| `archive.zip` / `archive.tar` | archive as a **build input**, delivered and installed as `files.tree` unless the consumer needs the archive itself (then stored entries, deterministic re-zip) | as `files.tree`                                                                                                                    | as `files.tree`                                                                                                                                                                                   | zip-slip checks                                                                                                                                                                                                 |
| `audio.bank`                  | FMOD `.bank`, Wwise `.bnk`, or a Godot audio pack                                                                                                              | hot if the middleware can reload, else restart                                                                                     | chunk → full                                                                                                                                                                                      | middleware version                                                                                                                                                                                              |
| `l10n.table`                  | `.translation`, PO, CSV or JSON (small)                                                                                                                        | hot (`TranslationServer`)                                                                                                          | full (compressed transfer) → delta for large tables                                                                                                                                               | BCP-47 locale, key-schema version                                                                                                                                                                               |
| `data.json`                   | JSON documents (balance tables, event definitions)                                                                                                             | hot                                                                                                                                | full                                                                                                                                                                                              | JSON Schema version. Tiny, frequently tuned values belong in **managed config** (signed config document, enforced/default states), not a pack                                                                   |
| `ml.model`                    | GGUF, ONNX or safetensors                                                                                                                                      | hot (swap path after a load test)                                                                                                  | chunk (larger average chunk) → full                                                                                                                                                               | runtime, quantisation, RAM/VRAM needs                                                                                                                                                                           |
| `unity.addressables` (later)  | an Addressables catalog + bundles as a tree                                                                                                                    | Addressables custom provider                                                                                                       | file-level reuse                                                                                                                                                                                  | Unity version, player content version                                                                                                                                                                           |
| `custom.<name>`               | file or tree                                                                                                                                                   | game-registered                                                                                                                    | as file or tree                                                                                                                                                                                   | game-registered                                                                                                                                                                                                 |

---

## 5. Versions, channels and compatibility (general rules)

- **Versions:** each pack has semver `version` plus monotonic `seq`. Releases are immutable; a fix
  is a new release.
- **Compatibility axes:** `engine` (range), type `formatVersion`, `contentApi` (range), `features`
  (e.g. `astc`), `platform`/`arch`, `locale`, `packs` (dependency ranges), `conflicts`.
- **Resolution happens on the server** (§6.3). Unsatisfiable selectors fail the publish; clients
  verify pack sets but never solve them.
- **Atomic sets:** a device never runs a mixed set. The whole set pointer switches; restart types
  apply at the next boot, hot types now.

---

## 6. App ↔ pack relationships: binding, compatibility and lifecycle

Packs live in Release beside the app, so the relationship between an **app release** and the
**pack releases** it runs with is the heart of the model. Three questions are independent and
must not be conflated:

| Axis                | Question                                                | Values                                                           | Owner                                 |
| ------------------- | ------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------- |
| **Binding**         | which pack _version_ does a given app release run with? | `pinned`, `compatible`, `standalone` (§6.1)                      | release                               |
| **Delivery policy** | _when_ do the bytes arrive?                             | `essential`, `prefetch`, `onDemand`; plus `required`/optional    | release (declared), update (executed) |
| **Transport**       | _which route_ carries the bytes on this outlet?         | `embedded`, `pkey-cdn`, `apple-ba`, `play-pad`, `steam-depot`, … | distribution                          |

Some transports **constrain** binding (§6.6); the effective binding on an outlet is the declared
binding narrowed by what the transport can do.

### 6.1 Binding modes

| Mode             | Meaning                                                                                                                                                                       | Updates without an app release?                                        | Use for                                                                                                                                                                                | Trade-off                                                                                                  |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **`pinned`**     | the app release record lists the exact pack release (hash) it runs with                                                                                                       | **no**: a new pack version reaches devices only with a new app release | content tightly coupled to code (scenes wired to scripts, save-format-critical data), anything on transports that only update with the app, anything you want reviewed with the binary | fully deterministic and reproducible; slow to fix, since a bad pinned pack needs an app release            |
| **`compatible`** | the app release declares a content API level (`contentApi`); pack releases declare which levels they support; a device gets the newest compatible pack release on its channel | **yes**, within the compatibility window                               | most downloadable content: art, audio, foes, biome dressing, balance data, events                                                                                                      | fast fixes and content drops; needs compatibility discipline and maintenance lines per `contentApi` (§6.7) |
| **`standalone`** | the pack depends only on its **type's format version**, not on the app's content API                                                                                          | **yes**, for every app with a handler for that type                    | localisation tables, ML models, data with its own schema version                                                                                                                       | simplest; unsuitable for anything that references code or content ids that change with the app             |

- **Baseline + compatible.** This is the common real-world combination.
  - The app **embeds** a pinned baseline (offline first run; store-safe; the seed for patching),
    and the pack is `compatible` above it.
  - The baseline acts as an implicit floor and offline fallback.
  - Newer compatible releases replace it when available.
  - This is Diceroll's content-streaming design: packs embedded everywhere in phase 1, remote
    updates on top later.
- **Per-app-release overrides.** An app release may **hold** a compatible pack at a specific
  release, e.g. "1.5.2 pins `foes@1.4.3` because 1.4.4 breaks a quest". This is recorded in the
  CI-signed app release record, so it is as trustworthy as a pin.
- **Required vs optional.** `required` packs must be present, in some compatible release, before
  the app reaches READY. Optional packs (DLC, events, high-res variants) degrade gracefully. This
  is independent of binding.

### 6.2 The compatibility contract: `contentApi`

- **One integer per app deliverable, bumped when the code expects a different content shape.**
  - Examples: new node or resource types; renamed resource paths or content ids; changed data
    schemas; removed content the code still references.
  - The app release record carries it: `content.contentApi: 4`.
- **Pack releases declare what they support:** `requires.contentApi: {app: ">=3 <5"}`, keyed by app deliverable, plus
  engine range, type `formatVersion`, features and pack dependencies.
- **Named contracts** (`contracts: {scenes: 4, balance: 7}`) are the extension point for large
  products whose content families evolve independently. Start with one integer.
- **Bump discipline, with help from CI.** Like Expo's `runtimeVersion` "fingerprint" policy, the
  publish step can compute a **content-interface fingerprint** from what the code references. For
  Diceroll that is its content-id registry (`needs.gd`) and the path prefixes it loads. It warns
  when the fingerprint changes but `contentApi` did not.
- **Engine compatibility** is separate from `contentApi`. Imported Godot resources are
  engine-`major.minor`-specific, so an engine upgrade forces new pack releases even when the
  content shape is unchanged. Treat it as a hard requirement axis (`requires.engine`), resolved
  alongside.

### 6.3 Resolution: what the server computes

On every publish, pointer move, floor change or yank, **release**:

1. **Collects the live app releases:** every non-yanked app release at or above its channel's
   floor. The floor, not store availability, decides what is live. Store lag is covered because
   an operator never raises the floor above what a store still serves (App Store may serve 1.4
   while direct serves 1.5). Release never reads distribution, which keeps the dependency chain
   release ← distribution ← update one-way.
2. **Derives the live `contentApi` levels** from those releases, and the **pinned sets** from
   their records.
3. **For each** (channel, app deliverable, `contentApi`, platform, variant), resolves a **pack
   set** over `compatible` and `standalone` packs:
   - the highest release of each pack satisfying every requirement and dependency;
   - ties broken by `seq`;
   - honouring floors, yanks, holds and the channel's `includes`.
4. **Stores** each set with a content-addressed **`packSetId`**. Update publishes the sets into
   the channel feed, keyed by `contentApi`, and narrows each pack's binding per outlet by the
   transport distribution has configured there (§6.6).

Pinned packs need no feed entry: they are already in the app's signed record.

A device therefore resolves nothing:

- **Pinned packs** come from its own app release record.
- **Compatible and standalone packs** come from the feed entry for its `contentApi`, platform
  and variant, unless its outlet's transport narrows them to pinned.
- The union is its **active pack set**, identified by a hash it reports in telemetry and shows in
  diagnostics.

### 6.4 Publishing checks, in both directions

**Publishing a pack release** (a dry run is always available: `pkey release publish --dry-run`):

- For every live `contentApi` in the pack's declared range, re-resolve the would-be sets.
- **Fail** on unsatisfied dependencies, missing variants for a live platform, a removal of content
  ids that the previous release `provides` without a `contentApi` bump (§6.7), or a data-only
  violation.
- **Report** exactly which app releases and outlets will receive it, and what each device's set
  becomes.

**Publishing an app release:**

- Pins and holds must reference existing, non-yanked pack releases whose requirements the app
  satisfies.
- Every `required` compatible pack must have **at least one** compatible release on each of the
  app's channels. Otherwise the new app would boot without required content.
- Report the resulting sets.

**Outlet readiness** (distribution):

- An app release must not go live on an outlet before its required pack set is available through
  that outlet's transport.
- Transports that ship inside the build (`embedded`, `play-pad`, `steam-depot` builds) are ready
  by construction.
- For `apple-ba`, the asset packs for the new `contentApi` must be uploaded and approved.
  Distribution therefore **holds** the app release on App Store until they are, and shows the
  blocker in the Distribution matrix. For outlets Polaris Key cannot hold (a manual store release),
  it warns.
- For `pkey-cdn`, the set is ready as soon as its blobs are published.

### 6.5 Channels across deliverables

- **Each deliverable has its own channels**, with the same semantics everywhere: pointer,
  `includes`, floor, yank; rollout and halt per outlet in distribution.
- **Channel mapping.** By default an app on channel `beta` consumes each pack's `beta` channel,
  falling back through `includes` (beta ⊇ stable). The app release record can map pack families to
  other channels, e.g. `packChannels: {"diceroll.events.*": events}`, so every app channel
  subscribes to the `events` channel for event packs.
- **Testers.**
  - Access to beta _app_ builds stays the licence `channels` entitlement.
  - Access to beta _packs_ without a beta app uses the same entitlement, scoped by deliverable
    (`channels: {app: [stable], "diceroll.*": [stable, beta]}`).
  - Neither can widen what the outlet allows: a store build never downloads scripts.

### 6.6 Transport-imposed binding (per outlet)

| Transport                 | Pinned                                                                                     | Compatible / standalone                                                                                                           | Consequence                                                                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `embedded`                | ✓ (the build's baseline)                                                                   | as a **baseline** under a CDN overlay                                                                                             | always offline-ready; the seed for patching                                                                                            |
| `pkey-cdn`, `web`         | ✓                                                                                          | ✓                                                                                                                                 | the only transports with every mode on every outlet where policy allows downloads                                                      |
| `apple-ba` (Apple-hosted) | impractical: it would need an asset pack id per app release, within Apple's 200-pack limit | ✓, **with `contentApi` in the asset-pack id** (`foes.c3`), because a live asset-pack version switches every installed app version | resolution emits one asset pack per live `contentApi`; retire old ones promptly (quota)                                                |
| `play-pad`                | ✓ (tied to `versionCode`)                                                                  | ✗: packs change only with a new app bundle                                                                                        | a `compatible` pack on Play is effectively pinned. To float on Play, route that pack through `pkey-cdn` (data-only, policy permitting) |
| `steam-depot`             | ✓ (a build is a set of depot manifests)                                                    | ✓ via **content-only builds** that change just the pack's depot on a branch; SteamPipe deltas keep them small                     | distribution publishes content-only Steam builds when a compatible pack moves                                                          |
| `msix-optional`           | ✓                                                                                          | ✓ (optional packages are serviced independently; related sets bind versions)                                                      | good fit for Windows Store content                                                                                                     |
| `flatpak-ext`             | ✓                                                                                          | ✓ (extensions update independently)                                                                                               | —                                                                                                                                      |

**Effective binding** = declared binding ∧ transport capability. Update evaluates it per outlet
when it composes the feed, from release's sets and distribution's transports. The console shows it per cell, e.g. "compatible (pinned by Play Asset Delivery)".

### 6.7 Lifecycle implications

1. **App update that changes `contentApi`.**
   - _Self-updating outlets_ (desktop direct, sideload): the update decision returns `binary` with
     a **pre-stage list**. The new pack set downloads beside the new binary or code pack, and both
     activate together at the next boot. The new app never starts with the old content shape.
   - _Store outlets_: the new binary arrives first. At boot, `PKeyBoot` sees a new `contentApi`
     and fetches the required set before READY, with size disclosure (Apple 4.2.3(ii)).
     - **Recommendation:** store builds _embed_ the baseline of every required pack, so a store
       update is always playable offline and fetching only improves content.
     - With `apple-ba`, the App Store downloads essential asset packs at install/update time,
       which is the ideal case.
2. **Pack-only update** (compatible/standalone): it arrives through the feed and activates by the
   type's mode (restart types at next boot, hot types now). It never requires an app update.
3. **Floors.**
   - An app floor forces an app update, as today.
   - A **pack floor** is set **per `contentApi` line** (e.g. "foes ≥ 1.4.2 for contentApi 4;
     ≥ 1.3.4 for contentApi 3"). A fix can then be backported to an older content line instead of
     stranding those players.
   - If a floor has no compatible release for a device's `contentApi`, the decision is
     `blocked(content-floor)`. That leads to the store prompt or binary update, the same UX as an
     app floor, with a precise reason.
4. **Maintenance lines.** While an older `contentApi` is live anywhere (typically the store lag
   window), packs may need patch releases on that line. Recommended versioning: bump the pack's
   **major** when it moves to a new `contentApi` (foes 1.x ↔ contentApi 3, 2.x ↔ contentApi 4).
   Patch releases then read naturally per line.
5. **Rollback.**
   - Boot-guard rollback of an app update reverts the binary **and** the pack set activated with
     it; they switched together.
   - A pack-only rollback (failed boot after a pack set change, or a distribution halt) reverts the
     pack set alone.
   - The previous set is always kept until the new one is confirmed.
6. **Yank vs revoke.**
   - **Yank** means "stop newly serving". Devices that already run the release keep it. Pins in
     signed app records cannot be changed by the Worker, so a yanked _pinned_ pack stays with its
     app until an app release replaces it.
   - For genuinely dangerous content, **revoke** is a CI-signed release record that marks the pack
     release unusable and names a replacement. The Worker cannot fabricate one, which preserves
     the two-signer property. SDKs refuse to mount a revoked release, and swap in the replacement
     if it is compatible; otherwise the decision is `blocked(revoked-content)`.
   - Pinned content is safe and slow to fix; compatible content is fast to fix. That is the core
     trade-off to weigh per pack.
7. **Retention and GC.** A pack release, and its chunks, stays downloadable while any live app
   release pins it, or any live `contentApi` resolves to it, on **any** outlet. Beyond that, keep
   it through a grace period and until telemetry shows the installed base has moved on. On Apple,
   the 200-asset-pack and 200 GB quotas make retiring old `contentApi` asset packs a routine chore
   that distribution should automate.
8. **Save compatibility.**
   - Saves reference **content ids**, never paths.
   - A pack release may list the ids it `provides`. Publishing a release that **removes** a
     provided id requires either a `contentApi` bump or an explicit `removes` acknowledgement.
     Saves that reference a removed id then fail loudly in CI instead of silently for players.
   - `provides` also powers the SDK's `is_available(id)` and "Continue (downloading 12 MB…)" UX
     (Diceroll's `Content.available()` / `needs.gd`).
9. **Entitlements are per deliverable, not per version.**
   - Buying `diceroll.supporter.skins` entitles every compatible release of it, across app
     updates and `contentApi` lines.
   - The commerce bridge maps a store product (IAP, Play, Steam DLC) to the deliverable.
   - Distribution enforces entitlement at delivery. Update hides unentitled optional packs from the
     plan.
10. **Mandatory binary update pending.** When the decision is a **mandatory** `binary` or `store`
    update that changes `contentApi`, the SDK skips optional pack downloads for the old level and
    fetches only what is needed to run now. The Diceroll rule that "the binary supersedes content"
    becomes an explicit decision-matrix row.
11. **Multiple consumers of one pack set.**
    - A product may have several app deliverables (game client, dedicated server, level editor),
      each with its own `contentApi`.
    - Packs declare which apps they support (`requires.contentApi: {client: ">=4", server: ">=2"}`).
    - Where peers must agree, e.g. multiplayer matchmaking, they compare **`packSetId`**. Server
      SDKs (Node, Python) resolve the same set as clients because they read the same feed.
12. **Web.** No store gate, so compatible and standalone packs are the norm. Each web deployment
    is an app release (pinned baseline); packs float above it.
13. **Diagnostics and support.** Every device reports `appRelease + packSetId`. Support can
    reproduce any device's exact content, and pin a device, or a cohort through distribution's
    rollout salt, to a set.

### 6.8 Diceroll, worked through

| Scenario                                                                                                                     | What happens                                                                                                                                                                                                                                                                                            |
| ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App **1.5** (`contentApi` 4) is live on direct and Play; App Store still serves **1.4** (`contentApi` 3), with 1.5 in review | Live levels are {3, 4}. `diceroll.foes` has 1.x (requires 3) and 2.x (requires 4). The stable feed carries sets for both. On iOS, asset packs `foes.c3` and `foes.c4` both exist, and distribution **holds** 1.5 on the App Store until `foes.c4` is approved                                           |
| A bug in `diceroll.foes` 2.0.0                                                                                               | Publish 2.0.1 (compatible). Distribution rolls it out per outlet (25% → 100%). Play devices with `foes` in Play Asset Delivery stay on 2.0.0 until the next app bundle, unless `foes` is routed through `pkey-cdn` on Play                                                                              |
| The same bug also in the 1.x line                                                                                            | Publish 1.3.4 on the `contentApi` 3 line and set the floor "≥ 1.3.4 for contentApi 3". App Store 1.4 players get it without an app update                                                                                                                                                               |
| Halloween event                                                                                                              | `diceroll.events.halloween` (compatible, `requires.contentApi: {app: ">=3"}`, optional, `onDemand`) on the `events` channel. Every app channel maps event packs to `events`. Players on 1.4 and 1.5 both get it; on iOS via `events_halloween.c3`/`.c4` or `pkey-cdn` (data-only, with size disclosure) |
| New French localisation                                                                                                      | `diceroll.l10n` is `standalone` (`l10n.table` format v1). Publishing `fr` reaches every app version immediately; hot activation through `TranslationServer`                                                                                                                                             |
| Supporter skins                                                                                                              | `diceroll.supporter.skins` is compatible, optional and entitled (`extras.diceSkins`). Owners get new skin releases automatically; non-owners never see them in a plan                                                                                                                                   |
| Godot 4.8 upgrade                                                                                                            | Every `godot.pck` pack needs new releases (`requires.engine` changes). App 1.6 bumps the engine; resolution fails the publish until new pack releases for engine 4.8 exist                                                                                                                              |
| Exploit fixed only in content                                                                                                | A pack floor for `contentApi` 4. Devices on `contentApi` 3 with no backport get `blocked(content-floor)` → store prompt to 1.5                                                                                                                                                                          |

### 6.9 Record and table changes

- **App release record** (`pkey-release+jws`, `kind: app`) gains
  `content: {contentApi, pins[{pack, release}], holds[{pack, release}], expects[{pack, required}], packChannels}`.
- **Pack deliverable definition** gains `binding` (`pinned` | `compatible` | `standalone`),
  `required`, `baseline` (embedded baseline expected), `requires` defaults and `provides`
  policy.
- **Pack release record** (`kind: pack`) gains `requires.contentApi.<app>`,
  `requires.engine`, `requires.packs`, `formatVersion`, optional `provides[]` and `removes[]`.
- **Revocation record:** a CI-signed `pkey-release+jws` with `kind: revocation` naming a release
  hash and an optional replacement.
- **Release tables:**
  - `release_sets` keyed by (channel, app deliverable, `contentApi`, platform, variant) with
    `pack_set_id`;
  - `release_channel_policy` floors keyed per (deliverable, channel, `contentApi`);
  - `release_holds`.
- **Distribution:** `dist_readiness(app_release, outlet, blocking_pack_release, state)`.
- **Update's feed** carries `packSets: {contentApi → {packSetId, packs[]}}` per selector, pack
  floors per `contentApi`, revocations in force, and per-outlet binding narrowing.
- **Update decision matrix** gains:
  - `packs` (apply a set);
  - `binary` with `prestage[]`;
  - `blocked(content-floor | revoked-content | app-floor)`;
  - the mandatory-binary-supersedes-packs rows.
- **Console:**
  - a **compatibility matrix** (app releases × pack releases: pinned, held, compatible,
    incompatible, revoked), overlaid with per-outlet liveness;
  - a **"what does this device get?"** simulator (app release × outlet × platform × variant →
    pack set);
  - readiness blockers in the Distribution matrix.

---

## 7. Transports

Transports are **distribution** configuration: a pack's transport is chosen per outlet in
`.pkey/distribution` (`transports: {packs: {app-store: apple-ba}, default: pkey-cdn}`).
A pack uses **one transport per outlet**, never a mix for the same pack on the same install.

| Transport       | Used on                                                                                                       | Hosts the bytes                                                                    | Versioning and patching done by                         | How Polaris Key knows the installed version                                                                    | Notes                                                                                              |
| --------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `embedded`      | any build that ships content inside the app/depot/APK/IPA                                                     | the build                                                                          | the build's own update                                  | the build stamp + marker                                                                                       | read-only baseline; also a **seed** for chunk patching of newer CDN releases                       |
| `pkey-cdn`      | direct desktop, sideload, Android direct/F-Droid, web, compatible and standalone packs anywhere policy allows | R2 via the gateway (Range, `Repr-Digest`, immutable caching; gated via the Worker) | Polaris Key (chunk / delta / full)                      | local install state                                                                                            | the universal fallback                                                                             |
| `apple-ba`      | App Store, TestFlight (Apple-hosted managed packs, OS 26+)                                                    | Apple                                                                              | Apple (no documented differential; plan for whole-pack) | `AssetPackManager.localVersion`, the marker, and ASC `BACKGROUND_ASSET_VERSION_*` webhooks → transport binding | independent of app versions; Apple-reviewed; pack id carries `contentApi`; paid packs gated at use |
| `play-pad`      | Google Play                                                                                                   | Google                                                                             | Google (asset patches with the app update)              | pack location + marker; versionCode                                                                            | tied to versionCode; fast-follow/on-demand need a plugin                                           |
| `steam-depot`   | Steam                                                                                                         | Valve                                                                              | SteamPipe (1 MB chunk deltas)                           | depot manifest via GodotSteam; marker                                                                          | never write into the install dir; DLC depots for paid packs                                        |
| `msix-optional` | Windows App Installer / Store                                                                                 | the package host                                                                   | MSIX block map (64 KB)                                  | package family + version                                                                                       | optional packages are serviced independently of the main app                                       |
| `flatpak-ext`   | Flathub                                                                                                       | Flathub                                                                            | OSTree                                                  | ref + marker                                                                                                   | extensions as content                                                                              |
| `web`           | browser builds                                                                                                | R2 via the gateway                                                                 | Polaris Key (chunk / full) into OPFS or IndexedDB       | local state                                                                                                    | `Cache.put` rejects 206 responses; quotas and eviction; request `persist()`                        |

**Layering rule.** Wherever we author the pack contents, the platform-delivered payload contains
`.pkey/pack.json`: pack id, version, release hash and files-index hash, with a detached JWS. After
the platform says "installed", the SDK verifies the marker, then hashes files against the signed
files index before activation (lazily for very large packs, always before mount). The platform
handles transfer; Polaris Key keeps identity, compatibility, entitlement and activation.

---

## 8. Patching

### 8.1 The strategy ladder and planner

```text
plan(target, installed, caps):                  integers only; full spec in notes/A7 §4
  if an installed payload == target payload               → noop
  if the pack is bound to a platform transport here       → platform if caps has that transport,
                                                            else error plan.transport_unsupported
                                                            (never a silent CDN fallback)
  candidates, each with bytes and requests:
    delta   each published delta whose `from` is installed, method ∈ caps, memBytes ≤ memBudget
    chunk   chunk index + Σ clen of chunks missing from every seed; requests = 1 + request runs
    file    files index + gaps blob + missing file blobs (any installed release with a files index)
    full    the full blob (always a candidate)
  cost     = bytes + requestWeight × requests          requestWeight: a capability, default 16 KiB
  peakDisk = payload size + bytes; drop candidates with peakDisk > freeDisk
  choose by (cost, strategy rank, menu order); fallbacks in that order, full always last
```

- **Deterministic.** The planner is a pure integer function of (channel feed and release records,
  installed state, seed indexes, capabilities). It becomes the corpus file `plan-matrix.json`
  (like `gate-matrix.json` and README §3.6's `update-matrix.json`), so every SDK chooses
  identically. notes/A7 wrote the first 23 rows and ran them in six runtimes.
- **Disk and memory are constraints, not prices.** Every strategy applies at 100+ MB/s even in
  GDScript, so CPU is not worth pricing, and per-device constants would make the function
  non-portable.
- **The request weight matters.** On the real v1→v2 menu, the whole-payload delta wins
  (311,529 B), then per-file deltas (345,603 B), chunk sync (558,312 B, 22 requests), file
  (665,655 B) and full (1,246,961 B). At a 64 KiB request weight, full beats chunk sync. SDKs on
  high-latency links, or in throttled background sessions, raise it.
- **The request-run rule is shared** by the planner and the chunk applier, and the applier's
  request count is checked against it in the corpus.
- **UX policy stays outside the pure function:** metered/cellular consent, and the "replace in
  place, loses rollback" offer when nothing fits on disk.
- **First install:** take the single full blob, then _record its chunk index as a seed_, so the
  next update is incremental without ever having downloaded chunks.
- **Cross-pack seeds:** a chunk can come from any installed pack or the embedded baseline. Moving
  assets between packs costs nothing.
- **Telemetry** of `{strategy, bytes, duration, fallbackUsed, failureStage}` finds hot `(from, to)`
  pairs. CI then generates deltas for those pairs only (Epic's A→B optimisation, butler's rediff).

### 8.2 What works best for which payload shape

| Payload shape                                                                                                                                                            | Best strategy                                                        | Why                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Container with **per-entry** compression (Godot PCK, Unreal IoStore, stored zip): chunk **each entry separately** ("file-aware"), which halved the bytes for a Godot PCK | chunk (content-defined)                                              | resynchronises right after an edit; any old version → latest                    |
| Container with **whole-container** compression (deflated zip, `.tar.gz`, LZMA)                                                                                           | fix the container: per-entry compression, or deliver as `files.tree` | defeats chunking _and_ deltas (Blizzard patches decoded content and re-encodes) |
| Directory tree                                                                                                                                                           | file-level reuse by hash, then chunk inside large changed files      | cheapest, no container rebuild                                                  |
| Single large file                                                                                                                                                        | chunk (any old → latest); a delta only for hot pairs                 | deltas are pairwise and hold whole files in RAM                                 |
| Small file (under 4 MiB)                                                                                                                                                 | full                                                                 | request overhead dominates                                                      |
| Pack delivered by a platform                                                                                                                                             | platform                                                             | the platform owns transfer and patching                                         |

Rule of thumb: full under 4 MiB; full plus one delta for small packs that change every release;
chunk sync from about 16 MiB up.

### 8.3 Godot, measured (pure GDScript, 4.7.2)

`notes/A6` measured every strategy on a synthetic 36 MiB PCK: 625 entries, 82% textures, 9.80 MB as
a whole-file zstd download. From v1 to v2, 24 entries changed, 10 were added and 5 removed. All
times are on the official release template, 4-vCPU x86 desktop.

| Strategy                                                                                                     | Download                       | Client CPU (36 MB, incl. final SHA-256)                                                   | Works from                                     | Notes                                                                                               |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------ | ----------------------------------------------------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `full`                                                                                                       | 9.80 MB                        | ~0.2 s                                                                                    | nothing                                        | first install, then record the chunk index as a seed                                                |
| `delta`: per-entry `zstd --patch-from`, **decoded by Godot's own engine decoder** and baked into a full pack | **0.60 MB (−94%)**             | **~0.23 s**                                                                               | the exact previous release                     | see the mechanism below                                                                             |
| `chunk`: file-aware FastCDC, 64 KiB average                                                                  | **1.05 MB incl. index (−89%)** | ~0.36–0.45 s (80–100 MB/s)                                                                | **any** older release with a known chunk index | whole-pack FastCDC 64 KiB: 1.93 MB. Fixed-size blocks and whole-file-compressed inputs save nothing |
| `file`: changed entries + local rebuild                                                                      | 0.99 MB (−90%)                 | ~0.21 s                                                                                   | any release with a known files index           | simplest incremental path                                                                           |
| Godot's native delta PCK left mounted as an overlay                                                          | 0.60 MB                        | mount < 1 ms, then **+2.9 ms on every open** of a 2.8 MB patched file, per layer, forever | the byte-exact base                            | use only as a decode step, never as the active state                                                |
| byte-wise bsdiff or rolling hash in GDScript                                                                 | —                              | 1.1–1.7 s per 36 MB                                                                       | —                                              | not viable; keep rolling hashes in CI                                                               |

**How the `delta` strategy works in pure GDScript.**

`PackedByteArray.decompress` cannot apply a `--patch-from` frame, but Godot 4.6+'s delta PCK
decoder can, and it is reachable without native code:

1. CI (just the zstd CLI and a small PCK writer; no Godot editor needed) publishes a per-entry
   `zstd --patch-from` frame against the **stored** previous release, plus blobs for added entries.
2. The client appends a small directory trailer to the old pack. The trailer re-exposes its entries
   under a private `__pkey/base/` prefix, and is mounted at the trailer's offset.
3. The client writes a tiny delta PCK whose entries target those private paths, each frame wrapped
   in the 5-byte `GDDL\x01` header, and mounts it.
4. The client streams the new pack: unchanged entries are copied by offset, changed ones are read
   through the decoder, added ones come from blobs.
5. The trailer is truncated off, restoring the old pack byte for byte.

Results:

- The output is **byte-identical to CI's pack**, so one whole-pack SHA-256 verifies it.
- The live `res://` namespace is untouched.
- RAM is bounded by the largest changed entry.
- Whole-file decode also works: 160 MB was tested, at about 2× the file in RAM.
- Verify every delta's SHA-256 from the signed menu before feeding it to the decoder.
- **Caveat:** the `GDDL` wrapper and delta entry flag are engine-internal (Godot 4.6+), not a
  public API. Pin the method per engine `major.minor` in the SDK's advertised capabilities, run a
  per-engine conformance check in CI, and keep `chunk` and `file` as fallbacks that need no
  engine internals.

**Rules the measurements forced:**

- **Always rebuild a full, exporter-identical pack** at a new content-addressed path and mount it at
  next boot.
  - Overwriting a mounted pack corrupts reads (118 of 625 files correct) and can return another
    file's bytes.
  - Mounting a new version mid-session works (1.4 ms), but `load()` returns stale cached
    resources and removed files stay visible. So `restart` activation is right for PCKs.
- **Hash packs yourself.** Godot never checks a PCK's per-file MD5s: a tampered unpatched entry
  loads with no error.
- **`replace_files` is not a security boundary.** Zips ignore it. `false` also silently drops a
  delta patch's full entries and stops the pack's own UIDs registering. Enforce data-only with a
  directory check before mounting, and keep the "no `uid://` into packs" rule.
- **No runtime texture compression** on official templates (`Image.compress` to S3TC/BPTC/ETC2
  fails). Texture packs ship pre-imported `.ctex` per texture family, which is why packs have
  `variant.texture`.
- **Loose files hot-load cheaply.** JSON, PO/`.translation` via `TranslationServer`, OGG/WAV via
  `load_from_file`, TTF, and pre-imported `.ctex`/`.res`/`.scn` via `ResourceLoader.load("user://…")`
  each load in 0.1–4 ms. That is what makes `files.tree`, `l10n.table` and `data.json` hot types.
- **Zip is second-class:** it cannot remove files, ignores `replace_files`, has no offsets, and
  reads about 1.8× slower than PCK. `ZIPPacker` deflate runs at 16 MB/s.
- **Primitive speeds:**
  - `HashingContext` SHA-256 ~220 MB/s;
  - zstd `decompress` 0.8–1.26 GB/s (it needs the exact output size, which the chunk index carries);
  - a GDScript rolling hash only 20–22 MB/s.
- **Pack offsets are 32-bit**, so container files that hold several packs must stay under 2 GiB.

**Still unmeasured:** mobile (including the Android `load_resource_pack` stall) and the web build
itself.

---

## 9. Formats

Full JSON sketches are in `notes/E8 §5.4`. The essentials:

- **Pack deliverable definition** (`.pkey/release` `deliverables.<packId>` → D1 `release_deliverables`):
  - `packId`, `type`, `variants`, `contentApi`;
  - handler options (`mountOrder`, `prefixes`, `activation`);
  - policy (`required`, `delivery`, `cellular`, `keepPrevious`), `entitlement`, `channels`;
  - patch config (strategies, chunking parameters, delta bases);
  - `contentPolicy.dataOnly`.
  - Transports per outlet are **distribution** configuration (`.pkey/distribution`), not part of the
    pack definition.
- **Pack release record** (`pkey-release+jws` with `kind: pack`; CI release key or a delegated content
  key):
  - `packId`, `version`, `seq`, `type`, `variant`;
  - `payload {size, sha256, blob}`, `files {format, sha256}`, `chunks {format, sha256, params}`;
  - `deltas[]`, `requires`, `conflicts`, `entitlement`, `marker`, `provenance`.
  - Platform ids are **not** in here, because platforms assign them after signing. They live in
    distribution's availability records and in the channel feed.
- **Files index** (`pkey-files/1`, JSON; defined in full in notes/A7 §3.3):
  - `layout: container` (a single-file payload such as a PCK): `{path, offset, size, sha256}` per
    file in offset order, plus one **gaps blob** holding every byte no file covers (header,
    padding, directory). A container rebuild is then type-neutral (gap, file, gap, file, …), so
    no SDK needs a PCK writer for the `file` strategy.
  - `layout: tree`: the same list without offsets, verified per file and summarised as a
    `treeDigest`.
  - **Portable path rules:** printable ASCII only, no Windows-reserved characters or names, no
    `.`/`..` or empty segments, and no case-insensitive collisions or file/directory conflicts.
    GDScript has no Unicode normalisation, so the rules are ASCII by construction.
- **Chunk index** (`pkey-chunks/1`, binary, little-endian; notes/A7 §3.1):
  - a 64-byte header: magic `PKEYCHNK`, version, record size, flags (`fileAware`), chunk and
    bundle counts, `payloadSize` and **`payloadSha256`**, which binds a seed index to its payload
    without the release record;
  - fixed 48-byte chunk records `id[32] | len u32 | clen u32 | bundle u32 | offset u32`, then a
    table of 48-byte chunk-bundle records `sha256[32] | size u64 | reserved u64`;
  - a fixed validation order with one error code per failure;
  - parseable in GDScript with `PackedByteArray.decode_u32`;
  - ids are SHA-256 of **uncompressed** bytes; `clen == len` means stored raw, and `clen > len` is
    invalid. Chunker parameters live in the release record, since clients never chunk.
- **Codec.** Every compressed object is **one zstd frame with its content size**, or stored raw.
  Every zstd reference in a record carries the decoded `size`, because Godot's `decompress` needs
  it. There is no second codec (README §11 decision 21).
- **Patch descriptor** (`pkey-patch/1`):
  - `from`/`to` hashes, `size`, `method` (`zstd-patch-from` | `hdiffpatch` | `bsdiff` |
    `godot-delta-pck`), `artifact`, `artifactSha256`;
  - apply needs (`memBytes`, `tmpDiskBytes`, `minSdk`) and the frame's window size;
  - `layerOver` and `maxStack` for Godot delta PCKs.
  - **Publish and decode rules** (notes/A7 §3.2, found by running six runtimes):
    - decoders use **raw-content prefix** mode, never dictionary-type auto-detection;
    - CI never publishes a `zstd-patch-from` delta against a base starting with the zstd
      dictionary magic `37 A4 30 EC`, which several SDK decoders misparse; the planner falls back;
    - the frame's window is at least the larger file (153 MiB for a 160 MB pair), so decoders
      raise `windowLogMax` explicitly, within `memBytes`;
    - the stored artifact is the bare frame; the browser's `dcz` framing is added at the edge.
- **Error codes:** one registry shared by every SDK (`chunks.*`, `files.*`, `full.*`, `delta.*`,
  `chunk.*`, `plan.*`; notes/A7 §3.5).
- **Channel feed, pack part** (`pkey-feed+jws`, update's Worker-signed, device-less feed):
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

## 10. Client pipeline (every SDK)

1. **Preflight:**
   - Verify the chain channel feed → pack release record (by hash) → files/chunk indexes (by hash).
   - Check type/format/compat, entitlement and revocation.
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
6. **Activate:** hot types now; restart types at next boot. Mount in order, from the new
   content-addressed path, after the directory check. Never overwrite a mounted payload.
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
- Godot's web `user://` is an IndexedDB-backed filesystem that is copied **entirely into memory at
  boot** and written back whole. Everything stored there stays resident for the session.
- So on web, keep only small state in `user://`. Fetch large packs each session from immutable,
  content-addressed URLs that the browser's HTTP cache (or OPFS, via page JavaScript) keeps
  across sessions, and mount them from memory.
- Web pack sets should stay lean; patching saves bandwidth there, not memory.
- **Deltas in Chromium use Compression Dictionary Transport.** When the installed payload was
  fetched with `Use-As-Dictionary`, distribution serves the stored bare `--patch-from` frame with
  a 40-byte `dcz` header derived from `from`, and the browser decodes it natively (dictionaries up
  to 100 MiB). notes/A7 decoded the vectors' own delta byte-identically this way. Elsewhere, a
  vendored decoder-only libzstd WASM build (69 KB, 24 KB gzipped) applies it.
- `DecompressionStream` has no zstd, WebCrypto `digest()` does not stream, and `Cache.put`
  rejects 206 responses. Stage in OPFS from a worker.

---

## 11. Server side, by service

**Worker routes** (all new routes need an OpenAPI spec entry and a `routeCoverage` entry, rule 10).
Packs add routes to the existing services, not a new one:

| Service      | Route                                                   | Purpose                                                                                                                                                                                                                        |
| ------------ | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| release      | `POST /<p>/release/publish/*`                           | trusted-publisher (GitHub OIDC) upload tickets, finalize (verify size and SHA-256), submit release records for any deliverable, move channel pointers                                                                          |
| release      | `GET /<p>/release/record/<sha>`                         | a release record (app or pack) by hash                                                                                                                                                                                         |
| distribution | `GET /<p>/distribution/blob/<sha>` (on the byte domain) | payloads, indexes, chunk bundles, deltas: Range-capable, immutable, `Repr-Digest`; gated deliverables from a gated prefix, authorised per request; a delta as `dcz` when the request's `Available-Dictionary` matches its base |
| distribution | connector webhooks, CI reports                          | availability per release per outlet, including ASC `BACKGROUND_ASSET_VERSION_*` and PAD/Steam/MSIX reports                                                                                                                     |
| update       | `GET /<p>/update/<channel>/feed.jws`                    | the channel feed: app release + pack sets + availability/rollout/halts + delta menu; public, edge-cached, short TTL                                                                                                            |
| core         | `POST /<p>/devices/report`                              | pack install telemetry (allowlisted keys)                                                                                                                                                                                      |

**D1:**

- **release:**
  - `release_deliverables(product, deliverable_id, kind, pack_type, def_json, def_source)`;
  - `release_metadata` (+ `deliverable_id`, `seq`) and `release_builds` (pack variants);
  - `release_artifacts` with roles `payload`, `files-index`, `chunk-index`, `chunk-bundle`,
    `delta`;
  - `release_channel_policy` (pack floors per `contentApi`), `release_sets` (`pack_set_id`),
    `release_holds`, `release_yanks`; revocations are release records of `kind: revocation`.
- **distribution:** `dist_transports`, `dist_availability`, `dist_rollouts`, `dist_access`,
  `dist_readiness`.
- **core:** `blob_objects(hash, kind, size, created_at)`, `blob_refs(release_sha256, hash)`.

**R2:** `blobs/sha256/…`, `bundles/sha256/…`, `deltas/<from>/<to>.<method>`, bucket locks, plus a
separate gated prefix.

**GC:**

- An object is collectable when no live app release pins it, no live `contentApi` level resolves
  to it, and no outlet still lists it as available (plus a grace period). GC is Core's, reading
  references from release and distribution through their hooks (§6.7).
- Chunk bundles below about 50% live data are repacked into the next release's bundles, and the
  old bundle ages out.
- Deltas are disposable caches outside the hot-pair policy.

**CI tooling** (`pkey release publish --deliverable <packId>` and the `polaris-key/publish`
Action):

- The publish step builds the files index, content-defined chunks (FastCDC), chunk bundles and
  optional deltas against the last _N_ releases. It records the chunker version and parameters and
  never re-chunks history.
- It lints each type (data-only list for `godot.pck`, stored entries for zips, path
  safety) and signs with the release key or a delegated content key.
- Upload: new objects only (dedupe by hash).
- Per-transport steps:
  - `xcrun ba-package` + ASC Background Assets upload;
  - AAB asset-pack modules for PAD;
  - Steam depot build scripts;
  - MSIX optional packages.

  Each writes the marker and reports availability to **distribution**.

---

## 12. Security

- **Signing** (README §3.3 unchanged):
  - The CI release key signs pack releases.
  - Optionally, the release key **delegates** a content key restricted to data-only types and a
    pack-id prefix, so a content team can publish without code-release power.
  - Types that can carry scripts (`godot.pck`, `godot.zip`) always need the release key.
  - Data-only is enforced at publish (CI lint) and again before mount, by checking the pack's
    directory against its declared prefixes. It is never left to `replace_files`, which zips
    ignore.
- **What a compromise buys:**
  - The Worker signs only channel feeds, so a compromise can choose only among CI-signed releases.
  - The CDN, Apple, Google or Valve can only withhold or corrupt bytes, which verification catches.
- **Hashes:** SHA-256 everywhere. Never inherit the weak hashes of the formats we wrap (Godot's
  per-file MD5, Steam/Epic SHA-1, Blizzard MD5, Riot 64-bit ids).
- **Entitlements:**
  - Gated packs' chunk bundles live under a gated prefix.
  - **Never share chunk bundles between gated and free packs** (a Range would leak content).
  - Use `private, no-store` or tokenised cache keys.
- **Paths:** tree handlers refuse `..`, absolute paths and symlink escapes; zip-slip checks.

---

## 13. Per-SDK integration

Every SDK exposes packs through the **update** sub-client's pack facet (`client.update.packs`:
`ensure`, `state`, `isAvailable`, `registerHandler`, with progress events), mirroring the service
that decides them. Release data (`client.release`) and delivery details (`client.distribution`)
are available for tooling but not needed by game code. Cross-SDK parity is designed in
[`PARITY.md`](PARITY.md).

| SDK                          | Types (v1 → v3)                                                                             | Transports                                                                                          | Patch strategies                                                                                                                |
| ---------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| **Godot**                    | `godot.pck`, `godot.zip`, `files.tree`, `l10n.table`, `data.json`, `audio.bank`, `custom.*` | embedded, pkey-cdn, web; apple-ba (iOS plugin), play-pad (Android plugin), steam-depot (GodotSteam) | noop, platform, delta (via Godot's own decoder, pure GDScript), chunk (file-aware), file, full: all pure GDScript (§8.3)        |
| **Swift** (macOS/iOS apps)   | `files.tree`, `ml.model`, `data.json`, `l10n.table`                                         | apple-ba (native), pkey-cdn                                                                         | chunk, delta (libzstd from the official `facebook/zstd` SwiftPM package; Apple's Compression framework has no zstd), file, full |
| **Node / Electron**          | `files.tree`, `archive.*`, `ml.model`                                                       | pkey-cdn                                                                                            | chunk, delta (`node:zlib` on Node ≥ 22.19, else the shared WASM decoder; probed at startup), file, full                         |
| **Python** (tools, ML)       | `files.tree`, `ml.model`, `data.json`                                                       | pkey-cdn                                                                                            | chunk, delta (stdlib `compression.zstd` on 3.14; `zstandard` on 3.9–3.13), file, full                                           |
| **React / web**              | `files.tree`, `data.json`, `l10n.table`                                                     | web                                                                                                 | chunk (OPFS, WASM zstd), delta (`dcz` in Chromium, else WASM), file, full                                                       |
| **Kotlin** (proposed)        | `files.tree`, `ml.model`                                                                    | play-pad, pkey-cdn                                                                                  | chunk, delta (zstd-jni `.aar`; relies on the magic-base publish rule), file, full                                               |
| **C# / .NET, Unity** (later) | `files.tree`, `unity.addressables`                                                          | pkey-cdn (Unity custom provider), steam-depot, msix-optional                                        | chunk, delta (.NET 11 `SetPrefix`; `ZstdSharp.Port` on .NET ≤ 10, Unity and Blazor), file, full                                 |

`client-core` gains the shared pieces, with `sha256`, `zstd` and `fetch` injected. This is the
shape that ran unchanged in Node and Chromium in notes/A7:

- index verification and chunk-index parsing (`chunkIndexCases`);
- the chunk, file, full and delta appliers;
- the planner (`plan-matrix.json`);
- the path rules and the error registry;
- the install-state machine.

Python, Swift, Kotlin, C# and GDScript reimplement the same ~450–700 lines against the same
vectors. Per-type handlers stay per SDK.

---

## 14. Experiences

- **Developer:**
  - `.pkey/release` declares packs as deliverables beside the app.
  - `.pkey/distribution` says which transport carries them on which outlet.
  - `pkey release publish --deliverable <packId>`, `promote`, `pin` and `yank` work exactly as for
    the app, locally or in the Action.
  - The Godot export plugin lists packs per preset (embedded / lean).
  - In code, `PolarisKey.update.packs.ensure(["diceroll.events.halloween"])` returns progress
    signals and a result, and `PolarisKey.update.packs.is_available(id)` backs UI badges.
- **Administrator.** No separate content section: packs appear wherever the app does.
  - **Release:** deliverables → releases (size, dedupe ratio against the previous release, types,
    variants); channel pointers, floors, yanks; resolved pack sets per selector.
  - **Distribution matrix:** pack releases × outlets, with transport states (e.g. "App Store asset
    pack `foes.c3` v7: in review") and rollout/halt.
  - **Update health:** install-plan strategies, hot delta pairs and generated deltas, failure and
    fallback rates.
- **Player:**
  - Required packs load inside `PKeyBoot` (README §5.8) with size disclosure and cellular choice.
  - Optional packs stream in the background, with per-item "downloading" badges.
  - Offline play works with the installed set.
  - Updates are mostly small (chunk reuse).
  - Content never blocks play once the required set is present.

---

## 15. Diceroll mapping

| Pack                                                 | Type                                  | Binding                                                            | Transport (App Store / Play / Steam / direct / web)                     | Notes                                                                               |
| ---------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `diceroll.ui`                                        | `godot.pck`                           | `pinned`                                                           | embedded / embedded / embedded / pkey-cdn / pkey-cdn                    | fonts, UI sfx, rendered icons; coupled to the scenes that use them                  |
| `diceroll.core3d`                                    | `godot.pck`                           | `compatible`, embedded baseline, required                          | embedded (v1) → apple-ba / embedded / steam-depot / pkey-cdn / pkey-cdn | on Play, PAD or embedded narrows it to pinned unless routed through `pkey-cdn`      |
| `diceroll.audio`                                     | `godot.pck` or `audio.bank`           | `compatible`, optional                                             | apple-ba / embedded / steam-depot / pkey-cdn / pkey-cdn                 | prefetch; music could become `files.tree` of `.ogg` loaded at runtime               |
| `diceroll.foes`, `diceroll.nature`, `diceroll.extra` | `godot.pck`                           | `compatible`; `foes` and `nature` required with embedded baselines | as `core3d`                                                             | per-texture-family variants (`s3tc`, `etc2`/`astc`) fix today's S3TC-on-arm64 issue |
| `diceroll.l10n` (future)                             | `l10n.table`                          | `standalone`                                                       | pkey-cdn everywhere (hot)                                               | one variant per locale; ship new languages between app releases                     |
| `diceroll.events.<name>` (future)                    | `godot.pck` (data-only) + `data.json` | `compatible`, optional                                             | apple-ba / pkey-cdn / …                                                 | on the `events` channel through `packChannels`                                      |
| `diceroll.supporter.skins` (future)                  | `godot.pck`                           | `compatible`, optional, entitled                                   | pkey-cdn (gated) direct; IAP-gated on stores                            | entitlement `extras.diceSkins` via the commerce bridge                              |

Diceroll keeps `packs.gd` and `needs.gd` (content id → packs) and its `Content.available()` gating.
They read `PolarisKey.update.packs` state instead of a hand-rolled store.

---

## 16. Phasing and effort

| Phase  | Ships                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Size   | Wire / corpus impact (plan mode)                                                                                                                                                                                                       |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **v1** | **release:** pack deliverables (types, variants, requirements, dependencies); `pinned` packs in the app's release record and `contentApi` stamped on every app release; patch artifacts (files index, per-entry deltas)<br>**distribution:** CDN and embedded transports for packs (embedded baselines), availability, delivery gating, marker file<br>**update:** the pack part of the channel feed; the handler contract, install state, full/file/delta strategies in every SDK (GDScript via Godot's own decoder); `packSetId` in telemetry                                                                                                                                                                        | 5–7 wk | release records with `kind: pack` inside wire v4's `pkey-release+jws`; corpus `releaseRecordCases` (pack kind), marker vectors, apply vectors for file and delta                                                                       |
| **v2** | **release:** file-aware chunk indexes and chunk bundles; `compatible` and `standalone` resolution per live `contentApi`; pack floors per level, holds, `packChannels`, revocation records; two-way publish checks with a dry run<br>**distribution:** chunk-bundle delivery; per-outlet rollout and halt for packs; outlet readiness holds; platform transports (Background Assets, PAD, Steam) as their connectors land; server GC and chunk-bundle repacking<br>**update:** chunk sync from seeds in every SDK; per-outlet binding narrowing; `blocked(content-floor \| revoked-content)` and binary pre-staging in the decision<br>**console:** compatibility matrix and the "what does this device get?" simulator | 6–8 wk | the channel feed's pack-set, floor and revocation fields; `kind: revocation`; corpus `chunkIndexCases`, `plan-matrix.json`, `applyCases` (tampered chunk, wrong base, truncated chunk bundle), new `update-matrix.json` rows; all SDKs |
| **v3** | more types (`l10n.table`, `data.json`, `audio.bank`, `ml.model`, `custom.*`, `unity.addressables`); lazy delta generation for hot pairs (R2 events → Queue → Workflow → Container); Compression Dictionary Transport on web; content-key delegation; `provides`/`removes` save-compatibility checks, named contracts and the content-interface fingerprint lint                                                                                                                                                                                                                                                                                                                                                        | 4–6 wk | delegation record; per-type verify vectors                                                                                                                                                                                             |

This is README P4: **15–21 weeks across three increments**, with no new service. v1 alone
unblocks Diceroll's content-streaming phases 1–2, which embed or pin every pack. v2 brings the
small-update win and content that ships between app releases.

---

## 17. Open questions and spikes

1. Are Apple asset-pack updates differential in practice? Measure in TestFlight.
2. Does Cloudflare's origin Range handling cover R2 custom-domain objects on our plan? Measure
   cold-miss behaviour and multi-range requests.
3. Chunk size for **real** Diceroll PCK history. The synthetic pair favoured file-aware 64 KiB
   (16 KiB saved only 5% more at 1.8× the index size); confirm on several real versions,
   including the any-older-version case.
4. SHA-256 and zstd throughput on low-end Android and in mobile browsers. Desktop is measured
   (notes/A7 §8): Godot's release template hashes at 242 MB/s and decodes zstd at 568 MB/s;
   Chromium hashes at ~200 MB/s, decodes WASM zstd at 302 MB/s and chunk-syncs at 106–136 MB/s.
5. The Android `load_resource_pack` stall (godot#105009) with several packs, and web memory with a
   realistic pack set.
6. Which Steamworks calls expose installed depot manifests on the device?
7. Can a Unity custom resource provider enforce verification before bundles load?
8. How long is the store-lag window in practice, and so how many `contentApi` levels are live at
   once? Measure from ASC and Play availability history before committing to maintenance lines.
9. Does App Review treat new asset packs for a new `contentApi` as part of the app's review, or
   separately? That decides how long distribution's readiness hold lasts.
10. Can a content-interface fingerprint be derived reliably from a Godot project (content-id
    registry, `load()` paths, exported resource types), or does it need an explicit registry?

Answered on desktop by `notes/A6`: Godot delta-PCK load cost (+2.9 ms per open per layer, hence
bake instead of layering); whether a delta applies over a chunk-rebuilt base (yes); whether
`--patch-from` is reachable from GDScript (yes, via the engine's decoder).
