# Godot on Polaris Key: omni-platform distribution, content packs and a full-parity Godot SDK

**Date:** 2026-09-29 · **Status:** research and proposal. Nothing here is implemented. · **Audience:**
Polaris Key maintainers, and the Diceroll (`vladzaharia/diceroll`) side evaluating adoption.

This document answers one question: what would Polaris Key need so that a Godot game written in
GDScript (Diceroll is the reference) can take **all** of its distribution, updates, content delivery,
licensing, managed config and identity from Polaris Key, on every platform, through one SDK and one
drop-in boot/update UI? It also asks how to express the answer so the same concepts carry over to
the other SDKs and products.

It is non-normative. [`AGENTS.md`](../../../AGENTS.md), the concepts glossary
(`packages/docs/src/content/docs/start/concepts.md`) and
[`WIRE-CONTRACT-V3.md`](../../security/WIRE-CONTRACT-V3.md) stay authoritative. Anything below that
touches `shared-protocol`, `shared-jws`, `client-core`, a signed document, `PROTOCOL_VERSION` or the
corpus is a **plan-mode, all-languages event** (CLAUDE.md) and is flagged as such.

**What sits beside this file:**

- [`CONTENT.md`](CONTENT.md): the content delivery system design. It covers many independently
  versioned packs of any type, delivered and patched through whatever each platform offers. It
  expands §3.7 of this report.
- `notes/`: fourteen research reports this synthesis is built from (§15). They carry the file:line
  evidence and the external sources.
- `prototype/`: a runnable Godot 4.7 project with a pure-GDScript SHA-512, Ed25519 verifier and JWS
  verifier. It is tested against RFC 8032 and the repo's own conformance corpus.

---

## 0. Summary

### 0.1 Verdict

**Polaris Key can natively support everything asked for.** That covers:

- iOS and iPadOS (App Store, TestFlight, AltStore/SideStore, AltStore PAL);
- Android (Play, direct APK, Obtainium, a self-hosted F-Droid repo);
- macOS (Developer ID with Sparkle, and the Mac App Store);
- Windows (Microsoft Store, MSIX/App Installer, installer and portable builds with in-app updates);
- Linux and the web;
- content packs with their own release channels;
- a Godot SDK at full parity with the other SDKs, plus a Godot UI that owns boot, update and loading.

None of this requires giving up a founding rule. Products stay data, the wire stays one contract
across languages, and services stay independent.

It is, however, a **program and not a feature**. Estimated at **~60–80 engineer-weeks** across eight
phases (§10), several of which parallelise. The difficulty is breadth, not depth: a dozen outlets,
each with its own feed format, API, signing rules and store policy, plus **one deliberate wire
event** (protocol v4) that every SDK must follow.

### 0.2 Why it is tractable

- **The wire contract survives Godot.** Godot has no Ed25519 and no SHA-512 (it uses mbedTLS 3.6,
  with RSA and ECDSA only). A pure-GDScript verifier built during this research, in `prototype/`:
  - matches Node/OpenSSL on all 36 corpus-v2 `jwsCases` and on all 68 distinct signatures in
    `cases.json`;
  - takes **~7 ms per verify** on a Godot 4.7.2 release template.

  So there is no GDExtension in the trust path and no algorithm change (notes/A5, notes/A2).

- **Release and Update are unsigned routes.** Almost all distribution work is additive: routes, D1
  tables, manifest fields and renderers, behind the existing drift gates (OpenAPI/`routeCoverage`,
  the manifest mutation table). There is no `PROTOCOL_VERSION` bump for that part (notes/A1 §6.4).
- **Update was built to be "a feed rendered over truth".** Its gateway (`serveReleaseSurface`) is
  callback-based, so AltStore, Velopack, App Installer, WinSparkle and F-Droid feeds are new files,
  not a new architecture.
- **Core already has the primitives:**
  - an anonymous-capable device principal (`open` registration);
  - entitlements and access modes (`entitled`);
  - per-product Ed25519 keys and KEK-sealed secret storage;
  - ES256/RS256 JWT signing (edge-mint);
  - a Sparkle EdDSA verifier.

### 0.3 The big rocks (what is genuinely missing)

1. **A platform × arch × build model in Release, and a separate Distribution service for
   outlets.** Release today serves only extension-less CLI
   binaries and `.dmg`, knows `arm64|x86_64` only, and has no build numbers, no per-platform
   availability, no yank and no rollout. `.ipa`, `.apk`, `.aab`, `.exe`, `.msix`, `.AppImage`,
   `.pck` and `universal` all fall through (notes/A1 §3). Where builds go (outlets, submissions,
   availability, rollouts, storefront feeds) moves into a new `distribution` service (§3.2, §3.8).
2. **A trust model for shipping code and packs.** A CI-held **release key** signs _what exists_
   (hashes). The Worker's product key signs _which and when_ (channel pointer, freshness, rollout,
   halts). The second part is a new signed feed document without `deviceId`: **wire v4** (§3.3).
3. **A byte store Polaris Key controls, and a CI credential.** Every download today streams from
   GitHub through one GitHub App installation quota (~5,000 calls/hour, shared by every product on
   that installation). The fix is R2, content-addressed. Today CI cannot authenticate to Polaris Key
   at all; the fix is GitHub Actions OIDC "trusted publishing" (§3.5).
4. **Content packs as first-class releases.**
   - Many independently versioned packs of any type: Godot PCKs, file trees, audio,
     localisation, data, models.
   - They are handled like the app itself across the same three services:
     - **Release** records what exists (versions, channels, dependencies, CI-signed records,
       patch artifacts);
     - **Distribution** delivers the bytes through whatever each outlet offers (Background Assets,
       Play Asset Delivery, Steam depots, MSIX, embedded, or our CDN);
     - **Update** tells the device which packs to install and how to patch them.
   - There is no separate content service (§3.2, §3.7, [`CONTENT.md`](CONTENT.md)).

5. **Distribution's store connectors** (App Store Connect, Google Play, Microsoft Store) with
   **isolated credential custody**. They must not use product secrets (§3.8).
6. **The Godot SDK** as a sixth conformance language, plus a UI kit and optional native plugins
   (§5).
7. **Web reachability.** The Worker emits no CORS headers anywhere, so a Godot web build on any
   other origin cannot call it today.

### 0.4 Findings that should change plans now

1. **Godot 4.6+ official export templates ignore `--main-pack`.**
   - Upstream PR godotengine/godot#111909, merged 2025-11-12, disables `--main-pack`, `--path`,
     `--scene` and `-s` in templates. Web is exempt.
   - The prototype run saw the same refusal on 4.7.2.
   - Diceroll's updater relaunches with `--main-pack` (`game/update/updater.gd:313`) on official
     4.7.2 templates, so **its staged code packs most likely never apply in shipped desktop
     builds.** Verify on an exported build.
   - Any Godot code-update design must use a full-app updater with deltas, a sidecar-`.pck` swap,
     or custom templates (§5.6).
2. **Polaris Key's Release today would mis-serve Diceroll.**
   - Diceroll's rolling `channels` and planned `packs` GitHub releases would be ingested as
     "versions" and can become `latest`.
   - Built-in `beta` excludes stable releases.
   - "Newest" follows GitHub list order, not version order.
   - Release health reports "missing arm64 DMG" forever.
3. **Resync silently overrides operator settings.**
   - A `.pkey/` push rewrites `artifact_policy_json`, both access modes and the compat window.
   - That **downgrades an operator's `entitled` back to `public`** (`resync.ts:179-191, 277-290`).
   - Fix this before adding more operator controls.
4. **Channel vocabularies disagree inside Polaris Key.**
   - The license gate knows `stable|staging|pr|dev`, derived from `0.0.0-*` version strings
     (`core/gate.ts:51-88`).
   - Release knows `stable|beta|pr-N|<manual>`.
   - A client sending `X-PKey-Channel: beta` is refused as unknown.
5. **Store credentials must never be ordinary product secrets.**
   - An edge-mint recipe authored in the repo can name _any_ product secret as its signing key.
   - Under `open` registration anyone can mint (`services/config/mint.ts:214-234`).
   - So one `.pkey/` push could turn a stored App Store Connect `.p8` into a public token mint.
6. **Store policy dictates the architecture for paid content and code.**
   - iOS 3.1.1, Play Payments, Microsoft Store 10.8.1 and Steam all require their own commerce for
     digital unlocks.
   - Apple 2.5.2, Play's Device and Network Abuse policy and Microsoft Store 10.2.2 constrain
     downloaded code.
   - Packs must be **data-only on store builds**.
   - Paid packs on store builds need a **commerce bridge**: store receipts → Polaris entitlements.
7. **The native content transports to target are:**
   - **Apple-hosted Background Assets** (OS 26+): versioned independently of the app, Apple-reviewed,
     with ASC webhooks;
   - **Play Asset Delivery**, which cannot update without a new AAB;
   - **Steam depots**.

   Polaris Key should model _one_ pack identity delivered through several transports, not one
   transport. The same holds for patching: production launchers (Riot, Blizzard, Epic, Steam)
   all use CI-chunked manifests plus a thin client that needs only SHA-256, zstd and HTTP Range.
   That is exactly what a pure-GDScript client can do. Measured on Godot 4.7.2 (§5.7), it can
   also drive Godot's own delta decoder: a v1→v2 update of a 36 MiB pack took 0.6 MB instead of
   9.8 MB, with a byte-identical result ([`CONTENT.md`](CONTENT.md) §7).

### 0.5 Difficulty at a glance

Sizes: S ≤ 1 week · M 1–3 · L 3–6 · XL 6+ engineer-weeks.

| Capability                                                                                                                                 | Today                                   | Work                                                                       | Size | Gates                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------- | -------------------------------------------------------------------------- | ---- | ---------------------------------------------------------------------------------------------- |
| Godot SDK: License, Config, Devices, Identity, Update check                                                                                | none                                    | new GDScript SDK + corpus runner                                           | XL   | sixth conformance language                                                                     |
| Ed25519 in GDScript                                                                                                                        | prototype passes corpus                 | harden, cache keys, thread                                                 | S    | corpus malleability vectors (plan mode)                                                        |
| Multi-platform artifacts (ipa/apk/aab/exe/msix/AppImage/pck/universal)                                                                     | macOS CLI/DMG only                      | artifact map, build numbers, outlets, generic route                        | L    | rule 9, rule 10                                                                                |
| R2 byte store + CI publish via GitHub OIDC                                                                                                 | none (GitHub-only; no CI auth)          | core blob store, trusted publisher, `pkey publish`, GitHub Action          | L    | new bindings, threat model                                                                     |
| Signed channel feed + CI-signed release record                                                                                             | `/version` unsigned `{version,tag,url}` | two new document types                                                     | L    | **wire v4**, corpus, all SDKs                                                                  |
| AltStore/SideStore (and PAL) sources                                                                                                       | none                                    | renderer + IPA permission extraction                                       | M    | rule 10                                                                                        |
| Sparkle (extend), WinSparkle, Velopack, `.appinstaller`, zsync, Obtainium, Scoop/Flathub JSON                                              | Sparkle only (single item, DMG)         | renderers over one release record                                          | L    | rule 10                                                                                        |
| Self-hosted F-Droid repo                                                                                                                   | none                                    | CI-generated and signed, Polaris Key serves                                | M    | —                                                                                              |
| Content packs as release deliverables: many versioned packs of any type, channels, dependencies, platform transports, chunk/delta patching | none                                    | packs across release, distribution and update ([`CONTENT.md`](CONTENT.md)) | XL   | no new service; covered by wire v4's two documents; corpus `plan-matrix.json`, content vectors |
| App Store Connect / Play / Microsoft Store connectors                                                                                      | none                                    | webhooks + polling + control actions, credential custody                   | L    | threat model                                                                                   |
| Staged rollout, halt, yank, promote, min-supported per outlet                                                                              | none                                    | policy tables + feed fields + console                                      | M    | —                                                                                              |
| Commerce bridge (IAP/Play/Steam → entitlements)                                                                                            | none                                    | receipt verification + notifications                                       | L    | —                                                                                              |
| Godot boot/update/loader UI                                                                                                                | none (Diceroll has a design)            | `PKeyBoot` + outlet adapters                                               | L    | —                                                                                              |
| Godot native plugins (iOS, Android, macOS, Windows)                                                                                        | none                                    | 5–7 small plugins                                                          | L    | per-platform CI                                                                                |
| Web builds (CORS, optional hosting)                                                                                                        | blocked                                 | CORS allowlist; R2-backed hosting on a separate domain                     | M    | rule 10 (OPTIONS)                                                                              |
| Console release matrix, outlets, content, devices                                                                                          | licence-centric                         | new views                                                                  | L    | docs-link drift gate                                                                           |
| Public download page (platform detect, store badges, deep links)                                                                           | portal needs licence + sign-in          | new public surface                                                         | M    | —                                                                                              |

---

## 1. Scope, method and confidence

**Scope.** In scope: backend, SDK, Godot UI, and the developer, administrator and player
experiences, for:

- iOS/iPadOS: App Store, TestFlight, AltStore/SideStore, EU marketplaces;
- Android: Play, sideload, Obtainium, F-Droid;
- macOS: direct with Sparkle, Mac App Store;
- Windows: Microsoft Store, MSIX/App Installer, installer and portable with in-app updates,
  winget/Scoop;
- Linux: tar, AppImage, Flatpak, Snap, Steam Deck;
- Web, Steam and itch;
- content packs with channels.

Also in scope: which existing tools to adopt, and how the concepts generalise.

**Method.** Fourteen research tracks:

- four read this repository end to end;
- one mapped Diceroll's own updater and content design onto Polaris Key;
- one ran Godot 4.7.2 headless to test crypto, HTTP and platform identity empirically;
- six researched external platforms and tools, with sources dated 2025–2026;
- two more covered general content delivery: a survey of how launchers, chunk stores, engines
  and platform transports version and patch content, and a Godot 4.7.2 measurement of what a
  pure-GDScript client can patch.

Every claim about this repo carries file:line evidence in `notes/`. External claims carry URLs and
confidence tags there.

**Confidence.**

- The repo findings are high confidence. The ones this synthesis relies on most were spot-checked
  directly: `core/gate.ts` channels, `release/store.ts` classification, `mint.ts` secret access,
  `core/services.ts` unknown-slug fallback, Diceroll's `--main-pack` use, and PR #111909.
- External platform facts are dated and move fast; the notes flag unverified items. The most
  time-sensitive are:
  - Google's sideload developer verification (regional enforcement from 2026-09-30; global 2027);
  - Apple's EU terms (unified 2026-10-01);
  - Play's fee restructuring (2026-06-30 onward);
  - Microsoft Store Developer CLI limits.

---

## 2. Where Polaris Key stands today

### 2.1 Already fits

| Capability                                                                                         | Where                                        | Use for Godot                                                                                       |
| -------------------------------------------------------------------------------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Keyless device principal (`open` registration), `pkeyt_` tokens, device facts                      | Core (`core/register.ts`, `core/devices.ts`) | every install gets an identity with no licence in the picture: rollout bucketing, telemetry, config |
| Signed licence and config documents, trust manifest, offline bundles, clock floor                  | Core + License + Config, `client-core`       | managed config (remote tuning, kill switches), supporter tiers, entitlements, kiosk builds          |
| Entitlements, tiers, `channels`, `app.minVersion/maxVersion`, auto-issue enrollment, claim/migrate | License                                      | beta access, forced updates, free-tier licence that a sign-in later claims                          |
| Device-code sign-in                                                                                | Identity (`oidc.ts`)                         | the right native login for games (QR on TV/Deck/desktop)                                            |
| Access modes incl. `entitled`                                                                      | Release/Update (`core/entitledAccess.ts`)    | gated beta feeds and supporter-only downloads                                                       |
| Channel resolution: stable / beta / `pr-N` / manual regex channels                                 | Release (`channels.ts`)                      | base of channel pointers (needs fixes, §2.2)                                                        |
| Streaming gateway with Range/ETag, SSRF-guarded redirects, forced content types                    | Release (`gateway.ts`, `github.ts`)          | resumable downloads (needs R2 and caching, §3.5)                                                    |
| Sparkle appcast + server-side EdDSA verification of CI signatures                                  | Update (`appcast.ts`, `sparkle.ts`)          | the macOS feed and the template for WinSparkle; the CI-signs model for all artifacts                |
| KEK-sealed secret storage with typed kinds; ES256/RS256 signing                                    | `keyvault.ts`, `services/config/mint.ts`     | outlet credentials (new sealed kind), ASC and Google JWTs                                           |
| Manifests as data, GitHub App link + resync, discovery, enablement coherence                       | Core + Release                               | `.pkey/` gains platform, outlet and content blocks                                                  |

### 2.2 macOS/CLI-shaped (must generalise)

Every item below comes from notes/A1 and notes/A3, with file:line references there.

**Asset classification.**

- It works by filename sniffing. The only kinds are `signature`, `checksum`, `dmg`, `pkg`,
  `archive`, `cli` and `other`.
- Platform detection knows `macos`, `linux` and `windows` only.
- Arch is a closed `arm64|x86_64` union, repeated in about six places (router regex, OpenAPI,
  protocol types, SDK mirrors).

**Download route.**

- It has one shape: `/<p>/release/dl/<sel>/<binary>-<arch>[.dmg]`.
- Matching is fuzzy, and a tie between two candidates answers 404.
- Godot's universal macOS DMG has no arch token, so it is unservable.

**Appcast.**

- It emits one item, DMG only, with `sparkle:version == shortVersionString`.
- It has no build numbers, phased rollout, critical flag, deltas or `minimumAutoupdateVersion`.

**Channels.**

- "Newest" means GitHub list order over one page of 100 releases.
- Built-in `beta` means newest-prerelease-only, so beta never includes stable.
- Any non-draft release is a candidate, including `channels` and `packs` tags.
- Pinned `vX.Y.Z` selectors are rejected even though the OpenAPI spec documents them.

**Sync.**

- The webhook handles `push` events touching `.pkey/` only; `release` events are ignored.
- Resync overwrites operator-owned policy.
- A tag pair such as `v1.2.0` and `1.2.0` fails a batch midway: the unique index on
  `(product, version)` is outside the upsert's conflict target.

**Health, install and portal.**

- Release health is macOS-DMG-only.
- `install.sh` refuses anything but Darwin.
- Portal downloads require sign-in _and_ a licence even for `public` artifacts, and list every
  sidecar file.

### 2.3 Missing entirely

- Build numbers, per-platform availability, store-review lag, staged rollout, yank, promote/pin, kill
  switch, and minimum-supported per outlet.
- Any notion of the **outlet** an install came from, and of what that outlet allows (self-update,
  downloaded code, channel switching, commerce).
- iOS, Android and Web platforms. Feeds other than Sparkle and `/version`.
- Content delivery of any kind: packs, pack types, content channels, engine compatibility
  gating, deltas.
- R2 and any artifact caching. CORS. A CI credential. A GitHub Action.
- Store connectors (ASC, Play, Microsoft Store) and a place to keep their credentials safely.
- A product-wide device list for licence-free products (devices are listed per licence only, so an
  `open`-registration game's devices appear nowhere in the console).

---

## 3. Target architecture

### 3.1 Vocabulary

These nouns must not collide with the glossary:

- "surface" is already a Release/Update route kind (`surfaces.ts`);
- "profile" is taken twice;
- "bundle" is the offline bundle;
- "catalog" is the config catalog;
- "manifest" means `.pkey/` files;
- "staging" is a licence-gate channel.

The proposed additions go into `start/concepts.md` in the first implementing PR.

| Term                           | Meaning                                                                                                                                                                                                                                                                                  | Notes                                                                                                                   |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **platform**                   | OS family: `macos`, `ios`, `android`, `windows`, `linux`, `web`. iPadOS is `ios`, with a device-family facet                                                                                                                                                                             | already on the wire as `X-PKey-Platform`; normalise its values across SDKs (they differ today, notes/A2 §14)            |
| **arch**                       | `arm64`, `x86_64`, **`universal`**, `armv7`, `wasm32`, **`any`**                                                                                                                                                                                                                         | `universal` and `any` match every arch                                                                                  |
| **outlet**                     | a venue a build reaches players through, and that owns (or delegates) its updates: `direct`, `app-store`, `testflight`, `altstore`, `altstore-pal`, `play`, `play-testing`, `obtainium`, `fdroid-repo`, `ms-store`, `app-installer`, `steam`, `itch`, `flathub`, `snap`, `winget`, `web` | not "surface" or "distribution"; owned by the **`distribution`** service (§3.2, §3.8)                                   |
| **outlet capabilities**        | what an outlet permits: `binaryUpdates` (`self` \| `store` \| `none`), `codeUpdates`, `dataUpdates`, `channelSwitch`, `commerce` (`own` \| `store-iap` \| `steam` \| `none`), `downloadedScripts`                                                                                        | security-relevant bits are **operator-owned**, never manifest-writable (the `requireSparkleSignature` precedent)        |
| **build**                      | one compiled deliverable for (platform, arch, outlet, format), with a **build number**                                                                                                                                                                                                   | iOS `CFBundleVersion`, Android `versionCode`, MSIX 4-part, Sparkle `sparkle:version`                                    |
| **artifact**                   | a file of a build, or a sidecar (sig, checksum, zsync, dSYM)                                                                                                                                                                                                                             | exists today; gains role, format, build and sha256                                                                      |
| **listing**                    | store-page metadata (name, subtitle, description, icon, screenshots, tint, category)                                                                                                                                                                                                     | feeds AltStore, F-Droid and the download page                                                                           |
| **submission**                 | a build's review lifecycle at a store outlet                                                                                                                                                                                                                                             | ASC, Play, Microsoft Store states                                                                                       |
| **availability**               | "version V (or pack release P) is live on outlet O since T"; a distribution record                                                                                                                                                                                                       | the answer to "is it in the App Store yet"                                                                              |
| **rollout**                    | percentage exposure of a release on one outlet; distribution state, carried into update's signed feed                                                                                                                                                                                    | client-evaluated buckets for self-hosted outlets; mirrored from stores otherwise                                        |
| **promote / pin / yank**       | move a channel pointer / freeze it / make a release unservable except by pin                                                                                                                                                                                                             | "yank", not "revoke" (keys and licences revoke)                                                                         |
| **release record**             | the CI-signed record of one release of one deliverable (`pkey-release+jws`): builds or variants, hashes, sizes, requirements, patch artifacts; for the app, the pinned pack releases                                                                                                     | new signed document (§3.3)                                                                                              |
| **channel feed**               | the Worker-signed, device-less feed per channel (`pkey-feed+jws`): the app's release, the resolved pack set, freshness, floors, per-outlet availability, rollout and halts                                                                                                               | update's output (§3.3, §3.6)                                                                                            |
| **pack**                       | a named, independently versioned unit of content of some **pack type** (`godot.pck`, `files.tree`, `l10n.table`, `data.json`, `audio.bank`, `ml.model`, `custom.*`), with requirements, dependencies, a delivery policy and optional entitlement                                         | full model in [`CONTENT.md`](CONTENT.md)                                                                                |
| **deliverable** / **pack set** | something a product releases: the `app` (kind `app`) or a pack (kind `pack`) / a release-resolved lock of exact pack releases for one selector (channel × `contentApi` × platform × variant)                                                                                             | every deliverable goes through release, distribution and update the same way; Diceroll's `requires_packs` is a pack set |
| **requirements**               | constraints on where an artifact or pack may run: `engine` (e.g. `godot-4.7`), `format`, `textures` (`s3tc`/`etc2`/`astc`), `minBuild`, `minOS`, `arch`                                                                                                                                  | the generic "compat key"; generalises to Unity, Electron, etc.                                                          |
| **delivery policy**            | `essential` \| `prefetch` \| `onDemand`                                                                                                                                                                                                                                                  | Apple Background Assets' vocabulary, reused across transports                                                           |
| **transport**                  | how a pack's bytes arrive: `embedded`, `pkey-cdn`, `apple-ba`, `play-pad`, `steam-depot`, `msix-optional`, `flatpak-ext`, `web`                                                                                                                                                          | one pack id, many transports                                                                                            |
| **patch strategy**             | how an update is obtained: `noop`, `platform`, `delta`, `chunk`, `file`, `full`, picked by a deterministic client planner                                                                                                                                                                | not "route" (a Worker term)                                                                                             |
| **release key**                | a developer/CI-held Ed25519 key that signs release records (optionally delegating a content key for data-only packs)                                                                                                                                                                     | Sparkle's EdDSA key generalised; the Worker never holds it                                                              |

### 3.2 Service model: Release, Distribution and Update across everything delivered

**The rule** (from `start/service-model.md`): a capability becomes a service when a product would
want it on its own. For everything a product delivers, the application **and** its content packs,
responsibility splits into three services with one question each:

| Service                  | Answers                                                                 | For every deliverable (the app and each pack) it owns                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------ | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`release`** (extended) | _what exists?_                                                          | deliverables and their kinds; versions and monotonic `seq`; builds (app: platform × arch × format, build numbers) and variants (pack: texture family, locale, …); artifacts and **derived patch artifacts** (files index, chunk index, chunk bundles, deltas) as records; requirements and dependencies; the CI-signed release record; **channel pointers** (promote, pin, `includes`, floor, critical); compatible-set resolution; yanks; changelog; provenance; the publish API (§3.4)                                   |
| **`distribution`** (new) | _how does it reach devices and outlets, and what state is it in there?_ | outlets and **transports** (our CDN, embedded, App Store, TestFlight, Background Assets, Play and Play Asset Delivery, Steam depots, Microsoft Store and MSIX optional packages, Flatpak, web, …); **all byte delivery** (downloads, blobs, chunk bundles and deltas with Range, access gating, CORS; install scripts); store connectors and credentials; submissions; **availability** per release per outlet; **outlet-scoped rollouts and halts**; storefront feeds; the public download page; the key inventory (§3.8) |
| **`update`** (extended)  | _what should this installed app do next?_                               | the device-facing **signed channel feed** for the app _and_ its packs; app-updater feeds (Sparkle, WinSparkle, Velopack, App Installer, zsync, `/version`); the specification of the client-side **update decision** and **pack install planning**; outcome telemetry that feeds halts (§3.6)                                                                                                                                                                                                                              |

**Content packs are releases.**

- Packs are handled exactly like the application. A pack is a **deliverable** with its own
  versions, channels, requirements, CI-signed release records and yanks.
- Its bytes reach devices through **distribution's** transports.
- Whether and how to install a new version of it is **update's** decision.
- There is no separate content service. §3.7 and [`CONTENT.md`](CONTENT.md) describe the packs
  model through these three services.

**The same activity, for the app and for a pack:**

| Activity                               | App                                                              | Pack                                                                               | Service                                   |
| -------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------- |
| Declare it                             | `.pkey/release` `deliverables.app`                               | `.pkey/release` `deliverables.<packId>` (kind `pack`, pack type)                   | release                                   |
| Publish a version                      | builds per platform/arch/format                                  | variants per texture family/locale                                                 | release                                   |
| Sign what exists                       | `pkey-release+jws` (CI release key)                              | `pkey-release+jws` (CI release key or a delegated content key for data-only types) | release                                   |
| Compute patch artifacts                | Sparkle/Velopack deltas; per-entry deltas for sidecar code packs | files index, chunk index, chunk bundles, per-entry deltas                          | release (records); CI (computes)          |
| Channel pointer, floor, yank           | ✓                                                                | ✓ (per pack; or a pinned set)                                                      | release                                   |
| Compatible set                         | the app pins pack releases (locked)                              | channel-resolved pack sets per `contentApi` (floating)                             | release                                   |
| Store and serve bytes                  | direct downloads, install scripts                                | blobs, chunk bundles, deltas                                                       | distribution (bytes in Core's blob store) |
| Platform transports                    | App Store, Play, Microsoft Store, Steam, …                       | Background Assets, Play Asset Delivery, Steam depots, MSIX optional packages, …    | distribution                              |
| Availability, rollout, halt per outlet | ✓                                                                | ✓                                                                                  | distribution                              |
| Storefront feeds, download page        | ✓                                                                | pack listings where a storefront supports them                                     | distribution                              |
| Tell the device what to do             | signed feed → update decision                                    | signed feed → pack sets → install plan                                             | update                                    |
| Outcome telemetry → auto-halt          | ✓                                                                | ✓                                                                                  | update (telemetry) → distribution (halt)  |

**Dependencies and enablement.**

- The chain is **release ← distribution ← update**: truth, then delivery, then decision.
- Coherence rules:
  - `distribution_requires_release`;
  - `update_requires_distribution` (which subsumes today's `update_requires_release`).
- The legacy `releases` module name maps to all three, so djdl's manifest keeps meaning "this
  product distributes software".
- Products without Polaris-hosted bytes still use all three. For a store-only game, Release holds
  versions and builds (artifacts located in the stores), Distribution tracks the stores, and
  Update prompts players.
- Release alone remains useful as a changelog and truth store.

**Sharing data without importing.**

- `boundaries.test.ts` allows exactly one cross-service import, `update → release`, and it stays.
- Everything else goes through **Core-declared descriptor hooks**, the pattern of
  `ServiceDescriptor.authorizeRegistration` (`core/registry.ts:121-134`):
  - `releaseCatalog` (release): deliverables, releases, builds/variants, artifact records, channel
    pointers, resolved pack sets;
  - `delivery` (distribution): transports, availability, rollout and halt per outlet, and delivery
    URLs for a release or artifact;
  - `outletCapabilities` (distribution).
- A disabled service contributes no hook, and consumers degrade explicitly.

**First, make the service list data-driven.** A new slug touches about 45 files across five
languages today (notes/A3 §5.3); the docs' "one entry in `mount.ts`" claim is wrong and should be
corrected.

- Replace the hand-maintained enumerations with one table plus a drift gate before adding
  `distribution`: `ServiceSlug`, `SERVICE_NAMESPACES`, discovery, console nav and accents, manifest
  modules, and the SDKs' service enums.
- Ship **tolerance for unknown service slugs** in `parseServices` one deploy ahead. Today an
  unknown slug discards the **whole** `services_json` record (`core/services.ts:158`), so a worker
  rollback would silently switch Release, Update and Identity off.

**Core gains:**

- the **blob store** (R2, content-addressed): written by publishing, served by distribution;
- **trusted-publisher auth** (GitHub OIDC);
- **outlet-credential custody** (a new sealed kind, used only by distribution);
- the descriptor hooks;
- a **CORS policy**;
- the data-driven service table.

### 3.3 Trust model: two signers, two documents

The model is TUF's targets/timestamp split and Uptane's image/director split, adapted to Polaris
Key's existing JWS machinery (notes/E5 §1). Packs add **no document types**: the same two cover
every deliverable.

| Key                                                                                                                         | Held by                                                                                                                | Signs                                                                                                                                                                                                           | Rotation                                                                                                                                                |
| --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Release key** (Ed25519, one or more per product; optionally delegating a **content key** limited to data-only pack types) | CI: a GitHub Environment secret behind required reviewers, or better a non-exportable KMS Ed25519 key reached via OIDC | the **release record** `pkey-release+jws` for one release of one deliverable. It carries `deliverable`, `kind`, `version`, `seq`, then builds (app) or variants (pack), each with its own fields (listed below) | pinned in the app binary (as Sparkle pins `SUPublicEDKey`) and declared in `.pkey/release`. Two keys valid during rotation; later a root-signed keyring |
| **Product key** (existing, Worker-held under the KEK)                                                                       | Worker                                                                                                                 | the **channel feed** `pkey-feed+jws`, per channel and selector (`contentApi`, platform, variant), with the fields listed below. **No `deviceId`**, so it is public and edge-cacheable, like the trust manifest  | unchanged (trust manifest)                                                                                                                              |

Release record, per build or variant:

- `{platform, arch, format, sha256, size, buildNumber | variant}`;
- requirements and dependencies;
- patch artifacts: files index, chunk index, delta descriptors;
- for an app release, the **pinned pack releases** (the locked set);
- `minSupportedSeq`.

Store-assigned ids are not in here, because they arrive after signing; they live in
distribution.

Channel feed:

- `seq`, `issuedAt`, `expiresAt`;
- the app's current release (record hash);
- the resolved **pack set** (pack release record hashes), from release;
- floors and `critical`, from release;
- per-outlet availability, `rollout{bp, salt}` and `halted`, from distribution;
- the delta menu.

**The client:**

1. Verifies the feed against the product trust set: kid lookup, `expiresAt`, and `seq` ≥ the
   stored value.
2. Fetches each release record _by the hash the feed pins_, then verifies it against the **pinned
   release keys** (or a delegated content key, within its delegation), never the Worker-served
   trust set.
3. Verifies every payload, index and chunk against the record's SHA-256s.
4. Refuses a lower `seq`. Rolling back means rolling forward: CI publishes a higher-`seq` record
   that re-pins old hashes.

**What a compromise buys.** A compromised Worker or KEK can only withhold, delay or re-target among
already-signed releases. It **cannot ship code or a poisoned pack**. That matters because a Godot
`.pck` can carry GDScript and Godot itself never verifies packs. Diceroll's current model (one
offline RSA key over the manifest) has this property today, and moving onto Polaris Key must not
lose it.

**Wire impact (plan mode).**

- Two new `typ`s: `pkey-feed+jws`, a _device-less_ envelope variant like the trust manifest, and
  `pkey-release+jws`.
- A `PROTOCOL_VERSION` 3 → 4 bump.
- New corpus sections: `feedCases`, `releaseRecordCases` (app and pack kinds, delegation),
  `update-matrix.json`, `plan-matrix.json`, content apply vectors.
- All SDKs follow.
- While at it, add signature-malleability vectors (non-canonical S, A and R) so every Ed25519
  backend agrees (notes/A2 §7, notes/A5 §3).

**Interim option.** If v4 must wait, ship CI-signed release records first and verify them with
the pinned release key only. That is Diceroll's current security level, without freshness. Add
the Worker-signed feed with v4. Do not ship Worker-signed code pointers without the release-key
layer.

### 3.4 Release: the record of everything that exists

**Deliverables.**

- A product declares its deliverables in `.pkey/release`:
  - `app` (kind `app`): the product's application;
  - any number of packs (kind `pack`, with a pack type such as `godot.pck`, `files.tree`,
    `l10n.table`; see [`CONTENT.md`](CONTENT.md) §4).
- Each deliverable has its own version line, channels, requirements, dependencies and
  entitlement.
- **Declared, not sniffed.**
  - An `artifacts` map assigns each file `{deliverable, id, platform, arch, format, role, match}`.
  - CI uploads a **release descriptor** (the unsigned body of the release record, with sizes,
    hashes, build numbers and patch artifacts), ingested once per release.
  - Filename sniffing survives only as a fallback for legacy app releases.

**Schema** (sketch; new tables need `TABLE_OWNERS` entries for the generated data-model page):

- `release_sources(product, source_id, provider github|r2|store, owner, repo, installation_id, role, tag_pattern)`:
  multiple sources per product, which realises the spec's "non-GitHub provider seam".
- `release_deliverables(product, deliverable_id, kind app|pack, pack_type, def_json, def_source)`.
- `release_metadata` gains `deliverable_id` and `seq`.
- `release_builds(product, release_id, build_id, platform, arch, format, build_number, variant_json, requires_json, min_os)`:
  app builds and pack variants alike.
- `release_artifacts`:
  - fill the reserved `sha256`, `storage_key` and `metadata_json` columns;
  - add `build_id`, `role` (`payload`, `files-index`, `chunk-index`, `chunk-bundle`, `delta`,
    `signature`, `checksum`) and `locations_json` (R2, GitHub, store, external; all hash-pinned).
- `release_channel_policy(product, deliverable_id, channel, pointer_release_id, pinned, includes_json, min_supported, critical, source)`:
  - operator-owned with a `*_source` guard, replacing the never-read and sync-clobbered
    `release_channels.policy_json`;
  - rollout and halt are outlet-scoped and live in distribution.
- `release_sets(product, channel, select_json, set_json, resolved_at)`: resolved pack sets per
  selector (`contentApi` × platform × variant).
- `release_yanks(product, release_id, reason, at, by)`.

**Resolution rules** (every deliverable):

- **Newest** means highest precedence by the deliverable's version scheme (`semver` |
  `semver+build` | `4part`), not API order.
- **Channels** may declare `includes: [stable]`, so beta ⊇ stable.
- **Tags** outside `stableTagPattern` or listed in `ignoreTags` are never app-release candidates.
  That fixes `channels`/`packs`; packs publish through the descriptor, not through tags.
- **Per platform:** resolution picks the newest release with a matching build or variant, so a
  release missing the iOS build doesn't blank iOS. Whether it is _live_ on the device's outlet is
  distribution's answer, combined by update.
- **Pack sets:** on publish or pointer move, release resolves one set per selector. It takes the
  highest version of each pack satisfying every requirement and dependency, with ties broken by
  `seq`. An unsatisfiable set fails the publish; clients verify sets but never solve them.
- **Pagination** goes beyond 100 releases.
- **Yanked** releases resolve only by explicit pin.

**Publishing** (into release):

- CI authenticates with its GitHub Actions OIDC token, the npm/PyPI trusted-publishing model:
  1. The Worker verifies RS256 against the JWKS cached in KV.
  2. It checks the product's publisher policy: numeric `repository_id` and `repository_owner_id`,
     `job_workflow_ref` pinned to a protected ref, `environment: release`, `ref_protected`, a
     GitHub-hosted runner, a custom `aud`.
  3. It issues prefix-scoped R2 temporary credentials plus a one-shot "submit release" ticket.
- Ingest requires a GitHub **immutable release** where GitHub is the source, and cross-checks
  every artifact's digest.
- Fallback credential: hashed, scoped, expiring `pkeyci_` tokens.
- Sigstore/SLSA attestation checks can come later, asynchronously (notes/E5 §2).

**`pkey` CLI + `polaris-key/publish` GitHub Action:**

- `pkey auth github-oidc`
- `pkey build-info` (stamps `pkey_build.json` per export)
- `pkey release publish --deliverable app|<packId>`: uploads, computes patch artifacts for packs,
  signs with the release or content key, submits the descriptor
- `pkey release promote|pin|yank`
- `pkey distribution report|rollout|halt` (for outlets without connectors)
- `pkey feeds fdroid|zsync` (CI-signed static storefront and updater files)
- `pkey validate --strict`

Vendor CLIs do the store uploads, not the Worker (fastlane/ASC API, Play Publishing API, `msstore`,
`butler`, `steamcmd`, `xcrun ba-package`). Distribution records and controls.

### 3.5 Storage and byte delivery

- **Core blob store.**
  - R2, bound per environment in `wrangler.toml`.
  - Keys are `blobs/sha256/<hash>`, `bundles/sha256/<hash>` and `deltas/<from>/<to>.<method>`,
    immutable under R2 bucket locks.
  - A separate prefix holds gated content.
  - Release writes records; **distribution serves bytes**.
- **Distribution's `pkey-cdn` transport** serves every artifact role:
  - `Accept-Ranges`, `If-Range`;
  - a strong `ETag` equal to the SHA-256;
  - `Repr-Digest: sha-256=…` (RFC 9530);
  - `Cache-Control: public, max-age=31536000, immutable` for ungated objects;
  - CORS per the product allowlist.
- **Gating.**
  - Entitlement-gated releases (paid packs, supporter builds) are authorised per request, either
    streamed `no-store` or via a short-lived signed URL. Never rely on a hash being secret.
  - Gated and free packs never share chunk bundles.
  - Today's Release access modes (`public`/`authenticated`/`licensed`/`entitled`) move here as
    distribution's delivery access.
- **Separate domain.** Public bytes live on a **separate registrable domain**, not a `*.plrs.im`
  sibling, which would count as same-site with the console's cookies (notes/A3 §7).
- **Direct downloads and install scripts** are distribution routes. The existing
  `/<p>/release/dl/…` and `install.sh` paths become permanent aliases, as the appcast paths
  already are.
- **GitHub as a source.**
  - Cache release resolution for 60–120 s.
  - Offer a redirect mode for public artifacts.
  - Optionally mirror into R2 by cron or Queue, so a download costs at most one API call instead
    of 2–4 per request _and per Range chunk_.
  - Keep a streaming, non-redirecting path for outlets that reject redirects; winget does.

### 3.6 Update: what an installed app should do next

- **One signed channel feed for the app and its packs** (`pkey-feed+jws`, §3.3), composed from
  release's pointers and pack sets and distribution's per-outlet availability, rollout and halts.
- **Two conformance-tested client functions**, specified here and implemented in every SDK:
  - **Update decision** (`update-matrix.json`, like `gate-matrix.json`).
    - Inputs: feed, release records, build stamp, installed pack set, outlet capabilities, and the
      rollout bucket `u32(sha256(salt ‖ installId)[0..4]) mod 10000`, evaluated client-side so the
      feed is identical for everyone and cacheable.
    - Output: `none` (with `behind`), `packs`, `code-ready`, `binary` (URL or native updater),
      `store` (listing URL or deep link), `blocked` (below the outlet floor), or `platform` (the
      outlet updates itself).
    - Invariants carried from Diceroll (notes/A4 §5): no downgrades; the binary supersedes packs;
      the floor is judged against the binary and suppressed when `behind`; engine, format and
      texture gating; drop staged content on a channel switch; store builds never self-update code.
  - **Pack install planning** (`plan-matrix.json`).
    - Inputs: the target pack set, installed payloads and seed indexes, and the client's
      capabilities.
    - It chooses `noop`, `platform`, `delta`, `chunk`, `file` or `full` per pack by cost
      ([`CONTENT.md`](CONTENT.md) §7).
- **App-updater feeds** are update routes, rendered from the same records:

  | Feed                                                                                              | Consumer                                                                   | Signed by                | Notes                                                                                                                                                               |
  | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `pkey-feed+jws` + `pkey-release+jws`                                                              | Polaris Key SDKs (all languages)                                           | Worker / CI              | the native feed, app and packs                                                                                                                                      |
  | `/update/version` JSON (extended: build, sha256, size, url, minOS, critical, per platform/outlet) | simple clients; also read by Scoop `checkver` and Flathub `x-checker-data` | unsigned                 | CORS-enabled                                                                                                                                                        |
  | Sparkle appcast (extended)                                                                        | macOS direct                                                               | CI (EdDSA per enclosure) | build numbers, `minimumAutoupdateVersion`, `criticalUpdate`, `phasedRolloutInterval`, deltas, `hardwareRequirements`; universal DMGs                                |
  | WinSparkle appcast                                                                                | Windows installer builds                                                   | CI (EdDSA)               | reuse `appcast.ts`/`sparkle.ts` + `sparkle:os`, `installerArguments`; stream-hash instead of buffering (today's verifier buffers up to 256 MiB in a 128 MB isolate) |
  | Velopack `releases.<channel>.json`                                                                | Windows/Linux Velopack builds                                              | package hashes (CI)      | per channel/arch; bytes via distribution                                                                                                                            |
  | MSIX `.appinstaller` (2021 schema)                                                                | Windows App Installer                                                      | MSIX publisher cert (CI) | per channel; Range-capable delivery; `application/appinstaller` MIME                                                                                                |
  | AppImage `.zsync` pointer                                                                         | AppImageUpdate                                                             | CI (zsyncmake)           | stable per-channel URL                                                                                                                                              |

- **Telemetry.** `update_applied`, `update_confirmed`, `update_reverted`, `pack_failed` and
  `boot_rolled_back` arrive via `devices/report`. Allowlisted `engine` and `outlet` keys must be
  added; the allowlist silently drops unknown keys today. The events feed distribution's
  auto-halt (§3.9).

### 3.7 Content packs across Release, Distribution and Update

Packs are **release deliverables**, so everything in §3.2–§3.6 applies to them unchanged. This
section lists only what is pack-specific; the full design is [`CONTENT.md`](CONTENT.md).

- **Types** (release metadata, handled by per-SDK handlers): `godot.pck`, `godot.zip`,
  `files.tree`, `archive.*` (delivered as trees), `audio.bank`, `l10n.table`, `data.json`,
  `ml.model`, game-registered `custom.<name>`, and `unity.addressables` later. Handlers stage,
  verify, activate (hot, or at restart for Godot PCKs), roll back and uninstall.
- **Locked or floating.**
  - An app release **locks** exact pack releases in its record.
  - Event, localisation and cosmetic packs can **float** on a channel between app releases, as
    release-resolved pack sets gated by the app's `contentApi`.
- **Patch artifacts are release data; their bytes are distribution's.**
  - At publish, CI computes a files index, file-aware content-defined chunks packed into 4–16 MiB
    chunk bundles, and per-entry deltas for hot pairs. Release records them.
  - Distribution serves them through its transports.
  - Update's planner picks among `noop → platform → delta → chunk → file → full`.
  - On a synthetic 36 MiB Godot pack these downloaded 0.60 MB (delta), 1.05 MB (chunk) and
    0.99 MB (file), against 9.80 MB full, at 0.2–0.45 s of pure-GDScript client CPU
    ([`CONTENT.md`](CONTENT.md) §7.3).
  - Never compute deltas or chunk boundaries in the Worker.
- **Transports are distribution's.**
  - `pkey-cdn`, `embedded`, `apple-ba` (Apple-hosted Background Assets are versioned independently
    of the app and switch every installed app version, so the `contentApi` is part of the asset-pack
    id), `play-pad` (tied to versionCode), `steam-depot`, `msix-optional`, `flatpak-ext`, `web`.
  - Their availability per pack release is ordinary distribution availability, e.g. ASC
    `BACKGROUND_ASSET_VERSION_*` webhooks.
- **Data-only on store builds.**
  - Enforced at publish by CI lint: no scripts, `project.binary`, class caches or native
    libraries.
  - Enforced again on the device before mount, by checking the pack's directory against its
    declared prefixes. `replace_files` is not a boundary: zips ignore it, and `false` stops a
    pack's own UIDs registering.
- **Entitlements.**
  - A pack may name a licence `flag`; distribution enforces it at delivery.
  - On store outlets the entitlement originates from store commerce (§3.10).

### 3.8 Distribution (`distribution` service)

Distribution delivers **every release of every deliverable** (the app and each pack) to devices
and outlets, and tracks its state there.

**Data model** (sketch):

- `dist_outlets(product, outlet_id, kind, identity_json, capabilities_json, listing_json, capabilities_source)`:
  - identities come from `.pkey/distribution`;
  - security-relevant capabilities are operator-owned.
- `dist_transports(product, deliverable_id, outlet_id, transport, config_json)`: which transport
  carries which deliverable on which outlet, e.g. `diceroll.foes` on `app-store` uses `apple-ba`,
  on `play` `embedded`, elsewhere `pkey-cdn`.
- `dist_availability(product, release_id, build_id, outlet_id, transport, state, since, platform_ref_json, detail_json)`:
  - ASC app-version and Background Asset states;
  - Play track state;
  - Microsoft Store submissions;
  - Steam branches and depot manifests;
  - itch channels;
  - CDN publication;
  - CI reports for outlets without connectors.
- `dist_submissions(product, release_id, outlet_id, state, submitted_at, reviewed_at, detail_json)`.
- `dist_rollouts(product, deliverable_id, outlet_id, channel, release_id, rollout_bp, rollout_salt, state active|paused|halted|complete, mirrored, source)`:
  - self-hosted outlets: authoritative here, evaluated client-side (§3.6);
  - stores: mirrored from, and controlled through, the connector.
- `dist_access(product, deliverable_id, mode public|authenticated|licensed|entitled, entitlement)`:
  delivery gating, the successor to Release's access modes.
- `dist_keys(product, purpose, fingerprint_sha256, outlet_id, notes)`: the key inventory below.

**Routes:**

- `pkey-cdn` byte delivery (blobs, chunk bundles, deltas; Range; gated prefix);
- direct downloads and install scripts, with the `/release/dl` and `install.sh` aliases;
- storefront feeds under `/<p>/distribution/…`: AltStore/SideStore/PAL sources, the F-Droid
  static relay, Obtainium configs, the winget REST source, Scoop/Flathub JSON;
- the public download page (separate domain, §3.5);
- connector webhooks (ASC HMAC);
- admin controls: rollout, pause, resume, halt, submit, release a `PENDING_DEVELOPER_RELEASE`.

**Storefront feeds** (distribution routes; the app-updater feeds are update's, §3.6):

| Feed                                           | Consumer                                 | Signed by                           | Notes                                                                                                                                                                                     |
| ---------------------------------------------- | ---------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AltStore/SideStore source, AltStore PAL source | iOS sideload / EU                        | none (native client)                | two flavours (SideStore rejects PAL markers); `appPermissions` extracted from the IPA at ingest; top-level legacy fields for SideStore; short TTL; secret per-user URLs for private betas |
| F-Droid index-v2 (`entry.jar`)                 | F-Droid, Droid-ify, Neo Store, Obtainium | CI with the repo key (apksigner v1) | static files per channel repo; distribution never holds the repo key                                                                                                                      |
| Obtainium add-links (`obtainium://app/<json>`) | Obtainium                                | —                                   | per-channel configs; stable ETag/content hash                                                                                                                                             |
| winget REST source (later)                     | winget private source                    | —                                   | beta/private channels without PRs                                                                                                                                                         |

**Manifest.** `.pkey/distribution` holds outlets, identities, listings and per-outlet transports,
so `.pkey/release` stays about what exists (§3.12). Both are rule-9 validated.

**Connectors and credential custody:**

- **Custody.**
  - New sealed kind `outlet-credential` in its own table.
  - Unreachable from `openProductSecret` and edge-mint.
  - Written only by a platform admin, never from a manifest.
  - Every use audited.
  - Least-privilege scopes.
  - Signing primitives move to `core/jwt.ts`: ES256 for ASC (`kid`, `iss`, `aud:appstoreconnect-v1`,
    ≤ 20 min) and RS256 for Google service accounts, which also needs the JWT-bearer exchange and a
    token cache. RS256 is duplicated in `githubApp.ts` today.
- **App Store Connect** (API 4.x):
  - Webhooks (HMAC-signed, 12 event types) drive build upload, external TestFlight,
    app-version-state and Background Asset states.
  - Poll phased release, review submissions and internal TestFlight state, which have no webhooks.
  - Control actions: pause/resume/complete phased release, release a
    `PENDING_DEVELOPER_RELEASE`, manage public TestFlight links.
  - Stop relying on the iTunes lookup API: `bundleId` lookup is undocumented and lags. Polaris Key's
    availability record is authoritative, fed by webhooks.
- **Google Play:**
  - No review webhooks; poll via a throwaway edit plus `tracks.list`.
  - Controls: `userFraction` ramp, halt/resume, `inAppUpdatePriority`.
  - Optional auto-halt from the Play Developer Reporting API (crash/ANR).
  - RTDN over Pub/Sub push is billing-only; use it for the commerce bridge.
- **Microsoft Store:**
  - Submission status and package-flight rollout via the Store APIs.
  - `msstore` publishing is limited to free products and needs a manual first submission.
- **Steam and itch:** optional. Record branches and channels, and trigger `SetLive` for named
  branches.
- **Android developer verification:** a per-product key inventory (Play signing, upload, sideload,
  F-Droid repo) with SHA-256s. It feeds developer-verification registration, AppVerifier,
  `assetlinks.json` and the download page.

### 3.9 Rollouts, halts and telemetry

The responsibilities split three ways, for the app and for packs alike:

| What                                            | Service      | Notes                                                                                   |
| ----------------------------------------------- | ------------ | --------------------------------------------------------------------------------------- |
| Channel pointer, floor, `critical`, yank        | release      | per deliverable                                                                         |
| Rollout percentage, pause, halt, freeze windows | distribution | per outlet                                                                              |
| Signed freshness, kill-document TTL (5–15 min)  | update       | carries distribution's rollout and halts, and release's floors, for the device's outlet |

- **Store outlets:** distribution mirrors the store's own rollout (Apple's phased release is 7
  days; Play `userFraction`) and exposes controls through the connector.
- **Auto-halt:** update's outcome events (§3.6) are aggregated in a Durable Object or Analytics
  Engine, and distribution halts the outlet rollout on a threshold with a minimum sample.
- **Sentry:** the official Godot SDK (all six platforms) can tag `release` and `environment` with
  Polaris ids, and a Sentry alert webhook can open a halt candidate.

### 3.10 Commerce and entitlements

Store builds must sell digital unlocks through the store:

| Store           | Rule                                                                                                                 |
| --------------- | -------------------------------------------------------------------------------------------------------------------- |
| Apple App Store | 3.1.1; 3.1.3(b) lets a Polaris entitlement bought elsewhere unlock content only if the same item is also sold in-app |
| Google Play     | Payments policy; the 2026 fee restructuring and the US/EEA programs allow alternatives with fees                     |
| Microsoft Store | 10.8.1                                                                                                               |
| Steam           | Steam DLC and microtransactions                                                                                      |

**The bridge.**

- **Inputs:**
  - Apple: App Store Server Notifications v2 and signed transactions (x5c-chained JWS; use
    `appAccountToken` to link a Polaris user).
  - Google Play: purchase verification, server-side acknowledgement within 3 days, RTDN.
  - Steam: ownership checks.
- **Output:** licence entitlements (`flag`s). A pack's `entitlement` is then satisfied however the
  player paid, subject to each store's cross-platform rule.
- **Also useful:**
  - Apple `AppTransaction.originalAppVersion` for paid-to-free migrations.
  - Optionally, App Attest / Play Integrity to raise trust in a device token (sideloaded builds
    can't attest; give them a lower trust tier).

### 3.11 Web

- **CORS.** Add a per-product origin allowlist (like `OIDC_ISSUER_ALLOWLIST`):
  - preflight for `Authorization` and `X-PKey-*`;
  - `Access-Control-Expose-Headers: ETag, Content-Range, Repr-Digest`;
  - no credentials on public blobs.

  `OPTIONS` handling touches the OpenAPI/`routeCoverage` gate.

- **Hosting (optional).** Polaris Key can host web builds without breaking the console's origin:
  - R2 plus a thin Worker route on a **separate registrable domain**;
  - immutable `/<build>/…` paths and short-TTL `/<channel>/` pointers;
  - per-channel service-worker scope;
  - precompressed Brotli;
  - `application/wasm`;
  - COOP/COEP/CORP only for threaded builds (Diceroll's is single-threaded).

  Workers static assets cap files at 25 MiB, which is too small for Godot `.wasm` and `.pck`, so
  R2 is required.

- **Verification on web.** The GDScript verifier works everywhere. WebCrypto Ed25519 (Chrome 137+,
  Firefox 129+, Safari 17+) is an optional fast path via `JavaScriptBridge`.

### 3.12 What Diceroll's `.pkey/` would look like (illustrative)

The block below is a sketch of **proposed** fields, not today's schema. Each field needs a
validator rule, a mutation-table entry and a JSON-schema change (AGENTS rule 9).

```yaml
# .pkey/release.yaml (proposed v2, illustrative): WHAT EXISTS, for the app and every pack
github:
  owner: vladzaharia
  repo: diceroll
releaseKeys: # CI-held; the Worker never sees the private half
  - kid: diceroll-release-2026
    ed25519: "MCowBQYDK2VwAyEA…"
contentKeys: # optional delegation: may sign data-only pack types only
  - kid: diceroll-content-2026
    ed25519: "MCowBQYDK2VwAyEA…"
    scope: { kinds: [pack], dataOnly: true }
publishing:
  trustedPublisher:
    workflow: .github/workflows/release.yml
    environment: release
contentApi: 3 # the content shape this app build line expects
deliverables:
  app:
    kind: app
    versioning:
      scheme: semver
      stableTagPattern: "^v\\d+\\.\\d+\\.\\d+$"
      ignoreTags: [channels, packs]
      buildNumber: descriptor
    channels:
      beta: { includes: [stable] } # beta ⊇ stable
    artifacts: # declared map; filename sniffing is only the fallback
      - id: macos
        platform: macos
        arch: universal
        format: dmg
        match: "Diceroll-*-macos.dmg"
      - id: win-zip
        platform: windows
        arch: x86_64
        format: zip
        role: portable
        match: "Diceroll-*-windows-x86_64.zip"
      - id: linux-x64
        platform: linux
        arch: x86_64
        format: tar.gz
        match: "Diceroll-*-linux-x86_64.tar.gz"
      - id: apk
        platform: android
        arch: any
        format: apk
        match: "Diceroll-*-android.apk"
      - id: ipa-sideload
        platform: ios
        arch: arm64
        format: ipa
        match: "Diceroll-*-ios-sideload.ipa"
      - id: web
        platform: web
        arch: wasm32
        format: zip
        match: "Diceroll-*-web.zip"
  diceroll.core3d:
    kind: pack
    type: godot.pck
    required: true
    delivery: essential
    handler: { mountOrder: 2, prefixes: ["res://assets/kaykit/"] }
    variants: { texture: [s3tc, etc2, astc] }
  diceroll.audio:
    kind: pack
    type: godot.pck
    delivery: prefetch
    handler: { mountOrder: 3 }
  diceroll.extra:
    kind: pack
    type: godot.pck
    delivery: onDemand
    handler: { mountOrder: 6 }
  diceroll.l10n:
    kind: pack
    type: l10n.table
    variants: { locale: [en, fr, de] }
    delivery: prefetch # hot-activated via TranslationServer
  diceroll.events.halloween:
    kind: pack
    type: godot.pck
    channels: [events] # floats between app releases
    delivery: onDemand
    requires: { packs: { diceroll.core3d: "^1.2.0" } }
  diceroll.supporter.skins:
    kind: pack
    type: godot.pck
    delivery: onDemand
    entitlement: extras.diceSkins # enforced by distribution at delivery
patch: # computed in CI at publish, recorded by release, served by distribution
  strategies: [delta, chunk, file]
  chunking: { alg: fastcdc, avg: 65536, fileAware: true }
  deltaBases: hot-pairs
---
# .pkey/distribution.yaml (proposed, illustrative): HOW IT REACHES DEVICES AND OUTLETS
outlets: # identities only; capabilities are operator-owned
  direct:
    platforms: [macos, windows, linux]
  app-store:
    appleId: "…"
    bundleId: gg.vlad.diceroll
  testflight:
    bundleId: gg.vlad.diceroll
  altstore:
    artifact: ipa-sideload
  play:
    packageName: gg.vlad.diceroll
    tracks:
      stable: production
      beta: beta
  obtainium:
    artifact: apk
  fdroid-repo:
    artifact: apk
  steam:
    appId: "…"
    branches:
      beta: beta
  itch:
    target: vladzaharia/diceroll
  web: {}
transports: # per deliverable per outlet; default is our CDN
  default: pkey-cdn
  packs:
    app-store: apple-ba # Apple-hosted Background Assets; contentApi becomes part of the pack id
    play: embedded # or play-pad
    steam: steam-depot
listing:
  name: Diceroll
  subtitle: A cozy dice-rolling roguelite
  tintColor: "#3b1f1f"
```

The update service needs no manifest of its own: its feeds are computed from the two files above.

Outlet **capabilities** (`codeUpdates`, `downloadedScripts`, `commerce`) are deliberately absent.
They default per outlet kind and are changed only by an operator.

---

## 4. Per-platform playbooks

Each table reads: the outlet, what Polaris Key **provides** (feeds, files), what it can
**automate** (APIs), what the Godot SDK **needs**, and the **policy** that constrains packs,
code and commerce. Outlets, storefront feeds, connectors and availability are the
**distribution** service. The app's own update feeds (Sparkle, WinSparkle, Velopack, App
Installer, zsync, the signed channel feed) are **update**. Builds and artifacts are **release**. Details, sources and exact policy text are in `notes/E1` (Apple), `notes/E2`
(Android) and `notes/E3` (Windows, Linux, Web).

### 4.1 iOS and iPadOS

| Outlet                                 | Provides                                                                                                                                                                                                                           | Automates                                                                                                                                  | SDK needs                                                                                                                                                                             | Policy                                                                                                                                                             |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **App Store**                          | channel feed with Apple availability and phased day; listing URL; pack index; commerce bridge                                                                                                                                      | ASC webhooks (version state, build upload, Background Assets); phased release pause/resume/complete; release a `PENDING_DEVELOPER_RELEASE` | outlet detection via MarketplaceKit `AppDistributor.current` (iOS 17.4+); store prompt (`SKStoreProductViewController` or URL); StoreKit 2 for paid packs; Background Assets consumer | 2.5.2 plus DPLA 3.3.1(B): **data-only packs**, keep GDScript in the signed bundle; 3.1.1 IAP for paid content; 4.2.3(ii) disclose first-launch download size       |
| **TestFlight**                         | beta channel mapped to TestFlight groups and public link                                                                                                                                                                           | beta groups, What to Test, external beta review; webhooks for external build state                                                         | detect `testFlight` via `AppDistributor`; prompt to open TestFlight                                                                                                                   | builds expire after 90 days; no paid betas (2.2)                                                                                                                   |
| **AltStore / SideStore**               | **source JSON**: Classic/SideStore flavour, with top-level legacy fields and `appPermissions` extracted from the IPA; per-channel sources; deep links `altstore://source?url=` and `sidestore://source?url=`; unsigned IPA hosting | regenerate on release; `news` entries with `notify` for push                                                                               | detect `other`; poll the feed; open the store app's deep link to update; no IAP or App Attest here                                                                                    | free Apple IDs: 7-day signing, 3 apps, 10 App IDs a week. Ship **no app extensions** in the sideload IPA, because each consumes an App ID                          |
| **AltStore PAL / EU web distribution** | byte-exact ADP hosting; a separate PAL source with `marketplaceID`                                                                                                                                                                 | ASC alternative-distribution package endpoints; AltStore REST registration                                                                 | detect `marketplace(…)`                                                                                                                                                               | EU/JP/BR only; notarization review; 5% Core Technology Commission from 2026-10-01. A self-run source is easy; becoming a marketplace is not realistic for one game |

**Background Assets is the App Store pack transport.**

- **Modes:** Apple-hosted managed packs (`StoreDownloaderExtension`, `BAUsesAppleHosting`) for App
  Store and TestFlight installs; self-hosted managed or unmanaged packs for other cases.
- **Tooling:** packs are built with `xcrun ba-package` (Linux tools exist) and uploaded via the ASC
  API (`/v1/backgroundAssets` → versions → upload files).
- **Limits:** 200 GB and 200 packs per app.
- **Versioning:** packs are versioned independently of the app.
- **Consumption:** the Godot plugin calls `AssetPackManager.ensureLocalAvailability`, resolves
  `url(for:)` fresh on every launch, and passes the path to `ProjectSettings.load_resource_pack`.
- **Largest risk:** Background Assets needs an **app extension target and an App Group**, which
  Godot's iOS export and `.gdip` system do not support. CI must patch the exported Xcode project;
  prototype this first.
- **Unknown:** the self-hosted _managed_ protocol is not publicly documented. Use Apple-hosted for
  store builds, and the `pkey-cdn` transport elsewhere.

### 4.2 Android

| Outlet                                                    | Provides                                                                                                                             | Automates                                                                                                                                                 | SDK needs                                                                                                                                                                             | Policy                                                                                                                                                                                                                                                     |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Google Play** (production, open/closed/internal tracks) | feed with Play state (versionCode, rollout, priority, floor); pack index; commerce bridge                                            | Publishing API edits: tracks, `userFraction`, halt, `inAppUpdatePriority`, notes; state polling; Reporting API auto-halt; internal app sharing for `pr-N` | Kotlin v2 plugin: In-App Updates (flexible/immediate, priority), install-source detection; optionally Play Billing (`godot-google-play-billing`), Play Integrity, Play Asset Delivery | no self-update and no downloaded dex/`.so` (Device and Network Abuse); GDScript in downloaded packs is a grey zone, so **data-only packs**; Play Billing for digital goods, with alternative programs and fees in US/EEA/UK; no `REQUEST_INSTALL_PACKAGES` |
| **Direct APK**                                            | feed (versionCode, sha256, size, signer cert SHA-256); Range and strong-ETag hosting; `assetlinks.json`                              | developer-verification registration via the Android Developer Console API (OAuth user flow only)                                                          | direct-flavour plugin: `PackageInstaller` session, verify sha256, signer and versionCode; Android 14 update ownership; install at a quiet moment                                      | sideload developer verification: regional enforcement from 2026-09-30 for participating stores, broader in 2027. **Register `gg.vlad.diceroll` and every signing key now**                                                                                 |
| **Obtainium**                                             | stable per-channel URLs or an HTML index carrying versions; `obtainium://app/<json>` add-links; cert fingerprints for AppVerifier    | generate per-channel configs                                                                                                                              | none                                                                                                                                                                                  | as direct APK. A direct link without a version in it disables version detection, so prefer the F-Droid-format repo or GitHub source                                                                                                                        |
| **Self-hosted F-Droid repo**                              | static `entry.jar`, `entry.json`, `index-v2.json`, diffs and icons, one repo per channel; `fdroidrepos://…?fingerprint=` link and QR | CI generates and signs with the repo key (fdroidserver/apksigner v1); Polaris Key never holds that key                                                    | none                                                                                                                                                                                  | keep `versionCode` monotonic across channels. Use **one app signing key across Play (via PEPK), direct and F-Droid** so installs can cross-upgrade                                                                                                         |
| **F-Droid main**                                          | —                                                                                                                                    | —                                                                                                                                                         | a FOSS flavour without self-update                                                                                                                                                    | must build from public source, so not viable while Diceroll's assets stay private                                                                                                                                                                          |

**Pack transport.** Play Asset Delivery packs update only with a new AAB, and Godot does
install-time packs natively. So on Play, packs are embedded or delivered by PAD. The `pkey-cdn`
transport serves every other Android outlet.

### 4.3 macOS

| Outlet                             | Provides                                                                                                          | Automates                                                                                                                                    | SDK needs                                                                                                                                                                                                                      | Policy                                                                                                                                                                                         |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Direct (DMG/zip, Developer ID)** | Sparkle appcast (extended; universal builds; deltas; critical; phased; build numbers); pack index; code-pack path | CI signs, notarizes, staples and runs `sign_update`. Polaris Key verifies and stores signatures and never holds Sparkle or Developer ID keys | a Sparkle wrapper (GDExtension creating `SPUStandardUpdaterController`, plus `SUFeedURL`/`SUPublicEDKey`) **or** a GDScript "new version" prompt; packs in `user://` (Application Support), which keeps the bundle seal intact | notarization; Sparkle ≥ 2.6.4 (CVE floor, D-24; latest 2.10.0). A signed feed (`SURequireSignedFeed`) clashes with dynamic rendering unless CI pre-signs each variant, so keep it off at first |
| **Mac App Store**                  | availability and listing URL                                                                                      | ASC as for iOS                                                                                                                               | sandbox; no Sparkle; StoreKit; Background Assets (macOS 26+)                                                                                                                                                                   | 2.4.5: no downloaded code or resources that add functionality, no licence keys, updates only via the Mac App Store                                                                             |

### 4.4 Windows

| Outlet                   | Provides                                                                                                                          | Automates                                                                                                                    | SDK needs                                                                                                                                    | Policy                                                                                                                                                                         |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Microsoft Store**      | availability and listing URL (`ms-windows-store://pdp/?productid=`)                                                               | `msstore publish` from CI (free products only; the first submission is manual); package flights; gradual rollout (MSIX only) | detect package identity (`GetCurrentPackageFullName`); optional C++/WinRT GDExtension for `StoreContext` updates and add-ons                 | **games must ship as MSIX and update only through the Store** (10.2.5); no dynamic code (10.2.2); Store in-product purchase (10.8.1). Disable every self-updater in this build |
| **MSIX + App Installer** | `.appinstaller` per channel (2021 schema: `OnLaunch`, `ShowPrompt`, `AutomaticBackgroundTask`); Range gateway; correct MIME types | CI builds and signs MSIX (Azure Artifact Signing, $9.99/month)                                                               | none (the OS updates it; 64 KB block-map differential)                                                                                       | trusted certificate required; `ms-appinstaller:` is disabled by default, so link the `.appinstaller` file directly                                                             |
| **Installer / portable** | Velopack `releases.<channel>.json` **or** WinSparkle appcast; sidecar-PCK code updates for portable builds                        | CI: `vpk pack` (full + delta nupkg, `Setup.exe`, `Portable.zip`), or Inno Setup + `winsparkle-tool` signing                  | Velopack needs a tiny native launcher (its hooks must run first in `main()`) plus a GDExtension; WinSparkle needs a GDExtension over its DLL | sign with Authenticode; a sidecar `.pck` keeps the exe hash, and so its SmartScreen reputation, stable across content patches                                                  |
| **winget / Scoop**       | direct, **non-redirecting**, stable-hash URLs; per-channel `/version` JSON (Scoop `checkver` jsonpath)                            | `wingetcreate update --submit`; later a private winget REST source                                                           | none                                                                                                                                         | winget has no channels, so beta is a separate package id                                                                                                                       |

### 4.5 Linux

| Outlet                | Provides                                                                          | Automates                                                                                     | SDK needs                                                                        | Policy                                                                                                                                                                        |
| --------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **tar.gz / portable** | channel feed; sidecar-PCK code updates; packs                                     | —                                                                                             | pure GDScript                                                                    | —                                                                                                                                                                             |
| **AppImage**          | stable per-channel `.zsync` over a Range gateway (embedded as `zsync\|https://…`) | CI `appimagetool -u`, `zsyncmake`                                                             | `OS.execute("appimageupdatetool")`, or a prompt                                  | FUSE 2 for old runtimes; GPG optional                                                                                                                                         |
| **Flathub**           | JSON for `x-checker-data` (External Data Checker, every 2 h)                      | a PR to the `new-pr` branch; a `beta` branch for the beta repo                                | disable self-update inside Flatpak (`FLATPAK_ID`); optional portal UpdateMonitor | the monetisation policy; **the Flathub page reportedly forbids AI-automated submissions and AI-assisted manifests** (flagged unverified in notes/E3; check before automating) |
| **Snap**              | —                                                                                 | `snapcraft upload --release=<track>/<risk>` (channels map naturally; `pr-N` becomes a branch) | detect `SNAP`; disable self-update                                               | —                                                                                                                                                                             |
| **Steam Deck**        | see Steam                                                                         | —                                                                                             | GodotSteam (GDExtension)                                                         | Deck Verified: controller support, ≥ 9 px text at 1280×800                                                                                                                    |

### 4.6 Web

| Outlet                                                                  | Provides                                                                                                                                                            | Automates                                                | SDK needs                                                                                                                                                                                                        | Policy                                                                                                                                                          |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Polaris-hosted** (optional) or any host (itch, GitHub Pages, own CDN) | CORS on API routes; optional R2 hosting on a separate domain (immutable build paths, channel pointers, Brotli, COOP/COEP only for threaded builds); lazy pack blobs | CI uploads the build to R2 and moves the channel pointer | web branch of the loader (no threaded loading on single-threaded builds); `user://` is IndexedDB (may not persist; same-origin readable); optional WebCrypto fast path; PWA update signal via `JavaScriptBridge` | own commerce allowed; no stable device anchor, so no keyless enrollment on web and a new device on every storage clear; itch HTML5 limits (1,000 files, 500 MB) |

### 4.7 Steam and itch

| Outlet    | Provides                                        | Automates                                                        | SDK needs                                                                                                                      | Policy                                              |
| --------- | ----------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| **Steam** | availability, branch mapping (channel → branch) | optional `steamcmd +run_app_build`; `SetLive` for named branches | detect Steam (GodotSteam or `SteamAppId`); **all self-updating disabled**; packs embedded in depots; DLC depots for paid packs | Steam DLC and microtransactions for digital unlocks |
| **itch**  | availability (butler channel → channel)         | `butler push … --userversion`                                    | detect the itch app; self-update disabled in itch builds                                                                       | —                                                   |

This is why Diceroll's current behaviour is wrong: its Steam and itch uploads reuse the `github`
desktop zips, so the in-game updater downloads packs _inside_ Steam and itch installs. Outlet
detection plus operator-owned capabilities fixes this structurally (§5.5).

---

## 5. The Godot SDK

The target is **full parity** with Node and Swift across Core, License, Config, Devices, Identity,
Release and Update. It adds the distribution layer, content packs and a UI kit, and must pass the
conformance corpus as the **sixth language**. The full parity matrix (every method in every SDK,
with a proposed GDScript signature) is in notes/A2 §9.

### 5.1 Shape and API

The SDK ships as the addon `addons/polaris_key/`. It follows the proven Godot SDK pattern (Nakama,
Talo, Play Games): one autoload, `await`-able calls returning typed `RefCounted` results, signals,
Resource-based config and drop-in scenes.

```text
addons/polaris_key/
  plugin.cfg, plugin.gd            EditorPlugin: autoload, project settings, setup dock, export plugin
  polaris_key.gd                   autoload `PolarisKey`
  core/        transport, b64url, json_strict, crypto/{sha512, ed25519}, jws, trust, clock,
               cache, store/{file, secure}, discovery, device_id, fingerprint, facts, errors
  services/    license, config, devices, identity, release, update, content
  distribution/ build_stamp, outlet_detector, outlets/{direct, app_store, testflight, altstore,
               play, apk, fdroid, ms_store, app_installer, velopack, sparkle, steam, itch,
               flatpak, snap, appimage, web}, decision (the conformance-tested update function)
  content/     pack_store (content-addressed user://pkey/packs), mounter, transports/{embedded,
               pkey_cdn, apple_ba, play_pad, steam}
  updater/     slots (staged/current/previous), boot_guard (rollback), sidecar_swap
  ui/          boot/, gate, activation, sign_in, offline, devices, settings, banner,
               update_prompt, dev_menu_section, theme
  export/      export_plugin.gd (per-preset options, build stamp, pack verification)
  native/      optional: ios/ (xcframework), android/ (AAR), macos/, windows/
```

```gdscript
# Configure once: res://polaris_key.tres (outside addons/, so updates don't overwrite it)
# product = "diceroll", base_url, pinned_trust_keys, pinned_release_keys, default_channel

func _ready() -> void:
    var boot := await PolarisKey.boot({required_packs = ["core3d", "foes"], allow_offline = true})
    match boot.outcome:
        PKeyBoot.READY: get_tree().change_scene_to_file("res://game/title.tscn")
        PKeyBoot.BLOCKED: pass  # PKeyBoot already shows "update required" for this outlet

# Anywhere later
var dice_speed: float = PolarisKey.config.get_value("dice.animSpeed", 1.0)
if PolarisKey.license.is_entitled("extras.diceSkins"): unlock_skins()
PolarisKey.update.update_available.connect(_on_update)          # outlet-aware decision
var r := await PolarisKey.update.packs.ensure(["diceroll.nature"])   # any pack type; progress via signals
PolarisKey.update.packs.register_handler("custom.dialogue", DialogueHandler.new())  # game-defined pack type
var prompt := await PolarisKey.identity.begin_sign_in("Vlad's Deck")  # device-code + QR
```

### 5.2 Crypto (measured)

Godot 4.7.2 has mbedTLS 3.6.7: RSA PKCS#1 v1.5 and ECDSA (DER) only, and no Ed25519.
`HashingContext` stops at SHA-256; `Marshalls` accepts standard padded base64 only. The prototype
(`prototype/`, notes/A5) contains:

- **`PKSha512`**: FIPS 180-4, 24/24 against Python `hashlib`.
- **`PKEd25519Fast`**: a ref10-style port with fully unrolled field arithmetic and an interleaved
  double-scalar multiply. It rejects S ≥ L and non-canonical public keys, matching Node.
  - Verify time on the release template: ~7.1 ms median for small messages; 28 ms for the 87 KB
    payload at the cap.
  - The 350 KB bundle at its cap takes 96 ms, dominated by the GDScript SHA-512.
  - Estimates: 20–45 ms on low-end Android, 10–60 ms on web.
- **`PKEd25519Ref`**: a TweetNaCl port at ~122 ms, kept as a test cross-check.
- **`PKJws`**: the 13-step `verifyJws` order from `shared-jws`. It matches **all 36 corpus v2
  `jwsCases` verdicts and 68/68 raw signatures**.

**Recommendation:** pure GDScript is the one trust path.

- Add a per-`kid` cache of decompressed keys, and run bundle-sized verifies off the main thread
  (chunked on single-threaded web).
- Optional accelerators behind the same facade: WebCrypto on web; a Monocypher GDExtension
  (`freehuntx/gd-ed25519`, MIT, immature) on native.
- Accelerators are never required. The corpus decides edge cases, and the malleability vectors it
  lacks today should be added (plan mode).

**JSON caveats (Godot differs from JS).**

- Last duplicate key wins, so the SDK must port the duplicate-key scan.
- Trailing commas, leading zeros and raw control characters are accepted, so strict validation is
  needed _after_ signature checks.
- A lone surrogate is rejected.
- Every number is a float64 (exact to 2^53, as in JS).
- **U+0000 cannot live in a Godot `String`.** The corpus vector `valid-nul-byte-in-string` gets the
  right verdict but does not round-trip. Record it as a documented divergence or reject such
  documents.

### 5.3 Transport, persistence, device identity

**HTTP** (measured on 4.7.2).

- `HTTPRequest` **forwards `Authorization` on cross-host redirects**. The prototype's `pkeyt_` token
  reached a third-party host in the probe. So use `max_redirects = 0` and follow redirects manually
  without credentials.
- Gzip is on by default and breaks Range, so turn it off for downloads.
- `download_file` truncates rather than appending, so resume needs `HTTPClient` with append (or
  4.8's `append_to_download_file`).
- **iOS:** there is no OS trust-store reader, so the bundled Mozilla CAs are used. Pin via
  `TLSOptions.client(chain)` if desired.
- **Web:** `fetch` with CORS, and browsers strip `Authorization` on cross-origin redirects.

**Persistence.** `user://pkey/<product>/{device, token, managed.json}`:

- write-once 0600 device id;
- the token in a secure-store plugin where available (Keychain/Keystore), otherwise a 0600 or
  sandboxed file;
- atomic temp-file-and-rename for the cache;
- clock floor, anti-replay floors and trust set **never persisted**, per the contract.

**Device id and fingerprint** (`sha256("pkey-device:<slug>:<raw>")`, hashed on device, AGENTS
rule 7).

- `OS.get_unique_id()` is `/etc/machine-id` on Linux, `ANDROID_ID`, and `identifierForVendor` on
  iOS. It is **empty on Web**: use a random id in `user://`.
- On Windows it returns a hardware-profile GUID, not `MachineGuid`. On macOS it returns the
  **serial number**, not `IOPlatformUUID`. To agree with Node and Swift on desktop, read
  `MachineGuid` and `IOPlatformUUID` via `OS.execute`.
- Mobile gets anchor, model, RAM (and CPU on iOS).
- Consequences:
  - `strict` fingerprint tiers are unusable on web;
  - keyless enrollment is impossible on web;
  - device-code sign-in sends no fingerprint, so strict tiers fail on that path (a server gap).

**Secrets.**

- `clientScoped` secrets sit in the cache and a `.pck` is extractable, so treat them as
  **non-secret** in games.
- Use **edge-mint** (`config.mint_token(id)`) for third-party API keys such as leaderboards or
  cloud saves. No existing SDK implements edge-mint yet; Godot would be first.
- The docs claim secrets go to the OS keyring, but no SDK does this. Reconcile the two.

### 5.4 Managed config in a game

Precedence is unchanged: enforced/hidden > local override > environment > remote default > schema
default. In a game the layers become:

- **Local override:** a live provider over the game's own `user://settings.cfg`, keyed by each
  catalog entry's `accessor`. Enforced and hidden keys _ignore_ the saved value without deleting
  it, so the player's choice returns if the operator relaxes the state.
- **Environment:** `PKEY_CONFIG_*` on desktop plus `--pkey-config key=value` user arguments. Both
  are disabled in release builds for mobile and web.
- **Schema defaults:** a generated `catalog_generated.gd` (add a `gdscript` target to
  `tools/gen-mirrors.ts`).
- **Applying values:** through live engine APIs (vsync, audio buses, `Engine.max_fps`) in a
  `config_changed` handler. `PKeyConfigBinding.bind_property(node, prop, key)` automates it.

**What goes where:**

- remote kill switches and tuning → managed `config` keys;
- paid or earned features → licence `flag` entitlements;
- Godot feature tags → build facts only.

### 5.5 Distribution layer: one build, any outlet

**Build stamp.**

- The export plugin adds a per-preset **"Polaris Key → Outlet / Channel"** option through
  `_get_export_options`; `get_or_env` allows a CI override.
- It writes `res://.polaris_key/build.json` containing:
  - version, build number, outlet, channel, engine, platform, arch;
  - pack sources (`embedded` / `remote` / `mixed`) and the list of embedded packs.
- It returns `pkey_outlet_*` feature tags.
- This replaces Diceroll's `stamp_version.py` distribution field, which today is set **per export
  rather than per artifact** and so mislabels Steam, itch and sideload builds.

**Runtime detection overrides the stamp when the platform knows better.**

| Platform | Evidence                                                                                                 |
| -------- | -------------------------------------------------------------------------------------------------------- |
| iOS      | `AppDistributor.current` distinguishes App Store / TestFlight / marketplace / other in the same IPA      |
| Windows  | package identity (Store or App Installer)                                                                |
| Linux    | `FLATPAK_ID`, `SNAP`, `APPIMAGE`                                                                         |
| Steam    | GodotSteam or `SteamAppId`                                                                               |
| Android  | installer package (`com.android.vending`, `org.fdroid.fdroid`, `dev.imranr.obtainium`) via a tiny plugin |

**Capabilities come from the outlet, not the game.**

- Each outlet adapter declares defaults: code/data updates, binary update method, channel switch,
  commerce and downloaded scripts.
- The server may **narrow** them (operator-owned) but never widen security-relevant ones beyond
  the compiled defaults. A store build can never be talked into self-updating code.
- The dev-menu channel picker shows "locked by <outlet>" where switching isn't allowed.

### 5.6 Code updates without `--main-pack`

Official templates block `--main-pack` since 4.6, which is Diceroll's current mechanism. The
options, in order of preference:

1. **Full-app updaters with deltas** on desktop direct outlets: Sparkle on macOS, Velopack on
   Windows and Linux, AppImage zsync. These are platform-sanctioned, keep code signatures valid,
   and their deltas make "code-only" updates small (a changed `.pck` becomes a zstd delta).
2. **Sidecar-PCK swap** for writable portable installs on Windows and Linux.
   - Godot loads `<exe-name>.pck` beside the executable, so the updater verifies a staged pack,
     atomically renames it into place, and restarts (`OS.set_restart_on_exit`).
   - The per-entry delta bake measured in [`CONTENT.md`](CONTENT.md) §7.3 makes such a code-pack
     update a few hundred KB, and the result is byte-identical to CI's pack, so one SHA-256
     verifies it.
   - Not for macOS `.app` bundles (breaks the seal) or `Program Files` installs.
3. **Custom export templates** built with `disable_path_overrides=no`, keeping Diceroll's current
   design. This carries a large CI cost (6–8 template builds per engine bump) and should be chosen
   only together with PCK encryption, which needs custom templates anyway.
4. **Override-pack at autoload `_init()`** with `replace_files=true`. Fragile: already-loaded
   scripts, the global class cache, and typed `class_name` parsing in runtime packs. Avoid for code.

**Boot guard** is kept from Diceroll: staged/current/previous slots, rollback after two failed
boots, and a skipped version. It moves into `updater/` and reports `boot_rolled_back` so the server
can halt a bad rollout.

### 5.7 Packs at runtime

`PolarisKey.update.packs` (the update sub-client's pack facet) implements
[`CONTENT.md`](CONTENT.md) for Godot:

- **Handlers:**
  - `godot.pck` (restart activation);
  - `godot.zip` (tolerated, not preferred);
  - `files.tree`, `l10n.table`, `data.json` (hot activation);
  - `audio.bank`;
  - game-registered `custom.*`.
- **Resolves** the locked or floating pack set, then **checks** requirements: engine
  `major.minor`, format, `contentApi`, and texture family from `OS.has_feature("etc2"/"s3tc"/"astc")`.
  There is no runtime texture compression on templates, so each texture family is its own
  variant. This fixes Diceroll's S3TC-only pack being applied on arm64 Linux.
- **Picks a transport per outlet** and **plans** with the conformance-tested planner. Every
  strategy is pure GDScript, measured on 4.7.2 (notes/A6):

  | Strategy                                                                                                               | 36 MiB pack, v1→v2 | Client CPU |
  | ---------------------------------------------------------------------------------------------------------------------- | ------------------ | ---------- |
  | `delta` (per-entry `zstd --patch-from`, decoded by Godot's own engine decoder via a 5-byte `GDDL` wrapper, then baked) | 0.60 MB            | ~0.23 s    |
  | `chunk` (file-aware FastCDC 64 KiB)                                                                                    | 1.05 MB            | ~0.4 s     |
  | `file` (changed entries + GDScript PCK writer)                                                                         | 0.99 MB            | ~0.21 s    |
  | `full`                                                                                                                 | 9.80 MB            | ~0.2 s     |

- **Always rebuilds a full pack byte-identical to CI's**, verifies one SHA-256, writes it to a new
  content-addressed path under `user://pkey/store/`, and mounts it at next boot.
  - Godot never checks a PCK's own MD5s, so verification is the SDK's job.
  - Native delta overlays are never left mounted: they cost ~2.9 ms per file open per layer,
    forever.
  - A mounted pack is never overwritten: that corrupts reads.
- **Mounts** in `mountOrder`, one pack per frame, from an autoload before first use, after a
  directory check (declared prefixes, data-only).
- **Hot types** (trees, translations, data, audio) load from `user://` in milliseconds via
  `ResourceLoader.load`, `TranslationServer` and `load_from_file`.
- **Evicts** payloads outside the active and previous sets after a confirmed boot.

**Signals:** `pack_progress(id, bytes, total)`, `pack_ready(id)`, `pack_failed(id, err)`,
`set_changed(activation)`.

**UX obligations it enforces:**

- size disclosure before the first download (Apple 4.2.3(ii));
- a cellular choice;
- pause/resume;
- an "offline, play with installed content" path.

**Known engine issues:**

- `load_resource_pack` stalls the UI on Android (godot#105009);
- there is no unload API, and a mid-session remount serves stale cached resources;
- pack offsets are 32-bit;
- on web, `user://` is held entirely in memory, so large packs come from the browser's HTTP cache
  each session instead.

### 5.8 UI kit and `PKeyBoot`

**`PKeyBoot`** generalises Diceroll's BootShell design into the SDK's drop-in boot scene.

- It uses only engine built-ins until the UI pack mounts, then re-themes in place.
- It never cuts to another scene.
- It exposes every stage as a signal so a game can drive its own visuals instead.

| Stage               | What happens                                                                        | Player sees                                        |
| ------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------- |
| `SHELL`             | stamp + outlet detection; load and verify cache offline                             | logo, "Starting…"                                  |
| `GUARD`             | boot guard; apply a staged sidecar or code update; roll back after two failed boots | —                                                  |
| `SYNC`              | discovery, trust, feed, licence/config docs (bounded timeout; offline OK)           | "Checking for updates…"                            |
| `GATE`              | licence status → activation/sign-in UI when needed (`not-applicable` passes)        | activation panel / QR sign-in                      |
| `DECIDE`            | update decision for this outlet                                                     | store prompt, "update required", or silent         |
| `FETCH`             | required packs (size disclosure, cellular choice, pause)                            | progress bar with MB and speed                     |
| `MOUNT`             | ordered mounts; theme and font swap; backdrop and music fade in                     | the shell "upgrades itself"                        |
| `READY`             | emits `ready`; the progress bar morphs into the game's buttons                      | title                                              |
| `BACKGROUND`        | optional packs, update downloads, staged code                                       | corner pill; Camp/route items badged until mounted |
| `OFFLINE` / `ERROR` | explanation, Retry, "Play offline" when the required set is present                 | card                                               |

Other scenes come from React and Swift parity (notes/A2 §10). Each is themable through a `Theme`
and `tr()`-localisable copy, with gamepad focus support:

- `PKeyGate`;
- `PKeyActivationPanel`: key entry, sign-in, "continue free", offline;
- `PKeySignInDialog`: user code, **QR**, open/copy link, countdown;
- `PKeyOfflineDialog`: request code, bundle import by file, paste or drag-drop;
- `PKeyDeviceList`: other devices read-only;
- `PKeySettingsPanel`: rendered from catalog UI hints; enforced rows locked with "Set by …";
  provenance badges;
- `PKeyStatusBanner`, `PKeyUpdatePrompt`, `PKeyEntitlementBadge`;
- a dev-menu section: channel picker with outlet lock reason, build info, COPY DIAGNOSTICS, force
  check. It plugs into Diceroll's existing `DevMenu.register_section`.

### 5.9 Editor and export plugin

- **Setup dock.** Product slug, base URL, pinned keys fetched and verified from discovery, and a
  channel for editor runs. Use `add_control_to_dock` for 4.4 compatibility; `add_dock` exists only
  from 4.6.
- **Per-preset options.**
  - Outlet, channel, and pack sources (embedded/lean).
  - `pkey_*` feature tags.
  - Android manifest and Gradle patches for the direct flavour only: `REQUEST_INSTALL_PACKAGES`,
    `PackageInstaller`.
  - Info.plist keys (`SUFeedURL`, `SUPublicEDKey`, Background Assets keys).
- **Pack verification at export.** Fail on scripts, caches or native libraries in data packs.
- **CLI parity.** Everything works headless for CI via `EditorExportPreset.get_or_env` (4.4+).

### 5.10 Native plugins (optional, each behind a GDScript interface with stubs)

Missing plugins degrade to "store link" or "unknown outlet". They never break boot.

| Plugin                                     | Wraps                                                                                                                                                                     | Size                                                             |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| iOS (xcframework GDExtension, not `.gdip`) | `AppDistributor`, StoreKit 2 (paid packs), `AppTransaction`, Background Assets, Keychain, App Attest                                                                      | M–L; the Background Assets extension-target patching is the risk |
| Android (AAR, plugin v2)                   | install source, In-App Updates, `PackageInstaller` (direct flavour), Play Asset Delivery (fast-follow/on-demand), Keystore; reuse `godot-google-play-billing` for Billing | M                                                                |
| macOS                                      | Sparkle 2 (`SPUStandardUpdaterController`; sign helpers inside-out)                                                                                                       | S–M                                                              |
| Windows                                    | Velopack (plus a launcher shim), WinSparkle, `StoreContext` (C++/WinRT)                                                                                                   | M                                                                |
| Linux                                      | none required (`OS.execute` for AppImageUpdate)                                                                                                                           | —                                                                |
| Web                                        | a JS shim: WebCrypto Ed25519, PWA update events, storage persistence                                                                                                      | S                                                                |

Native plugins need NDK r28+ for 16 KB pages on Android and "Disable Library Validation" for
GDExtensions on macOS.

### 5.11 Conformance and CI

- A headless runner, `sdks/godot/tests/run_conformance.gd`, reads `conformance/corpus/v2` directly
  (desktop), so no mirror is needed.
- CI job: install Godot (`chickensoft-games/setup-godot`), run `--headless --import`, then run the
  runner (the editor binary, since templates ignore `-s`).
- **Every place that enumerates the language set changes:**
  - AGENTS.md, CONTRIBUTING.md, README, WIRE-CONTRACT;
  - about 15 docs pages, `build/wire/corpus.md` ("four runners") and `build/sdks/index.md`, plus a
    new `godot.mdx`;
  - `tools/gen-mirrors.ts` and `test:all`;
  - a new `release-godot.yml`.

  The list is in notes/A2 §5.4.

- **Fix first:** the Node runner's port of the build gate is stale against `core/gate.ts`. It
  still has the dev-build bypass that finding R3-01 removed.

### 5.12 Packaging and versions

- **Distribution:** a GitHub Release zip (canonical) and the Godot Asset Store. The Store was
  announced 2026-05, is in beta, and has no upload API yet. Also the legacy Asset Library while it
  lives.
- **Versioning:** keep `plugin.cfg`, the git tag and `PolarisKey.SDK_VERSION` identical, and ship
  `.uid` files.
- **Engine versions:** source-compatible floor 4.4; tested 4.4–4.7 plus 4.8 beta; blessed range
  4.6+. Feature-gate delta patches (4.6), `add_dock` (4.6),
  `add_apple_embedded_platform_*` (4.5) and `PCKPacker.add_file_from_buffer` (4.7).
- **Languages:** GDScript core. Godot 4 C# cannot export to web, so a thin C# facade can come
  later.

---

## 6. Experiences

### 6.1 Developer (adopter)

**Day one**

1. `pkey init --template godot` scaffolds `.pkey/{product,release,content}.yaml` from a Godot
   project.
   - It reads `export_presets.cfg` (bundle ids, package names, platforms) and `project.godot`
     (version, name).
   - It fixes today's scaffold bugs: `maxOfflineDays` is read as `policyExpiryDays`; a
     release-only product has no schema but still fails at link.
   - It **vendors the JSON schemas**, because a Godot repo has no `node_modules` and the packages
     publish as restricted.
2. Install the addon, either from the Asset Store or by running `pkey sdk godot`, which drops
   `addons/polaris_key/` and `res://polaris_key.tres` with pinned keys fetched from discovery and
   checked.
3. In the editor dock, pick the product and a dev channel. Each export preset gets an **Outlet**
   dropdown.
4. Link the repository in the console, as today. Enable trusted publishing: the console shows the
   exact workflow/environment policy to paste.
5. Add `polaris-key/publish@v1` to the release workflow after the existing export and sign steps.

**Release day**

- Tag `v0.3.0`. CI exports, signs and notarizes as it does today.
- `pkey release publish` then:
  1. uploads blobs to R2;
  2. signs the release records with the release key (a KMS or Environment secret);
  3. submits the descriptor;
  4. runs `vpk pack`, `zsyncmake` and F-Droid index signing.
- The vendor CLIs (fastlane/ASC, Play, `msstore`, butler, steamcmd) upload to the stores. **Polaris
  Key is not a build server.**
- The console shows the release × outlet matrix filling in:
  - direct outlets live at once;
  - TestFlight "processing" then "ready" via ASC webhooks;
  - App Store "in review";
  - Play "internal 100%".
- Promote to stable per outlet, optionally with a rollout percentage.

**Hotfix (code only).** Tag `v0.3.1`. What players get depends on the outlet:

| Outlet                            | What happens                                                                                         |
| --------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Desktop direct (Velopack/Sparkle) | a delta of a few MB                                                                                  |
| Store outlets                     | their normal review path                                                                             |
| iOS                               | shows "update available in the App Store" only once Apple availability flips (webhook), never before |

**Content drop.** `pkey release publish --deliverable diceroll.events.halloween --channel events`
publishes a new pack version, the same way the app is released:

- iOS gets them as Apple-hosted Background Asset versions uploaded by CI; Polaris Key tracks
  review through webhooks.
- Other outlets fetch from R2.
- Pack/app compatibility is enforced by `requires`.

**Beta testers.**

- A `beta` channel entitlement on the licence (keyless enrollment plus a sign-in claim works for a
  free game).
- The desktop dev menu lists beta.
- On iOS the tester goes to TestFlight; on Android, the Play open track or the beta F-Droid repo.
- Channel names are unified across the licence gate and Release (§11, decision 5).

**Debug and support.** The player presses COPY DIAGNOSTICS; the ticket carries device id, outlet,
channel, build, pack set and last decision. The console's device page shows the same, and support
can pin that device to a channel or build.

### 6.2 Administrator (operator)

New or changed console surfaces, in the order they matter (notes/A3 §2.4):

1. **Distribution matrix** (Distribution section).
   - Rows are app releases and pack releases; columns are outlets.
   - Each cell shows submission state, availability, rollout % and pause/halt controls. Artifact,
     sha256 and signature/notarization come from Release through the build-catalog hook.
2. **Builds and channels** (Release section).
   - Builds per platform/arch/format with artifacts and hashes. The artifact data is already
     returned by `…/release/releases` but not shown.
   - Channel pointers with promote/pin/yank, `includes`, floor and critical flag. Every control is
     operator-owned and survives resync.
3. **Outlets and credentials** (Distribution section). Outlet identities and listings, credential
   health (expiry, last successful call, scopes), webhook health (ASC deliveries), key inventory
   (Play signing, upload, sideload, F-Droid, release keys) with fingerprints.
4. **Packs, in the same places as the app.** Pack deliverables, versions, requirements,
   entitlement, size and which app releases pin which pack releases (Release); pack releases ×
   outlets with transport states such as Background Assets review (Distribution).
5. **Devices, product-wide.** Breakdown by platform, outlet, version, engine and channel. Today
   devices are listed per licence only, so free games see none.
6. **Update health.** Funnel (offered → downloaded → applied → confirmed/reverted), pack failures,
   crash-free rate from Sentry, auto-halt state.
7. **Setup checklists that respect enablement.** Today they always ask for a Sparkle key and
   "Issue a license" even with License off.

**Operator-ownership model.** Everything an operator sets live (access modes, compat window,
rollout, halts, outlet capabilities) gets a `*_source` column. A manifest resync never overwrites
an operator's value. This is the same machinery as `services_source` and `fingerprint_policy_source`.

### 6.3 Player (end user)

**Download page** (public, per product, on the separate domain):

- **Platform detection** via User-Agent Client Hints. Handle iPadOS reporting itself as a Mac.
- **Primary button** for the detected platform; store badges built from outlet identities.
- **"Other ways to get it":**
  - AltStore / SideStore "add source" (deep link + QR);
  - Obtainium add-link;
  - F-Droid repo (link + QR + fingerprint);
  - winget and Scoop commands;
  - AppImage / Flatpak / Snap;
  - web "Play now".
- Checksums and signer fingerprints, minimum OS, per-outlet notes, full vs lean desktop download.
- TestFlight, Play testing and beta repo links **only for entitled accounts**.
- The portal's current Downloads view requires sign-in and a licence even for public artifacts,
  and lists sidecars. It stays for licensed products; the public page is separate.

**In game**, by outlet:

| Outlet               | Update experience                                                                                                                                    |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Store                | "Update available" opens the store page (or the in-app sheet: `SKStoreProductViewController`, Play In-App Updates flexible or immediate by priority) |
| TestFlight           | "open TestFlight"                                                                                                                                    |
| AltStore / SideStore | "open AltStore"                                                                                                                                      |
| Steam / itch         | silent; the platform updates                                                                                                                         |
| Desktop direct       | downloads in the background, "Restart to update"                                                                                                     |
| Web                  | always current (PWA "new version, reload")                                                                                                           |

- Content downloads disclose size, respect cellular, can pause, and never block play when the
  required set is present.
- A **mandatory floor** shows one clear screen with the right action for the outlet, not a generic
  error.
- **Privacy:** fingerprint components are hashed on device and optional under `open` registration.
  Facts are an allowlist. No installed-app enumeration. The existing `PRIVACY.md` posture carries
  over; add `outlet`, `engine` and update events to its tables.

---

## 7. Existing tools to incorporate

Principle: **adopt platform mechanisms and vendor tooling; build only the parts that are Polaris
Key's contract** (verification, decision, trust, records). Full tables with licences, versions and
maintenance status are in `notes/E6` (client), `notes/E7` (server and CI), `notes/E4` (Godot) and
`notes/E5` (cross-cutting).

### 7.1 SDKs (client side)

**Architecture: keep independent per-language implementations verified by the shared corpus.**

- Do not move to a shared Rust/C core (UniFFI / napi-rs / gdext). The shared wire logic is small.
- A native core would need five binding layers plus a hand-written Godot shim (UniFFI has no Godot
  target).
- It would hurt exactly the hardest Godot targets: web (a GDExtension needs dlink templates and
  cross-origin isolation) and iOS.
- nakama-godot, a pure-GDScript client that works on web, is the closest precedent.

| Area                  | Adopt                                                                                                                                                                                                         | Wrap / optional                                                                                                                         | Build ourselves                                                                                                                     | Avoid                                                                                                                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ed25519               | WebCrypto (Node/React/web), CryptoKit (+ swift-crypto on Linux), pyca/cryptography, JCA on Android API 33+ / Tink below                                                                                       | Monocypher 4.0.3+ GDExtension (or a vetted fork of `freehuntx/gd-ed25519`) as a Godot accelerator; @noble/ed25519 as a browser fallback | pure-GDScript SHA-512 + Ed25519 (done, `prototype/`)                                                                                | Monocypher's default BLAKE2b EdDSA; relying on library defaults for edge cases (ZIP215 vs strict): the corpus decides                                                                       |
| Self-update (desktop) | Sparkle **≥ 2.9.6** (raise the Swift floor from 2.6.4: Aug 2026 security fixes), WinSparkle 0.9.x (EdDSA), Velopack (MIT; Rust core; SDKs for C#/C++/JS/Rust/Python; deltas)                                  | a Velopack launcher shim + GDExtension for Godot                                                                                        | the signed Polaris Key manifest _on top of_ Velopack/Sparkle (neither signs its feed by default)                                    | tufup, CodePush (retired), Squirrel.Windows (legacy)                                                                                                                                        |
| OTA protocol ideas    | Expo Updates' open protocol (`runtimeVersion` = our `requires`, channel header, `rollBackToEmbedded` directive, SHA-256 immutable assets, percentage rollouts); Tauri updater (mandatory signatures, 200/204) | —                                                                                                                                       | —                                                                                                                                   | —                                                                                                                                                                                           |
| Godot UI and plumbing | built-ins (HTTPRequest/HTTPClient, `load_resource_pack`, `TCPServer`, `JavaScriptBridge`); kenyoni QR (pure GDScript, MIT); GUT 9.7 (corpus runner)                                                           | GodotApplePlugins (StoreKit 2, Sign in with Apple; xcframework pattern); `godot-google-play-billing`; Godot Mod Loader (ideas only)     | device-code sign-in (the existing device-flow addon is a toy); secure storage (no maintained plugin); pack manager; outlet adapters | fenix-hub JWT addon (HS/RS only); a web GDExtension dependency                                                                                                                              |
| Identity              | ASWebAuthenticationSession + own PKCE (iOS); Custom Tabs + own PKCE (Android; AppAuth-Android unmaintained since 2021); oauth4webapi / openid-client (JS); Authlib (Python); SimpleWebAuthn (passkeys)        | AppAuth-iOS 3.0 (optional)                                                                                                              | the RFC 8628 user-code page on the server                                                                                           | —                                                                                                                                                                                           |
| Remote config interop | OpenFeature providers for Web/React/Node first (stable SDKs); Python, Swift and Kotlin SDKs are pre-1.0                                                                                                       | an OpenFeature-shaped GDScript API (no Godot SDK exists)                                                                                | —                                                                                                                                   | competing on generic flag evaluation. Polaris Key's differentiator is **signed, offline-verifiable** config, which none of LaunchDarkly, ConfigCat, Unleash, Flagsmith or Firebase document |
| Deltas                | zstd `--patch-from` (CI)                                                                                                                                                                                      | HDiffPatch (MIT) as an optional native applier on desktop/Android                                                                       | full-pack + Range resume first; chunk index later                                                                                   | computing deltas in the Worker                                                                                                                                                              |
| Telemetry             | Sentry Godot SDK (MIT, all six platforms incl. web; release health)                                                                                                                                           | —                                                                                                                                       | first-party update/pack events via `devices/report`                                                                                 | OpenTelemetry in browsers (experimental)                                                                                                                                                    |

**A new SDK worth considering: Kotlin/Android.** Its AAR would double as the Godot Android plugin
backend, and native Android apps get a first-class client. It would use:

- JCA/Tink for Ed25519;
- OkHttp/Ktor for transport;
- WorkManager for background work;
- DataStore + Keystore for storage (EncryptedSharedPreferences is deprecated);
- `play` and `foss` flavours (F-Droid rejects Play Services).

C#/.NET should wait unless Unity or MAUI comes into scope. When it does, use BouncyCastle or NSec;
the BCL still has no Ed25519.

**Licensing flags for commercial games:**

- **Avoid embedding:** AGPL/GPL code (libsignal, Bitwarden sdk-internal); LGPL (casync) is awkward
  to link statically on iOS.
- **MPL-2.0** (gdext, UniFFI, Capgo) is fine to link, but modified files must stay public.
- **zstd** is dual-licensed: choose BSD.

### 7.2 Server, CI and publishing

**Principle: bytes never transit the Worker.**

- The request body cap is 100 MB on Free/Pro and isolates get 128 MB.
- CI uploads to R2 with presigned or temporary credentials, or pushes with the store CLI.
- The Worker records metadata, verifies hashes after upload, serves or redirects downloads, and
  calls small-JSON store APIs.

Libraries below were tested inside `workerd 1.20260929.1` during the research (notes/E7).

| Layer                                     | Adopt                                                                                                                                                                                                                                                                                                                                                                                                                                          | Notes                                                                                                                                                                                                             |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Worker (embed)**                        | `jose` 6 (tested: ES256 ASC JWT, RS256 Google SA JWT, GitHub OIDC verify via remote JWKS; the Worker still pins `^5.9.6`); `fflate`/`unzipit` (read IPA/APK in memory); `bplist-parser` (Info.plist); a vendored AXML manifest parser (`@devicefarmer/adbkit-apkreader`, Apache-2.0: package, versionCode); `aws4fetch` (R2 presign); native `crypto.DigestStream` (tested 32 MiB) and WebCrypto Ed25519                                       | IPA/APK parsing is a cross-check only. CI extracts the authoritative metadata (`plutil`, `aapt2`). The AltStore `appPermissions` come from the IPA's entitlements and privacy keys                                |
| **Worker (lazy)**                         | Apple's App Store Server Library for Node (MIT)                                                                                                                                                                                                                                                                                                                                                                                                | works **only via `await import()`** inside the handler (its `jsrsasign` dependency touches randomness at global scope, which workerd forbids); for StoreKit 2 transaction and Server Notification v2 verification |
| **Worker (avoid)**                        | `googleapis` (1 MB, needs a `process` shim, gzip error bodies undecoded), `jsrsasign`, in-Worker Sigstore/TUF verification                                                                                                                                                                                                                                                                                                                     | raw REST + `jose` (31 KB) for Play                                                                                                                                                                                |
| **`pkey` CLI (native)**                   | `sign sparkle` (Sparkle and WinSparkle signatures are pure Ed25519 over the whole file, so a ~30-line signer replaces macOS-only `sign_update`), `release upload/finalize/publish/yank/promote`, `feed render --dry-run`, `doctor` (tool presence, Android verification readiness, immutable-release setting)                                                                                                                                  | —                                                                                                                                                                                                                 |
| **`pkey` CLI (wrap)**                     | `rcodesign` (pin 0.29; maintenance smell) with `quill` as fallback; `jsign` (Apache-2.0; Authenticode for exe/msi/msix from Linux, incl. Azure Artifact Signing, KMS, HSM); `osslsigncode`; `apksigner`; `asc` (open-source ASC CLI; Build Upload API works from Linux); `fdroid update` (AGPL, runs in CI only); `butler`; `steamcmd`                                                                                                         | the Azure Artifact Signing Action is Windows-only, so use jsign on Linux                                                                                                                                          |
| **Official Action `polaris-key/publish`** | OIDC auth → classify, hash and sign sidecars → R2 upload → finalize (the Worker verifies size and sha256) → publish or promote (rollout %, critical, floors, `requires`) → record store links and attestation refs → notify                                                                                                                                                                                                                    | it does **not** build, sign binaries or upload to stores. Diceroll's `setup-diceroll` composite keeps doing the Godot setup                                                                                       |
| **Bring your own (document it)**          | fastlane (`match` is its unique value), gradle-play-publisher / `upload-google-play`, `msstore` + `setup-msstore-cli`, `wingetcreate` (MIT; avoid AGPL/GPL winget-releaser and Komac for embedding), Homebrew bump, Flathub PR + `flatpak-external-data-checker`, `appimagetool` + zsync, Velopack `vpk`, `game-ci/steam-deploy`, Firebase App Distribution for QA, `setup-godot` / `godot-export` / `godot-ci` / GodotPckTool / GUT / gdUnit4 | Codemagic CLI tools are GPL-3.0: BYO only, never embed                                                                                                                                                            |

**Reference model to copy: Keygen.sh.** It is the closest existing platform to Polaris Key's
licensing and distribution. Borrow:

- **Release status** DRAFT → PUBLISHED → YANKED: yank delists but retains.
- **Artifact lifecycle:** WAITING → UPLOADED → FAILED. Create returns a presigned upload URL; the
  artifact fails if not uploaded within 1 h.
- **Artifact fields:** `platform`/`arch`/`filetype`, checksum and signature.
- **Packages with "engines":** protocol renderers over the same artifacts, which maps onto our
  outlets and feeds.
- **An `/upgrade` endpoint** (semver-sorted, channel-aware, entitlement-filtered, 404 when none).
- **Expiry-aware access:** a lapsed licence keeps releases published _before_ its expiry. This is a
  better fit for games sold once than "expired means no downloads".

Also borrow:

- **Unity CCD:** content release snapshots plus named badge pointers, the shape of pack indexes and
  content channels.
- **Expo Updates:** the `runtimeVersion` gate plus directives.

**Multiple byte providers.** Model each artifact as an ordered, hash-pinned `locations[]`:

| Provider   | How it serves bytes                                      |
| ---------- | -------------------------------------------------------- |
| `r2`       | binding stream, public 302, or presigned for gated files |
| `github`   | proxy or `browser_download_url`                          |
| `s3`       | B2 or MinIO via SigV4                                    |
| `store`    | link-out only (`itms-apps://`, `market://`, `steam://`)  |
| `external` | a stable URL with a pinned sha256                        |

**Package-manager outlets** (winget, Homebrew cask, Scoop, Flathub extra-data) need a **public,
immutable, non-redirecting, hash-pinned** URL. Add one for `access=public` artifacts.

**GitHub caveats.**

- GitHub **immutable releases** lock tags and assets after publish, which breaks Diceroll's mutable
  rolling `channels` release if the repository setting is on. Moving feeds into Polaris Key removes
  that mutation entirely.
- Android developer verification (from 2026-09-30) affects the APK, Obtainium and F-Droid-repo
  outlets. Diceroll's APK is currently debug-signed unless the release keystore secret is set, so a
  release keystore is a prerequisite.

---

## 8. Carrying the concepts to the other SDKs and products

Nothing above is Godot-specific except the runtime mechanics in §5. The generalisable pieces:

1. **One canonical release record, many feeds.** Builds × outlets × requirements × hashes, with
   AppStream-flavoured field names. Every feed is a pure renderer of it: Sparkle, AltStore,
   Velopack, `.appinstaller`, F-Droid, the native signed feed. A new outlet is a renderer and a
   record kind, never a new architecture. There is no universal release-metadata standard, so make
   ours a documented superset and publish it in the OpenAPI spec.
2. **Outlet + capabilities.** Any app on any stack asks the same question: "where did this install
   come from, and what may it do?" Swift apps get `AppDistributor`. Electron apps and Python CLIs
   get Velopack, WinSparkle or package-manager detection. Web apps are an outlet too.
3. **Two-signer trust.** `client-core` verifies the feed (product key) and the release records
   (release key) for every language. Sparkle's EdDSA key becomes one instance of the release key
   (same algorithm).
4. **The update decision is a conformance-tested pure function** (`update-matrix.json`), like the
   licence gate. Six languages decide identically about downgrades, floors, requirements and outlet
   capabilities.
5. **Packs are typed, versioned, content-addressed units** ([`CONTENT.md`](CONTENT.md)) with
   requirements, dependencies, delivery policy, transports and a patch-strategy ladder:
   - Unity Addressables bundles and catalogs;
   - Unreal ChunkDownloader chunks;
   - Electron resource bundles;
   - ML models or datasets for Python tools;
   - Swift apps' Background Assets;
   - lazily loaded web chunks.

   `requires` is the generic compatibility key: `engine: godot-4.7`, `unity-6000.3`,
   `electron-38`, `abi: …`.

6. **A boot protocol, rendered natively per framework:** Godot `PKeyBoot`, SwiftUI
   `PolarisBootView`, React `<PolarisBoot>`. Each has the same stages (shell → guard → sync → gate
   → decide → fetch → mount → ready) and the same signals and events.
7. **Build stamp** (`pkey build-info`) and **trusted publishing** work for any build system and any
   GitHub Actions workflow.
8. **Commerce bridge.** Store receipts become licence entitlements for any product sold on a store.

**Per SDK:**

| SDK                    | What it gains                                                                                                                                                                    |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node                   | Electron: Velopack JS or an electron-updater-compatible feed renderer. CLIs: the generic `/version`, and `install.ps1` alongside `install.sh` (today's installer is Darwin-only) |
| Python                 | Signed-feed verification, a resumable pack downloader (models, datasets), the Velopack Python SDK for desktop tools                                                              |
| Swift                  | Extended Sparkle features; iOS outlet detection; Background Assets transport; StoreKit 2 bridge; raise the Sparkle floor to ≥ 2.9.6                                              |
| React                  | CORS-enabled feed, PWA update pointer, OpenFeature provider                                                                                                                      |
| Kotlin (new, optional) | Play/F-Droid flavours, In-App Updates, PAD, PackageInstaller; doubles as the Godot Android backend                                                                               |

**djdl** (the first product) benefits directly: universal DMGs, build numbers, critical, phased and
delta Sparkle items, R2 hosting off the GitHub quota, trusted publishing, and a Windows path via
WinSparkle.

---

## 9. Issues found along the way

### 9.1 Polaris Key (worth fixing regardless of Godot)

| #   | Issue                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Where                                                 | Impact                                                                                                 | Severity                 |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------ |
| 1   | Resync overwrites operator-owned `artifact_policy_json`, both access modes, and the compat window. An operator's `entitled` is downgraded to `public` on every `.pkey/` push                                                                                                                                                                                                                                                                                               | `release/resync.ts:179-191, 277-290`                  | silent weakening of an access control (same class as R6-03)                                            | **High**                 |
| 2   | Licence gate channels `stable\|staging\|pr\|dev` vs Release channels `stable\|beta\|pr-N\|manual`; `X-PKey-Channel: beta` is refused as unknown                                                                                                                                                                                                                                                                                                                            | `core/gate.ts:51-88`, `release/channels.ts`           | no coherent beta program across License and Release                                                    | **High**                 |
| 3   | Every download/Range chunk costs 2–4 GitHub API calls against one ~5,000/hour installation quota shared by all products; exhaustion 503s everyone                                                                                                                                                                                                                                                                                                                          | `release/gateway.ts:70-106`, `github.ts`              | a single popular game degrades every product                                                           | **High** (at game scale) |
| 4   | Non-semver tags (`channels`, `packs`) can become `latest`; "newest" is API order; only 100 releases are read                                                                                                                                                                                                                                                                                                                                                               | `release/channels.ts:112-146`, `github.ts:144`        | wrong builds offered                                                                                   | High (for Diceroll)      |
| 5   | Edge-mint signs with any named product secret; minting needs only a device token (anyone under `open`)                                                                                                                                                                                                                                                                                                                                                                     | `services/config/mint.ts:214-234`                     | latent: anything stored as a product secret is mintable. Hard design constraint for outlet credentials | High (latent)            |
| 6   | Unknown service slug discards the whole `services_json`                                                                                                                                                                                                                                                                                                                                                                                                                    | `core/services.ts:158`                                | rollback hazard for any new service (`distribution`)                                                   | Medium (prerequisite)    |
| 7   | Webhook ignores `release` events; the truth store is stale until a `.pkey/` push or manual resync                                                                                                                                                                                                                                                                                                                                                                          | `githubWebhook.ts:155-157`                            | console and portal lag                                                                                 | Medium                   |
| 8   | Unique `(product, version)` index is outside the upsert's conflict target; `v1.2.0` + `1.2.0` fail a batch after earlier writes landed                                                                                                                                                                                                                                                                                                                                     | truth-store upsert                                    | partial resync                                                                                         | Medium                   |
| 9   | R6-10 downgrade finding still open (deleting the newest release silently promotes an older one)                                                                                                                                                                                                                                                                                                                                                                            | `test/attack/R6-release.test.ts:1332`                 | no yank semantics                                                                                      | Medium                   |
| 10  | No CORS anywhere                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `packages/worker/src`                                 | web clients blocked                                                                                    | Medium                   |
| 11  | Sparkle verification buffers the whole DMG (≤ 256 MiB) in a 128 MB isolate                                                                                                                                                                                                                                                                                                                                                                                                 | `release/sparkle.ts`                                  | OOM on large DMGs, not a clean 404                                                                     | Medium                   |
| 12  | Devices are listable only per licence                                                                                                                                                                                                                                                                                                                                                                                                                                      | `admin/api.ts:900-920`                                | licence-free products' devices are invisible                                                           | Medium                   |
| 13  | `pkey init` scaffold writes `maxOfflineDays` (read as `policyExpiryDays`: licences expire in 14 days) and an ignored `deviceLimit`; `validate` and link disagree on a missing schema                                                                                                                                                                                                                                                                                       | `cli/src/manifest.ts:148-152, 233-239`                | broken first-run experience                                                                            | Medium                   |
| 14  | No SDK implements re-register-on-401 for licence-less devices                                                                                                                                                                                                                                                                                                                                                                                                              | `sdk-node/src/client.ts:130-137`, Python              | contract gap                                                                                           | Medium                   |
| 15  | Node conformance runner's build-gate port is stale (dev bypass removed by R3-01)                                                                                                                                                                                                                                                                                                                                                                                           | `conformance/runners/node/corpusV2.test.ts:350-357`   | test integrity                                                                                         | Medium                   |
| 16  | Swift pins Sparkle `from: 2.6.4`; 2.9.5/2.9.6 fixed delta-patch symlink and root-escalation issues                                                                                                                                                                                                                                                                                                                                                                         | `sdks/swift/Package.swift`                            | security floor                                                                                         | Medium                   |
| 17  | Platform/arch header values differ across SDKs (`win32`/`x64` vs `windows`/`AMD64` vs `darwin`/`x86_64`); `ramBucket` < 1 GiB differs                                                                                                                                                                                                                                                                                                                                      | SDKs                                                  | analytics and fingerprint drift                                                                        | Low–Med                  |
| 18  | Device flow is not RFC 8628: no page to type a user code; the code is embedded in the URL                                                                                                                                                                                                                                                                                                                                                                                  | `identity/oidc.ts:729-785`                            | TV/Deck UX; interop                                                                                    | Low–Med                  |
| 19  | Corpus lacks Ed25519 malleability and JSON edge vectors (lone surrogate, control chars, NUL)                                                                                                                                                                                                                                                                                                                                                                               | `tools/sign-corpus.ts`                                | backends can silently diverge                                                                          | Low–Med                  |
| 20  | Docs drift: <br>• `authenticated` "licence not required" (code requires one) <br>• `v1.2.3` and `?channel=1.2.3` documented but rejected <br>• "Release is not macOS-specific" <br>• "webhook keeps the product current" <br>• "`artifact_policy_json` is operator-owned" <br>• secrets "in the OS keyring" (they're in `managed.json`) <br>• `architecture.md`'s one-line "add a service" <br>• RUNBOOK's `/djdl/schema` <br>• schema vs validator `architectures` length | docs + OpenAPI                                        | trust in docs                                                                                          | Low                      |
| 21  | Release health and setup checklist assume macOS/Sparkle/License                                                                                                                                                                                                                                                                                                                                                                                                            | `release/health.ts:241-257`, admin `shape.ts:311-314` | permanent "needs setup"                                                                                | Low                      |
| 22  | Portal Downloads require sign-in and a licence for `public` artifacts, list sidecars, and redirect only to GitHub hosts                                                                                                                                                                                                                                                                                                                                                    | `identity/portal/*`                                   | free products can't use it                                                                             | Low                      |

### 9.2 Diceroll (for the Diceroll side)

1. **`--main-pack` relaunch is blocked by official Godot 4.6+ templates** (godotengine/godot#111909).
   Staged code packs most likely never apply on shipped desktop builds, and the updater may churn
   `boot_attempts`. Verify on an exported build. §5.6 has the replacement options.
2. **Steam and itch uploads reuse the `github`-stamped zips**, so the in-game updater runs inside
   Steam and itch installs.
3. **Sideload builds are stamped as store builds:** the sideload APK as `play`, the sideload IPA as
   `appstore`. TestFlight is never stamped. The iOS store URL is a placeholder (`id0000000000`).
4. **Beta can go backwards:** every stable release overwrites `update-beta.json`, so a beta line
   ahead of stable regresses. The beta AltStore source never receives stable releases.
5. **CI never sets the version floors:** the engine version lives in three places, and CI never
   sets `min_binary` or `min_supported`.
6. **Build codes collide:** `-beta.2` and `-rc.2` get the same code; minor or patch ≥ 100
   overflows; a Windows final's file version sorts below its RCs.
7. **Binary checksums are unused:** `binaries[].sha256` is published but never checked.
8. **The bearer token leaks on redirects:** it is sent on every request and redirects are
   followed. Godot 4.7.2 **does** forward `Authorization` across hosts (measured), so it very
   likely reaches the CDN.
9. **Downloads cannot resume.**
10. **Auto-update off quietly reverts content:** turning Auto-update off also stops running the
    already-downloaded pack.
11. **Failed checks consume the 6-hour throttle.**
12. **Wrong texture pack on arm64 Linux:** the S3TC-only Linux pack is applied there.
13. **Freeze attack:** there is no manifest expiry.
14. **SideStore fields missing:** the AltStore source lacks the app-level fields SideStore needs.

---

## 10. Roadmap and effort

Estimates are focused engineer-weeks for one experienced engineer. Each phase includes its docs,
skills and threat-model updates (~10%). Agent assistance compresses calendar time, not review.

| Phase                                             | Scope                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Size     | Depends on          | Gates                                                                                  | Outcome                                                                                                                                  |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **P0 Hygiene and unblockers**                     | • operator-ownership `*_source` for access modes, compat window, artifact policy<br>• `release` webhook events<br>• tag filter, version-ordered "newest", pagination<br>• version-conflict fix; R6-10<br>• **channel vocabulary unification**<br>• CORS allowlist<br>• product-wide devices<br>• `init`/`validate` fixes<br>• unknown-slug tolerance<br>• **data-driven service table** (one table + drift gate replacing the per-file slug enumerations, before two new services)<br>• Sparkle floor ≥ 2.9.6<br>• docs drift                                                                                                                                                                                                             | 4–6 wk   | —                   | channel unification touches `gate-matrix.json` (plan mode); `OPTIONS` routes (rule 10) | Polaris Key is correct for any non-macOS product                                                                                         |
| **P1 Godot SDK core**                             | • `addons/polaris_key` core (verify, trust, cache, clock, transport)<br>• License / Config (incl. edge-mint) / Devices / Identity (device-code + QR) / Update-check parity<br>• UI kit v1 (gate, activation, sign-in, settings, banner, dev-menu section)<br>• export plugin v1 (build stamp)<br>• GUT corpus runner + CI job<br>• docs page, Asset Store listing<br>• server: RFC 8628 user-code page; `engine`/`outlet` report keys                                                                                                                                                                                                                                                                                                     | 8–11 wk  | P0 (channels, CORS) | sixth conformance language                                                             | **Diceroll adopts managed config, licensing and identity**                                                                               |
| **P2 Release truth and publishing**               | • Core blob store (R2) + trusted publisher (GitHub OIDC)<br>• `pkey publish` + `polaris-key/publish` Action<br>• release descriptor ingest; artifact map; platforms/arches incl. `universal`/`wasm32`<br>• builds and build numbers; per-platform resolution<br>• generic + blob routes<br>• channel policy (pin/promote/yank/includes)<br>• console builds view                                                                                                                                                                                                                                                                                                                                                                          | 5–7 wk   | P0                  | rules 9 and 10; migrations; threat model                                               | every Diceroll artifact indexed, downloadable and published without long-lived secrets                                                   |
| **P2b Distribution core**                         | • `distribution` service (new slug via the service table)<br>• `.pkey/distribution` (outlets, identities, listings)<br>• availability and submissions (CI-reported first)<br>• outlet-scoped rollouts and halts<br>• storefront feeds: AltStore/SideStore/PAL, Obtainium, F-Droid CI generator + static relay, Scoop/Flathub JSON<br>• public download page v1<br>• key inventory<br>• descriptor hooks (`buildCatalog`, `availability`, `outletCapabilities`)<br>• console distribution matrix v1                                                                                                                                                                                                                                        | 5–7 wk   | P0, P2              | rules 9 and 10; new service; threat model                                              | Diceroll's AltStore source, F-Droid repo and download page come from Polaris Key                                                         |
| **P3 Signed feed, decision, feeds**               | • **wire v4**: `pkey-feed+jws` + `pkey-release+jws`<br>• corpus: feed, release, `update-matrix`, malleability<br>• five SDKs + Godot<br>• update feeds: Sparkle extensions, WinSparkle, Velopack, `.appinstaller`, zsync<br>• decision inputs from distribution's availability and rollout<br>• Godot updater: outlet adapters, sidecar swap, boot guard, Velopack/Sparkle hooks                                                                                                                                                                                                                                                                                                                                                          | 6–8 wk   | P2, P2b             | **plan mode; `PROTOCOL_VERSION` 4; all SDKs**                                          | **Diceroll deletes `game/update/*`, `update_manifest.py`, `altstore_source.py`, and the `channels` release**                             |
| **P4 Packs** ([`CONTENT.md`](CONTENT.md) §15)     | • **v1** (5–7 wk): pack deliverables in release (types, requirements, dependencies, locked sets); CI patch artifacts (files index, per-entry deltas); distribution transports for packs (CDN, embedded; availability); update's pack install planning and handler contract in every SDK; marker file; install state; Godot `PKeyBoot`; console pack views<br>• **v2** (5–7 wk): chunk indexes and chunk bundles; chunk sync in every SDK; floating pack sets per `contentApi`; pack rollouts and halts per outlet; server GC<br>• **v3** (4–6 wk): more types (`l10n.table`, `data.json`, `audio.bank`, `ml.model`, `custom.*`, `unity.addressables`); lazy hot-pair deltas; web Compression Dictionary Transport; content-key delegation | 14–20 wk | P2, P2b, P3         | no new service; corpus `plan-matrix.json`, chunk-index and apply vectors               | Diceroll's content-streaming phases 1–3 run on Polaris Key (v1); small chunk updates (v2); localisation, events and supporter packs (v3) |
| **P5 Distribution connectors and native plugins** | • outlet-credential custody<br>• ASC (webhooks, TestFlight, phased release, Background Assets states)<br>• Play (tracks, rollout, priority, Reporting API)<br>• Microsoft Store status<br>• Godot plugins: iOS (`AppDistributor`, Background Assets, StoreKit 2), Android (install source, In-App Updates, PAD, PackageInstaller), macOS Sparkle, Windows Velopack/WinSparkle/StoreContext                                                                                                                                                                                                                                                                                                                                                | 10–14 wk | P2–P4               | threat model; per-platform CI                                                          | store state in the console; Background Assets packs on iOS; in-app updates on Play                                                       |
| **P6 Commerce, ops, web**                         | • commerce bridge (App Store Server Notifications v2, Play purchases + RTDN, Steam ownership) → entitlements<br>• App Attest / Play Integrity trust tiers<br>• update funnel + auto-halt + Sentry<br>• optional Polaris-hosted web builds<br>• optional Kotlin SDK (+6–8 wk)                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 6–9 wk   | P3–P5               | —                                                                                      | paid packs on stores; automatic halts                                                                                                    |

**Totals.**

- **~60–80 engineer-weeks**, excluding the optional Kotlin SDK. Content delivery v2 and v3 account
  for about 9–13 of those and sit off the critical path.
- The critical path is P0 → P2 → P3 → P4 v1, about 22–29 weeks. P2b (distribution) runs
  alongside P3.
- P1 (the Godot SDK) runs in parallel from the start. P5 plugins can start as soon as their P2/P3
  interfaces are fixed.

**Minimum viable slice for Diceroll to drop its updater:** P0 + P1 + P2 + the AltStore part of
P2b + the Sparkle and generic-feed part of P3, plus the interim release-key-only manifest (§3.3). That is roughly
**26–32 engineer-weeks**, with the Godot SDK track in parallel.

---

## 11. Decisions needed

| #   | Decision                            | Recommendation                                                                                                                                                                                                                                                                                                                               |
| --- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | A separate content service?         | **No.** Packs are release **deliverables**, handled like the app: Release records them, Distribution delivers them, Update decides what to install. No new document types either                                                                                                                                                             |
| 2   | Trust model for code and packs      | **Two signers** (CI release key + Worker feed), wire v4. Interim: release-key-only manifest                                                                                                                                                                                                                                                  |
| 3   | Release-key custody                 | GitHub Environment secret with required reviewers now; a non-exportable KMS Ed25519 key via OIDC later                                                                                                                                                                                                                                       |
| 4   | Byte hosting                        | R2, content-addressed, bucket-locked, on a **separate registrable domain**; GitHub remains a source with caching and mirroring                                                                                                                                                                                                               |
| 5   | Channel vocabulary                  | Unify on Release's (`stable`, `beta`, `pr-N`, manual) and teach the licence gate. Map `staging` and `dev` as aliases for existing clients. Plan mode (gate matrix)                                                                                                                                                                           |
| 6   | Godot desktop code updates          | Full-app updaters with deltas (Velopack on Windows/Linux, Sparkle on macOS) plus a sidecar-PCK swap for portable builds. Custom templates only if PCK encryption is also wanted                                                                                                                                                              |
| 7   | Outlet connectors                   | Read-only state first (webhooks/polling), controls second (phased release, rollout %), uploads never (CI and vendor CLIs)                                                                                                                                                                                                                    |
| 8   | Commerce bridge timing              | After content (P6), unless paid packs on iOS/Play are needed at launch                                                                                                                                                                                                                                                                       |
| 9   | Web hosting by Polaris Key          | Optional; CORS is the must-have. Hosting is worthwhile for channel-pinned web builds                                                                                                                                                                                                                                                         |
| 10  | Kotlin SDK                          | Yes if native Android apps are in scope; its AAR becomes the Godot Android backend either way                                                                                                                                                                                                                                                |
| 11  | Godot floor                         | 4.4 source-compatible; 4.6+ blessed                                                                                                                                                                                                                                                                                                          |
| 12  | Diceroll iOS v1                     | Ship the full IPA (fits under 200 MB). Adopt Apple-hosted Background Assets when content drops between app versions matter                                                                                                                                                                                                                   |
| 13  | How builds consume content          | Both: **lock** core packs in the release record; let event, localisation and cosmetic packs **float** on content channels, gated by `contentApi`                                                                                                                                                                                             |
| 14  | Patch mechanism priority            | Platform transport where the outlet mandates or does it better; otherwise **chunk sync** (v2) as the default for packs ≥ 16 MiB; deltas only for hot pairs; `full` always available                                                                                                                                                          |
| 15  | Who may publish content             | The release key by default. Allow a delegated **content key** for data-only types, so content can ship without code-release power                                                                                                                                                                                                            |
| 16  | Distribution separate from Release? | **Yes, a `distribution` service.** Release answers "what was built", Distribution "where it goes and its state there" (outlets, connectors, availability, outlet rollouts, storefront feeds, download page), Update "what this device should do". Cross-service reads use Core descriptor hooks, so `update → release` stays the only import |
| 17  | Service table first?                | **Yes.** Make the service list data-driven with a drift gate before adding `distribution`, instead of editing ~45 files for the new slug                                                                                                                                                                                                     |

---

## 12. Risks and open questions

**Unverified platform mechanics** (spike before committing):

- Background Assets needs an app extension and an App Group, which Godot's iOS export can't add.
  CI Xcode-project patching is the risk. The self-hosted _managed_ Background Assets protocol is
  undocumented.
- MSIX virtualisation versus Godot `user://`. Velopack's lifecycle hooks versus Godot startup (a
  launcher shim is likely needed).
- Android `load_resource_pack` UI stall (godot#105009); absolute-path PAD loading; web multi-pack
  mounting; UID and class-cache behaviour of mounted packs.

**Policy drift.** These are dated facts; re-check at implementation time:

- Google sideload developer verification (regional from 2026-09-30, broader in 2027);
- Apple EU terms (2026-10-01);
- Play fee programs;
- Microsoft Store CLI limits;
- Flathub's AI policy;
- whether scripts in downloaded packs are acceptable. The data-only rule sidesteps this on store
  builds.

**Content delivery unknowns** ([`CONTENT.md`](CONTENT.md) §16):

- whether Apple asset-pack updates are differential;
- Cloudflare Range and cold-miss behaviour on R2 custom domains;
- the right chunk size for real PCK history;
- GDScript SHA-256/zstd throughput on low-end devices;
- the load-time cost of Godot delta PCK layers.

**Wire v4 blast radius.** Six SDKs in lockstep through the corpus. The v3 split proved the
machinery (one generator, mirrors, `--check` drift gate) and the same discipline applies.

**Key custody is permanent:**

- Losing the Android signing key breaks direct, Obtainium and F-Droid updates forever.
- Losing the release key forces a binary update to re-pin.
- F-Droid and Sparkle keys must stay off the Worker.
- Keep a key inventory (§3.8) and offline backups.

**Performance on low-end devices.** The Ed25519 numbers for phones and web are estimates. Measure
on real hardware; the WebCrypto and native accelerators are the fallback.

**Scope creep.** Polaris Key must stay "records, decides, serves, controls". Vendor CLIs upload and
CI builds. Several connectors mean operational load for a solo maintainer, so prioritise: ASC and
Play first, then the Microsoft Store, then Steam and itch.

**Anti-piracy realism.** GDScript and PCKs decompile trivially (`docs/security/arch/anti-piracy-realism.md`).
Entitlements protect _delivery_ (gated blobs, edge-mint, server-side features), not the client.

---

## 13. Diceroll adoption path

| When                             | Diceroll does                                                                                                                                                             | Diceroll deletes                                                                                                                                                                                    | Diceroll keeps                                                                                                                            |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **Now** (no Polaris Key changes) | fix §9.2 items 1–3 and 8; register `gg.vlad.diceroll` and signing keys for Android developer verification; stamp per artifact                                             | —                                                                                                                                                                                                   | everything                                                                                                                                |
| **After P1**                     | adopt the SDK for managed config (balance tuning, kill switches), entitlements (supporter tier, free-tier enrollment + sign-in claim), device-code sign-in, update checks | nothing yet (own updater still ships binaries/packs)                                                                                                                                                | updater                                                                                                                                   |
| **After P2–P3**                  | publish via the Action; take feeds from Polaris Key (native, AltStore, Sparkle, Velopack, F-Droid)                                                                        | `game/update/*` and its six suites, `update_manifest.py`, `altstore_source.py`, the `channels` release, `UPDATE_SIGNING_KEY` (becomes the release key), the distribution half of `stamp_version.py` | content registry, UI visuals                                                                                                              |
| **After P4**                     | packs as release deliverables, delivered by distribution and planned by update; `PKeyBoot` drives the boot shell (Diceroll's visuals plug into its signals and slots)     | pack store and mount plumbing                                                                                                                                                                       | `packs.gd`, `needs.gd`, `Content.available` gating, save-compat rules, asset rules and tests, BootShell visuals, DevGesture/DevMenu shell |
| **After P5–P6**                  | Background Assets on iOS; In-App Updates on Play; store state in the console; paid packs via IAP/Billing → entitlements                                                   | store-prompt code                                                                                                                                                                                   | CI export, sign, notarize and store uploads (vendor CLIs)                                                                                 |

---

## 14. The prototype

`prototype/` is a Godot 4.7 project (engine 4.7.2-stable, `ed1daf0bf`). Its `README.md` explains how
to run it.

| Path                                             | What                                                                                                                                                        |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `addons/polaris_key/crypto/sha512.gd`            | `PKSha512`, FIPS 180-4                                                                                                                                      |
| `addons/polaris_key/crypto/ed25519_fast.gd`      | `PKEd25519Fast`, ref10-style, ~7 ms per verify (release template)                                                                                           |
| `addons/polaris_key/crypto/ed25519_tweetnacl.gd` | `PKEd25519Ref`, TweetNaCl port, test cross-check                                                                                                            |
| `addons/polaris_key/jws.gd`                      | `PKJws`, the `shared-jws` 13-step verify order                                                                                                              |
| `tests/`                                         | suites for SHA-512, Ed25519, JWS (corpus), platform identity, profiling, an HTTP probe; a CLI runner                                                        |
| `vectors/`                                       | RFC 8032 + Node-signed Ed25519 vectors, SHA-512 vectors, and generators for the corpus-derived vector files (regenerate with `node vectors/gen_corpus.mjs`) |

It is research code: not wired into the green gate, not a published SDK, no `sdks/godot/` yet.
Moving it to `sdks/godot/` is the first task of P1.

---

## 15. Research notes

| Note                                | Track       | Scope                                                                                                                                                     |
| ----------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [A1](notes/A1-release-update.md)    | codebase    | Release + Update: data model, routes, assumptions, extension points, gaps                                                                                 |
| [A2](notes/A2-sdk-port.md)          | codebase    | the SDK port checklist, parity matrix, UI, config, persistence, identity, conformance                                                                     |
| [A3](notes/A3-admin-dx.md)          | codebase    | onboarding, manifests, console, portal, CLI/CI, service model, terminology, security                                                                      |
| [A4](notes/A4-diceroll-mapping.md)  | codebase ×2 | Diceroll's updater and content design mapped onto Polaris Key; Diceroll bugs                                                                              |
| [A5](notes/A5-godot-empirical.md)   | empirical   | Godot 4.7.2 crypto, JSON, HTTP, platform identity, the Ed25519 prototype                                                                                  |
| [E1](notes/E1-apple.md)             | external    | App Store Connect, TestFlight, AltStore/SideStore/PAL, Sparkle, Background Assets, StoreKit, EU                                                           |
| [E2](notes/E2-android.md)           | external    | Play Publishing API, In-App Updates, PAD, Integrity, Billing, sideload verification, Obtainium, F-Droid                                                   |
| [E3](notes/E3-windows-linux-web.md) | external    | Microsoft Store, MSIX/App Installer, Velopack, WinSparkle, winget, AppImage, Flatpak, Snap, Steam, web                                                    |
| [E4](notes/E4-godot-ecosystem.md)   | external    | Godot packaging, GDExtension vs GDScript, native plugins, export plugin, runtime packs, self-update                                                       |
| [E5](notes/E5-frontier-tech.md)     | external    | TUF/Uptane, provenance, GitHub OIDC, deltas, HTTP/R2, rollouts, content data models, feed standards                                                       |
| [E6](notes/E6-client-tools.md)      | external    | client libraries to adopt per SDK, licensing                                                                                                              |
| [E7](notes/E7-server-ci-tools.md)   | external    | publishing, signing and hosting tools; reference platforms                                                                                                |
| [E8](notes/E8-content-delivery.md)  | external    | multi-type content delivery and patching: Riot, Blizzard, Epic, Steam, itch, casync/OSTree/OCI, Unity/Unreal/Godot, platform transports; schema sketches  |
| [A6](notes/A6-godot-patching.md)    | empirical   | what a pure-GDScript client can patch on Godot 4.7.2: delta PCKs, PCK rebuild, chunk reassembly, binary deltas, zip and loose-file types, mount semantics |

The notes are research working papers produced during this investigation. They are kept for their
evidence and sources, not as reviewed documentation. Where a note and this synthesis disagree, the
synthesis reflects the cross-checked position.

**Known superseded claims:**

- notes/E6 and notes/E7 state that GDScript cannot practically verify Ed25519 without a
  GDExtension or an RSA sidecar. notes/A5 measured a pure-GDScript verifier at ~7 ms that passes
  the corpus, and notes/E4 independently measured its own port at 25–45 ms.
- notes/A2's Diceroll use cases were written without access to the Diceroll repo; notes/A4 is
  authoritative for Diceroll.
- notes/E8 treats `zstd --patch-from` as unreachable from GDScript and suggests leaving Godot delta
  PCKs mounted as overlays. notes/A6 measured both: the engine's own decoder is reachable from
  pure GDScript, and overlays cost load time on every open, so deltas are baked into full packs.
- notes/A3 recommends store connectors as a Release capability. This synthesis moves them, with
  outlets, availability, rollouts and storefront feeds, into a separate `distribution` service
  (§3.2).
- The first drafts of this report and `CONTENT.md`, and notes/E8, model content as a separate
  `content` service with its own `pkey-pack+jws` and `pkey-content+jws` documents. Packs are now
  release deliverables: `pkey-release+jws` and the channel feed cover them, distribution delivers
  them, and update plans their installation (§3.2).
- notes/E8 and the first drafts rely on `replace_files=false` for data-only safety. notes/A6 shows
  that zips ignore it and that it blocks a pack's UIDs. The rule is a directory check before mount.
