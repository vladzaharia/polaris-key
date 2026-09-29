> Research note for [Godot on Polaris Key](../README.md), 2026-09-29. A working paper kept for its
> evidence and sources; the README synthesis is the cross-checked position. Scratch paths in the
> original run are rewritten to `prototype/` where the code was kept.

# A1 — Release + Update services: what native Godot multi-platform distribution would need

Scope: `packages/worker/src/services/release/*`, `packages/worker/src/services/update/*`, release
migrations, `@polaris-key/protocol` release/update types, `@polaris-key/manifest` release schema +
validator, `openapi/polaris-key.v3.yaml` release/update paths, docs under
`packages/docs/src/content/docs/services/{release,update}/`, the release/update/appcast tests, plus
how the customer portal (`services/identity/portal`) and admin console (`packages/admin/src`) read
release data.

All paths below are relative to `/home/user/polaris-key/packages/` unless absolute. Line numbers are
per-file (verified with `grep -n`).

---

## 0. One-paragraph verdict

Release + Update today are a **macOS-CLI/DMG + Sparkle** distribution engine built over **one GitHub
repo per product**, with **semver-ish `vX.Y.Z` tags**, **two architectures (`arm64`, `x86_64`)**, and
**exactly two servable artifact shapes** (a bare extension-less CLI binary, or a `.dmg`). The truth
store (`release_artifacts`) is more general than the serving routes (it indexes _every_ asset with a
free-text `kind`/`platform`/`arch`), but nothing device-facing reads it — every download/feed request
resolves live against the GitHub API, costing 1–4 installation-quota API calls per request with no
caching of artifact resolution. Nothing in the model knows about iOS, Android, Web, content packs,
universal binaries, build numbers, per-platform availability, staged rollout, or yanks. The good news:
none of Release/Update is in the signed wire set (license/config/trust/bundle), so almost everything a
Godot story needs is unsigned JSON/XML routes + manifest schema + D1 columns/tables — i.e. OpenAPI +
routeCoverage + validator/mutation-table/JSON-schema + migration + generated-docs drift gates, **not** a
`PROTOCOL_VERSION` bump — unless we decide the content-pack catalog must be a signed document.

---

## 1. The exact current data model

### 1.1 Tables

**`release_config`** — one row per product (`worker/migrations/0001_init.sql:122-134`, plus
`0006_hardening.sql:21` `artifact_policy_json`, plus `0007_backend_contracts.sql:144-145`
`metadata_access`/`artifacts_access`):

| column                                      | meaning / writer                                                                                                                |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `product` PK → `products(slug)`             |                                                                                                                                 |
| `gh_owner`, `gh_repo`, `gh_installation_id` | the ONE linked repo (from the URL pasted at link time, `linkRepo.ts:402-406`)                                                   |
| `channel_workflow`                          | Actions workflow file/id used to resolve `beta`/`pr-N`                                                                          |
| `beta_branch` DEFAULT `'main'`              | branch whose successful workflow runs define `beta`                                                                             |
| `manual_channels_json`                      | `[{name, regex}]` from `.pkey/release manualChannels`                                                                           |
| `binary_name`                               | asset-name stem; defaults to repo name (`linkRepo.ts:267`)                                                                      |
| `install_template`                          | custom `install.sh` template — **no writer anywhere**; `stmtInsertReleaseConfig` hard-codes `NULL` (`worker/src/repo.ts` ~L597) |
| `sparkle_ed25519_pub`                       | Sparkle EdDSA public key (base64, 32 raw bytes)                                                                                 |
| `summary_marker` DEFAULT `'pkey:summary'`   | changelog summary fence token                                                                                                   |
| `artifact_policy_json`                      | nominally "operator-owned" (`config.ts:89-96`, `feed.ts:119-125`) but see §7 — resync overwrites it wholesale                   |
| `metadata_access`, `artifacts_access`       | `public`/`authenticated`/`licensed`/`entitled` (validated in code, no CHECK)                                                    |

TS shape: `ReleaseConfigRow` (`worker/src/services/release/config.ts:16-31`); `ResolvedConfig`
(`config.ts:34-38`) is the same row with `gh_owner`, `gh_repo`, `gh_installation_id` non-null
(`isResolved`, `config.ts:40-42`).

**The truth store** (`0007_backend_contracts.sql:46-141`; writer `release/store.ts`; populated only by
resync/link, `sync.ts:73-116`):

- `release_metadata` (`0007:46-63`): `(product, release_id)` PK; `version`, `title`, `notes`,
  `commit_sha` (always NULL), `source_url` (GitHub `html_url`), `metadata_access`, `artifacts_access`
  (CHECK `public|authenticated|licensed` — `entitled` is stored as `licensed`, `store.ts:167-169`),
  `published_at`, `metadata_json` (`{tag, prerelease, assetCount}`, `store.ts:361-365`),
  `created_at`, `modified_at`. **`UNIQUE INDEX idx_release_metadata_version ON (product, version)`**
  (`0007:64-65`). `release_id` = the GitHub tag name (`store.ts:348`); `version` =
  `versionFromTag(tag)` = tag minus ONE leading `v` (`channels.ts:168-169`).
- `release_artifacts` (`0007:69-93`): PK `(product, release_id, artifact_id)`; `name`, `kind`,
  `platform`, `arch`, `content_type`, `size_bytes`, `sha256` (**always NULL**, `store.ts:452`),
  `source_url` (GitHub `browser_download_url`), `storage_key` (**always NULL**, `store.ts:456` — the
  reserved R2-mirror slot), `sparkle_signature` (**always NULL**, `store.ts:457`), `access` (CHECK
  `public|authenticated|licensed`), `metadata_json` (**always NULL**), `created_at`. Indexes on
  `(product, name)` and `(product, platform, arch)`.
- `release_channels` (`0007:95-104`): PK `(product, channel)`; `release_id` FK; `policy_json`
  (**always NULL, never read**, `store.ts:407`).
- `release_health` (`0007:106-118`): `subject_kind IN ('release','channel','artifact')`,
  `status IN ('unknown','healthy','degraded','blocked')` — `artifact` subject and `blocked` status are
  **never written**.
- `release_download_tokens` (`0007:120-141`, rebuilt in `0016_drop_dead_pii.sql:16-50`): portal
  single-use download tokens, FKs into metadata/artifacts; has a `device_id` column.

Upserts only, **nothing is ever DELETEd** (`store.ts:23-31`) because `release_download_tokens` FKs
would break. Stale rows for withdrawn releases/replaced assets persist forever.

**License-side channel/version policy** (`0002_channels.sql:6-11`): `licenses.channels_json`,
`licenses.min_version`, `licenses.max_version`, `tiers.channels_json`, `tiers.min_version`,
`tiers.max_version`; plus `products.compat_min`/`compat_max` (the product-global window).

### 1.2 Artifact classification (truth store only)

`store.ts:172-181` — `artifactKind(name)`, first match wins, on the lower-cased filename:

```ts
if (lower.endsWith(".sig")) return "signature";
if (lower.endsWith(".sha256")) return "checksum";
if (lower.endsWith(".dmg")) return "dmg";
if (lower.endsWith(".pkg")) return "pkg";
if (lower.endsWith(".zip") || lower.endsWith(".tar.gz")) return "archive";
if (/\.[a-z0-9]+$/.test(lower)) return "other";
return "cli";
```

So the complete kind vocabulary is `signature | checksum | dmg | pkg | archive | other | cli`.
Consequences: `.exe`, `.msi`, `.msix`, `.appx`, `.appinstaller`, `.apk`, `.aab`, `.ipa`, `.AppImage`,
`.zsync`, `.deb`, `.rpm`, `.flatpak`, `.tar.xz`, `.7z`, `.pck`, `.wasm`, `.json`, `.xml`, `.nupkg`,
`.minisig` → all `other`. Any extension-less file (`SHA256SUMS`, `LICENSE`, `RELEASES` — Velopack's
legacy feed file) → `cli`.

`store.ts:183-190` — `artifactPlatform(kind, name)`:

```ts
if (kind === "dmg" || kind === "pkg") return "macos";
if (lower.includes("darwin") || lower.includes("macos")) return "macos";
if (lower.includes("linux")) return "linux";
if (lower.includes("windows") || lower.endsWith(".exe")) return "windows";
return null;
```

Vocabulary: `macos | linux | windows | null`. No `ios`, `android`, `web`, `any`. Substring matching
(so `mygame-macos-universal.zip` → macos; `.apk` → null; `win64`/`win` → null unless `.exe`).

`store.ts:193-197` — content type recorded: `dmg` → `application/x-apple-diskimage`, everything else
`application/octet-stream`.

`arch` = `archOf(name)` (`assets.ts:83-88`) — the SAME matcher the download route uses:

```ts
export type Arch = "arm64" | "x86_64"; // assets.ts:14
const ARCH_TOKENS: Record<Arch, Set<string>> = {
  // assets.ts:17-20
  arm64: new Set(["arm64", "aarch64"]),
  x86_64: new Set(["x86_64", "amd64", "x64"]),
};
```

`archMatches` (`assets.ts:66-75`) requires a wanted token AND no other-arch token, after tokenizing on
non-alphanumerics (with `x86`+`64` re-joined, `assets.ts:42-58`). Results: `universal`, `armv7`,
`armeabi-v7a`, `x86`, `i686`, `win32`, `win64`, `wasm32`, `riscv64` → `null`. A file naming BOTH
(`MyGame-arm64-x86_64.dmg`) → `null`. `arm64-v8a` tokenizes to `arm64`,`v8a` → `arm64` (accidentally
fine).

### 1.3 Channel model

`channels.ts:44-64` — `classifyChannel(selector, manualChannels)`:

```ts
if (!selector || selector === "latest")
  return { kind: "stable", raw: selector ?? "latest" };
if (selector === "stable") return { kind: "stable", raw: "stable" };
if (selector === "beta") return { kind: "beta", raw: "beta" };
const prMatch = selector.match(/^pr-(\d{1,7})$/); // → { kind: "pr", pr: N }
const manual = manualChannels.find((c) => c.name === selector); // → { kind: "manual" }
if (/^\d+\.\d+\.\d+/.test(selector)) return { kind: "stable", raw: selector }; // pinned
return null;
```

- `ChannelKind = "stable" | "beta" | "pr" | "manual"` (`channels.ts:22`).
- Pinned grammar: must START with `\d+.\d+.\d+` (not end-anchored → `1.2.3.4`, `1.2.3-rc.1`,
  `1.2.3foo` all "pinned"). `v1.2.3` is **not** accepted (returns `null` → 404) despite the OpenAPI
  saying it is (`openapi/polaris-key.v3.yaml` `downloadArtifact` version param: "a pinned `1.2.3` /
  `v1.2.3`"). Two-part `1.2` → `null`.
- `resolveChannel` (`channels.ts:130-160`): `newest()` walks the GitHub list in API order and skips
  drafts (`channels.ts:113-122`):
  - `stable`/`latest` → newest **non-prerelease** (GitHub's `prerelease` flag only; a `-beta.1` suffix
    is irrelevant) (`:138`).
  - pinned → tag `v<raw>` OR `<raw>` (`:141`) — BUT the live gateway does not use this path for pinned
    selectors: `resolveSelector` calls `resolveRelease` which only fetches
    `/releases/tags/v<version>` (`github.ts:127`). **Tags without a `v` prefix cannot be pinned**, and
    the stable appcast's enclosure URL is pinned (`feed.ts:206-208`), so a repo tagging `1.2.3` gets
    an appcast whose enclosure 404s.
  - `beta` → with channel tags from the workflow: newest release in that set; otherwise newest
    prerelease (`:146`).
  - `pr` → only via workflow; else `null` (`:150`).
  - `manual` → newest release whose tag matches `^(?:regex)$` (≤ 80 chars,
    `shared-manifest/src/index.ts` `compileManualChannelRegex`, `MANUAL_CHANNEL_REGEX_MAX = 80`).
- Channel workflow (`gateway.ts:364-413`): for `beta`, GETs workflow runs on `beta_branch` with
  `status=success`; for `pr-N`, GETs `/pulls/N` then runs by `head_sha`. The tag set it builds is
  `v${run.head_branch}` and `run.head_sha.slice(0,7)` (`gateway.ts:409-410`) — i.e. a beta/PR release
  must be tagged with the 7-char SHA (or literally `v<branchname>`). Adds `actions:read` +
  `pull_requests:read` to the token (`githubApp.ts` `CHANNEL_PERMISSIONS`).
- `isMovingSelector` (`channels.ts:67-73`): everything except a pinned version → `max-age=120`; pinned
  → `max-age=86400, immutable` (`gateway.ts:65-66`).
- Truth store records only `stable`, `beta`, and manual names (`store.ts:465-468`); `beta` in the store
  is always the prerelease fallback (no workflow call at sync, `store.ts:398-401`), so the console's
  "beta points at" can disagree with what the live route serves.
- `release_metadata.version` sort in portal/admin is lexical (`ORDER BY COALESCE(published_at,0) DESC,
version DESC`).

**Channel vocabulary mismatch with License:** the license build gate's channels are
`stable | staging | pr | dev` (`worker/src/core/gate.ts:51-61`, `normalizeChannel` `:82-88`) and a
`beta` header normalizes to `null` → `channel-not-entitled`. Release's are `stable | beta | pr-N |
<manual>`. The installer advertises `["staging", "beta"]` (`surfaces.ts:95`) but `staging` is not a
Release built-in (only works if a manual channel named `staging` exists).

**Tags/prereleases → channels:** only GitHub's `draft` and `prerelease` booleans matter, plus the tag
string (pinned lookup, manual regex, workflow SHA-tag). Non-semver tags are ingested verbatim (§5).

### 1.4 Version grammar

- Tag → version: strip one leading `v` (`channels.ts:168-169`). No build number anywhere.
- Semver comparator (`worker/src/core/entitlements.ts:31-73`): `^(\d+)\.(\d+)\.(\d+)(-pre)?(+build)?$`;
  **unparseable inputs compare equal** (`:48`), so `versionInWindow` never blocks a non-semver version
  (`:134-138`) — a 4-part `1.2.3.4`, a CalVer `2024.10`, or `channels` sail through every window.
- Manifest `compatMin`/`compatMax` must be strict semver (`SEMVER_RE`, `shared-manifest/src/index.ts`
  ~L288); admin `update/settings` PATCH same (`update/admin.ts:44`).
- Sparkle `sparkle:version` (the build number Sparkle actually compares) is set to the short version:
  `build: shortVersion` (`update/appcast.ts:156`).

### 1.5 Release config fields in the manifest

`ManifestRelease` (`shared-manifest/src/index.ts` ~L188-199): `ghOwner`, `ghRepo`, `binaryName`,
`channelWorkflow`, `betaBranch`, `summaryMarker`, `sparkleEd25519Pub`, `manualChannels[]`,
`artifactPolicy {channels[], architectures[], requireDmg, requireCli, allowAmbiguousAssets}` (L165-171;
`requireSparkleSignature` deliberately dropped, R6-03), `access {metadata, artifacts}` limited to
`public|authenticated|licensed` (`RELEASE_ACCESS_VALUES`, ~L388; `entitled` is admin-only).
Notes:

- `ghOwner`/`ghRepo`/`provider` are validated but **ignored at link time** — the coordinates come from
  the pasted URL (`linkRepo.ts:170, 402-406`); resync never rewrites them.
- `provider.type` must be `github` (`unsupported_release_provider`).
- `artifactPolicy.channels`, `.architectures`, `.allowAmbiguousAssets` are validated, persisted into
  `artifact_policy_json`, and **read by nothing**. Only `requireDmg`/`requireCli` are read (by
  `health.ts:65-95`), and `requireSparkleSignature`/`minimumSystemVersion` (operator fields) by
  `config.ts:97-120` / `feed.ts:126-139`.
- Schema/validator drift: the JSON schema bounds `artifactPolicy.architectures` items to `{0,31}` chars
  (`schemas/v1/release.schema.json`), the validator uses `CHANNEL_RE` `{0,63}`.
- Manual channel names allow `A-Z` and `.`/`_` (`CHANNEL_RE`), but `/update/<channel>/appcast.xml` and
  `?channel=` only accept `^[a-z0-9-]+$` (`update/routes.ts:20`, router `router.ts:181`) — a valid
  manifest channel like `Beta.2` is unreachable on the feed routes.

### 1.6 Access modes

`ReleaseAccess = "public" | "authenticated" | "licensed" | "entitled"`
(`shared-protocol/src/release.ts:7-11`). Parsed by `readAccessMode` (`config.ts:62-67`, garbage →
`public`). Which column governs which surface: `accessModeFor` (`config.ts:140-147`) — `version`,
`changelog`, `install` use **metadata**; `appcast`, `channelAppcast`, `cli`, `dmg` use **artifacts**.
Enforcement: `enforceReleaseAccess` (`access.ts:109-152`):

- `public` → nothing.
- `authenticated`/`licensed` → `usableLicensedDevice` (device token + usable licence) → flat 401
  `download_auth_required`. (The docs table in `services/release/artifacts.md` says `authenticated`
  does not need a usable licence — the code does require one.)
- `entitled` → `entitledAccessCheck` (`core/entitledAccess.ts:145-189`) → nested v3 401
  `unauthorized` / 403 `channel_not_allowed` / 403 `version_blocked` + top-level `allowedRange`.

### 1.7 The `entitled` eligibility check

`entitledSelectorFor` (`access.ts:85-103`) maps the request to `{channel, channelKind, version}`:
stable/latest/pinned → channel `"stable"`; `version` set ONLY for a pinned selector (`:101`).
`entitledAccessCheck`:

1. `usableLicensedDevice` (token + usable licence).
2. `resolveMergedPayload` + `injectAdminPolicy` (`core/entitlements.ts:166-215`) — the same merge the
   licence document does. Entitlements read:
   - **`channels`** (array) — union of `tiers.channels_json` ∪ `licenses.channels_json`, plus any
     profile/override-authored `channels`; absent ⇒ `["stable"]` (`entitledChannels`, `:109-113`).
   - **`app.minVersion`** / **`app.maxVersion`** — tighter of tier/licence, then intersected with
     `products.compat_min/compat_max` (`versionWindow`, `:119-131`).
3. `channelAllowed` (`entitledAccess.ts:126-135`): `stable`/`latest`/null always allowed; else channel
   in set, or `pr-N` allowed by `pr`.
4. Version window check only if `selector.version` (pinned) (`:179`).

**Gap:** moving selectors are never version-checked. A licence with `app.maxVersion: 1.9.9` fetching
`/update/appcast.xml` is offered 2.0.0; the stable enclosure is pinned (`/release/dl/2.0.0/...`), so
the subsequent download then 403s `version_blocked`. The feed offers what the download refuses.

---

## 2. Every route and what it emits

Router: `worker/src/router.ts` — service namespaces `license|config|release|update|identity`
(`:41-47`); four permanent aliases rewritten to canonical segments (`:157-163`, `:181-183`).

### Release (`release/routes.ts`)

| Route                                                    | Kind                       | Emits                                                                                                                                                                  |
| -------------------------------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /<p>/release/changelog`                             | `changelog` (metadata)     | `{entries:[{version, tag, date, summary, url}]}` from up to 50 non-draft releases, live GitHub list (`surfaces.ts:112-140`); `max-age=300`; edge-cacheable when public |
| `GET /<p>/release/install.sh` (+alias `/<p>/install.sh`) | `install` (metadata)       | POSIX shell (`install.ts:243-376`), no GitHub call; `max-age=300`; **not** edge-cached (`CACHEABLE_KINDS` excludes it, `gateway.ts:101-106`)                           |
| `GET /<p>/release/dl/<version>/<binary>-<arch>[.dmg]`    | `cli` or `dmg` (artifacts) | streamed asset bytes; `?checksum=sha256` → bare hex digest                                                                                                             |

**Download-route matching rules** (`routes.ts:39-51`, `surfaces.ts:142-203`):

- Exactly 3 segments; leaf ending `.dmg` → `dmg`, else `cli`. The leaf (minus `.dmg`) must match
  `ARCH_SUFFIX = /^(?:[^/]+)-(arm64|aarch64|x86_64|amd64)$/` (`routes.ts:23`) or the route returns
  `null` (404). So `x64`, `universal`, `_aarch64`, and any other extension (`.zip`, `.exe`, `.apk`,
  `.pck`, …) are **unroutable**.
- The leaf's stem is **only used to extract the arch**; the asset is re-selected by fuzzy matching:
  - `cli`: exact `<binaryName>-<arch>` (or `<binaryName>-<channelSuffix>-<arch>`) first, else
    `matchAsset(ext: "")` — i.e. only **extension-less** assets (`assets.ts:164-174`).
  - `dmg`: `matchAsset(ext: "dmg")` (`surfaces.ts:165-170`).
  - `matchAsset` (`assets.ts:107-147`): pool = right ext AND right arch; 1 → it; >1 → score +2 binary
    name token, +2 channel-suffix tokens (or +1 if no `staging`/`pr` token when no channel); tie → null
    (404). `artifactPolicy.allowAmbiguousAssets` is never consulted.
- Content type forced: `application/x-apple-diskimage` for dmg, `application/octet-stream` otherwise
  (`surfaces.ts:190-194`, `gateway.ts:64`); `Content-Disposition: attachment; filename="<sanitized>"`
  (`github.ts:239-242`); `nosniff`.
- Cache header: pinned `public, max-age=86400, immutable`, moving `public, max-age=120` (if upstream
  gave none) (`surfaces.ts:199-201`).
- Consequence for the appcast: its enclosure URL uses the asset's real name as the leaf
  (`feed.ts:208`). If the DMG's name doesn't END in `-<arm64|aarch64|x86_64|amd64>` (e.g.
  `djdl_aarch64.dmg`, `MyGame-x64.dmg`, `MyGame-arm64-1.2.3.dmg`), the matcher happily selects it for
  the feed, but the enclosure URL 404s at the router.

**Checksum sidecars** (`surfaces.ts:178-180, 205-235`): `<asset>.sha256` exact-name sibling; read
through `fetchTextAsset` capped at 4 KiB (`github.ts:343`); first whitespace token must be 64 hex;
served `text/plain` lowercase + `\n`. Only reachable for assets the `cli`/`dmg` route can select.
No SHA256SUMS / multi-file manifest support; the truth store never records `sha256`.

**install.sh** (`install.ts`): template placeholders `{{binaryName}} {{origin}} {{cliBase}}
{{installPath}} {{versionEnv}} {{channels}}` (`:222-234`) — but no writer for `install_template`. Default
script: `uname -m` → `arm64|aarch64 → arm64`, `x86_64|amd64 → x86_64`, else exit ("ships builds for
arm64 and x86_64 macs only", `:147-153`); `uname -s` must be `Darwin` ("is a macOS tool", `:156-160`);
downloads `$ORIGIN$CLI_BASE/$VERSION/<binary>-$ARCH` (`:162`); requires the `.sha256` (fail closed);
installs to `/usr/local/bin` or `~/.local/bin`; channel names `staging|beta|pr-N` get suffixed
install names (`:136-141`).

### Update (`update/routes.ts`, `update/feed.ts`)

| Route                                                                                  | Kind (access col)            | Emits                                                     |
| -------------------------------------------------------------------------------------- | ---------------------------- | --------------------------------------------------------- |
| `GET /<p>/update/appcast.xml[?arch=]` (+ alias `/<p>/appcast.xml`)                     | `appcast` (artifacts)        | Sparkle RSS, channel forced to `stable` (`feed.ts:84-89`) |
| `GET /<p>/update/<channel>/appcast.xml[?arch=]` (+ alias `/<p>/<channel>/appcast.xml`) | `channelAppcast` (artifacts) | Sparkle RSS for `<channel>` (`^[a-z0-9-]+$`)              |
| `GET /<p>/update/version[?channel=]` (+ alias `/<p>/version`)                          | `version` (metadata)         | `{version, tag, url}`                                     |

**`/version` JSON** (`feed.ts:93-116`): exactly `{ "version": versionFromTag(tag), "tag": tag,
"url": release.html_url }`, `cache-control` per selector (`max-age=120` moving). No artifacts, no
platform, no arch (`?arch=` ignored — `updateParams` returns only `{channel}` for `version`,
`eligibility.ts:45-50`), no build number, no min-supported, no critical flag, no notes, no size/hash.
`?channel=` limited to `[a-z0-9-]` — a pinned `1.2.3` (has dots) cannot be requested even though the
OpenAPI description lists "a pinned X.Y.Z". Not typed in `@polaris-key/protocol` (only in OpenAPI
`components/schemas/VersionCheck` and each SDK: `sdk-node/src/update/client.ts:20-26`, Python, Swift,
React `useLatestVersion`).

**Sparkle appcast details** (`feed.ts:141-229`, `update/appcast.ts`):

- Arch: `?arch=` normalized to `arm64|x86_64`, unknown → default `arm64` (`feed.ts:45, 55-58`);
  discovery advertises `archParameter: ["arm64","x86_64"]` (`update/index.ts:58`).
- Asset: `matchAsset(ext: "dmg", arch, binaryName, channelSuffix)` (`feed.ts:158-164`) — DMG only.
- Signature: requires `sparkle_ed25519_pub` when `requireSparkleSignature` (default true) else 404
  (`feed.ts:170-172`); requires sibling `<dmg>.sig` (`sigAssetName`, `assets.ts:184-186`) when a key is
  set or required (`feed.ts:174-177`); **server verifies** the sidecar's Ed25519 signature over the
  DMG's full bytes (`sparkle.ts:75-129`) and 404s the whole feed on failure (`feed.ts:200`). **PKey
  never computes the signature — it reads it from the repo-uploaded `.sig` sidecar and verifies it.**
  Verification buffers the whole DMG (`fetchAssetBytes` → `res.arrayBuffer()`, `github.ts:424`) with
  `MAX_VERIFY_BYTES = 256 MiB` (`sparkle.ts:24`) inside a 128 MB isolate; positive verdicts cached in KV
  `HOT` for 1 day (`sparkle.ts:22, 87, 123-127`).
- Item: exactly ONE `<item>` (`feed.ts:220`): `<title>` = `<binary> <version>`; `<pubDate>` RFC-1123
  (epoch if null); `<sparkle:version>` = `<sparkle:shortVersionString>` = tag-minus-v
  (`appcast.ts:110-111, 156`); optional `<sparkle:minimumSystemVersion>` from
  `artifact_policy_json.minimumSystemVersion` (`^\d+(\.\d+){0,2}$`, `feed.ts:126-139`); optional CDATA
  `<description>` = escaped curated summary with `]]>` neutralized (`appcast.ts:76-92`);
  `<enclosure url type="application/octet-stream" length [sparkle:edSignature]>` (`appcast.ts:112`).
- Enclosure URL: stable → `/<p>/release/dl/<version>/<dmg.name>` (immutable); moving →
  `/<p>/release/dl/<channel>/<dmg.name>` (`feed.ts:206-208`).
- Channel `<title>`: `<binary>` or `<binary> (<channel>)`.
- **Not emitted:** `sparkle:channel` (channels are separate feed URLs instead), `sparkle:phasedRolloutInterval`,
  `sparkle:criticalUpdate`, `sparkle:informationalUpdate`, `sparkle:deltas`,
  `sparkle:minimumAutoupdateVersion`, `sparkle:ignoreSkippedUpgradesBelowVersion`,
  `sparkle:maximumSystemVersion`, `sparkle:hardwareRequirements`, `sparkle:releaseNotesLink`,
  `sparkle:fullReleaseNotesLink`, `sparkle:os` (WinSparkle), `sparkle:installerArguments`
  (WinSparkle), DSA signatures, multiple historical items. `APPCAST_CACHE = public, max-age=300`
  (`gateway.ts:67`).

**Admin routes** (behind `/manage/api/products/<slug>/…`):

- `release/health` GET (`release/admin.ts:36-40`) → `checkReleaseHealth` (`health.ts`), which checks:
  config fields, Sparkle key, GitHub access, latest release, **`dmg-arm64` (unconditionally
  `missing` if absent, `health.ts:247-257`)**, `dmg-x86_64`, Sparkle `.sig`, `cli-arm64`/`cli-x86_64`.
  Its own local `artifactPolicy` defaults `requireDmg: true` (`health.ts:65-95`). A non-macOS product is
  permanently `needs-setup`.
- `release/releases` GET (`release/admin.ts:42-79`) → truth-store view (releases, artifacts with
  kind/platform/arch/size/access, channel map).
- `release/resync` POST (`release/admin.ts:81+`).
- `update/settings` GET/PATCH (`update/admin.ts`) → metadata/artifacts access + `compatMin`/`compatMax`.

**Discovery** (`/.well-known/polaris.json`): release fragment `{enabled, configured, binaryName,
repository, endpoints:{changelog, install, download}}` (`release/index.ts:39-55`); update fragment
`{enabled, configured, channels:["stable","beta",…manual], sparkleEd25519PublicKey, endpoints:{version,
appcast, channelAppcast}, archParameter}` (`update/index.ts:39-60`).

---

## 3. Hard-coded assumptions that block non-macOS / Godot

Quoted, with what each blocks.

1. **Two arches, closed union** — `export type Arch = "arm64" | "x86_64";` (`release/assets.ts:14`),
   `ReleaseParams.arch?: "arm64" | "x86_64"` (`release/access.ts:58`), `UpdateArch = "arm64" | "x86_64"`
   (`shared-protocol/src/update.ts`), router `ARCH_SUFFIX` (`release/routes.ts:23`), OpenAPI asset
   pattern `^.+-(arm64|aarch64|x86_64|amd64)(\.dmg)?$`, discovery `archParameter`. Blocks: Android
   `armeabi-v7a`/`x86`, Windows `x86`/`arm64ec`, Web `wasm32`, **macOS universal** (Godot's default
   macOS export is a universal binary → never matches `archMatches`, so neither the DMG route nor the
   appcast can serve it; only workaround is uploading the same DMG twice as `-arm64.dmg` and
   `-x86_64.dmg` with two `.sig` sidecars), "any"/arch-independent artifacts (`.pck`, web zip, AAB,
   universal APK, IPA).
2. **Only two servable shapes: extension-less binary or `.dmg`** — `const dmg = leaf.endsWith(".dmg");`
   (`routes.ts:42`); `findBinaryAsset … matchAsset(assets, { arch, ext: "", … })` (`assets.ts:173`);
   `ext: "dmg"` (`surfaces.ts:167`, `feed.ts:160`). Blocks `.exe`, `.msi`, `.msix`, `.zip` (portable
   Windows, macOS zip, web build), `.tar.gz`, `.AppImage`, `.zsync`, `.deb`, `.apk`, `.aab`, `.ipa`,
   `.pck`, `.json`/`.xml` feed files. Even a Linux CLI named `mygame-linux-x86_64` works only because
   it has no extension.
3. **One artifact per (release, arch, ext)** — the whole matcher is "pick exactly one DMG / one binary
   for this arch"; a tie is a 404 (`assets.ts:133-146`). Blocks installer-vs-portable, apk-vs-aab,
   sideload-ipa-vs-store-ipa, per-texture-format packs, debug/release builds, Steam-vs-DRM-free.
4. **Platform vocabulary** — `artifactPlatform` only returns `macos|linux|windows|null`
   (`store.ts:183-190`); `dmg`/`pkg` → macos by fiat. No iOS/Android/Web.
5. **Content type** — `kind === "dmg" ? "application/x-apple-diskimage" : "application/octet-stream"`
   (`store.ts:193-197`, `surfaces.ts:190-194`). No `application/vnd.android.package-archive`,
   `application/msix`, `application/appinstaller`, `application/wasm`, `application/json`. Forced
   `Content-Disposition: attachment` (`github.ts:239-242`) — breaks anything that must be rendered or
   fetched inline (web export, `.appinstaller` opened by App Installer, `itms-services` plist).
6. **Sparkle is macOS/DMG-only** — `matchAsset(... ext: "dmg")` in the feed (`feed.ts:158-164`),
   `DEFAULT_APPCAST_ARCH = "arm64"` (`feed.ts:45`), `sparkle:minimumSystemVersion` "minimum macOS
   version" (`feed.ts:119`), `sigAssetName(dmgName)` (`assets.ts:184`). WinSparkle appcasts need
   `sparkle:os="windows"` + an `.exe`/`.msi` enclosure — impossible today.
7. **Health is macOS-centric** — `"macOS arm64 DMG"` missing ⇒ `needs-setup` (`health.ts:247-257`),
   `requireDmg: true` default (`health.ts:72, 90`).
8. **install.sh is Darwin-only** — `if [ "$OS" != "Darwin" ]; then echo "… is a macOS tool …"`
   (`install.ts:157-160`); "ships builds for arm64 and x86_64 macs only" (`install.ts:151`). No
   Windows PowerShell installer, no Linux path.
9. **Single binary name per product** — `cfg.binary_name ?? product.slug` everywhere
   (`surfaces.ts:89, 152`, `feed.ts:146`); a Godot game shipping `MyGame.exe`, `MyGame.x86_64`,
   `MyGame.app`, `mygame.apk`, `mygame.pck`, `index.pck` has no single stem; the scoring (+2 for binary
   token) assumes one.
10. **Channel-suffix naming convention** — non-stable assets must carry `-<channel>` tokens
    (`gateway.ts:416-420`, `assets.ts:122-129`), and stable prefers assets WITHOUT `staging`/`pr`
    tokens. Godot export presets don't name this way by default.
11. **Version = tag** — `sparkle:version` = `shortVersionString` = tag-minus-`v` (`appcast.ts:152-157`).
    Blocks iOS `CFBundleVersion`, Android `versionCode`, MSIX 4-part `Major.Minor.Build.Revision`,
    Velopack semver2 with build metadata.
12. **Pinned lookup forces `v` prefix** — `` `${base}/tags/v${encodeURIComponent(version)}` ``
    (`github.ts:127`).
13. **Semver-start pinned grammar** — `/^\d+\.\d+\.\d+/` (`channels.ts:61`).
14. **100-release window, no pagination** — `releases?per_page=${perPage}` with 100 (`github.ts:144`,
    `gateway.ts:346-352`, `sync.ts:82-88`). A game repo with frequent nightlies/pack releases can push
    the last stable release off page 1 → `latest` 404s, and older releases never reach the store.
15. **CORS absent everywhere** — no `Access-Control-*` header in the worker (grep finds none), no
    OPTIONS handling; `harden()` adds `CSP default-src 'self'`, `X-Frame-Options: DENY`,
    `Referrer-Policy: no-referrer` to every release response (`gateway.ts:149-152`,
    `securityHeaders.ts:23-74`). See §4.
16. **Per-product manual channel names are URL-lowercase only on Update** (`update/routes.ts:20`).

---

## 4. Byte-hosting model

**Origin = GitHub Releases, streamed through the Worker.** No R2 binding, no artifact KV, no Cache API
for artifacts (`wrangler.toml` binds only `DB` (D1), `HOT` (KV), `RL` (DO), `ASSETS`, `EMAIL`).

`streamAsset` (`github.ts:182-245`):

1. `GET api.github.com/repos/<o>/<r>/releases/assets/<id>` with `Accept: application/octet-stream`,
   installation token, `redirect: "manual"`, passing `Range` and `If-None-Match` (`:191-198`).
2. On 3xx, parse `Location`; host must satisfy `isAllowedStorageHost` (`worker/src/http.ts:64-70`:
   `github.com`, `githubusercontent.com`, `*.githubusercontent.com`); re-fetch the signed URL with only
   `Range`/`If-None-Match` and **default redirect-follow** (`:210`) — a known R6-08 residual (further
   hops unguarded; a relative `Location` throws a TypeError → 500, pinned by
   `test/attack/R6-release.test.ts:1218-1300`).
3. 401/403/404 → `NotFoundError` (404); quota 429/403 → `UpstreamRateLimitedError` → 503 +
   `Retry-After` (`gateway.ts:271-285`).
4. Response headers: allowlist `Content-Length`, `Content-Range`, `Accept-Ranges`, `ETag`,
   `Last-Modified` (`:228-237`) + forced type/disposition/nosniff; status 200/206/304 passed through.

**Size/time for ~100 MB+ files:**

- Streaming is a pure pipe (`new Response(upstream.body)`), so memory is fine and Workers impose no
  wall-clock limit while the client is connected. 2 GB GitHub assets are explicitly anticipated
  (`gateway.ts:83-88`).
- **Quota is the real ceiling.** Every download MISS costs installation-quota API calls: pinned =
  `/releases/tags/v…` + `/releases/assets/<id>` = 2; `latest`/manual = list + asset = 2; `beta`/`pr`
  with workflow = +1–2. Tokens are cached in KV (sealed) so minting is amortized. The installation quota
  (nominally 5,000/h, shared by every product on that installation — `gateway.ts:15-18`) therefore
  caps an installation at roughly **2,000–2,500 downloads/hour across all products**. A game patch day,
  or **Range-heavy clients** (resumable downloaders, parallel chunked downloads, AppImage `zsync`,
  MSIX App Installer/BITS) multiply this, because **every Range request re-resolves the release and
  re-hits the asset API**. Exhaustion 503s every download _and_ every appcast for every product on that
  installation.
- Per-IP limiter: artifacts 120/min, metadata 30/min (`gateway.ts:89-90`) — parallel chunk downloaders
  or zsync behind NAT can trip it.
- **Sparkle verification buffers the whole DMG** (`github.ts:411-429`) with a 256 MiB cap in a 128 MB
  isolate (`sparkle.ts:24`). A 100 MB+ game DMG risks isolate OOM on first verify and again after each
  24 h KV TTL; the OOM is not a catchable `NotFoundError`, so the appcast would 500/crash rather than
  fail closed cleanly. It also downloads the full DMG from GitHub once per day per (asset, sig, key).
- `fetchTextAsset` sidecars capped at 4 KiB (`github.ts:343`) — fine for `.sig`/`.sha256`; too small
  for relaying a Velopack `releases.json`, an F-Droid index, or an AltStore source with many versions.

**Caching:**

- Edge Cache API (`caches.default`) only for `appcast`, `channelAppcast`, `version`, `changelog` and
  only when the effective access mode is `public` (`gateway.ts:101-106, 192-203, 249-253`); key is
  synthesized `(product, kind, version, channel, arch)` (`gateway.ts:128-141`).
- Artifacts: never cached by PKey (`gateway.ts:92-100`); `Cache-Control` headers (pinned `immutable`)
  let browsers/downstream caches reuse bytes, and GitHub's storage host is CDN-fronted, but each client
  request still transits the Worker and the API.
- Non-public modes: nothing cached at all.

**CORS / a Godot Web build fetching packs cross-origin:** would **not** work.

- No `Access-Control-Allow-Origin` on any response; no preflight handling (an `Authorization: Bearer`
  header for non-public modes forces a preflight that the router 404s).
- Godot 4 web exports with threads need cross-origin isolation (COOP/COEP); a cross-origin `.pck` then
  also needs `Cross-Origin-Resource-Policy: cross-origin` or CORS — neither is sent.
- Hosting the web export itself on `key.plrs.im` is off the table by design: same origin as the admin
  console + portal (R1-09 threat model), CSP `default-src 'self'` with no `wasm-unsafe-eval`,
  `X-Frame-Options: DENY` (breaks itch.io-style iframe embedding), forced `attachment` disposition and
  `application/octet-stream` (a `.wasm` must be `application/wasm` for streaming compile). Web builds
  need a separate origin (Pages/R2 custom domain/separate Worker); PKey can at most hold the "current
  build" pointer and serve a CORS-enabled manifest.

**Portal byte path (humans):** `/api/releases/<p>/<rid>/artifacts/<aid>/token` mints a single-use
token → `/download/<token>` → **302 to the stored `browser_download_url`**, host-allowlisted
(`identity/portal/api.ts:296-311, 815-870`). For a **private** repo that URL requires GitHub auth, so
portal downloads effectively only work for public repos (the device-facing `/release/dl` route streams
with the installation token and does work for private repos).

---

## 5. GitHub sync

**Link** (`release/linkRepo.ts:157-243, 246-486`): parse URL → discover installation → repo-scoped
read-only token → read `.pkey/{schema,product,release}.{json,yaml,yml}` (`manifestFiles.ts`) →
`parseManifest` → one `db.batch` (product, schema, key, tiers, profiles, provisioning, oidc,
`release_config`, edge-mint) → `syncReleaseStore` best-effort (`linkRepo.ts:466`).

**Webhook** (`worker/src/githubWebhook.ts`): HMAC verify → delivery-GUID replay guard (7 days, KV) →
**only `x-github-event: push`** (`:155-157`; everything else answered `{ok:true, ignored:<event>}`) →
only `refs/heads/*` (`:171`) → only if a changed path is `.pkey` or under it (`:182`) → for each product
linked to that `owner/repo` (`listProductsByGithubRepo`, `:193`) with matching installation id →
`resyncRepo`.

**Consequence: `release` events (published/edited/deleted/prereleased) are ignored.** The truth store
(portal Downloads, console Releases, `release_channels`, `release_health`) is refreshed only by a
`.pkey/` push, the console "Resync" button, or link. A newly published game build or pack does not
appear in the portal until someone touches `.pkey/`. (Live device routes are unaffected — they call
GitHub per request.)

**Resync** (`release/resync.ts:77-429`): no `ref` (default branch only, R6-05); several un-batched
`db.run` writes first (products, fingerprint, auto-issue, services, schema, `release_config` UPDATE at
`:277-292`), then ONE batch of manifest-owned rows + truth-store statements (`:402-426`). Two sharp
edges:

- The `release_config` UPDATE sets `artifact_policy_json = rel.artifactPolicy ? JSON.stringify(…) :
null` (`:280, 288`) — it **overwrites** the "operator-owned" `requireSparkleSignature` and
  `minimumSystemVersion` on every resync with a release doc (there is no admin endpoint that writes
  `artifact_policy_json`, so "operator-owned" today means "set by hand in D1, then lost at next push").
- The truth store rides in the same batch; if any statement fails the whole batch rolls back after the
  un-batched writes already applied. One concrete trigger: `idx_release_metadata_version` is UNIQUE on
  `(product, version)` and the upsert's `ON CONFLICT(product, release_id)` does not cover it — two tags
  that strip to the same version (`v1.2.0` and `1.2.0`; `v-packs` vs `-packs`) raise `UNIQUE constraint
failed` (verified with SQLite in a scratch script), failing the resync mid-way.

**Truth-store ingestion** (`release/store.ts:330-427`, one `listReleases(100)` per sync, `sync.ts:73-95`,
errors swallowed → `[]`): drafts filtered (`:341`); per release → metadata row; per asset → artifact
row (kind/platform/arch/content_type/size/source_url); health row `healthy` iff assetCount>0; channel
rows for `stable`, `beta`, manual names.

**Drafts**: skipped in resolution (`channels.ts:118`), store (`store.ts:341`), changelog
(`surfaces.ts:128`), health (`health.ts:61-63`).

**Multiple repos per product: not supported.** `release_config` has one `(gh_owner, gh_repo,
gh_installation_id)` per product (PK = product). The mapping is 1 repo → N products, never 1 product →
N repos. A separate content-pack repo would have to be a separate product (own slug, signing key,
licences — which breaks "licence for the game unlocks its packs") unless a new sources table is added.

**Non-semver tags (`channels` rolling release, immutable `packs` release):**

- Ingested verbatim: `release_id = "channels"`, `version = "channels"` (only a leading `v` is stripped
  — `v-packs` would become `-packs`). Assets indexed as kind `other` (`.json`, `.xml`, `.pck`) or `cli`
  (extension-less `RELEASES`), platform mostly `null`, arch mostly `null`.
- **They poison moving selectors.** `stable`/`latest` = newest non-draft, non-prerelease release in API
  order (`channels.ts:138`). If `channels`/`packs` is not flagged prerelease and is newer (by GitHub's
  creation order) than the last game release — e.g. CI does `gh release delete channels && gh release
create channels` — then `/update/version` answers `{"version":"channels","tag":"channels",…}`, the
  appcast 404s (no DMG in it), `/release/dl/latest/...` 404s. If flagged prerelease, it hijacks `beta`
  (prerelease fallback when no `channel_workflow`). `gh release upload --clobber` keeps the original
  `created_at`, so a rolling release created long ago stays buried — fragile either way. There is no
  tag filter / "stable tag pattern" / ignore list.
- Pinned selector: `channels`/`packs` don't match `^\d+\.\d+\.\d+`, so they're reachable only if a
  manual channel with that name exists (`{name:"packs", regex:"packs"}`), and then only through routes
  that can't serve `.pck`/`.json` anyway.
- Version windows: `compareSemver("channels", x) === 0` → always "in window".
- Rolling re-uploads: each re-uploaded asset gets a new asset id → a NEW `release_artifacts` row; the
  old row is never deleted and still points at the same `browser_download_url` (URL is by tag+name, so
  it now serves the new bytes with a stale `size_bytes`). The portal lists every historical copy.

---

## 6. Extension points

### 6.1 Where things slot in

| Need                                                                                                                                                    | Slot                                                                                                                                                                                                          | Notes                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| New platforms / kinds / content types                                                                                                                   | `release/store.ts:172-197` (`artifactKind`, `artifactPlatform`, `artifactContentType`)                                                                                                                        | Private functions; `kind`/`platform`/`arch` are free TEXT (no CHECK) → no migration. Better: replace name-sniffing with a **manifest-declared artifact map** (rule 5: products are data) — e.g. `release.artifacts: [{id, platform, arch, kind, format, match: <glob/regex>, feeds:[…]}]`.                                                 |
| New arches                                                                                                                                              | `release/assets.ts:14-20` (`Arch`, `ARCH_TOKENS`), `access.ts:58`, `routes.ts:23`, `shared-protocol/src/update.ts`, `update/index.ts:58`, OpenAPI `Arch` param + asset pattern, SDKs that mirror `UpdateArch` | `universal`/`any` need "matches every arch" semantics in `archMatches`.                                                                                                                                                                                                                                                                    |
| Generic download route                                                                                                                                  | `release/routes.ts` + `surfaces.ts` + `ReleaseKind`/`ReleaseSurfaceKind` + `gateway.ts:220` (artifact rate-lane `isArtifact = kind === "cli" \|\| kind === "dmg"`) + `CACHEABLE_KINDS` + `accessModeFor`      | e.g. `/<p>/release/a/<selector>/<artifactId>` (manifest artifact id) or `/<p>/release/f/<selector>/<exactAssetName>`. OpenAPI path + `routeCoverage.test.ts:63-78` `SERVICE_PATHS` entry (rule 10).                                                                                                                                        |
| New feed renderers (AltStore source, F-Droid index, WinSparkle appcast, Velopack feed, `.appinstaller`, zsync pointer, generic multi-platform manifest) | New files in `services/update/` + routes in `update/routes.ts`; each calls `serveReleaseSurface(…, compute)`                                                                                                  | The gateway is explicitly callback-based for this (`gateway.ts:20-23`): access enforcement, rate limiting, edge cache, 404/503 mapping are free. Extend `UpdateSurfaceKind` (`feed.ts`) and `ReleaseKind` (`config.ts:130-137`).                                                                                                           |
| Content-pack catalog                                                                                                                                    | Either a new feed in Update over new Release tables, or a new service slug                                                                                                                                    | A new slug touches `router.ts:41-47`, `mount.ts`, `core/services.ts` (`ServiceSlug`, validation like `update_requires_release`), manifest `MODULE_SERVICES`, discovery, and `boundaries.test.ts:57-59` (it could NOT import `release` without a second sanctioned edge). Keeping packs inside Release (truth) + Update (feed) avoids that. |
| Byte-host alternatives                                                                                                                                  | `release_artifacts.storage_key` (reserved, always NULL), `portal/api.ts:294` comment anticipates "an R2 mirror"                                                                                               | Needs an R2 binding per env in `wrangler.toml` + `Env` type; mirror work belongs in a cron/Queue, not in the webhook request. `redirectableSourceUrl`/`isAllowedStorageHost` must learn the R2 public host (R6-12).                                                                                                                        |
| Release-event sync                                                                                                                                      | `githubWebhook.ts:155`                                                                                                                                                                                        | Handle `release` events → `syncReleaseStore` (no manifest re-read; idempotent upserts; harmless on replay). GitHub App must subscribe to Release events.                                                                                                                                                                                   |
| Per-channel policy (rollout %, min supported, critical, per-platform availability)                                                                      | `release_channels.policy_json` (exists, always NULL, never read)                                                                                                                                              | But channel rows are rewritten by every sync with `policy_json = NULL` (`store.ts:404-408`, upsert sets `policy_json = excluded.policy_json`) — policy must be preserved or moved to its own table.                                                                                                                                        |
| Yank / blocked                                                                                                                                          | `release_health.status = 'blocked'` (CHECK allows, never written)                                                                                                                                             | Needs a writer (admin or manifest) and resolution that skips blocked releases.                                                                                                                                                                                                                                                             |
| Checksums / signatures in store                                                                                                                         | `release_artifacts.sha256`, `.sparkle_signature`, `.metadata_json` (all reserved, NULL)                                                                                                                       | Filling `sha256` from a single `SHA256SUMS` asset is one extra subrequest per release, not per asset.                                                                                                                                                                                                                                      |

### 6.2 Reusable pieces

- `serveReleaseSurface` + `enforceReleaseAccess` + `entitledAccessCheck`: generic, any surface.
- `resolveSelector`/`classifyChannel`/`resolveChannel`: generic over GitHub releases (but see the
  poisoning issue — needs a tag filter).
- `streamAsset` (Range/ETag/SSRF guard, forced type): generic by asset id — just needs a content-type
  allowlist per kind.
- `verifySparkleSignature` (Ed25519 over bytes vs a configured key): directly reusable for WinSparkle
  EdDSA and for signing/verifying `.pck` packs with the same key, subject to the memory issue.
- `renderAppcast`/`buildAppcastItem`: reusable for WinSparkle with `sparkle:os` + `installerArguments`
  additions and an `.exe`/`.msi` matcher.
- `extractSummary` (changelog) for every feed's release notes.
- Truth-store tables: generic enough to index everything; they lack pack identity, build numbers,
  per-platform availability.

### 6.3 New tables vs new columns

- **New columns** (ALTER TABLE ADD COLUMN, mind the `0007` non-idempotent-tail convention and the
  `0018`/`scheduled.ts` index assertions): `release_config.artifact_map_json`,
  `release_config.tag_filter`/`stable_tag_pattern`, `release_config.version_scheme`,
  `release_artifacts.build_number`, `release_metadata.build_number`,
  `release_artifacts.platform_variant`/`format`, `release_artifacts.min_os`.
- **New tables** (and a `TABLE_OWNERS` entry in `packages/docs/scripts/gen-reference.mjs` ~L262 so the
  generated `data-model.mdx` stays fresh):
  - `release_sources(product, source_id, gh_owner, gh_repo, gh_installation_id, role, tag_pattern)` for
    multi-repo (app repo + packs repo).
  - `content_packs(product, pack_id, title, description, entitlement_key, …)` and
    `content_pack_versions(product, pack_id, version, source_id, release_id, artifact_id, channel,
engine_min, engine_max, game_min, game_max, texture_family/platform, size, sha256, signature,
deps_json)`.
  - `release_platform_availability(product, release_id, platform, store, state, available_at)` for
    store-review lag.
  - `release_rollouts(product, channel, release_id, percent, started_at, halted)` or fold into a
    preserved `release_channels.policy_json`.
  - `release_yanks(product, release_id, reason, yanked_at)` (or the `blocked` health status).
- **Table rebuild required** (SQLite can't alter CHECK): adding an access value to
  `release_metadata`/`release_artifacts` `access` CHECKs, or a new `release_health.subject_kind`.

### 6.4 Signed wire vs unsigned

- **Unsigned (no `PROTOCOL_VERSION` bump, no corpus regen):** every Release/Update route —
  `/version`, appcasts, changelog, install.sh, downloads, and any new feed (AltStore JSON, F-Droid
  index relay, WinSparkle XML, Velopack JSON, `.appinstaller` XML, zsync, generic manifest, pack
  catalog JSON). None of it is in the signed set (license/config/trust/bundle, AGENTS rule 2). Adding a
  `packs`/DLC entitlement is catalog DATA in the licence document's `entitlements` map, not a wire change.
- **Still "plan mode" (CLAUDE.md):** any edit to `shared-protocol` (e.g. widening `UpdateArch`,
  adding a `VersionCheck`/`PackCatalog` type) — it's a contract change that SDKs mirror (Node
  `sdk-node/src/update/client.ts`, Python `sdks/python/src/polaris_key/update/client.py`, Swift
  `sdks/swift/Sources/PolarisKeyUpdate/*`, React `useLatestVersion`), even without a version bump.
- **Signed wire (PROTOCOL_VERSION 3→4, `pnpm gen:corpus`, all five SDKs, Swift mirror):** only if the
  pack catalog / release manifest must be verifiable offline by the game with the product key — i.e. a
  new `pkey-packs+jws` (or `pkey-release+jws`) document type, or new fields in license/config/trust/
  bundle payloads (e.g. putting "allowed pack ids" or "rollout bucket" into the licence doc envelope
  rather than as ordinary entitlements). Also note there is no GDScript/Godot SDK; a Godot client that
  verifies anything signed becomes a sixth conformance participant.
- **OpenAPI + `routeCoverage`** (rule 10): every new route (and any alias). Generated
  `reference/routes.mdx` regenerates from the OpenAPI (`gen-reference.mjs` ~L218) → `docs gen:check`.
- **Manifest validator + mutation table + JSON schema** (rule 9): every new `.pkey/release` field
  (artifact map, tag filter, version scheme, platforms, feeds config, packs block, rollout defaults,
  store links) → rule in `shared-manifest/src/index.ts`, entry in
  `shared-manifest/test/schema-parity.test.ts` (existing release entries around L568-641), schema in
  `shared-manifest/schemas/v1/release.schema.json`, regenerated `reference/validation-codes.mdx`, and
  the `authoring-pkey-manifests` skill + `build/manifest/authoring.md`.

---

## 7. Update-policy gaps relevant to games

| Need                                                                          | Status today                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Forced / min-supported version**                                            | Only via the **License** service: `products.compat_min` ∩ tier/licence `app.minVersion` → licence document 403 `version-too-old` for the `X-PKey-Version` header (`core/gate.ts:111-137`). Product-global (not per-platform), semver-only, requires License + a live doc fetch. Update surfaces carry no min-supported/critical signal (`/version` is `{version,tag,url}`; appcast emits no `sparkle:criticalUpdate`/`minimumAutoupdateVersion`).                                                                                                          |
| **Engine/runtime compat gating** (a `.pck` needs matching Godot major.minor)  | None. No notion of runtime version; `X-PKey-*` headers carry app version/channel/platform/arch (`shared-protocol/src/core.ts:225-230`) but Release/Update read none of them (only `core/devices.ts:681-683` records platform/arch). Would need pack metadata (`engine_min/max`, `game_min/max`) + a request parameter/header + filtering in the pack feed.                                                                                                                                                                                                 |
| **Staged / percentage rollout**                                               | None. Nothing in Release/Update is keyed by device id; under `public` there's no device identity at all. `EntitledGrant` returns the device row (`entitledAccess.ts:97-103`) but no surface uses it. Sparkle's own client-side `phasedRolloutInterval` isn't emitted. Needs: deterministic bucket `hash(deviceId, releaseId) < pct` (requires a token, or a client-supplied bucket/installation id for public feeds), and edge-cache keys that don't leak one bucket's answer to another (today's cache key has no bucket; `public` responses are shared). |
| **Rollback / yank**                                                           | None; documented as an open finding: `R6-10 downgrade` test (`test/attack/R6-release.test.ts:1332-1385`) shows deleting the newest release silently makes an older one `latest`, cacheable-public, no floor. Truth-store rows are never deleted; `release_health.blocked` never written. The only levers are GitHub-side (delete/draft/prerelease the release). No "yank but keep for pinned", no "roll forward to X".                                                                                                                                     |
| **Kill switch**                                                               | Nothing in Release/Update. Blunt options elsewhere: lower `compatMax` below the bad version (clients on it are refused licence documents — they lose their licence state, not just updates), or a Config-service `flag` catalog entry the game polls. A feed-level "halt channel" needs the policy slot above.                                                                                                                                                                                                                                             |
| **Pinning**                                                                   | Pinned selectors exist on `/release/dl/<X.Y.Z>/…`; not on feeds (`/update/<channel>/appcast.xml` channel regex excludes dots; `/version?channel=` likewise). Per-licence pin = `app.maxVersion`, but only enforced for pinned selectors — moving feeds still offer newer builds (§1.7 gap). No per-device pin.                                                                                                                                                                                                                                             |
| **Per-platform availability / store-review lag**                              | None. A release is a single GitHub release containing whatever assets it has; channel resolution is per-release, not per (release, platform). There's no way to say "1.4.0 is live on Windows/Android-sideload but iOS is still 1.3.2 (in review)". A per-platform `latest` (or per-platform channel pointer) is required; resolution must fall back to the newest release _that has a matching artifact for this platform/arch_ (today the appcast just 404s if the newest stable release lacks the DMG).                                                 |
| **Build numbers** (iOS `CFBundleVersion`, Android `versionCode`, MSIX 4-part) | None. `sparkle:version` = short version. AltStore needs `buildVersion`; F-Droid/Obtainium key on `versionCode`; `.appinstaller` needs `Major.Minor.Build.Revision`. Needs a build-number source (manifest mapping, tag suffix `+123`, or a per-artifact sidecar `*.meta.json`) and a `build_number` column.                                                                                                                                                                                                                                                |
| **Release notes per platform / localized**                                    | One `summary` per release (600 chars).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Entitled-only portal fidelity**                                             | Portal can't enforce channel entitlement (`entitled` stored as `licensed`, `store.ts:154-169`); it lists every release (prerelease, `pr-*`, `channels`, `packs`) and every asset including `.sig`/`.sha256` sidecars (`portal/repo.ts:700-713`).                                                                                                                                                                                                                                                                                                           |

---

## 8. Test inventory touching these areas

- `worker/test/release.test.ts` — channels (L165-233), assets (L235-280), changelog, install template,
  appcast snapshot (L342), `handleRelease` surfaces incl. `/version`, cli streaming, entitlement gating,
  `.sig` appcast and fail-closed (L568-677), health (L679-800).
- `worker/test/updateFeed.test.ts` — public default, entitled feeds (R3 gap, tier entitlement, stable
  floor, `?channel=` on version, pinned artifact version window, metadata/artifacts independence, no
  caching of entitled), per-arch appcasts (L532-646), release notes/minimumSystemVersion (L648-747).
- `worker/test/releaseStore.test.ts` — resync writes store, idempotence, moved channel head, GitHub
  failure tolerance, entitled→licensed mapping, FK ordering, portal listing, R6-12 download redirect.
- `worker/test/attack/R6-release.test.ts` — R6-01 install injection, R6-02 checksums, R6-03 Sparkle
  verify, R6-04 content-type, R6-05 channel_workflow injection, R6-06 arch aliases, R6-07 webhook
  ref/replay, R6-08 redirect handling, R6-09 CDATA, **R6-10 downgrade (unfixed)**, R6-11 portal redirect.
- `worker/test/routeCoverage.test.ts` (L63-95 service paths + aliases), `router.test.ts`,
  `serviceRoutes.test.ts`, `surfaces.test.ts`, `boundaries.test.ts` (L57-59 sanctioned edge),
  `attack/R10-dos.test.ts` (rate limits/cache), `linkRepo.test.ts`, `portal.test.ts`.
- `shared-manifest/test/schema-parity.test.ts` (release rule entries ~L568-641), `src/index.test.ts`.

---

## 9. Doc/spec drift noticed along the way

- OpenAPI `downloadArtifact` says `v1.2.3` is an accepted selector; `classifyChannel` rejects it.
- OpenAPI/eligibility docs say `/update/version?channel=` accepts "a pinned X.Y.Z"; the `[a-z0-9-]`
  alphabet excludes dots.
- `services/release/index.md` "Release itself is not macOS-specific — the download route … classify
  assets by platform (macOS, Linux, Windows)": the download route can only serve extension-less binaries
  and DMGs; classification is truth-store-only.
- `services/release/artifacts.md` access table: `authenticated` "license doesn't have to be usable" —
  code requires a usable licence for both `authenticated` and `licensed`.
- `services/release/github-sync.md` "the push-webhook … keeps a linked product current": only `.pkey/`
  pushes; release events are ignored.
- `feed.ts:119-125` / `config.ts:89-96` call `artifact_policy_json` operator-owned; resync overwrites
  it (`resync.ts:280, 288`).
- `release.schema.json` `architectures` item length `{0,31}` vs validator `{0,63}`.

---

## 10. Suggested shape of a Godot-native design (for the synthesis step)

1. **Manifest-declared artifact map** in `.pkey/release` (per-platform/arch/format/role, glob or
   anchored regex on asset names, optional build-number source, feeds each artifact participates in).
   Classification then reads the map; name-sniffing remains the fallback.
2. **Tag hygiene**: `release.stableTagPattern` / `ignoreTags` (so `channels`/`packs` never become
   `latest`), version scheme (`semver` | `semver+build` | `4part`), pagination beyond 100.
3. **Generic artifact route** by artifact id + selector (+ platform/arch), content-type allowlist per
   format, optional **redirect mode** for public artifacts (hand the client GitHub's/R2's URL instead of
   streaming — removes the per-download API cost and the Range amplification), and/or **R2 mirroring**
   into `storage_key` via cron/Queue.
4. **Cache release resolution** (release JSON by selector in Cache API/KV for 60–120 s) so a download
   is ≤ 1 API call; cache the signed storage URL for its short lifetime.
5. **Feeds in Update**: generic multi-platform manifest JSON (per platform/arch: version, build, url,
   size, sha256, signature, minOS, critical, rollout), WinSparkle appcast (reuse `appcast.ts` +
   `sparkle.ts`), Velopack relay/rewrite, `.appinstaller`, AltStore/SideStore source, F-Droid index relay
   (CI-signed), zsync pointer; all CORS-enabled where browsers are clients; none signed-wire.
6. **Content packs**: packs tables + `release_sources` for a packs repo; pack feed filtered by engine
   version, game version, platform texture family, entitlement (DLC via licence entitlements, checked by
   a Core helper next to `entitledAccessCheck`); per-pack Ed25519 signatures verified server-side
   (streamed/hashed, not buffered) and optionally client-side with the product key.
7. **Policy table** preserved across syncs: per (channel, platform) pointer override, rollout %,
   min-supported, critical, yank list, store-availability state.
8. **Webhook `release` events** → `syncReleaseStore`.
