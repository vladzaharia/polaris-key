> Research note for [Godot on Polaris Key](../README.md), 2026-09-29. A working paper kept for its
> evidence and sources; the README synthesis is the cross-checked position. Scratch paths in the
> original run are rewritten to `prototype/` where the code was kept.

# A4 — Diceroll's home-grown distribution/update machinery mapped onto Polaris Key

Date: 2026-09-29. Scope: read-only research over two checkouts.

- **Diceroll** (Godot 4.7.2 GDScript game): `/home/user/vladzaharia/diceroll` @ `4e78bb6`
- **Polaris Key** (Cloudflare Worker + SDKs): `/home/user/polaris-key`

References are `path:line` (Diceroll paths relative to its repo root; PKey paths relative to
`/home/user/polaris-key`). "PKey" = Polaris Key.

---

## 0. TL;DR

1. Diceroll ships a complete, well-tested **self-updater for one surface only** (GitHub desktop
   builds): an RSA-3072-signed JSON manifest per channel on a rolling `channels` GitHub
   release, a full-content PCK swapped in via `--main-pack` relaunch, three on-disk slots
   (staged/current/previous) with boot-attempt rollback, and a pure decision function that
   yields `none | pack | ready | binary | store` with a strict **no-downgrade** rule. Every
   other surface is prompt-only or platform-managed.
2. The behaviour is keyed off a build-time **`distribution`** stamp in `build_info.json` — but CI
   stamps per _export_, not per _artifact_, so the same binary is shipped to several surfaces
   with the wrong identity (Steam/itch get `github` builds whose updater is live; the sideload
   APK is stamped `play`; the sideload IPA is stamped `appstore`). This is the single strongest
   argument for a first-class "distribution" concept in PKey.
3. The proposed **content-pack design** (manifest schema 2) adds content-addressed, data-only
   packs pinned by the code version (`code.requires_packs`), mounted in stages by a `BootShell`
   loader with `replace_files=false`, and a per-pack store with reference-based eviction. None
   of it is implemented.
4. PKey today covers **channels, a version check, an appcast, gated/streamed downloads, a truth
   store, a device principal, license-entitled channels and a compat window**. It does **not**
   have: a signed update/release document, artifact roles beyond `cli`/`dmg`, per-artifact
   hashes/compat keys, a distribution concept, store-listing metadata, an AltStore renderer,
   content packs, semver-ordered channel resolution, a "beta includes stable" channel, a
   feed-level mandatory floor, a device-only (license-free) gated access mode, or CORS for web
   clients.
5. Three **semantic conflicts** matter: PKey `beta` = newest _prerelease only_ (Diceroll `beta`
   ⊇ stable); PKey resolves "newest" by GitHub list order, not semver; and PKey's v3 signed
   envelope is device-bound (`deviceId`), which fights anonymous, edge-cacheable update checks
   (the trust manifest is the precedent for a non-device-bound doc). Also: moving-channel
   download URLs (`/release/dl/beta/...`) are incompatible with hash-pinned downloads.

---

## 1. Diceroll's current update/distribution architecture

### 1.1 Components and where they live

| Piece                                      | File                                                                                                                                                | Role                                                                                                    |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | -------- |
| `Updater` autoload (FIRST in `[autoload]`) | `game/update/updater.gd` (370 lines); `project.godot` `[autoload] Updater="*res://game/update/updater.gd"`                                          | gating, boot-time pack activation + relaunch, check scheduling, channel override API, banner            |
| `UpdateClient`                             | `game/update/update_client.gd`                                                                                                                      | fetch manifest + `.sig`, verify, parse, decide, download pack to staged                                 |
| `UpdateFetcher`                            | `game/update/update_fetcher.gd`                                                                                                                     | HTTP(S) or local file fetch/download, progress, stall watchdog, extra headers                           |
| `UpdateManifest`                           | `game/update/update_manifest.gd`                                                                                                                    | RSA PKCS#1 v1.5 SHA-256 verify, schema-1 validation                                                     |
| `UpdatePolicy`                             | `game/update/update_policy.gd`                                                                                                                      | pure decisions + build/env facts (`build_info`, platform key, base URL, channel override, lock reasons) |
| `UpdateStore`                              | `game/update/update_store.gd`                                                                                                                       | `user://updates/{staged,current,previous}` + `state.cfg`, verify, rotate, rollback, boot maintenance    |
| `Semver`                                   | `game/update/semver.gd`                                                                                                                             | SemVer 2.0.0 parse/compare                                                                              |
| `UpdateKeys`                               | `game/update/update_keys.gd`                                                                                                                        | compiled-in RSA public key PEM                                                                          |
| Banner                                     | `ui/widgets/update_banner.gd`                                                                                                                       | "Downloading… / Update ready [RESTART] / New version [DOWNLOAD                                          | UPDATE]" |
| Settings row                               | `ui/modals/settings_panel.gd:154-176`                                                                                                               | Auto-update ON/OFF + CHECK                                                                              |
| Dev menu                                   | `ui/modals/dev_menu.gd`, `ui/widgets/dev_gesture.gd`                                                                                                | channel override, check now, reset, build info, diagnostics                                             |
| Boot gate                                  | `main.gd:11-19`, `game/boot/asset_check.gd`, `game/boot/missing_assets_screen.gd`                                                                   | source-checkout asset check, missing-assets screen (seed of future BootShell)                           |
| CI                                         | `tools/ci/{stamp_version,update_manifest,altstore_source,changelog_llm,assets,selftest}.*`, `tools/export.sh`, `.github/workflows/{release,ci}.yml` | stamping, manifests, AltStore source, notes, asset bundles, exports, publishing                         |

Design rules the updater obeys: no `class_name`, no dependency on other autoloads or the global
class cache (`updater.gd:1-3`, `semver.gd:2-3`), so it works before anything else and across
`--main-pack` versions (a downloaded pack may carry a different class cache). Everything is
inert in the editor, headless, the screenshot/scenario harness, dev builds, and when the player
turns Auto-update off (`updater.gd:14-16`, `_active()` `updater.gd:104-110`).

### 1.2 Manifest schema 1

Published by CI as `<base>/update-<channel>.json` + `update-<channel>.json.sig`
(`update_manifest.gd:8-13`, `update_policy.gd:94-95`). Written by
`tools/ci/update_manifest.py:80-93`:

```json
{"schema": 1, "channel": "stable", "version": "0.2.0",
 "released": "2026-…Z", "notes": "<= 500 chars", "notes_url": ".../releases/tag/v0.2.0",
 "engine": "4.7.2", "min_binary": "0.1.0", "min_supported": "0.1.0",
 "pack": {"url": ".../Diceroll-0.2.0-desktop.pck", "sha256": "<64 hex>", "size": 73174748} | null,
 "binaries": {"macos": {"url","sha256","size"}, "windows.x86_64": {…}, "linux.x86_64": {…}, "linux.arm64": {…}},
 "stores": {"ios": "https://apps.apple.com/app/id0000000000", "android": "https://play.google.com/store/apps/details?id=gg.vlad.diceroll"}}
```

| Field                            | Producer                                                                                                         | Consumer semantics                                                                                                                                                     |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `schema`                         | const 1 (`update_manifest.py:81`)                                                                                | must equal 1 (`update_manifest.gd:17,116-117`)                                                                                                                         |
| `channel`                        | `--channel`, else `beta` if version has `-` (`update_manifest.py:77`); overwritten per file (`:100`)             | must equal the channel requested (`update_manifest.gd:121-122`) — **channel binding** against cross-channel replay                                                     |
| `version`                        | tag without `v`                                                                                                  | required, semver-valid (`:118-125`); compared to running version                                                                                                       |
| `released`, `notes`, `notes_url` | UTC now; `store/android_whats_new.txt` ≤500 chars; tag page                                                      | optional, normalised; notes clamped to 500 (`:18,132-134`)                                                                                                             |
| `engine`                         | `--engine`, default `"4.7.2"` (`update_manifest.py:71`) — **not passed by the workflow** (`release.yml:287-288`) | required semver; pack is only offered when `engine == Policy.engine_version()` exactly (full `major.minor.patch`, `update_policy.gd:57-59,248`)                        |
| `min_binary`                     | default `0.1.0` (`update_manifest.py:72`), not passed by workflow                                                | pack only offered when executable version ≥ it (`update_policy.gd:249`)                                                                                                |
| `min_supported`                  | default `0.1.0` (`:73`), not passed by workflow                                                                  | executable version < it ⇒ `mandatory` ⇒ BINARY/STORE, never PACK (`update_policy.gd:215,258-259`); banner loses its close button (`update_banner.gd` refresh)          |
| `pack`                           | `Diceroll-<v>-desktop.pck` if present (`update_manifest.py:87-89`)                                               | object `{url, sha256 (64 hex), size>0}` or null (`update_manifest.gd:135-147`); URL may be relative to base (`update_fetcher.gd:128-131`)                              |
| `binaries{}`                     | the 4 desktop archives (`update_manifest.py:35-40,90-93`)                                                        | `binaries[platform_key].url` for BINARY, else `notes_url` (`update_policy.gd:266-270`). `sha256` is published but **never verified** (binary path just opens the URL). |
| `stores{}`                       | hard-coded (`update_manifest.py:31-34`); the iOS id is a **placeholder**                                         | `stores[ios                                                                                                                                                            | android]`for STORE on`appstore`/`play` builds (`update_policy.gd:19,229-237`) |

Platform keys: `macos` (universal), `windows.<arch>`, `linux.<arch>`, `ios`, `android`, `web`
(`update_policy.gd:63-82`; `aarch64` → `arm64`).

### 1.3 Signing (RSA-3072 PKCS#1 v1.5 / SHA-256)

- CI: `openssl dgst -sha256 -sign` over the **exact manifest bytes**, base64 + newline, written as
  `.json.sig` (`update_manifest.py:51-59,98-104`). Key: `UPDATE_SIGNING_KEY` secret
  (`docs/RELEASE.md:150`); without it manifests are written UNSIGNED and games ignore them.
- Game: `UpdateManifest.verify_signature` (`update_manifest.gd:23-48`) strips whitespace,
  validates the base64 alphabet, requires sig length × 8 == modulus bits (it walks the SPKI DER
  by hand in `_modulus_bits`, `:53-101`, because mbedTLS logs engine errors on malformed input),
  then `Crypto.verify(SHA256, hash, sig, key)`.
- Public key compiled in `update_keys.gd:10-21` (3072-bit SPKI PEM). **Empty key fails closed**
  (`update_keys.gd:6-7`; test `tests/test_update_e2e.gd:82-86`). Tests use
  `tests/fixtures/update/test_signing*.pem`, never the real constant.
- Verification happens before parse (`update_client.gd:55-60`). The pack is then pinned by the
  signed `sha256` + `size` (`update_store.gd:159-174`).
- No key rotation, no `kid`, no expiry/freshness claim: an attacker able to serve an **older
  validly-signed manifest** can freeze a client on an old version (no downgrade is possible
  because of §1.6). Selftest re-verifies CI signing with openssl (`tools/ci/selftest.sh:55-64`).

### 1.4 Check cadence and gating

- `can_apply_packs()` = active ∧ exported (`OS.has_feature("template")`) ∧ `distribution ==
"github"` ∧ desktop ∧ Auto-update on (`updater.gd:118-120`).
- `can_check()` = active ∧ not web ∧ (`github` ∧ desktop, or `distribution ∈ {appstore, play}`)
  (`updater.gd:124-128`, `STORE_DISTS` at `update_policy.gd:19`).
- First check `CHECK_DELAY = 4 s` after `_ready` (i.e. after the title shows), then at most every
  `CHECK_INTERVAL = 6 h` unless forced (`updater.gd:47-48,96-98,181-182`). `last_check` is
  written **before** the network call (`updater.gd:191`), so a failed check also throttles for
  6 h. Manual CHECK (settings, dev menu) forces.
- Base URL: env `DICEROLL_UPDATE_BASE_URL` > project setting `diceroll/update/base_url` > default
  `https://github.com/vladzaharia/diceroll/releases/download/channels`
  (`update_policy.gd:11-13,86-91`; `project.godot [diceroll]`).
- Fetch limits: manifest body ≤1 MiB, 30 s timeout, 10 redirects (GitHub asset → CDN), threaded
  `HTTPRequest`; downloads use `download_file` + a 30 s **stall watchdog**; no Range/resume
  (`update_fetcher.gd:104-106,151-179,182-188`). Local paths / `file://` / `res://` / `user://`
  feeds are supported for tests (`update_fetcher.gd:112-124`).

### 1.5 The staged/current/previous store, `--main-pack` relaunch, boot-attempt rollback

Layout (`update_store.gd:1-11`): `user://updates/{staged,current,previous}/diceroll.pck +
meta.json {version, sha256, size, engine}` and `state.cfg [state] boot_attempts, active,
skip_version, binary_version; [check] last`.

Download path (`update_client.gd:77-87`, `update_store.gd:151-174`): `begin_staging()` wipes
staged and returns `staged/diceroll.pck.part`; after download, `finish_staging()` checks size,
then SHA-256 (streamed 1 MiB chunks, `:118-129`), renames into place, writes `meta.json`.

Boot path (`updater.gd:73-87` → `update_store.gd:228-263`), only when `can_apply_packs()` and
**not** already running a pack:

1. For each slot: drop if incomplete; drop if `meta.engine != running engine`; drop if
   `meta.version` is **not newer than the binary's version** ("a newer binary already contains
   that content") (`:230-242`).
2. If `current` exists and `boot_attempts >= MAX_BOOT_ATTEMPTS (2)` → `rollback()`:
   discard current, previous→current, `skip_version = <bad version>`, attempts = 0
   (`:20,208-218,243-246`).
3. If `staged` exists: re-verify size+sha; `activate_staged()` = current→previous,
   staged→current, attempts=0, `active=<version>`; corrupt staged is discarded
   (`:185-203,247-256`). Renames retry 12×250 ms for Windows file locks (`:269-274`).
4. If `current` exists and size still matches meta → return its absolute path (`:257-260`).

Then `_relaunch(pack)` (`updater.gd:311-323`): `note_launch()` increments `boot_attempts`,
spawns the same executable with `--main-pack <abs current pck>` plus original args minus old
pack args, appending user args `--diceroll-pack=<ver>` and `--diceroll-binary-version=<ver>`
(`:50-52,328-347`), mutes audio and quits before the main scene draws. If spawn fails it marks
boot OK and keeps running the built-in content.

In the relaunched process (`running_pack`, `updater.gd:162-168`), after `BOOT_OK_SECONDS = 10 s`
it calls `mark_boot_ok()` (attempts = 0) (`updater.gd:49,93-95`). So: launch → attempts 1 →
crash; launch → attempts 2 → crash; next launch → rollback to previous + skip that version.
If previous also fails twice, both are gone and the binary's built-in content runs
(`tests/test_update_store.gd:106-128`).

"Restart to update" (`updater.gd:288-295`): activate staged now and relaunch into it; if the
rename fails (Windows holds the running pack open) just relaunch and let the boot step do it.

Version accounting: `current_version()` = `build_info.version` of the _running content_ (the
pack's own `build_info.json` when running a pack) (`updater.gd:148-149`); `binary_version()`
comes from the relaunch arg or `state.cfg binary_version` (`:153-159`, written at `:82`). Both go
into the decision context (`updater.gd:214-221`).

### 1.6 `UpdatePolicy.decide()` — the decision table

`update_policy.gd:209-262`, context: `distribution, platform, engine, version (running content),
binary_version, staged_version, skip_version`.

```
mandatory := min_supported != "" && binary_version < min_supported            (215)
behind    := manifest.version < running version  (is_downgrade)                 (219-220)
if behind:        NONE, mandatory=false, reason "channel behind … no downgrade"  (221-225)
if !newer && !mandatory: NONE "up to date"                                        (226-228)
if dist in {appstore:ios, play:android}: STORE(stores[…]) or NONE if no URL     (229-237)
if dist != github: NONE "updates elsewhere"                                       (238-240)
if !mandatory && newer:
   staged_version == version          -> READY                                    (243-246)
   pack && engine== && bin>=min_binary && version != skip_version -> PACK       (247-254)
   else reason (rolled back / no pack / engine != / binary < min_binary)
BINARY(binaries[platform].url or notes_url), mandatory as computed               (260-262)
```

`UpdateClient` upgrades `PACK` to `READY` after a successful download (`update_client.gd:67-73`).
The Updater maps actions to signals and banner states (`updater.gd:199-209`): `ready` →
`update_ready` + RESTART; `binary` → `binary_update_available` + DOWNLOAD (open URL; "No
binary self-replace yet", `:30-31`); `store` → `store_update_available` + UPDATE. Mandatory
hides the close button.

Notable properties: `behind` beats `mandatory` (a `min_supported` bump on a lower channel can
never push a downgrade, `tests/test_update_channel.gd:154-178`); `mandatory` beats PACK (an old
binary must be replaced even if content is current, `tests/test_update_policy.gd:57-65`);
`min_binary` is judged against the **binary**, not the running pack (`:52-55`); a rolled-back
version is never re-downloaded (`:67-71`).

### 1.7 Channels and the dev-menu override

- Channels: exactly `["stable","beta"]` (`update_policy.gd:26`), test-locked to the CI rule
  (`tests/test_update_channel.gd:35-39`). Build default: `build_info.channel` (unknown →
  `stable`) (`:105-107`).
- Override: `user://settings.cfg [update] channel`, only published names accepted
  (`:111-136`). `effective_channel()` uses it only when `channel_lock_reason()` is empty
  (`:141-146`).
- Lock reasons by distribution (`:151-164`): `appstore`/`testflight`/`play` ("the store picks the
  track"), `web` ("always latest"), any other non-`github` ("updated by its storefront"),
  `github` on a non-desktop platform ("sideloaded mobile … AltStore / SideStore / Obtainium").
  `dev` is unlocked but never checks.
- `switch_channel(ch)` (`updater.gd:249-255`): refuse if locked or unknown; persist; **discard any
  staged pack from the old channel**; force a check (`:264-269`). `reset_channel()` clears the
  override (`:259-261`).
- No-downgrade UX: switching to `stable` while on a prerelease shows an inline confirmation
  (`update_policy.gd:175-177`; `dev_menu.gd:312-320`); the status line explains "Nothing is
  downgraded" (`update_policy.gd:193-195`).
- Dev menu: opened by 5 taps within 3 s in the bottom-right 80×80 px inside the safe area
  (`dev_gesture.gd:17-21,50-60`), hosted by the title screen (`ui/screens/title_screen.gd:68`)
  and the missing-assets screen (`game/boot/missing_assets_screen.gd:87`). Sections via a
  registration API (`dev_menu.gd:43-90`); UPDATES (channel picker disabled with the lock reason,
  CHECK NOW, RESET TO DEFAULT) and BUILD (version/commit/channel/distribution/godot/built +
  COPY DIAGNOSTICS, `:224-233,384-401`). Documented in `docs/RELEASE.md:110-138`.

### 1.8 `build_info.json` and the distributions

Written by `tools/ci/stamp_version.py:103-105,131` (git-ignored, `.gitignore`), exported via
`include_filter="build_info.json"` on every preset (`export_presets.cfg:10,77,191,242,302,362,406,436`);
read by `UpdatePolicy.build_info()` merged over dev defaults
(`update_policy.gd:42-53`): `{version, short_version, build, commit[:12], channel,
distribution, godot, built}`.

Designed distribution values (`docs/design/2026-09-29-content-streaming.md:200-206`):
`github | sideload-ios | testflight | appstore | play | steam | itch | web` (+ `dev`). The code
knows `github`, `dev`, `appstore`, `play`, `testflight`, `web` (`update_policy.gd:17-21,151-164`).

**What CI actually stamps** (the real behaviour):

| Job / step                                          | Stamp                  | Artifacts built from that stamp                                                                      | Consequence                                                                                                                                                                                        |
| --------------------------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| desktop-web "Stamp version" (`release.yml:103-106`) | `github`               | linux x64, linux arm64, windows zip, **`-desktop.pck`** (`:107-112,119-131`)                         | self-updating desktop; the PCK carries `distribution: github`                                                                                                                                      |
| desktop-web "Export Web" (`:113-118`)               | `web`                  | web zip                                                                                              | never checks (`updater.gd:125`)                                                                                                                                                                    |
| android (`:181-190`)                                | `play`                 | **both** the sideload APK and the Play AAB                                                           | the Obtainium/sideload APK prompts to the Play listing and its channel is locked "through Google Play"                                                                                             |
| apple macOS (`:226-237`)                            | `github`               | macOS zip + dmg                                                                                      | self-updating                                                                                                                                                                                      |
| apple iOS (`:238-247`)                              | `appstore`             | **both** the signed IPA (TestFlight) and the unsigned sideload IPA (`tools/ci/ios_build.sh:131-137`) | SideStore/AltStore users are prompted to a placeholder App Store URL; `testflight` is never stamped                                                                                                |
| itch (`:403-429`)                                   | (reuses `github` zips) | butler channels web/windows/linux/mac                                                                | the in-game updater **is active inside itch installs** (the workflow comment at `:424-425` calls it harmless)                                                                                      |
| steam (`:431-461`)                                  | (reuses `github` zips) | depots 1–3                                                                                           | the in-game updater **is active inside Steam installs**, contrary to `docs/RELEASE.md:107-108` and spec `docs/specs/2026-09-28-diceroll-design.md:267` ("Steam and itch handle their own updates") |
| ci export-smoke (`ci.yml:282`)                      | `dev`                  | smoke exports                                                                                        | inert                                                                                                                                                                                              |

Intended per-distribution behaviour vs actual:

| Distribution                 | Intended (`RELEASE.md:36-47,97-108`; design §4)  | Actual (code + CI)                                                                        |
| ---------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| github desktop               | signed pack via `--main-pack`; binary → open URL | as intended                                                                               |
| web                          | always latest (host cache-busting)               | as intended (`can_check` false)                                                           |
| Android sideload / Obtainium | Obtainium tracks GH releases; in-game prompt     | stamped `play` ⇒ prompt to Play listing                                                   |
| iOS SideStore/AltStore       | AltStore source JSON                             | source JSON generated (§1.10); IPA stamped `appstore` ⇒ App Store prompt (placeholder id) |
| TestFlight/App Store         | store prompt                                     | `appstore` ⇒ STORE prompt (placeholder id)                                                |
| Play                         | store prompt; in-app updates API later           | as intended                                                                               |
| itch / Steam                 | platform updates; updater disabled               | updater active (`github` stamp)                                                           |
| dev                          | never checks                                     | as intended                                                                               |

### 1.9 The bearer-token private feed

`DICEROLL_UPDATE_TOKEN` (env only, `update_policy.gd:14`): when set, the client's fetcher sends
`Authorization: Bearer <token>` on **every** request — manifest, sig and pack
(`updater.gd:187-189`, `update_fetcher.gd:108-109,142,157`). It exists for private pre-release
feeds (design `:344-345`), paired with `DICEROLL_UPDATE_BASE_URL`. It is not persisted, has no
UI, and is sent through up to 10 redirects (`update_fetcher.gd:186`) — so it may reach whatever
CDN host a redirect points at. GitHub's public `releases/download` URLs ignore it; a private
host must honour it.

### 1.10 AltStore / SideStore source generation

`tools/ci/altstore_source.py`: AltStore source v2 JSON. `base_source(beta)` (`:171-197`) with
name/identifier `gg.vlad.diceroll.source[.beta]`, icon/screenshots from raw GitHub, one app
`gg.vlad.diceroll`. New entry (`:222-231`): `version` = short X.Y.Z (CFBundleShortVersionString),
`buildVersion` = build code (CFBundleVersion), `marketingVersion` = full semver, `date`,
`localizedDescription` = iOS what's-new, `downloadURL` = the sideload IPA on the version's GitHub
release, `size`, `minOSVersion` (default 15.0). The previous source is downloaded from the
`channels` release and merged: newest first, dedup by `buildVersion`, capped at 20 versions
(`:161,214-220,232-233`). Beta = version contains `-` (`:212`), published as
`altstore-source-beta.json` (`release.yml:289-294`). Finals do **not** flow into the beta source
(unlike the updater manifest, §1.11). The app entry has no top-level `downloadURL`/`version`,
which the design doc says SideStore requires (`content-streaming.md:477-480`).

### 1.11 Release workflow — jobs and every store upload path

`.github/workflows/release.yml` (trigger: tag `v[0-9]+.[0-9]+.[0-9]+*` or manual with
`version`/`publish`, `:7-18`; `GODOT_VERSION: "4.7.2"` `:27-28`):

1. **prepare** (`:32-79`): resolve version via `stamp_version.py --print --github-output`
   (outputs version/short/build/channel/prerelease); git-cliff dev changelog; `changelog_llm.py`
   player notes (Claude, schema-constrained, with mechanical fallback) → `RELEASE_NOTES.md`,
   `store/ios_whats_new.txt` (≤4000), `store/android_whats_new.txt` (≤500).
2. **desktop-web** (`:82-137`): setup action (Godot + templates + encrypted asset bundles +
   encrypted import cache, `.github/actions/setup-diceroll/action.yml`); stamp `github`; export
   linux, linux-arm64, windows, `pck`; stamp `web`; export web; package tar.gz/zip/web zip and
   `Diceroll-<v>-desktop.pck`.
3. **android** (`:140-197`): optional release keystore else debug key (`tools/export.sh:241-272`);
   stamp `play`; APK (prebuilt template, arm64) + AAB (Gradle).
4. **apple** (`:200-253`, macOS runner): stamp `github` → macOS universal app →
   `macos_package.sh` (Developer ID codesign + hardened runtime, notarytool + staple when
   secrets exist; zip + dmg); stamp `appstore` → `ios_build.sh` (signed App Store Connect IPA
   when Apple secrets exist; always an unsigned sideload IPA; simulator zip when unsigned).
5. **publish** (`:256-349`): `update_manifest.py` → `channels/update-<ch>.json(.sig)` (a stable
   release also rewrites `update-beta.json`, `update_manifest.py:97`); AltStore source; a
   build manifest JSON (version, commit, run, godot, asset lock hash, unit hashes, notes source,
   artifact sha256/bytes); `SHA256SUMS.txt`; what's-new text files; GitHub Release via
   `softprops/action-gh-release` (prerelease flag, `make_latest` only for finals); then the
   rolling **`channels`** release is created if missing and `gh release upload --clobber
channels/*` (`:329-341`). "Never delete the channels release" (`RELEASE.md:91`).
6. **testflight** (`:353-375`, `vars.ENABLE_APPSTORE`): `apple-actions/upload-testflight-build`
   with the signed IPA; what's-new pasted manually.
7. **google-play** (`:377-401`, `vars.ENABLE_PLAY`): `r0adkll/upload-google-play`, AAB, track
   `PLAY_TRACK` (default internal), status `PLAY_STATUS` (default draft), `whatsnew-en-US`.
8. **itch** (`:403-429`, `vars.ENABLE_ITCH`): butler push `web`, `windows`, `linux`, `mac` with
   `--userversion`.
9. **steam** (`:431-461`, `vars.ENABLE_STEAM`): unpack windows/linux/macos into depots 1/2/3,
   `game-ci/steam-deploy`, branch `STEAM_BRANCH` (default `beta`).

`ci.yml` adds: static checks incl. `tools/ci/selftest.sh` (asset bundle round trip, build codes,
notes dry run, manifest signing, contact sheet) (`:89-115`); tests incl. the updater suites
(`:118-145`); screenshot matrix; export smoke stamped `dev` (`:266-285`).

### 1.12 Versioning and build numbers

- Tags `vX.Y.Z` / `vX.Y.Z-rc.N` / `-beta.N`; prereleases publish to `beta`, finals to `stable`
  **and** `beta` (`RELEASE.md:54-55`; `update_manifest.py:15-16,97`).
- `stamp_version.py`: version from arg or git — exact tag, else `<last tag base>-dev.<commits>`,
  else `0.0.0-dev.<count>` (`:44-54`). Writes `project.godot application/config/version`,
  preset `short_version`/`version` (macOS/iOS), `version/name`/`version/code` (Android),
  Windows `file_version`/`product_version`, and `build_info.json` (`:115-131`).
- Build code `major*1_000_000 + minor*10_000 + patch*100 + (last number in prerelease, capped
98 | 99 for final)` (`:57-62`): 0.1.0-rc.1 → 10001, 0.1.0 → 10099. Caveats: `-beta.2` and
  `-rc.2` collide; `minor`/`patch` ≥ 100 overflow into the next field; prerelease numbers > 98
  collide at 98; Windows `file_version` is `X.Y.Z.<pre#>` for prereleases but `X.Y.Z.0` for
  finals (`:119`), so a final sorts **below** its RCs on Windows. Dev versions `X.Y.Z-dev.N`
  sort below the tag they follow.
- Engine version appears in three places: `release.yml:28`, `stamp_version.py:36`,
  `update_manifest.py:71` (default not overridden by the workflow). If the engine is bumped and
  the script default is not, older clients see `engine` equal to theirs and download a pack
  built by the newer engine; only the 2-boot rollback saves them. `min_binary`/`min_supported`
  are never set by the workflow either.

### 1.13 Export presets that matter

`export_presets.cfg`: every preset `export_filter="all_resources"`, `include_filter=
"build_info.json"`, `exclude_filter="docs/*, tests/*, build/*"`, `script_export_mode=2`
(compiled), `encrypt_pck=false`, `patches=[]`, `patch_delta_encoding=false`
(`patch_delta_compression_level_zstd=19`, `min_reduction=0.1`) on macOS/iOS/Web
(`:9-24,76-91,190-205`). Identity: bundle id `gg.vlad.diceroll` (macOS `:34`, iOS `:105`),
Android `package/unique_name="gg.vlad.diceroll"` (`:267,327`), `package/signed=true`
(`:269,329`), iOS `app_store_team_id=""` injected at export (`:98`; `tools/export.sh:127-136`),
`min_ios_version=15.0` (`:109`), `targeted_device_family=2` (iPhone+iPad, `:114`). Textures:
macOS s3tc+etc2 (`:65-66`), Windows s3tc only (`:379-380`), Linux x86_64 s3tc only
(`:423-424`), Linux arm64 both (`:453-454`); Web desktop+mobile VRAM compression
(`:213-214`), nothreads (`:212`). Desktop `embed_pck=false` (`:378,422,452`) — the PCK sits
beside the executable. Android APK: prebuilt template, arm64 only (`:257-264`); AAB: Gradle,
armv7+arm64 (`:317-324`). The updater PCK is `--export-pack Linux` (`tools/export.sh:224-238`)
and is applied on **all** desktop platforms, including linux.arm64 (whose own preset ships
ETC2/ASTC too) — texture format is not part of the compatibility gate.

---

## 2. The proposed content-pack design (not implemented)

Source: `docs/design/2026-09-29-content-streaming.md` (status "proposal for Vlad's decision",
`:3`).

### 2.1 Position

- Content is ~73 MB PCK (~64 MB gz), identical per platform (textures ~5 MB) (`:24-27,106-117`).
  Install size doesn't justify streaming; **update size** (73 MB → ~5 MB) and **Web
  time-to-title** (~73 MB → ~15 MB) do (`:28-37,148-160`).
- Verdict: "lean core + content packs", one universal system, per-channel pack **source**
  (embedded / downloaded / store-delivered), phased; a bootstrapper-everywhere is rejected as a
  distribution rule but adopted as UX (`:16-58,162-178`).
- **Data-only rule:** no GDScript in any pack on any channel; all code ships in the binary or the
  main pack; self-updating _code_ stays on the desktop/sideload `--main-pack` path
  (`:38-41,565-566`). CI enforces with `godotpcktool` listing (`:208-211,460-461`).

### 2.2 Distribution matrix and the flag set (§4)

Per-channel table (`:186-198`) of base contents, pack source, scripts-allowed, update mechanism
and signing. Proposed `build_info.json` extension (`:202-206`):

```json
{
  "distribution": "github|sideload-ios|testflight|appstore|play|steam|itch|web",
  "packs": {
    "source": "embedded|remote|mixed",
    "downloads": true,
    "required_embedded": ["ui", "core3d", "foes", "nature"],
    "scripts_in_packs": false
  }
}
```

The same iOS binary serves SideStore/TestFlight/App Store because only `build_info.json`
differs — or even that is identical if `downloads` defaults false on iOS (`:208-211`). iOS
minimum-functionality: the IPA always contains a complete offline run; any first-launch download
must disclose size and ask (App Review 4.2.3(ii)) (`:213-217,401`).

### 2.3 Pack taxonomy and stages (§5.1)

| Stage | Pack                      | Units                                          | ≈MB   | Required           | Offline fallback            |
| ----- | ------------------------- | ---------------------------------------------- | ----- | ------------------ | --------------------------- |
| 0     | base (main pack / binary) | all GDScript, `ui/**`, logo, `build_info.json` | 4.3   | loader+logic       | —                           |
| 1     | ui                        | fonts, UI sfx, jingles, rendered icons         | 1.8   | themed UI          | default font, vector glyphs |
| 2     | core3d                    | boardgame, animations, adventurers, … dungeon  | 17.3  | title/board/heroes | none                        |
| 3     | audio                     | music, impact/rpg sfx                          | 9.8   | —                  | silence                     |
| 4     | foes                      | foes, skeleton_props                           | 5.7   | runs               | none                        |
| 5     | nature                    | forest                                         | 12–20 | Glade/Moonlit/Camp | sparse dressing             |
| 6     | extra                     | EXTRA packs                                    | 13.6  | —                  | FREE props                  |

(`:228-241`.) Packs group CI **asset units** (folder = unit = hash, `tools/ci/assets.py:9-12,
61-68,111-135`), not biomes. One universal pack per unit containing both S3TC/BPTC and
ETC2/ASTC (`:243-244`).

### 2.4 Building and mounting (§5.2)

- Base preset excludes `assets/**`; unit packs are built headless with **PCKPacker** from
  `.import` + `[deps] dest_files` ⇒ no scripts, no `project.binary`, no `uid_cache.bin`, no
  global class cache (`:248-255`). Pack hash = sha256(sorted unit hashes + engine version +
  import-settings hash), so CI rebuilds only on unit or engine change (`:256-258`).
- Measured failure mode: a `resources`-filtered export pack drags autoload scripts + caches; with
  default `replace_files=true` the global class count went **180 → 0** (`:259-264`, appendix A
  #3). `--export-patch` works but patches are tied to their base (`:265-269`).
- `ContentPacks.mount()` rules (`:270-275`): `replace_files=false` (add, never override); only
  paths under declared prefixes (CI-verified); mount before first use, **one pack per frame**
  (Android stall godot#105009); ~7 ms per 20 MB.
- UIDs: PCKPacker packs don't register UIDs ⇒ rule "no `uid://` into `assets/**`" (`:276-278`).
- Nested packs inside the main PCK work on desktop; sidecars are better for Steam/itch delta
  patching (`:279-283`).

### 2.5 Registry and `Content.available()` (§5.3)

`game/content/packs.gd` (pack → stage, units, required; single source for CI, loader, tests),
`game/content/needs.gd` (content id → packs, e.g. `biome:glade → [core3d, nature]`),
`Content.available(id)` / `Content.missing(ids)` (always true today; later drive Camp/class
select/route badges and pre-run prefetch). `core/` rules never know about packs (`:285-306`).

### 2.6 Manifest schema 2, pinning, engine gate, store, eviction, saves (§5.4)

Additive to schema 1, same key; old binaries ignore new fields (`:310-311`):

```json
"packs": {"core3d": {"hash": "b3c1…", "url": ".../packs/core3d-b3c1….pck", "sha256": "…",
          "size": 18123456, "engine": "4.7", "format": 1, "stage": 2, "required": true}},
"code":  {"url": ".../diceroll-0.5.0-code.pck", "sha256": "…", "size": 4900000,
          "requires_packs": {"core3d": "b3c1…", "foes": "…"}}
```

- **`code.requires_packs` pins exact pack hashes** like a lockfile; most releases reuse all
  cached packs (`:322-323`).
- **Engine gate:** a pack whose `engine` (major.minor) or `format` mismatches the binary is never
  mounted; CI rebuilds all packs on engine bump; `format` bumps on project-wide import changes
  (`:324-326`).
- **Store:** `user://packs/<id>-<hash>.pck` + `meta.json`; the code pack keeps
  staged/current/previous + rollback exactly as today; **eviction** keeps hashes pinned by
  current and previous, deletes the rest after a successful boot (`:327-331`); no LRU for
  required packs (`:408`).
- **Saves** store content ids, never paths; "Continue (downloading 12 MB…)"; never delete or
  migrate a save for a missing pack (`:332-337`).
- **Security** (`:339-347`): the signed manifest covers every pack sha256; verify after download,
  before mount, and at boot if size/mtime changed; embedded packs trusted via the binary
  signature; HTTPS only; bearer token for private feeds; data-only + `replace_files=false`
  means only the signed code-pack path can change code.

### 2.7 BootShell loader states (§6)

`BootShell` evolves from `MissingAssetsScreen` (engine built-ins + tracked logo only) and
upgrades itself in place into the title, never cutting scenes (`:349-359,381-387`):

| State               | Needs        | Player sees                                          | Exit                                    |
| ------------------- | ------------ | ---------------------------------------------------- | --------------------------------------- |
| SHELL               | base         | gradient, logo, default-font wordmark, "Starting…"   | immediately                             |
| VERIFY              | base         | "Checking content…" (hash only on size/mtime change) | ok → MOUNT_UI; missing → FETCH or ERROR |
| FETCH (remote only) | network      | bar, MB and rate, Pause, Wi-Fi note                  | pack verified → mount its stage         |
| MOUNT_UI            | ui           | wordmark crossfades to Lilita One, card re-themes    | → MOUNT_CORE3D                          |
| MOUNT_CORE3D        | core3d       | title backdrop fades in                              | → MOUNT_AUDIO                           |
| MOUNT_AUDIO         | audio        | music fades in                                       | → READY (non-blocking)                  |
| READY               | playable set | bar morphs into PLAY/Continue/Settings               | title interactive                       |
| BACKGROUND          | —            | optional packs keep downloading; corner pill; badges | done                                    |
| OFFLINE/ERROR       | base         | explanation, Retry, "Play offline" if playable       | retry/play                              |

(`:361-373`.) Subsequent launches: ~250–400 ms minimum hold; update checks after title
(`CHECK_DELAY`); code pack → existing "Restart to update"; unit packs download silently and
mount next boot (`:375-379`). DevGesture must be hosted from the first frame in every state
(`:389-392`). Download UX: Range resume into `*.part`, backoff, pause, cellular warning > ~50
MB, size disclosure, pre-run prefetch, storage per OS, IndexedDB on web (`:394-408`).

### 2.8 Hosting, CI, phases, risks

- Hosting: immutable `packs` GitHub release with `<pack>-<hash>.pck` (upload only new hashes);
  manifests stay on `channels`; R2 later (`:446-454`).
- CI: `build_packs.gd` → `build/packs/<id>-<hash>.pck` + `packs.json`, fails on scripts or foreign
  paths; base presets per platform; full vs lean artifacts; unsigned IPA; `update_manifest.py`
  schema 2; `altstore_source.py`; boot-stage screenshots; packs-missing boot test (`:456-483`).
- Phases 0–4 (`:50-58,541-563`); "never" list (`:565-566`); risks: stale-pack override,
  engine bump invalidates all packs, Android unverified, web memory, test matrix, App Review,
  two-key custody (`:570-596`).

---

## 3. Mapping table — Diceroll mechanism → Polaris Key today

Legend: **EXISTS** (usable as-is), **PARTIAL** (primitive exists, shape/semantics differ),
**MISSING**, **CONFLICT** (exists with semantics that would break a Diceroll property).

| #   | Diceroll mechanism                                                                                                                         | PKey capability                                                                                                                                                                                                                                                                                                                                                                                                                           | Status                      | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Signed update manifest (RSA-3072 PKCS#1 v1.5 over exact JSON bytes, detached `.sig`, compiled-in key) `update_manifest.gd:23-48`           | Ed25519 compact JWS with `typ` domain separation, `kid`-selected pinned trust set (`README.md:38-59`; `packages/docs/src/content/docs/services/core/trust.md`). Signed doc set = license/config/trust/bundle only (`AGENTS.md` rule 2). `/update/version` is **unsigned JSON** (`packages/worker/src/services/update/feed.ts:93-116`); the appcast is unsigned XML with only the DMG bytes EdDSA-verified server-side (`feed.ts:166-202`) | PARTIAL                     | Needs a new signed `typ` (e.g. `pkey-update+jws`) ⇒ wire change: `PROTOCOL_VERSION` bump (`packages/shared-protocol/src/core.ts:9`), corpus regen, all SDKs (AGENTS rule 2). Godot's built-in `Crypto` is mbedTLS-backed and has no Ed25519 ⇒ a Godot SDK needs a GDExtension (libsodium/monocypher) or a pure-GDScript verifier                                                                                                                                   |
| 2   | Freshness                                                                                                                                  | JWS envelope `issuedAt`/`expiresAt` (`DOC_EXPIRY_SECONDS=3600`, `core.ts:216`)                                                                                                                                                                                                                                                                                                                                                            | EXISTS (primitive)          | Improvement over Diceroll (which has no expiry ⇒ freeze attacks possible)                                                                                                                                                                                                                                                                                                                                                                                          |
| 3   | Channel binding (manifest `channel` must equal requested) `update_manifest.gd:121-122`                                                     | Channel resolved per request; no signed claim                                                                                                                                                                                                                                                                                                                                                                                             | MISSING                     | A signed update doc must carry `channel` (and `platform`/`distribution` if filtered)                                                                                                                                                                                                                                                                                                                                                                               |
| 4   | Device-independent, CDN-cacheable manifest                                                                                                 | v3 envelope is device-bound (`deviceId`) for license/config; the **trust manifest** has no `deviceId`, is public, `max-age=300` (`trust.md`)                                                                                                                                                                                                                                                                                              | PARTIAL / CONFLICT          | A per-device update doc breaks anonymous checks and edge caching. Follow the trust-manifest precedent (product-scoped, short-lived, no `deviceId`)                                                                                                                                                                                                                                                                                                                 |
| 5   | Channels `stable`/`beta`; **beta ⊇ stable** (`update_manifest.py:97`)                                                                      | `stable`/`latest`/pinned, `beta` (channel workflow or newest _prerelease_), `pr-<n>`, manual regex channels (`packages/worker/src/services/release/channels.ts:44-64,130-159`; `eligibility.md:192-215`)                                                                                                                                                                                                                                  | CONFLICT                    | PKey `beta` without a workflow = newest prerelease only, never a final: after `0.4.0` ships, beta still points at `0.4.0-rc.2`. A manual channel with an all-tags regex can emulate ⊇ but cannot be named `beta` (built-ins matched first, `eligibility.md:213-215`)                                                                                                                                                                                               |
| 6   | "Latest" = semver max (client compares with `Semver`)                                                                                      | `newest()` = first match in GitHub's list order (`channels.ts:112-122`), from one page of 100 (`gateway.ts:346-352`; `github.ts:137-151`)                                                                                                                                                                                                                                                                                                 | CONFLICT                    | A hotfix to an older line published later (e.g. `v0.3.5` after `v0.4.0`) becomes `stable`. Diceroll's client no-downgrade guard protects installed users, but download/AltStore/new-install consumers get the older build                                                                                                                                                                                                                                          |
| 7   | `/update-<ch>.json` version check                                                                                                          | `GET /<p>/update/version?channel=` → `{version, tag, url}` (`feed.ts:93-116`; `eligibility.ts:40-53`), `max-age=120`; SDK `updateAvailable = current < latest` (`packages/sdk-node/src/update/client.ts:42-79`)                                                                                                                                                                                                                           | PARTIAL                     | Missing `engine`, `min_binary`, `min_supported`, artifacts per platform with sha256/size, stores, notes, released. SDK comparison already never offers a downgrade, but there is no `behind` flag                                                                                                                                                                                                                                                                  |
| 8   | `min_supported` ⇒ mandatory binary/store update, judged on the **binary** version, overridden by `behind` (`update_policy.gd:215,221-225`) | Product `compatMin/compatMax` (Update settings, `eligibility.md:306-323`; `packages/worker/src/core/entitlements.ts:119-138`) and license `app.minVersion`/`app.maxVersion` (`license/document.md:115-124`), enforced by the **license-document build gate** (`document.md:171-226`) and by `entitled` pinned downloads                                                                                                                   | PARTIAL (semantic mismatch) | PKey's floor _blocks a grant_ (403 `version_blocked`); Diceroll's floor _prompts non-dismissibly_ and never blocks play. PKey says the feed "only ever informs" (`update/index.md:132-142`). Product-wide, not per channel. A feed-level `minSupported`/`mandatory` is missing                                                                                                                                                                                     |
| 9   | `min_binary` (content requires binary ≥ X)                                                                                                 | —                                                                                                                                                                                                                                                                                                                                                                                                                                         | MISSING                     | No inter-artifact dependency concept                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 10  | `engine` gate (pack engine == binary engine)                                                                                               | Only `sparkle:minimumSystemVersion`, operator-owned (`feed.ts:118-139`)                                                                                                                                                                                                                                                                                                                                                                   | MISSING                     | Needs a generic "compat key" on artifacts                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 11  | Pack artifact `{url, sha256, size}`                                                                                                        | `/release/dl/<version>/<binary>-<arch>[.dmg]` serves only extensionless binaries or `.dmg`, and the leaf must end in an arch token (`packages/worker/src/services/release/routes.ts:23,38-50`; `assets.ts:107-147`; `surfaces.ts:142-203`). Range/ETag streaming exists (`artifacts.md:62-72`)                                                                                                                                            | MISSING (for this shape)    | `Diceroll-0.2.0-desktop.pck` (no arch, `.pck`) and all `.zip`/`.tar.gz`/`.apk`/`.ipa` are unservable. Gateway streaming + Range would give Diceroll resumable downloads it lacks today                                                                                                                                                                                                                                                                             |
| 12  | Hash pinning (sha256 in the signed manifest)                                                                                               | `?checksum=sha256` serves a per-asset `<asset>.sha256` sidecar on demand (`surfaces.ts:205-235`); truth store records `sha256: null` (`store.ts:452`) to avoid per-asset subrequests                                                                                                                                                                                                                                                      | PARTIAL                     | Diceroll publishes one `SHA256SUMS.txt` (`release.yml:311`), not sidecars. A signed feed needs hashes at render time ⇒ ingest a CI-authored release descriptor once per release                                                                                                                                                                                                                                                                                    |
| 13  | `binaries{platform}` (macos universal, windows.x86_64, linux.x86_64, linux.arm64)                                                          | Platform classifier macos/linux/windows by name (`store.ts:183-190`); arch only arm64/x86_64 (`assets.ts:17-20`); `.zip/.tar.gz` = `archive` kind (`store.ts:172-181`), not downloadable via `/release/dl`; health check expects macOS DMGs (`truth-store.md:121-147`; `health.ts:66-91,243-255`)                                                                                                                                         | PARTIAL                     | No `universal`, `ios`, `android`, `web`; Diceroll releases would show `needs-setup`                                                                                                                                                                                                                                                                                                                                                                                |
| 14  | `stores{ios, android}` listing URLs                                                                                                        | — (`.pkey/release` schema has no such field, `packages/shared-manifest/schemas/v1/release.schema.json`)                                                                                                                                                                                                                                                                                                                                   | MISSING                     |                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 15  | `distribution` in `build_info.json` + lock reasons + per-distribution behaviour (`update_policy.gd:17-21,151-164`)                         | Headers carry version/channel/SDK/platform/arch (`core.ts:221-230`); `devices/report` key allowlist has no distribution and drops unknown keys silently (`device-principal.md:265-268`)                                                                                                                                                                                                                                                   | MISSING                     | No server concept of "where this install came from"                                                                                                                                                                                                                                                                                                                                                                                                                |
| 16  | AltStore/SideStore source JSON (`altstore_source.py`)                                                                                      | Only a Sparkle appcast renderer (`update/appcast.ts:147-181`)                                                                                                                                                                                                                                                                                                                                                                             | MISSING                     | Natural sibling: `/update/<channel>/altstore.json` rendered from the truth store                                                                                                                                                                                                                                                                                                                                                                                   |
| 17  | Obtainium (tracks GitHub releases)                                                                                                         | GitHub remains the byte host (`release/index.md:139-146`)                                                                                                                                                                                                                                                                                                                                                                                 | EXISTS (nothing needed)     |                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 18  | Private feed bearer token (`DICEROLL_UPDATE_TOKEN`)                                                                                        | Access modes `public`/`authenticated`/`licensed`/`entitled` per metadata vs artifacts (`artifacts.md:81-105`; `access.ts:109-152`)                                                                                                                                                                                                                                                                                                        | PARTIAL                     | All three non-public modes require a **usable license** (`core/entitledAccess.ts:62-78`; `core/devices.ts:177-184`), although `artifacts.md:90` says `authenticated` doesn't. A free game with `open` registration (license-less device tokens, `device-principal.md:41-66`) has no way to gate a tester feed without adopting License (keys or anonymous enrollment, `license/enrollment.md`). `entitled` is not a manifest value (`release.schema.json:179-181`) |
| 19  | Dev-menu channel switch (device-local override, persisted, locked per distribution, no downgrade, confirmation)                            | `?channel=` on the version check, per-channel appcast URLs; license `channels` entitlement gates under `entitled` (`eligibility.md:243-272`); SDK narrows offered channels from the entitlement (`sparkle.md:296-310`)                                                                                                                                                                                                                    | PARTIAL                     | Locking by distribution is missing. Server-assigned channels are possible via license tiers (`channels` entitlement) or a Config catalog key with a device-level override (effective config = tier(profile) → license → device, `README.md:70-71`)                                                                                                                                                                                                                 |
| 20  | Base URL override (`DICEROLL_UPDATE_BASE_URL`, project setting)                                                                            | Discovery `/.well-known/polaris.json` publishes the Update endpoints and channels (`update/index.md:88-96`; `packages/worker/src/services/update/index.ts:53-55`)                                                                                                                                                                                                                                                                         | EXISTS                      |                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 21  | `channels` rolling GitHub release as a mutable pointer                                                                                     | Truth store `release_channels` moving pointer + live resolution (`truth-store.md:56-63`; `store.ts:393-420`)                                                                                                                                                                                                                                                                                                                              | EXISTS                      | Removes the need to clobber assets on a rolling release                                                                                                                                                                                                                                                                                                                                                                                                            |
| 22  | Release notes (≤500 chars in manifest; `notes_url`)                                                                                        | Changelog summary via `<!-- pkey:summary -->` marker, ≤600 chars (`artifacts.md:140-152`); appcast `<description>`                                                                                                                                                                                                                                                                                                                        | PARTIAL                     | CI can wrap the Claude notes in the marker in the GH release body                                                                                                                                                                                                                                                                                                                                                                                                  |
| 23  | Build number (CFBundleVersion/versionCode)                                                                                                 | Appcast uses the tag for both `sparkle:version` and `shortVersionString` (`appcast.md:65-67`; `appcast.ts:205-210`)                                                                                                                                                                                                                                                                                                                       | MISSING                     | AltStore needs `buildVersion`; iOS/Android need monotonic codes                                                                                                                                                                                                                                                                                                                                                                                                    |
| 24  | Check cadence (4 s after title, ≤ every 6 h)                                                                                               | Version check `max-age=120`, appcast 300 (`gateway.ts:65-67`); metadata rate limit 30/min/IP, artifacts 120/min/IP (`gateway.ts:89-90`)                                                                                                                                                                                                                                                                                                   | EXISTS (server side)        | Throttle state is a client-SDK concern                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 25  | Download + verify + staged/current/previous + `--main-pack` + 2-boot rollback + `skip_version`                                             | Only the Swift/Sparkle macOS client path (`sparkle.md:203-236`)                                                                                                                                                                                                                                                                                                                                                                           | MISSING                     | Needs a Godot SDK; server could accept boot/rollback reports to halt a rollout                                                                                                                                                                                                                                                                                                                                                                                     |
| 26  | Binary update = open URL                                                                                                                   | `/release/dl` + Sparkle appcast (macOS only, native Swift)                                                                                                                                                                                                                                                                                                                                                                                | PARTIAL                     | Not usable by a Godot binary without embedding Sparkle; Velopack/WinSparkle are the design's candidates                                                                                                                                                                                                                                                                                                                                                            |
| 27  | Store prompt (open listing)                                                                                                                | —                                                                                                                                                                                                                                                                                                                                                                                                                                         | MISSING                     |                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 28  | Content packs (schema 2: `packs{}`, `code.requires_packs`, stages, required)                                                               | —                                                                                                                                                                                                                                                                                                                                                                                                                                         | MISSING                     | No content-addressed artifact, no pinning, no mount order, no per-distribution pack source                                                                                                                                                                                                                                                                                                                                                                         |
| 29  | Web lazy packs over HTTP                                                                                                                   | No CORS headers on release/update routes (`packages/worker/src/securityHeaders.ts:58-65`; no `access-control-allow-origin` anywhere in `packages/worker/src`)                                                                                                                                                                                                                                                                             | MISSING                     | A web build hosted on itch/GitHub Pages can't fetch from `key.plrs.im`                                                                                                                                                                                                                                                                                                                                                                                             |
| 30  | Per-install identity                                                                                                                       | Device principal: `X-PKey-Device`, `open` registration, `pkeyt_` tokens, roster, facts (`device-principal.md`)                                                                                                                                                                                                                                                                                                                            | EXISTS (new capability)     | Enables staged rollouts/telemetry Diceroll doesn't have                                                                                                                                                                                                                                                                                                                                                                                                            |
| 31  | Build manifest / SHA256SUMS / immutable history ("never delete channels", assets "never deleted")                                          | Truth store never deletes (`truth-store.md:81-102`)                                                                                                                                                                                                                                                                                                                                                                                       | EXISTS                      |                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 32  | Hosting on R2 (design option)                                                                                                              | Only the `github` provider is implemented (`release.schema.json` `provider.type const github`)                                                                                                                                                                                                                                                                                                                                            | MISSING                     |                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 33  | Changelog generation, store uploads, signing/notarization, encrypted asset bundles                                                         | Out of scope: "not a build server and not a CDN" (`release/index.md:139-146`)                                                                                                                                                                                                                                                                                                                                                             | N/A (stays in CI)           |                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

Additional PKey-side details relevant to adoption:

- Moving-channel enclosures point at `/release/dl/beta/...` (`feed.ts:204-208`;
  `appcast.md:77-96`). If a pack URL were moving, the release behind it could change between
  manifest fetch and download ⇒ sha mismatch. Hash-pinned artifacts need immutable (pinned
  version or content-addressed) URLs.
- The build gate infers channel from version only for `0.0.0-dev…`, `0.0.0-staging…`,
  `0.0.0-pr-N` (`license/document.md:217-221`). Diceroll's `X.Y.Z-dev.N` and `X.Y.Z-beta.N`
  would be inferred `stable` unless `X-PKey-Channel` is sent. Only relevant if Diceroll adopts
  License.
- `install.sh` is Darwin-only (`packages/worker/src/services/release/install.ts:156-157`) — not
  relevant to a game, but indicative of the macOS-CLI bias of Release today.
- Naming: "surface" already means a route kind in PKey (`surfaces.ts:4`, `gateway.ts:6` "all
  seven surfaces", `config.ts` `ReleaseKind`); "bundle" is the offline activation bundle
  (`pkey-bundle+jws`); "profile" is taken twice and "tier" once (`AGENTS.md` rule 4;
  `start/concepts.md:159-163`); "staging" is a channel name in the build gate.

---

## 4. What Diceroll deletes vs keeps if PKey (+ a Godot SDK) provided this natively

### 4.1 Deleted (moves into PKey or the Godot SDK)

| Diceroll file / thing                                                                                                                                                                                                | Replaced by                                                                                            |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `game/update/update_manifest.gd` (RSA verify, DER walk, schema-1 validation)                                                                                                                                         | SDK verifier of a PKey signed update doc (Ed25519 JWS)                                                 |
| `game/update/semver.gd`                                                                                                                                                                                              | SDK port of `client-core` `compareSemver` (must match the server, `sdk-node/src/update/client.ts:6-9`) |
| `game/update/update_fetcher.gd`                                                                                                                                                                                      | SDK fetcher (with Range resume, bearer device token, discovery)                                        |
| `game/update/update_client.gd`                                                                                                                                                                                       | SDK update client                                                                                      |
| `game/update/update_policy.gd` `decide()`, `is_downgrade`, `switch_needs_confirm`, `describe_result`, `effective_channel`, `channel_lock_reason`, `build_info()`, `platform_key()`, `engine_version()`, `base_url()` | SDK decision engine + distribution capability table + build-identity reader                            |
| `game/update/update_store.gd` (slots, rollback, boot maintenance)                                                                                                                                                    | SDK slot store (and the per-pack store with eviction)                                                  |
| `game/update/updater.gd` (autoload lifecycle, relaunch, signals)                                                                                                                                                     | SDK autoload; the game connects signals                                                                |
| `game/update/update_keys.gd`                                                                                                                                                                                         | pinned `kid → Ed25519` trust set compiled into the game (still in the game binary)                     |
| Updater tests `tests/test_update_{manifest,policy,store,e2e,semver,channel}.gd` + fixtures                                                                                                                           | SDK tests + conformance corpus vectors                                                                 |
| `tools/ci/update_manifest.py`, the `channels` release and its upload (`release.yml:287-288,329-341`), `UPDATE_SIGNING_KEY` (unless kept as a publisher key, §5.7)                                                    | PKey feed rendered from GitHub releases + a CI-published release descriptor                            |
| `tools/ci/altstore_source.py` + download/merge of the previous source (`release.yml:289-294`)                                                                                                                        | PKey AltStore renderer                                                                                 |
| `DICEROLL_UPDATE_BASE_URL`, `diceroll/update/base_url`, `DICEROLL_UPDATE_TOKEN`                                                                                                                                      | discovery + device token + access mode                                                                 |
| `build_info.json` distribution/channel logic in `stamp_version.py`                                                                                                                                                   | a `pkey` CLI "stamp" (build identity) — the Godot-specific preset rewriting may stay                   |
| Selftest step 4 (`tools/ci/selftest.sh:55-64`)                                                                                                                                                                       | PKey/SDK tests                                                                                         |
| Planned (unbuilt): manifest schema 2, per-pack store and eviction, pack download/resume, `altstore.json`                                                                                                             | PKey + SDK                                                                                             |
| Dev menu UPDATES section internals (`dev_menu.gd:158-222,305-381`)                                                                                                                                                   | an SDK-provided row builder registered through the game's `DevMenu.register_row` API                   |

### 4.2 Stays game-side

- **Content registry**: `game/content/packs.gd` (pack → units/stage/required) and
  `game/content/needs.gd` (content id → packs), `Content.available()/missing()` and every UI use
  (Camp/class-select badges, route prefetch "Downloading Magma Depths (6 MB)…", save Continue).
  The pack → unit folder map is Godot/project-specific; PKey should only see pack ids, hashes,
  compat keys and mount metadata.
- **BootShell** visuals and in-place morph (`MissingAssetsScreen` today), boot-stage screenshot
  scenarios, `DevGesture` + `DevMenu` shell, `update_banner.gd` presentation (or an SDK default
  UI the game can replace), the settings Auto-update toggle.
- **Save compatibility** (ids not paths; never delete/migrate a save for a missing pack; profile
  independent of packs) and the "no `uid://`/`preload` into `assets/**`" code rules + tests.
- **AssetCheck** (source-checkout lock check) and `tools/ci/assets.py` (private age-encrypted CI
  input bundles; `lock_hash` in the build manifest).
- **Builds**: export presets, texture formats, `PCKPacker` pack builder + data-only CI check,
  Developer ID signing/notarization, iOS signing, Android keystore, store uploads (TestFlight,
  Play, itch butler, Steam) — PKey is not a build server (`release/index.md:139-146`).
- **Release notes generation** (`changelog_llm.py`, git-cliff) — output feeds PKey's summary
  marker.
- Godot-generic mount mechanics (`replace_files=false`, prefix check, one pack per frame,
  `--main-pack` relaunch) belong in the **Godot SDK**, not in Diceroll, but not in the Worker.

---

## 5. Correctness properties PKey's model must preserve (and current conflicts)

| #   | Property (Diceroll)                                                                           | Where enforced                                                       | PKey today                                                                                                                                                     | Conflict?                                                                                                                                                                                                                                                                          |
| --- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | **No downgrade on channel switch**; `behind` suppresses even `mandatory`                      | `update_policy.gd:219-225`; tests `test_update_channel.gd:154-190`   | SDK `updateAvailable = current < latest` (`sdk-node/src/update/client.ts:77`) — never suggests a downgrade; no `behind` signal. Sparkle ignores lower versions | Compatible client-side. Server "latest" by list order (`channels.ts:112-122`) can present an _older_ build as the channel head — harmless to installed clients with the guard, wrong for download/AltStore consumers. Add semver ordering and an explicit `behind` in the response |
| P2  | **Beta ⊇ stable** (finals also update beta)                                                   | `update_manifest.py:97`                                              | `beta` = workflow tags or newest prerelease (`channels.ts:143-146`)                                                                                            | **Conflict.** Beta users on a prerelease never see the final. Needs a channel definition option like `includes: ["stable"]` or "max-semver over (prereleases ∪ finals)"                                                                                                            |
| P3  | **Channel binding** of the signed doc                                                         | `update_manifest.gd:121-122`                                         | no signed doc                                                                                                                                                  | Must be a claim in any new doc                                                                                                                                                                                                                                                     |
| P4  | **Engine-version gating** (exact `4.7.2` today; `major.minor` + `format` for packs)           | `update_policy.gd:248`; `update_store.gd:237-239`; design `:324-326` | none (only `minimumSystemVersion`)                                                                                                                             | Missing. The server should filter by compat key; the client must still re-check (the client's engine is the truth). Also include texture format (§1.13)                                                                                                                            |
| P5  | **`min_binary`**: content requires executable ≥ X, judged on binary not running pack          | `update_policy.gd:249`; `test_update_policy.gd:52-55`                | none                                                                                                                                                           | Missing                                                                                                                                                                                                                                                                            |
| P6  | **Mandatory floor on the binary version** (`min_supported`), non-blocking                     | `update_policy.gd:215,258-262`                                       | compat window / `app.minVersion` block the license document (`document.md:185-201`)                                                                            | **Semantic conflict if reused**: PKey's floor refuses a grant (hard lock) while Diceroll's is a prompt. Keep them distinct: a feed field "mandatory update" vs License's "may not hold a grant"                                                                                    |
| P7  | **Hash pinning** of downloaded bytes (size + sha256 from the signed doc; re-verified at boot) | `update_store.gd:138-145,159-174,247-256`                            | sidecar on demand, `sha256: null` in the store                                                                                                                 | Missing in the feed. Moving `/release/dl/beta/…` URLs (`feed.ts:204-208`) would race hash pinning — use immutable URLs                                                                                                                                                             |
| P8  | **Pack pinning by the code version** (`requires_packs`)                                       | design `:318-323`                                                    | none                                                                                                                                                           | Missing; the pin must be inside the signed doc (and the code pack itself must be authenticated by the same chain)                                                                                                                                                                  |
| P9  | **Rollback after 2 failed boots**, `BOOT_OK_SECONDS=10`, `skip_version` never re-downloaded   | `update_store.gd:20,96-102,208-218,243-246`; `updater.gd:93-95`      | client-only; no server input                                                                                                                                   | No conflict. Opportunity: report rollbacks via `devices/report` (needs allowlisted keys, `device-principal.md:265-268`) so the server can halt a channel                                                                                                                           |
| P10 | **Binary supersedes content** (drop packs not newer than the binary) and engine-changed packs | `update_store.gd:240-242`                                            | n/a                                                                                                                                                            | Client property; keep in SDK                                                                                                                                                                                                                                                       |
| P11 | **Staged pack dropped on channel switch**                                                     | `updater.gd:264-269`                                                 | n/a                                                                                                                                                            | Client property                                                                                                                                                                                                                                                                    |
| P12 | **Never scripts in packs on any channel**; `replace_files=false`; prefix-restricted mounts    | design `:38-41,208-211,270-275`                                      | n/a                                                                                                                                                            | The Worker must never be able to _turn on_ code delivery for a store build. Mirror the `requireSparkleSignature` pattern: operator-owned, never manifest-writable (`appcast.md:119-123`; `config.ts:94-120`), and compiled-in client policy is authoritative                       |
| P13 | **Store builds never self-update code**; channel locked; only prompts                         | `updater.gd:118-128`; `update_policy.gd:151-164,229-240`             | no distribution concept                                                                                                                                        | Missing; also Diceroll's own CI violates its intent (§1.8). The distribution capability table must be compiled into the client per artifact, with the server only as defense-in-depth                                                                                              |
| P14 | **Fail closed** on empty/wrong key, bad sig, bad schema                                       | `update_keys.gd:6-7`; `update_client.gd:55-60`                       | JWS verify fails closed; pinned-last trust merge (`trust.md`)                                                                                                  | Compatible                                                                                                                                                                                                                                                                         |
| P15 | **Freshness**                                                                                 | none in Diceroll                                                     | JWS `expiresAt`                                                                                                                                                | PKey is stronger; but a _publisher_-signed code/pack hash can't carry a 1-hour expiry, hence §5.7                                                                                                                                                                                  |
| P16 | **Anonymous checks** (no account needed)                                                      | public GitHub URLs                                                   | `public` access + edge cache; any non-public mode needs a license                                                                                              | Private tester feeds need License or a new device-only mode                                                                                                                                                                                                                        |
| P17 | **Device-independent signed feed** (cacheable)                                                | one file per channel                                                 | license/config docs carry `deviceId`                                                                                                                           | Must follow the trust-manifest shape                                                                                                                                                                                                                                               |

### 5.7 Trust-root shift (important)

Today the only signer is the maintainer's offline RSA key (CI secret). If PKey signs the update
document with the product key held (KEK-sealed) by the Worker, a Worker compromise could push a
**code pack** (which replaces all GDScript via `--main-pack`) to every desktop install. PKey
already knows this pattern from Sparkle: the Worker verifies the publisher's EdDSA signature as a
publishing gate but the client trusts only the key baked into the app (`appcast.md:98-117`;
`sparkle.md:245-266`). Recommendation: **the server signs the pointer (freshness, channel,
targeting); the publisher signs the bytes (artifact hashes).** Code packs must verify against a
publisher key compiled into the binary; data packs may rely on the server-signed hash list plus
`replace_files=false`.

---

## 6. Generalizable concepts for other products/SDKs

| Concept                                         | Definition                                                                                                                    | Diceroll instance                                           | Suggested PKey name (avoiding glossary collisions)                                                       |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------ | ----- | --------- | ------------------------------ | -------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Distribution                                    | Where an installed build came from and therefore who updates it                                                               | `build_info.distribution`                                   | **distribution** (not "surface": taken by `ReleaseKind`; not "profile"/"tier"/"bundle")                  |
| Distribution capabilities                       | Per-distribution policy: `codeUpdate: self                                                                                    | none`, `dataUpdate: self                                    | platform                                                                                                 | none`, `binaryUpdate: open-url | store | platform  | sparkle                        | none`, `channelSwitch: allowed         | locked(reason)`, `downloads: bool`, `scriptsInDownloads: false` | `can_apply_packs`, `can_check`, `channel_lock_reason`, design `packs.downloads` | distribution policy table in `.pkey/release` (display/filtering) + compiled client copy (authoritative) |
| Build identity stamp                            | version, build code, commit, default channel, distribution, engine, built-at                                                  | `build_info.json`                                           | `pkey stamp` → a standard identity file per artifact                                                     |
| Monotonic build code                            | derivation of CFBundleVersion/versionCode from semver                                                                         | `stamp_version.py:57-62`                                    | a shared, collision-free function (fix the beta/rc collision)                                            |
| Compat key / requires                           | constraints an artifact imposes on the runtime: engine major.minor, content format, texture formats, OS min, arch, min binary | `engine`, `min_binary`, `format`, texture presets           | `requires` on artifacts; server filters, client re-checks                                                |
| Artifact role                                   | binary installer / code bundle / content pack / store upload / checksum                                                       | `binaries`, `pack`, `code`, `packs`                         | `role` on release artifacts (Release currently only knows `cli`/`dmg` served, `archive`/`other` indexed) |
| Content pack                                    | content-addressed, data-only, cacheable across versions                                                                       | schema-2 `packs{}`                                          | **pack** (not "bundle")                                                                                  |
| Pack lock                                       | code version pins exact pack hashes                                                                                           | `code.requires_packs`                                       | lock / pin                                                                                               |
| Mount order and boot set                        | ordered stages; required-before-ready vs background                                                                           | `stage`, `required`                                         | `mountOrder` + `required` ("stage" collides with the `staged` slot and PKey's `staging` channel)         |
| Slots                                           | staged / current / previous with verify-before-activate                                                                       | `update_store.gd`                                           | A/B(/C) slot store                                                                                       |
| Main-pack swap                                  | relaunch the same executable pointing at a new code bundle                                                                    | `--main-pack`                                               | code swap with relaunch (Electron asar, Unity bundles, JS bundles)                                       |
| Boot health & rollback                          | attempt counter, "boot OK" after N s, max attempts, skip list                                                                 | `MAX_BOOT_ATTEMPTS=2`, `BOOT_OK_SECONDS=10`, `skip_version` | boot attempts / rollback, reportable                                                                     |
| Binary supersedes content                       | drop downloaded content not newer than the executable                                                                         | `update_store.gd:240-242`                                   | supersede rule                                                                                           |
| Behind / no-downgrade                           | channel head older than running ⇒ nothing, reported as `behind`                                                               | `decide()`                                                  | `behind` flag in the update decision                                                                     |
| Mandatory floor                                 | executable below floor ⇒ non-dismissible prompt                                                                               | `min_supported`                                             | `mandatory`/`minSupported` (distinct from License's grant-blocking window)                               |
| Decision vocabulary                             | `none                                                                                                                         | content                                                     | ready                                                                                                    | binary                         | store | platform` | `NONE/PACK/READY/BINARY/STORE` | SDK-level enum shared across languages |
| Store listing                                   | per-distribution URL to open                                                                                                  | `stores{}`                                                  | `distributions.<d>.listingUrl`                                                                           |
| Feed renderers                                  | same truth, several formats                                                                                                   | JSON manifest, AltStore source                              | native signed feed, Sparkle appcast, AltStore source, (Obtainium: none)                                  |
| Device-local channel override with lock reasons | dev menu                                                                                                                      | `effective_channel()`                                       | SDK feature, gated by distribution                                                                       |
| Publisher-signed bytes vs server-signed pointer | two trust layers                                                                                                              | (only publisher today)                                      | dual signature (§5.7)                                                                                    |

---

## 7. Diceroll findings worth fixing regardless of PKey

1. Steam/itch receive `github`-stamped builds ⇒ updater live inside platform installs
   (`release.yml:106,235,403-461`).
2. Sideload APK stamped `play`, sideload IPA stamped `appstore`; `testflight` never stamped
   (`release.yml:185,246`).
3. The iOS store URL is a placeholder (`update_manifest.py:32`).
4. `update-beta.json` is overwritten by every stable release, so a beta line ahead of stable
   regresses (`update_manifest.py:97`); the AltStore beta source does the opposite (finals never
   reach it, `altstore_source.py:212`).
5. The engine version is triplicated and the manifest default is never overridden
   (`release.yml:28`, `stamp_version.py:36`, `update_manifest.py:71`); `min_binary`/`min_supported`
   are never set by CI.
6. Build-code collisions (`-beta.N` vs `-rc.N`; >98; minor/patch ≥ 100) and Windows file versions
   where the final sorts below its RCs (`stamp_version.py:57-62,119`).
7. `binaries[].sha256` is published but never verified.
8. The bearer token is attached to every request and redirects are followed (`update_fetcher.gd:142,157,186`); if Godot's `HTTPRequest` re-sends custom headers on redirect (likely; unverified here), the token reaches the CDN host.
9. No download resume (`update_fetcher.gd:151-179`).
10. Turning Auto-update off also stops _running_ the current pack at next boot (`updater.gd:77,
118-120`), i.e. a silent content downgrade to the binary's built-in version.
11. `last_check` is recorded before the result, so a failed automatic check throttles for 6 h
    (`updater.gd:191`).
12. The desktop PCK comes from the S3TC-only Linux preset but is applied on linux.arm64
    (`tools/export.sh:224-238`; `export_presets.cfg:423-424,453-454`).
13. No manifest expiry ⇒ an attacker who controls the feed host can freeze clients on an older
    signed manifest (no downgrade is possible).
14. The AltStore source lacks the app-level `downloadURL`/`version` the design says SideStore
    needs.

---

## 8. What PKey would need (sketch, for the follow-up plan; wire-touching ⇒ plan mode)

1. **Release descriptor ingest**: CI uploads one `pkey-release.json` asset per GitHub release
   listing artifacts with `role`, `platform`, `arch|universal`, `distributions`, `requires`
   (compat key), `sha256`, `size`, and for packs `{id, hash, mountOrder, required}`, plus
   `code.requiresPacks`, `minBinary`, `mandatoryFloor`, `buildCode`. One subrequest per release
   at sync (the truth store already avoids per-asset fetches, `store.ts:448-452`). Optionally
   publisher-signed.
2. **Signed update document** (`pkey-update+jws`, no `deviceId`, short expiry, `channel` claim,
   filtered by `platform`/`distribution`/compat) at e.g. `/<p>/update/manifest` — a wire change
   requiring `PROTOCOL_VERSION`, corpus and all-SDK work (AGENTS rules 2 and 10; CLAUDE.md plan mode).
3. **Artifact addressing** by exact name or content hash (immutable URLs), beyond `<binary>-<arch>`.
4. **Channel semantics**: semver ordering; a way to express "beta includes stable".
5. **Distribution registry** in `.pkey/release` (capabilities + listing URLs), with
   security-relevant bits (code delivery) operator-owned only.
6. **Feed renderers**: AltStore/SideStore source (with `buildVersion` from the descriptor).
7. **Access**: a device-only (license-free) gated mode for tester feeds, or document that
   testers need License (enrollment/keys).
8. **Web**: CORS for the update/release routes a browser build must call.
9. **Telemetry**: allowlist `distribution`, `engine`, `rollback` facts in `devices/report`.
10. **Godot SDK** (sixth language): Ed25519 verifier (GDExtension or GDScript), conformance
    runner, autoload with the Diceroll slot/rollback/pack logic generalized.
