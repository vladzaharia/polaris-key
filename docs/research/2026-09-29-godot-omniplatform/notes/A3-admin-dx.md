> Research note for [Godot on Polaris Key](../README.md), 2026-09-29. A working paper kept for its
> evidence and sources; the README synthesis is the cross-checked position. Scratch paths in the
> original run are rewritten to `prototype/` where the code was kept.

# A3 — Admin, developer and end-user experience: what Polaris Key needs to ship an omni-platform Godot game (Diceroll)

Scope: the administrator (console), the developer/adopter (manifest, CLI, CI, onboarding), and the
end user (customer portal), plus the product/manifest/registration model and the service model.
Repo: `/home/user/polaris-key` at `fde0c0e`. Target: `vladzaharia/diceroll` (read-only clone).
All `file:line` references are to those two trees. Nothing in either repo was modified.

---

## 0. Headline findings

1. **Diceroll can register today, but PKey can serve almost none of its builds.** The release
   model is a macOS-app + CLI model: architecture is one of `arm64|x86_64`
   (`packages/worker/src/services/release/assets.ts:14-20`), the only downloadable leaves are
   `<binary>-<arch>` and `<binary>-<arch>.dmg` (`services/release/routes.ts:23,38-50`), and platform
   classification knows only `macos|linux|windows` (`services/release/store.ts:183-190`). Diceroll's
   `.zip`, `.tar.gz`, `.apk`, `.aab`, `.ipa`, `.pck` and its **universal** (arch-less) DMG are not
   reachable through `/<p>/release/dl/…`; the appcast finds no DMG; release health reports
   "missing arm64 DMG" forever (`services/release/health.ts:241-256`).
2. **Nothing in the manifest can express a platform matrix, store identity, store listing, build
   numbers, per-platform min OS, engine version, or content packs.** `.pkey/release` is GitHub
   coordinates plus Sparkle/installer knobs (`packages/shared-manifest/src/index.ts:165-199`), and
   three of its `artifactPolicy` fields are validated and persisted but never read by the worker.
3. **There is no CI credential.** The admin API accepts only the platform-admin browser session
   (`packages/worker/src/admin/api.ts:1-33`), `pkey bundle` scrapes that cookie from devtools
   (`packages/cli/src/bundle.ts:10-31`, `packages/cli/src/index.ts:322-329`: "there is no API token
   yet"), and the only inbound automation is the GitHub `push` webhook, which is ignored unless a
   `.pkey/` path changed (`packages/worker/src/githubWebhook.ts:155-157,182`). Publishing a GitHub
   release does not refresh the truth store. There is no GitHub Action.
4. **The console and portal are license-centric.** Devices are only listable per license
   (`packages/admin/src/api.ts:900-920`); a free game with `open` registration has devices nobody
   can see. The portal lists downloads only to a signed-in account that holds a license for the
   product (`services/identity/portal/api.ts:618,713`), dumps every asset of every release in one
   flat list (`packages/admin/src/portal/App.tsx:961-1078`), and redirects only to GitHub hosts
   (`packages/worker/src/http.ts:64-70`). It is not a public download page.
5. **Two operator-ownership traps.** Every `.pkey/` push unconditionally rewrites the compat window
   (`services/release/resync.ts:179-191`) and the release access modes
   (`services/release/resync.ts:277-290`), including resetting an operator-set `entitled` mode
   (which is not manifest-expressible) back to the manifest default `public`. The Update settings
   screen presents both as operator controls.
6. **A sixth service is a 5-language, ~45-file change, and the docs understate it.**
   `start/architecture.md:37-38` says a service is "one entry in `mount.ts`, one slug in
   `SERVICE_NAMESPACES`, and a directory — nothing in Core learns the new name", but Core enumerates
   the slugs itself (`core/services.ts:20-66`, `core/discovery.ts:74-80`). Worse, `parseServices`
   discards the **whole** `services_json` record on an unknown slug (`core/services.ts:158`), so
   rolling a worker back after a sixth slug has been written would silently switch Release, Update
   and Identity off for those products.
7. **Critical security hazard if store credentials go into `product_secrets`.** Edge-mint recipes
   are repo-authored (`.pkey/release` `edgeMint[]`), name any sealed product secret by string
   (`services/config/mint.ts:228-234`), accept arbitrary `iss`/`scope` claims and a
   recipe-controlled `aud`, and are served to **any device token** of the product
   (`mint.ts:214-219`). Under `open` registration that means anyone. An App Store Connect `.p8` or
   a Play service-account key stored as a product secret is one `.pkey/` push away from being a
   public token mint. The signing _primitives_ in `mint.ts` are reusable; the _route_ must never be.

---

## 1. How a product is onboarded today, and what Diceroll would write

### 1.1 End-to-end flow (as built)

| Step                                     | What happens                                                                                                                                                                                                                                   | Where                                                                                    |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | --------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 1. Scaffold                              | `pkey init --product <slug> --modules licensing,config,releases,oidc,edgeMint` writes `.pkey/product.yaml`, `schema.yaml` only if `config` is selected, and `release.yaml` only if `releases` is selected. Takes **legacy** module names only. | `packages/cli/src/manifest.ts:80-95,141-159`                                             |
| 2. Validate locally                      | `pkey validate` runs `validateManifestDocuments` and prints modules (in slug vocabulary), required secrets, warnings and errors.                                                                                                               | `packages/cli/src/index.ts:157-178`                                                      |
| 3. Remote check                          | `pkey doctor --base-url --product` fetches discovery and prints `signing ?? trust`. It still types the discovery body as having `modules` (`index.ts:201-205`), a v2 leftover.                                                                 | `packages/cli/src/index.ts:180-211`                                                      |
| 4. Install GitHub App                    | App `polaris-key`, permissions **Contents: read, Actions: read**, events **Push** only.                                                                                                                                                        | `docs/DEPLOYMENT.md:132-151`                                                             |
| 5. Link repo (console → Products → Link) | `linkRepo` parses `owner/repo`, discovers the installation, mints a repo-scoped installation token, reads `schema                                                                                                                              | product                                                                                  | release`×`.json | .yaml | .yml`, parses and validates, refuses an existing slug, then `registerFromManifest`: mints an Ed25519 key, seals it under the KEK, and in one batch writes `products`(incl.`services_json`), `product_schema`, `product_keys`, `oidc_config`, `profiles`, `tiers`, `provisioning_config`, **always** a `release_config`row with GitHub coordinates, and`edge_mint_config`. After the batch it applies the fingerprint and auto-issue policies and seeds the release truth store. | `packages/worker/src/services/release/linkRepo.ts:157-486` |
| 6. Record trust key                      | The console dialog shows kid, public key and JWKS URL once.                                                                                                                                                                                    | `packages/admin/src/views/products/CreateProductDialog.tsx:59-100`                       |
| 7. Set secrets                           | `PUT /manage/api/products/<slug>/secrets/<name>` is write-only and sealed; the setup-health checklist lists missing names.                                                                                                                     | `packages/worker/src/admin/handlers/products.ts:847-890`; `admin/lib/shape.ts:304-432`   |
| 8. Ongoing sync                          | A signed GitHub `push` whose changed paths touch `.pkey/` → `resyncRepo` for every product linked to that repo, bound to the installation id. Everything else is ignored.                                                                      | `packages/worker/src/githubWebhook.ts:154-253`                                           |
| 9. Manual resync                         | Console → Releases → "Resync from repo" → `POST …/release/resync`.                                                                                                                                                                             | `services/release/admin.ts:81-126`; `packages/admin/src/views/releases/ResyncButton.tsx` |

Seed SQL (`products/gen-seed.ts`) is fixture-only: it cannot mint `product_keys` or store secrets
(`products/gen-seed.ts:1-6`). Manual create (metadata + catalog JSON) writes no release or
edge-mint rows (`admin/handlers/products.ts:273-340`).

**Onboarding DX papercuts found along the way**

- **Schema is required at link but not at `pkey validate`.** `parseManifest` refuses a missing
  schema outright (`shared-manifest/src/index.ts:1472-1473`), but `validateManifestDocuments`,
  which `pkey validate` uses, only asks for it when Config is on. `pkey init --modules releases`
  writes no `schema.yaml` (`cli/src/manifest.ts:148-152`). A release-only product therefore passes
  `pkey validate` and fails at link. The quickstart documents the rule by hand
  (`packages/docs/src/content/docs/start/quickstart.md:15-24`); the tool does not enforce it.
- **The `pkey init` tier scaffold is wrong.** It writes `deviceLimit: 5` and `maxOfflineDays: 14`
  on the tier (`cli/src/manifest.ts:233-239`). `normalizeTier` ignores `deviceLimit` (it reads
  `policyDeviceLimit`, `index.ts:1674-1675`) and maps `maxOfflineDays` to **`policyExpiryDays`**
  (`index.ts:1666-1673`). A scaffolded product's "standard" licenses expire after 14 days.
  `licensing.keyActivation` (`manifest.ts:224`) is also read by nothing.
- **Editor schema paths assume `node_modules`.** The scaffold header points at
  `../node_modules/@polaris-key/manifest/schemas/v1/…` (`cli/src/manifest.ts:61-67`). A Godot repo
  has no `package.json`. The packages publish with `"access": "restricted"`
  (`.changeset/config.json:7`), so a public game repo cannot even `npm i @polaris-key/cli` without
  a private npm token.
- **Dead code in the CLI.** `enabledModules`, `collectRequiredSecrets`, `add` and `stringAt` in
  `cli/src/manifest.ts:324-364` are unused, left over from before validation moved to the shared
  package.
- **Stale runbook URL.** `docs/RUNBOOK.md:277` curls `/djdl/schema` (now `/djdl/config/schema`).

### 1.2 What `.pkey/product` can express

Source: `ManifestProduct` … `ParsedManifest` (`shared-manifest/src/index.ts:85-245`), plus the
validator.

| Block                         | Fields                                                                                                                              | Notes for a game                                  |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| identity                      | `slug`, `name`, `adminGroup` (metadata only), `compatMin/Max` (global semver window), `defaultDeviceLimit`, `defaultMaxOfflineDays` | One product = Diceroll. No per-platform anything. |
| `modules`                     | 5 slugs + legacy names; only literal `true` counts; all-off ⇒ license+config (`index.ts:267-284,434-455`)                           | —                                                 |
| `devices.registration`        | `open` / `requires-identity` / `requires-license`; undeclared ⇒ derived                                                             | A free game is `open`.                            |
| `licensing.profiles`, `tiers` | tiers: profile, expiry, device limit, fingerprint mode, **channels**, min/max version (`index.ts:131-149`)                          | Tiers can entitle testers to `beta`.              |
| `oidc`, `provisioning`        | platform or custom IdP, group→role/tier map, claim hooks                                                                            | Not needed for Diceroll.                          |
| `fingerprint`                 | enabled, default mode, **probes with `macos`/`windows`/`linux` targets only** (`index.ts:105-111,1287-1297`)                        | No iOS/Android/web probe targets.                 |
| `autoIssue`                   | anonymous / oidcDefault / both                                                                                                      | Could give "free" licenses to gate beta packs.    |
| `secrets.required`            | names only                                                                                                                          | —                                                 |
| `edgeMint`                    | recipes (also accepted in `.pkey/release`)                                                                                          | See §7.                                           |
| `release`                     | may be inlined here                                                                                                                 | —                                                 |

### 1.3 What `.pkey/release` can express

`ManifestRelease` (`index.ts:188-199`), validated at `index.ts:875-1062`, normalized at
`index.ts:1569-1639`, persisted by `linkRepo.ts:402-421` and `resync.ts:277-290`.

| Field                                                        | Used by                                                                              | Game relevance                                                                                                                                                    |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | ----------------------------------- |
| `provider {type: github, owner, repo}` / `ghOwner`, `ghRepo` | everything; only `github` is implemented (`index.ts:887-896`)                        | OK.                                                                                                                                                               |
| `binaryName`                                                 | `install.sh`, the CLI/DMG matcher, appcast title                                     | Only matters for the macOS/CLI paths.                                                                                                                             |
| `channelWorkflow`, `betaBranch`                              | `beta`/`pr-N` resolution through workflow runs                                       | —                                                                                                                                                                 |
| `manualChannels[{name, regex}]`                              | extra channels matched by anchored tag regex (≤80 chars)                             | Useful (see the gotcha in §1.5).                                                                                                                                  |
| `summaryMarker`                                              | changelog/appcast summary extraction, 600-char cap (`services/release/changelog.ts`) | One summary. No per-outlet "what's new".                                                                                                                          |
| `sparkleEd25519Pub`                                          | appcast signature verification                                                       | Only once macOS ships Sparkle.                                                                                                                                    |
| `artifactPolicy.requireDmg/requireCli`                       | release health only (`health.ts:65-95`)                                              | `requireDmg:false` does **not** silence the arm64 DMG check (`health.ts:241-256` is unconditional "missing").                                                     |
| `artifactPolicy.channels/architectures/allowAmbiguousAssets` | **nothing** (validated, persisted, never read)                                       | Inert. The JSON schema also caps `architectures` at 32 chars (`schemas/v1/release.schema.json:153`) while the validator allows 64 (`CHANNEL_RE`, `index.ts:341`). |
| `access.metadata/artifacts`                                  | `public                                                                              | authenticated                                                                                                                                                     | licensed` (`entitled` is operator-only) | Overwritten on every resync (§2.3). |
| `edgeMint[]`                                                 | Config's mint route                                                                  | §7.                                                                                                                                                               |

Operator-only, hidden: `artifact_policy_json.minimumSystemVersion` feeds Sparkle's
`minimumSystemVersion` (`services/update/feed.ts:126-139,214`). It is not manifest-expressible,
and resync overwrites the column anyway (§2.3).

### 1.4 How the truth store would see Diceroll's assets today

`releaseStoreStatements` / `artifactRow` (`store.ts:330-462`) classify by filename. Here is what
they would do with Diceroll's actual release assets (`.github/workflows/release.yml:126-130,189-190,309-313`):

| Diceroll asset                                                             | `kind`  | `platform` | `arch`                   | Servable via `/release/dl`?                                                                                 |
| -------------------------------------------------------------------------- | ------- | ---------- | ------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `Diceroll-<v>-macos.dmg` (universal)                                       | dmg     | macos      | **null** (no arch token) | No: the route needs `-arm64`/`-x86_64`, and `matchAsset` requires an arch token (`assets.ts:66-75,107-116`) |
| `Diceroll-<v>-macos.zip`                                                   | archive | macos      | null                     | No (not a leaf the router accepts)                                                                          |
| `Diceroll-<v>-windows-x86_64.zip`                                          | archive | windows    | x86_64                   | No (`.zip` leaf)                                                                                            |
| `Diceroll-<v>-linux-{x86_64,arm64}.tar.gz`                                 | archive | linux      | ✓                        | No                                                                                                          |
| `Diceroll-<v>-android.apk` / `.aab`                                        | other   | **null**   | null                     | No                                                                                                          |
| `Diceroll-<v>-ios-sideload.ipa`                                            | other   | **null**   | null                     | No                                                                                                          |
| `Diceroll-<v>-web.zip`                                                     | archive | null       | null                     | No                                                                                                          |
| `Diceroll-<v>-desktop.pck` (content pack)                                  | other   | null       | null                     | No                                                                                                          |
| `SHA256SUMS.txt`, `*-build-manifest.json`, `*-whats-new-{ios,android}.txt` | other   | null       | null                     | Listed as downloadable "files" in the portal                                                                |

Also: `sha256` is never recorded (`store.ts:452`), and `?checksum=sha256` needs a per-asset
`<asset>.sha256` sidecar, which Diceroll does not publish (it ships one `SHA256SUMS.txt`).
`storage_key` exists in the schema and is always null (`store.ts:456`), a seam for R2.

### 1.5 Draft manifests Diceroll would write **today**

Goal: register, get signed config and a changelog, keep GitHub as the binary host, add no
licensing. Nothing below makes the builds downloadable through PKey (see §1.4).

```yaml
# .pkey/product.yaml
# yaml-language-server: $schema=<vendored copy>/product.schema.json   # no node_modules in a Godot repo
apiVersion: pkey.dev/v1
product:
  slug: diceroll
  name: Diceroll
  compatMin: 0.1.0 # global window; there is no per-platform window
  compatMax: 99.0.0
modules:
  release: { enabled: true }
  update: { enabled: true } # appcast + /version; only useful once macOS ships a Sparkle build
  config: { enabled: true } # remote tuning / kill switches; warns config_without_activation (fine)
# devices.registration left undeclared ⇒ derived "open" (no License, no Identity)
fingerprint:
  enabled: false # a free game: collect no hardware components
```

```yaml
# .pkey/schema.yaml — REQUIRED even though Config content is the only reason to have it
apiVersion: pkey.dev/v1
schemaVersion: 1
entries:
  - key: update.checkIntervalHours
    kind: config
    category: Updates
    label: Update check interval
    description: Hours between background update checks (desktop direct builds).
    schema: { type: integer, minimum: 1, maximum: 168 }
    default: 6
    managementDefault: enforced
  - key: packs.remoteEnabled
    kind: config
    category: Content
    label: Remote content packs
    description: Kill switch for remote pack downloads.
    schema: { type: boolean }
    default: false
    managementDefault: enforced
  # WORKAROUND for missing outlet metadata: public, readable unauthenticated at
  # GET /diceroll/config/schema (defaults are part of the public catalog).
  - key: store.iosUrl
    kind: config
    category: Store
    label: App Store URL
    description: Where the iOS "new version" prompt sends players.
    schema: { type: string, format: uri }
    default: "https://apps.apple.com/app/id0000000000"
    managementDefault: hidden
  - key: store.androidUrl
    kind: config
    category: Store
    label: Google Play URL
    description: Where the Android "new version" prompt sends players.
    schema: { type: string, format: uri }
    default: "https://play.google.com/store/apps/details?id=gg.vlad.diceroll"
    managementDefault: hidden
```

```yaml
# .pkey/release.yaml
apiVersion: pkey.dev/v1
release:
  provider: { type: github, owner: vladzaharia, repo: diceroll }
  binaryName: Diceroll # matches ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$
  betaBranch: main
  summaryMarker: "pkey:summary" # release.yml must wrap the player-facing notes in <!-- pkey:summary --> … <!-- /pkey:summary -->
  # Built-in `beta` = newest GitHub PRERELEASE when no channelWorkflow is set
  # (services/release/channels.ts:143-146). Diceroll's rolling "channels" release IS a
  # prerelease (release.yml:337), so `beta` can resolve to it. Built-in names win over manual
  # ones (channels.ts:48-58), so the real prerelease lane needs a different name:
  manualChannels:
    - name: rc
      regex: "v[0-9]+\\.[0-9]+\\.[0-9]+-(rc|beta)\\.[0-9]+"
  artifactPolicy:
    requireDmg: false # does not clear the arm64-DMG health check (health.ts:241-256)
    requireCli: false
  access:
    metadata: public
    artifacts: public
  # sparkleEd25519Pub: <add when the macOS build embeds Sparkle>
```

Diceroll-specific gotchas when linked as-is:

- The **`channels` rolling release** (version string `"channels"`) and a planned immutable
  **`packs`** release of `<pack>-<hash>.pck` assets
  (`diceroll/docs/design/2026-09-29-content-streaming.md:446-452`) are ingested as ordinary
  releases. They show up in the console and the portal as versions called "channels" and "packs",
  and there is no tag filter for stable/beta.
- **Setup health is permanently yellow.** "Sparkle public key not configured"
  (`admin/lib/shape.ts:311-314`) and "missing arm64 DMG" (`health.ts:241-256`) show up, and the
  Overview checklist always asks the operator to "Issue a license", even with License off
  (`packages/admin/src/views/ProductOverview.tsx:315-331`).
- **Release notes.** Diceroll generates per-store notes with store limits
  (`diceroll/docs/RELEASE.md:63-77`: iOS ≤4000, Android ≤500 chars). PKey stores one body and
  extracts one ≤600-char summary.
- **Build numbers.** Diceroll's monotonic `CFBundleVersion`/`versionCode`
  (`diceroll/docs/RELEASE.md:52-61`) have no home. The docs say PKey "doesn't distinguish a
  marketing version from a separate build number" (`docs/services/update/appcast.md:66`).
- **Verifying signed documents in GDScript.** Every PKey signed document is EdDSA
  (`pkey-*+jws`). Godot's built-in `Crypto` handles RSA only, which is almost certainly why
  Diceroll signs its updater manifest with RSA-3072 PKCS#1 v1.5 (`diceroll/docs/RELEASE.md:101`).
  Consuming PKey documents from Godot needs a GDExtension (libsodium), a pure-GDScript Ed25519, or
  an engine-compatible second signature. This is a wire decision (AGENTS rule 2) for the SDK/wire
  track to resolve.

### 1.6 What Diceroll could NOT express

| Concept                                                                                                                                                   | Where Diceroll keeps it today                                                                             | PKey gap                                                                                                                   | Suggested home                                                           |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Platform matrix (ios, ipados, android, macos, windows, linux, web)                                                                                        | `export_presets.cfg`; README download table (`README.md:29-38`)                                           | `platform` is inferred from filenames and knows three OSes (`store.ts:183-190`)                                            | `.pkey/release` `platforms:` + explicit asset mapping                    |
| Arch incl. **universal**, arm64/x86_64 per OS                                                                                                             | asset names                                                                                               | `Arch = arm64 \| x86_64` (`assets.ts:14`)                                                                                  | release model                                                            |
| Outlet (distribution venue): github direct, App Store, TestFlight, Play (tracks), AltStore/SideStore, Obtainium, F-Droid repo, MS Store, Steam, itch, web | `build_info.json` `distribution` (`content-streaming.md:200-206`), `ENABLE_*` vars (`RELEASE.md:160-165`) | none                                                                                                                       | `.pkey/release` `outlets:`                                               |
| Store IDs: App Store `appleId`, bundle id `gg.vlad.diceroll`, Play package name, MS Store product id, Steam app id/depots, itch target                    | `export_presets.cfg:34,105,267`; `update_manifest.py:32-36` (`STORES`)                                    | none (`branding_json` exists but is written null, `linkRepo.ts:314`, and portal branding is an opaque blob nobody renders) | outlet config                                                            |
| Store listing: name, subtitle, description, icon, screenshots, tintColor, category, developer, website                                                    | `tools/ci/altstore_source.py:25-58`                                                                       | none                                                                                                                       | `listing:` (drives AltStore source, F-Droid metadata, the download page) |
| F-Droid metadata (summary, license, categories, AntiFeatures such as NonFreeAssets)                                                                       | not yet (F-Droid main repo is impossible; self-hosted repo possible: `content-streaming.md:189`)          | none                                                                                                                       | outlet `fdroid` + listing                                                |
| Per-platform min OS / SDK                                                                                                                                 | `min_ios_version="15.0"` (`export_presets.cfg:109`); Android `min_sdk`                                    | hidden operator-only macOS `minimumSystemVersion` (`feed.ts:126-139`)                                                      | `platforms.<p>.minOs`                                                    |
| Engine version / pack format                                                                                                                              | `build_info.json` `godot`; pack `engine`/`format` (`content-streaming.md:318-331`)                        | none on builds; devices can report it as `runtime{name,version}` (`core/devices.ts:859-875`, `device_facts.runtime_*`)     | build + pack metadata                                                    |
| Build number                                                                                                                                              | `stamp_version.py`                                                                                        | none                                                                                                                       | release/build model                                                      |
| Content packs (id, hash, size, stage, required, engine, format, units) and the code→pack-hash lock (`requires_packs`)                                     | `content-streaming.md:308-337`                                                                            | none                                                                                                                       | new `content` service (§5)                                               |
| Content channels                                                                                                                                          | `update-<channel>.json` stable/beta                                                                       | release channels only; no content concept                                                                                  | reuse the `channel` grammar in `content`                                 |
| Per-outlet release notes                                                                                                                                  | `store/*_whats_new.txt`                                                                                   | one summary                                                                                                                | release notes per outlet                                                 |
| Staged rollout, halted/yanked builds                                                                                                                      | Play `PLAY_STATUS`, App Store phased release                                                              | none (`release_channels.policy_json` always null, `store.ts:407`; `release_health` CHECK allows `blocked`, never written)  | release channel policy                                                   |
| Update feeds other than Sparkle: AltStore source, F-Droid index, Obtainium, Godot updater JSON, WinSparkle/Velopack, `.appinstaller`                      | self-generated into the `channels` release                                                                | only a Sparkle appcast and `/version` `{version, tag, url}` (`feed.ts:93-116`)                                             | `update` feed renderers                                                  |

---

## 2. The admin console

### 2.1 What exists

The nav is data-driven from `SECTIONS` (`packages/admin/src/route.ts:103-207`). Sections are
hidden when their service is off (`route.ts:242-259`).

| Section / tab                               | View                                                     | Shows                                                                                                                                                                                                    | Actions                                                                        |
| ------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Dashboard `#/`                              | `views/Dashboard.tsx`                                    | product count, access, session, product cards                                                                                                                                                            | open product                                                                   |
| Products `#/products`                       | `views/Products.tsx`, `products/CreateProductDialog.tsx` | registry                                                                                                                                                                                                 | link repo, manual create, edit, delete, prepare signing key                    |
| Platform → Overview                         | `views/ProductOverview.tsx`                              | setup strip, checklist (`280-364`, always license tasks), trust key, "modules", SDK starter                                                                                                              | links to the other tabs                                                        |
| Platform → Services                         | `views/services/ServicesCard.tsx`                        | 5 toggles, registration policy, source (manifest/admin)                                                                                                                                                  | save the set, revert to manifest                                               |
| Platform → Secrets                          | `views/Secrets.tsx`                                      | required-secrets checklist                                                                                                                                                                               | write-only PUT                                                                 |
| Platform → Activity                         | `views/Activity.tsx`                                     | audit log                                                                                                                                                                                                | paginate                                                                       |
| Platform → Settings                         | `views/Settings.tsx`                                     | name, defaults, signing key, danger zone                                                                                                                                                                 | edit, rotate, disable                                                          |
| License → Licenses / detail                 | `views/Licenses.tsx`, `LicenseDetail.tsx`, `licenses/*`  | licenses; per license: policy, keys, **devices** (OS/version/probes, first/last seen: `licenses/DevicesSection.tsx:80-125,224-248`), overrides                                                           | create, mint/revoke key, deauthorize device, reset fingerprint, offline bundle |
| License → Tiers / Enrollment & fingerprints | `Tiers.tsx`, `FingerprintPolicy.tsx`                     | tiers incl. channels/version window                                                                                                                                                                      | CRUD                                                                           |
| Config → Catalog / Profiles                 | `Catalog.tsx`, `Profiles.tsx`                            | catalog, profiles                                                                                                                                                                                        | publish a new schema version, edit payloads                                    |
| Release → Releases                          | `views/Releases.tsx`                                     | truth-store table: version, title, published, status, **artifact count only** (`186-191`), channel badges; channel→release list; release health checks; manifest sync state; read-only distribution card | **Resync from repo** (confirm dialog)                                          |
| Update → Update settings                    | `views/UpdateSettings.tsx`                               | metadata/artifact access (`public`/`authenticated`/`licensed`/`entitled`), compat window                                                                                                                 | save                                                                           |
| Identity → Sign-in & portal                 | `views/Identity.tsx`                                     | portal toggles (portal, OIDC, magic link, key claim, **release downloads**), auto-link                                                                                                                   | save                                                                           |

The admin API is platform-admin-only; there are no per-product admins
(`admin/api.ts:18-22`). The release admin surface is `health`, `releases` and `resync`
(`services/release/admin.ts:29-127`). Update's is `settings` (`services/update/admin.ts:1-27`).

### 2.2 Actions that exist for release and update, and nothing more

Resync (manual), health check (a live GitHub call), read the truth store, set access modes and
the compat window. Channels are read-only. They derive from tags and the manifest's
`manualChannels`, and there is no pin, promote, yank, rollout or per-channel view beyond a list.

### 2.3 Operator-ownership traps (they affect the admin experience directly)

- `resyncRepo` rewrites `products.name, compat_min, compat_max, default_*` on every push
  (`resync.ts:179-191`). The Update settings screen edits `compat_min/max`
  (`services/update/admin.ts`, `core/products.ts:setCompatWindow`), so a push silently reverts an
  operator's window.
- `resyncRepo` rewrites `release_config.artifact_policy_json, metadata_access, artifacts_access`
  (`resync.ts:277-290`). `entitled` is operator-only (`quickstart.md:204-206`,
  `onboarding.md:260-270`), and the manifest cannot say it, so any `.pkey/` push resets an
  `entitled` product to the manifest's access mode, which defaults to `public`
  (`index.ts:1605-1617`). The same write drops operator-set `minimumSystemVersion` and
  `requireSparkleSignature:false`. The latter is fail-safe, but it contradicts the comments in
  `config.ts:89-96` and `feed.ts:118-124` that call the column operator-owned. No test covers
  "operator sets `entitled`, then resync" (`test/serviceAdmin.test.ts:139-160` only covers the
  PATCH).
  **Recommendation:** give access modes and the compat window a `*_source` owner, as with
  `services_source`, `fingerprint_policy_source` and `auto_issue_source`, before any game ships
  gated beta content.

### 2.4 What an omni-platform game needs in the console

1. **Release × platform × outlet matrix** (replaces the artifact count). Rows are releases,
   columns are `platform/arch` × outlet. A cell shows artifact(s), size, sha256, signature/notarized
   state, submission state, rollout %, and health. The data already arrives on
   `GET …/release/releases` (`admin.ts:51-72`), but it needs real classification (explicit mapping
   from the manifest rather than filename heuristics) and a `release_builds`/`release_submissions`
   table.
2. **Artifact drill-down per release**, including checksums from `SHA256SUMS.txt`, and hiding
   non-installables (`kind: checksum|signature|notes|manifest`).
3. **Store submission status per build.** App Store Connect: build processing, TestFlight beta
   review, App Review, phased release. Play: track, status (draft/inProgress/halted/completed),
   `userFraction`. MS Store: submission status. Steam: branch. The state comes either from
   **outlet connectors** that poll with stored credentials (§7) or from CI reporting (§4). A
   timeline per release shows "submitted → in review → approved → live".
4. **Staged rollout controls.** Mirror store rollouts (Play `userFraction` halt/resume, App Store
   phased-release pause) and add PKey-native rollouts for self-updating outlets (direct desktop,
   Sparkle, the Godot updater): a percentage gate on `hash(deviceId, releaseId)`. The seam is
   `release_channels.policy_json`, which is always null today (`store.ts:407`).
5. **Promote / yank.** "Pin stable to 0.4.2" and "yank 0.5.0" (feeds and portal skip it; installs
   on it are told to move) need an admin-owned channel pointer that resync respects (same source
   pattern). `release_health.status` already allows `blocked` (`migrations/0007_backend_contracts.sql:106-117`).
6. **Channel management.** A per-channel page with its current release per platform, the pack set
   pinned to it, and who is entitled (the tiers that list it, `tiers.channels_json`).
7. **Content pack browser** (if the `content` service exists): pack × version (hash, size, engine,
   format, stage, required), which builds pin which hashes, per-channel pack sets, orphaned
   hashes, storage usage, "publish / retire / GC".
8. **Telemetry.**
   - The update funnel per platform/outlet/channel: check → offered → downloaded → staged →
     applied → rolled back. Diceroll already has "two failed boots roll back"
     (`RELEASE.md:105-106`).
   - Pack download failures and resume counts.
   - Web first-load time.
   - Crashes are better delegated (Sentry/Crashlytics) than built.

   Today `/devices/report` accepts a fixed allowlist and silently drops anything else
   (`core/devices.ts:855-875`). There is no event stream at all.

9. **Device breakdown.** A product-wide devices view grouped by platform, arch, app version,
   engine (`runtime_name/version`), outlet and channel. Today devices are only visible under a
   license (`api.ts:900-920`; `admin/repo.ts:189` `listDevicesByProduct` is used only by product
   delete, `admin/handlers/products.ts:254`), so **every device of an `open`-registration game is
   invisible**. Outlet and channel need new report keys (`X-PKey-Channel` exists as a header,
   `shared-protocol/src/core.ts:226`).
10. **Outlet credentials & health** card: which outlets are configured, whether the credential
    works, when it expires. See §7 for why these must not be ordinary product secrets.
11. **Product-kind-aware setup.** Drop the license tasks when License is off, and drop the Sparkle
    warning when no platform uses Sparkle.

---

## 3. The customer portal

### 3.1 What users see today

The portal is root-level and cross-product (`services/identity/portal/index.ts:1-18,67-96`).
Nav: Dashboard, Licenses, Downloads, Profile (`packages/admin/src/portal/App.tsx:294-360`).

- **Sign-in** is required: OIDC or magic link, per-product toggles (`api.ts:434-455`).
- **Licenses**: tier, expiry, entitlements, keys, **devices** (platform/arch/appVersion/SDK/UA;
  disconnect only). Claim a key.
- **Downloads** (`App.tsx:961-1078`): every release of every product the account holds a license
  for, with every artifact of each release, as `name · kind · platform · arch · size` and a
  Download button. Clicking mints a **one-time** token (`POST /api/releases/…/token`) and
  `/download/<token>` 302s to GitHub. Constraints:
  - The listing only includes products from `listLinkedProducts(accountId)` (`api.ts:618`), and
    the mint requires `hasLinkedProductLicense` even for `public` artifacts (`api.ts:713`). A
    player with no license sees nothing.
  - `listPortalReleases` has no limit or channel filter (`portal/repo.ts:684-698`).
  - Redirects are allowed only to `github.com`/`*.githubusercontent.com` (`http.ts:64-70`,
    `api.ts:296-309`).
  - Nothing detects the visitor's platform. There are no store badges and no "latest only" view.

### 3.2 What an omni-platform download page needs

A public **per-product download page**. This is a different product surface from the account
portal. Serve it outside the admin origin or as a static page with no user content (§7.2).
`/<product>` alone 404s today (`router.ts:133-136`).

| Capability                     | Design notes                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Platform detection             | UA-CH `navigator.userAgentData.getHighEntropyValues(['platform','architecture','bitness','platformVersion'])` with a UA fallback. iPadOS reports "MacIntel": disambiguate with `maxTouchPoints > 1`. Windows on ARM comes from `architecture`. Apple Silicon vs Intel is not reliably detectable (use universal DMGs). Show one primary CTA plus an "All platforms" matrix.         |
| Store badges                   | App Store (`https://apps.apple.com/app/id<appleId>`), Google Play (`https://play.google.com/store/apps/details?id=<package>`), Microsoft Store (`https://apps.microsoft.com/detail/<productId>` / `ms-windows-store://pdp/?productid=`), Steam, itch. Official badge artwork under each brand's rules. Driven by outlet config (§5).                                                |
| TestFlight / Play testing      | TestFlight public link (`https://testflight.apple.com/join/<code>`), Play testing opt-in URL. Show them only to accounts entitled to `beta` (tier channels).                                                                                                                                                                                                                        |
| AltStore / SideStore           | "Add source" deep links `altstore://source?url=<enc>` and `sidestore://source?url=<enc>` (also `sidestore://install?url=` and `altstore://viewApp?bundleID=`), plus the copyable URL and a QR code. The **source JSON must be a stable, public, unauthenticated URL** that PKey renders (an Update feed) from listing + release data. The portal's one-time tokens cannot serve it. |
| Obtainium                      | An "Add to Obtainium" deep link (`obtainium://add/<url>`; verify against current Obtainium docs) pointing at either the GitHub repo or a PKey-rendered "latest APK" JSON/HTML. Needs a stable per-release APK URL and the same signing key forever.                                                                                                                                 |
| F-Droid custom repo            | A PKey-rendered repo (`index-v1.jar`/`index-v2.json` + entry, signed with a repo key), a `fdroidrepos://<host>/<path>/repo?fingerprint=<sha256>` deep link, and a QR code of the `https://…?fingerprint=` URL. The listing must declare AntiFeatures (for example non-free assets).                                                                                                 |
| Web "Play now"                 | A button to the web build on its **own origin** (§7.2), with size and WebGL2 requirement notes.                                                                                                                                                                                                                                                                                     |
| Direct downloads               | Latest per platform/arch, size, sha256, signature/notarization state, min OS, and a link to version history per channel. Stable public URLs (generalize `/release/dl/<version>/<asset>` to all platforms/kinds).                                                                                                                                                                    |
| Content packs (desktop direct) | An optional "Full" vs "Lean" installer choice (`content-streaming.md:188-192`).                                                                                                                                                                                                                                                                                                     |
| Release notes                  | Per-outlet "what's new" variants.                                                                                                                                                                                                                                                                                                                                                   |
| Signed-in extras               | Beta builds and packs for entitled accounts; devices for products using License.                                                                                                                                                                                                                                                                                                    |

---

## 4. The CLI, CI and authentication

### 4.1 Commands today (`packages/cli/src/index.ts:59-92,306-333`)

| Command         | Does                                                                    | Auth                                                                  |
| --------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `pkey init`     | Scaffolds `.pkey/` (legacy module names; the tier scaffold bug in §1.1) | —                                                                     |
| `pkey validate` | Local validation                                                        | —                                                                     |
| `pkey doctor`   | Validate + fetch discovery                                              | —                                                                     |
| `pkey trust`    | Prints pinned-key snippets for Node/Python/Swift                        | —                                                                     |
| `pkey sdk`      | Prints a Node SDK snippet                                               | —                                                                     |
| `pkey bundle`   | Mints an offline bundle through the admin API                           | `PKEY_ADMIN_COOKIE`, copied from browser devtools (`bundle.ts:10-31`) |

There is **no GitHub Action**: no `action.yml` in the repo, and `.github/workflows/*` only build,
test, deploy and release the monorepo itself.

### 4.2 How CI can authenticate to PKey today

It can't. Product → PKey data flow is **pull-only**: the GitHub App reads `.pkey/` and releases,
and the webhook reacts only to `push` with `.pkey/` changes. The admin API has one credential,
the OIDC browser session of a `PLATFORM_ADMIN_GROUP` member. There are no product-scoped tokens
and no API keys.

Consequences:

- A new GitHub release is invisible to the truth store (portal, console) until someone resyncs or
  pushes a `.pkey/` change. The live feeds read GitHub directly (`views/Releases.tsx:36-47`), so
  they are fine.
- Nothing can push a non-GitHub artifact (R2), a pack, a build number or a submission state.

### 4.3 CI-facing commands a game needs

| Command (proposed)                                                                                     | Purpose                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pkey auth github-oidc`                                                                                | Exchange the Actions OIDC token for a short-lived, product-scoped PKey CI token (§4.5).                                                                                                      |
| `pkey build-info --platform ios --outlet appstore --channel stable`                                    | Emit the `build_info.json`/SDK bootstrap the game embeds: product, base URL, pinned keys, outlet, channel, build number. This absorbs `stamp_version.py`'s PKey-relevant half.               |
| `pkey release register --tag v0.2.0` / `pkey release sync`                                             | Tell PKey a release exists (and trigger a truth-store refresh) without a `.pkey/` push.                                                                                                      |
| `pkey artifact publish --platform android --outlet obtainium --file X.apk --build 20099 [--upload r2]` | Register or upload a build with explicit platform/arch/outlet/build number. Large files go through **presigned R2 PUTs**, not the admin API (64 KiB body cap, `admin/lib/respond.ts:73`).    |
| `pkey pack verify <dir>`                                                                               | Enforce the pack rules (data-only: no `.gd/.gdc/.remap`; paths inside the declared prefixes), hash, engine/format stamp. Diceroll specifies these at `content-streaming.md:207-209,279-283`. |
| `pkey pack publish --channel beta`                                                                     | Upload content-addressed packs, register pack versions, attach the code build's pack set (`requires_packs`). The signed pack index is produced **server-side**.                              |
| `pkey submission report --outlet appstore --build 20099 --state in_review`                             | For outlets PKey does not poll itself.                                                                                                                                                       |
| `pkey channel promote/yank/rollout`                                                                    | Operator actions from CI or a terminal (with a scoped operator token).                                                                                                                       |
| `pkey validate --strict`                                                                               | Same rules as `parseManifest`, including "schema required" (fixes §1.1).                                                                                                                     |
| `pkey manifest schema --out .pkey/.schemas/`                                                           | Vendor the JSON schemas into repos without `node_modules`.                                                                                                                                   |

### 4.4 GitHub Action

Ship `polaris-key/actions` (publish, packs, submission, build-info) wrapping the CLI, using OIDC
(no stored secret), with `permissions: id-token: write`. It would replace Diceroll's hand-rolled
`altstore_source.py` and `update_manifest.py`: PKey renders those feeds from registered data.

### 4.5 Credential design recommendation

- **Preferred: GitHub Actions OIDC federation.** PKey verifies the Actions token against
  GitHub's JWKS, then binds `repository_id`/`repository`, `ref` or `environment`, and
  `job_workflow_ref` to the product's linked repo (`release_config.gh_owner/gh_repo`). It issues a
  15-minute token scoped `{product, ops:[artifact:write, pack:write, submission:write]}`. There is
  no secret to leak, and it reuses the trust relationship PKey already accepts (the repo already
  writes `.pkey/` policy, `THREAT-MODEL.md:66-73,97`). Allow an operator-set required GitHub
  environment (for example `release`) so that branch protection and required reviewers gate
  publishing.
- **Fallback: product-scoped CI tokens** (`pkeyci_…`), created in the console, hashed like license
  keys, scoped, expiring and audited, for non-GitHub CI.
- Either way it is a **new surface**, not the admin API. The admin API's authority is
  platform-wide (`admin/api.ts:18-22`).

---

## 5. Enablement and the service model

### 5.1 How to decide: extend, capability, or new service

The glossary defines a service as an independent, opt-in unit with a slug that is also the worker
directory, route namespace, SDK sub-client and console section
(`packages/docs/src/content/docs/start/concepts.md:12-37`). Capabilities (edge-mint) live inside a
service (`concepts.md:139-145,270-273`). The test: **can a product want it without the others?**

### 5.2 Recommendation

| Need                                                                                                                                                                                    | Model                                                                                                                                                 | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Platform/arch/outlet/build-number model, explicit asset mapping, listings, store IDs, submissions, rollouts, promote/yank                                                               | **Extend `release`** (the truth store)                                                                                                                | It is "what software exists and where it is published". Release already owns `release_config` and the truth store (`services/release/store.ts:1-32`).                                                                                                                                                                                                                                                                                                                                |
| AltStore/SideStore source, F-Droid index, Obtainium JSON, Godot updater manifest, WinSparkle/Velopack feed, `.appinstaller`, store "update available" metadata, per-platform `/version` | **Extend `update`** (the feed over the truth store)                                                                                                   | This is exactly the D-05 split. Each is "an appcast for a different client". `update → release` is already the sanctioned edge.                                                                                                                                                                                                                                                                                                                                                      |
| Store API connectors (ASC, Play, Partner Center)                                                                                                                                        | **Release capability** ("outlet connectors"), core-mediated credential custody                                                                        | Not a unit a product enables alone. Credential custody must be core-level (§7).                                                                                                                                                                                                                                                                                                                                                                                                      |
| Content packs + pack index + pack channels + entitlement-gated DLC                                                                                                                      | **New sixth service `content`**                                                                                                                       | It passes the independence test. A store-only game (App Store + Play) turns Release/Update **off** (the stores deliver binaries) yet still wants remote packs for live-ops. It has its own storage (R2, content-addressed), its own lifecycle (pack hashes outlive versions, `content-streaming.md:318-326`), its own signed document, and its own gate (engine/format). Folding it into Release would force Release on for store-only products and conflate "binaries" with "data". |
| Paid DLC gating                                                                                                                                                                         | Reuse a License `flag` (e.g. `pack.extra`), checked through the Core-mediated path Release/Update use for `entitled` (`core/entitledAccess.ts:18-31`) | No cross-service import.                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

Coherence rules to add (`core/services.ts:250-280`): perhaps `content_requires_signing_client`,
certainly none that forces Release. Registration: a store-only game with `content` + `open`
registration works (devices register keylessly and fetch the pack index).

### 5.3 Blast radius of a sixth service (`content`)

The docs claim "one entry in `mount.ts`, one slug in `SERVICE_NAMESPACES`, and a directory"
(`start/architecture.md:37-38`, `contribute/layout.md:86-87`). The real list:

**Worker**

1. `packages/worker/src/core/services.ts:20-66`: the `ServiceSlug` union, `SERVICE_SLUGS`,
   `DEFAULT_SERVICES`, `defaults()`, and coherence rules `250-280`. **Rollback hazard:**
   `parseServices` discards the whole record on an unknown key (`:158`), so an old worker reading
   `{"content":…}` falls back to license+config for that product, turning Release, Update and
   Identity **off**. Ship "tolerate unknown slugs" (or a separate column) one deploy ahead.
2. `packages/worker/src/router.ts:41-47` `SERVICE_NAMESPACES`. It also shadows any existing release
   channel named `content` on the `/<p>/<channel>/appcast.xml` alias (`router.ts:167-183`).
3. `packages/worker/src/mount.ts:19-31`.
4. `packages/worker/src/core/discovery.ts:74-80` (object literal of five).
5. `packages/worker/src/services/content/` (descriptor, routes, admin, store).
   `test/boundaries.test.ts:58-60,184` (the "all five" assertion, and any cross-service edge,
   which should be avoided).
6. Migrations (`packages/worker/migrations/0022_content.sql`), then regenerate
   `reference/data-model.mdx`.
7. `openapi/polaris-key.v3.yaml` + `test/routeCoverage.test.ts` (AGENTS rule 10).
8. Ingest. `ServiceDescriptor.manifestIngest` exists but **nothing calls it**
   (`core/registry.ts:113-120`; `start/architecture.md:74-80`). `linkRepo.ts` and `resync.ts`
   write every row themselves through `core/ingest.ts:24-51`. Either implement the hook or add
   statements there. A new `.pkey/content` document also touches `services/release/manifestFiles.ts`.
9. `admin/api.ts` (generic `adminHandle` dispatch: comment only). Portal capabilities if packs
   appear in the portal (`services/identity/portal/api.ts:434-455`).
10. Tests: `registry.test.ts:227`, `services.test.ts`, `surfaces.test.ts:326`, `router.test.ts`.

**Shared packages / wire** 11. `packages/shared-manifest/src/index.ts:13-47` (`ProductModule`, `ServiceSlug`,
`SERVICE_SLUGS`), `:267-278` (`MODULE_SERVICES`), new validator rules, and
`test/schema-parity.test.ts` (base fixture modules + one mutation per new code, AGENTS rule 9).
Also `schemas/v1/product.schema.json` (`$defs.modules`, lines ~205-215), a new
`content.schema.json` if a new document, `src/index.test.ts:705-786`. 12. `packages/shared-protocol`: a new `./content` subpath export and `src/content.ts`. 13. If the pack index is a signed document (`pkey-content+jws`): `client-core` verification,
`PROTOCOL_VERSION` bump (`shared-protocol/src/core.ts`), corpus regeneration
(`tools/sign-corpus.ts`, `conformance/corpus/v2`, the Swift mirror), and all five SDKs
(AGENTS rules 1-2). The plan-mode rule in `CLAUDE.md` applies.

**SDKs.** Old SDKs ignore unknown discovery slugs, so they are forward-compatible. 14. `sdk-node/src/discovery.ts:33-85`, `core/context.ts`, `index.ts`,
`cli/{commander,yargs,commands}.ts`, new `src/content/`. 15. `sdk-react/src/core/services.ts:34-117`, `core/types.ts`, `browser/discovery.ts`,
`desktop/desktopAdapter.ts:218-321`, `browser/browserAdapter.ts:375,482`,
`react/Provider.tsx`. 16. `sdks/python/src/polaris_key/discovery.py:54`, `__init__.py`, new `content/`. 17. `sdks/swift/Sources/PolarisKeyCore/Discovery.swift:31` (a `CaseIterable` enum), `CoreContext.swift`,
`PolarisKey/PolarisKeyClient.swift`, a new target, `Package.swift`. 18. (Godot: a new SDK anyway; see §1.5.)

**Console** 19. `packages/admin/src/api.ts:309` (`ServiceSlug`), `:349` (`SERVICE_ERROR_MESSAGES`). 20. `packages/admin/src/route.ts:33-52` (`Tab`), `:65-71` (`ServiceAccent`), `:103-207` (`SECTIONS`),
`test/route.test.ts`. 21. `components/Shell.tsx:79` (icon map), `styles.css:113-161` (accent tokens in dark and light),
the brand registry. 22. `views/services/ServicesCard.tsx:70-110,499`. 23. `lib/docsLinks.ts` + route docs (gated against the slug manifest, AGENTS docs conventions).

**Products / CLI** 24. `products/gen-seed.ts` (generic over `SERVICE_SLUGS`, OK) + fixture. 25. `packages/cli/src/manifest.ts:9-14,72-78` (module list, init scaffold), `loadManifest` for a
new file.

**Docs, skills, meta** 26. Astro sidebar (`packages/docs/astro.config.*:56-61`) + `services/content/*`. 27. `start/concepts.md:12-37` ("five opt-in services"), `start/service-model.md`,
`start/architecture.md:37-38` (fix the claim), `start/index.md`, `start/quickstart.md`,
`build/onboarding.md:12-43`, `build/registering.md:17-28`, `build/manifest/index.md:39-61`,
`build/manifest/authoring.md:90-164`, `admin/console-tour.md`,
`admin/services-enablement.md`, `agents/*`, `contribute/layout.md:86-87`,
regenerated `reference/{validation-codes,routes,data-model}.mdx` (AGENTS rule 3). 28. `AGENTS.md` ("five-language… five opt-in", repo map, `SERVICE_NAMESPACES`), `CLAUDE.md`,
`.claude/skills/authoring-pkey-manifests/SKILL.md:63-83`, `README.md`,
`docs/security/THREAT-MODEL.md`.

### 5.4 Terminology: new nouns that don't collide

Constraints: device not machine, product not app, tier not plan (`AGENTS.md` rule 4); "profile" is
taken twice (`concepts.md:202-203`); "catalog" is the config catalog; "manifest" is `.pkey/`;
"bundle" is the offline `pkey-bundle+jws`; "channel" is the release channel; "surface" is already
an internal term for route kinds (`services/release/surfaces.ts:3-12,46`, `config.ts:122-137`);
"key" is a license key; "target" is used for audit targets and redirect targets. Counts across
worker/admin/docs/shared/migrations: `outlet` 0, `storefront` 0, `venue` 0, `track` 0, `pack` 0,
`rollout` 1, `submission` 5 (prose only).

| Concept                                                                                                                            | Proposed term                                                                                                                                                                                                                                      | Rejected, and why                                                                                                                                                                                                                                |
| ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| OS family of a build or device (ios, ipados, android, macos, windows, linux, web)                                                  | **platform**. It is already on the wire and in columns (`X-PKey-Platform`, `devices.platform`, `release_artifacts.platform`). Add it to the glossary and never use the bare word for the deployment (say "Polaris Key" or "platform-level" there). | `os` (web is not an OS), `target` (taken), `surface` (taken)                                                                                                                                                                                     |
| CPU architecture incl. `universal`                                                                                                 | **arch** (extend the enum)                                                                                                                                                                                                                         | —                                                                                                                                                                                                                                                |
| Distribution venue (App Store, TestFlight, Play, AltStore, SideStore, F-Droid repo, Obtainium, direct, MS Store, Steam, itch, web) | **outlet**                                                                                                                                                                                                                                         | `channel` (release channel), `surface` (internal), `storefront` (excludes direct/sideload/web; usable as an outlet _kind_ = `store`), `distribution` (used as a generic verb/activity in docs, e.g. `start/index.md:8`), `track` (Play-specific) |
| Store-side record identity (App Store app id, bundle id, Play package, MS product id)                                              | **outlet identity** (`appleId`, `bundleId`, `packageName`, `productId` fields)                                                                                                                                                                     | "app" (glossary forbids it as a noun for the product)                                                                                                                                                                                            |
| Store page metadata (name, subtitle, description, icon, screenshots, tint)                                                         | **listing** (in prose, "outlet listing")                                                                                                                                                                                                           | `profile` (taken), `branding` (existing opaque blob, too narrow)                                                                                                                                                                                 |
| One compiled deliverable for one platform/arch/outlet with a build number                                                          | **build** (a release has builds; a build has 0..n artifacts; an App Store build has none downloadable)                                                                                                                                             | `bundle` (taken; also Apple's "app bundle"), `binary` (`binaryName` means the CLI name)                                                                                                                                                          |
| Store build number (CFBundleVersion, versionCode)                                                                                  | **build number**                                                                                                                                                                                                                                   | —                                                                                                                                                                                                                                                |
| Sending a build to an outlet's review                                                                                              | **submission**                                                                                                                                                                                                                                     | —                                                                                                                                                                                                                                                |
| Percentage exposure                                                                                                                | **rollout**                                                                                                                                                                                                                                        | "phased release" (Apple-specific; map to it)                                                                                                                                                                                                     |
| Mark a release unservable                                                                                                          | **yank**                                                                                                                                                                                                                                           | "revoke" (used for keys, licenses, signing keys)                                                                                                                                                                                                 |
| Move a channel pointer                                                                                                             | **promote / pin**                                                                                                                                                                                                                                  | —                                                                                                                                                                                                                                                |
| Downloadable data-only content unit                                                                                                | **pack** (service slug **`content`**)                                                                                                                                                                                                              | `bundle`, `asset` (overloaded with GitHub release assets and "game assets"), `module` (manifest `modules`), `DLC` (paid subset only)                                                                                                             |
| Exact pack hashes a build requires                                                                                                 | **pack set**                                                                                                                                                                                                                                       | `lock`, `manifest` (taken)                                                                                                                                                                                                                       |
| Signed list of packs for a channel                                                                                                 | **pack index** (document `pkey-content+jws`, "content document" in the family naming)                                                                                                                                                              | `manifest` (taken), `catalog` (taken)                                                                                                                                                                                                            |
| Content channels                                                                                                                   | **channel** (same grammar and entitlement as release channels; "content channel" in prose)                                                                                                                                                         | new word (unnecessary; one `channels` entitlement should gate both)                                                                                                                                                                              |
| Godot version etc.                                                                                                                 | **engine** on builds/packs; devices keep reporting **runtime** (`runtime.name/version`)                                                                                                                                                            | —                                                                                                                                                                                                                                                |
| Store API credential                                                                                                               | **outlet credential**                                                                                                                                                                                                                              | "API key" (confusable with `pkey_` keys), "profile" (Apple "provisioning profile": never shorten to "profile")                                                                                                                                   |

---

## 6. Docs and skills to add or change

**New skills (`.claude/skills/`)**

- `publishing-a-godot-game`: end-to-end. Manifest with platforms/outlets/listing, the CI Action +
  OIDC, `build-info`, pinned keys in GDScript and the Ed25519 decision, updater integration,
  packs.
- `adding-an-outlet`: declare an outlet, its identity/listing, credentials (outlet kind, §7), the
  feed it renders, the download-page badge.
- `publishing-content-packs`: data-only rules, hashing, engine/format gating, publish, channel
  pack sets, GC.
- `adding-a-service` (contributor): the blast-radius checklist in §5.3, the unknown-slug rollback
  two-step, the drift gates (AGENTS rules 3, 9, 10) and the corpus rule.

**Skill edits**

- `authoring-pkey-manifests`: step 1, `pkey init` fixes and the always-required schema. Step 3,
  new release fields and optionally a `.pkey/content`. Step 4, the sixth slug. Step 7, CI
  identity. Step 8, ownership of access modes and the compat window.
- `adding-a-catalog-entry`: store IDs and URLs belong in `.pkey/release` outlets, not the catalog.
  Document the public-schema workaround only as a stopgap.

**New docs pages (`packages/docs/src/content/docs/`)**

- `build/omni-platform.md` ("Shipping one product to every platform"), `build/ci.md` (Action,
  OIDC, CI tokens), `build/sdks/godot.mdx`.
- `services/release/{platforms,outlets,builds,submissions,rollouts}.md`,
  `services/update/feeds.md` (AltStore/SideStore, F-Droid, Obtainium, Godot updater,
  WinSparkle/Velopack, `.appinstaller`).
- `services/content/{index,packs,pack-index,channels}.md`.
- `admin/release-matrix.md`, `admin/outlets-and-credentials.md`, `admin/telemetry.md`,
  `admin/devices.md` (product-wide).
- `users/downloads.md` (download page, adding an AltStore source, Obtainium, F-Droid repo, web).

**Existing docs to change**

- `start/concepts.md` (glossary §5.4), `start/service-model.md`, `start/architecture.md:37-38` (wrong
  today).
- `services/release/artifacts.md` (asset model beyond `-arm64/.dmg`),
  `services/update/appcast.md:66` (build numbers).
- `admin/console-tour.md`, `users/portal.md` + `users/updates.md` (non-Sparkle platforms).
- `docs/RUNBOOK.md:277` (stale path). Add R2 and outlet-credential rotation.
- `docs/DEPLOYMENT.md:138-143`: GitHub App events add `release` (so publishing refreshes the
  truth store). Add an R2 bucket.
- `docs/security/THREAT-MODEL.md` (§7.5). Regenerate `reference/*.mdx`.

---

## 7. Security and threat-model implications

### 7.1 Serving large binaries and packs

- **Today** every download streams from GitHub storage through the Worker, costing 1-3
  subrequests against the installation's **5,000/hour quota shared by every product on that
  installation**. Artifacts are deliberately not edge-cached (`services/release/gateway.ts:70-106`;
  `github.ts:182-222`). A game's traffic (installers, ~64-73 MB PCK updates, per-pack downloads,
  web lazy loads; `content-streaming.md:148-160`) would exhaust the quota and 404 every download
  and auto-update for every product on the installation (the R10-05 failure mode, now easy to
  reach).
- **Recommendation:** an R2 bucket binding (none exists: `packages/worker/wrangler.toml` has D1,
  KV, DO, ASSETS and EMAIL only).
  - Content-addressed keys `content/<product>/<sha256>` and
    `release/<product>/<release>/<artifact>`. Fill the existing `storage_key` column
    (`store.ts:77,456`).
  - Serve through the Worker with `Range`, immutable cache headers and edge cache for public
    immutable objects, or through an R2 custom domain on a **separate registrable domain**.
  - Presigned PUT for CI uploads.
  - Extend `isAllowedStorageHost`/`redirectableSourceUrl` deliberately. The two-layer defence is
    documented for exactly this future writer (`portal/api.ts:285-295`).
- **Integrity.** The signed pack index covers sha256 and size, and clients verify before mounting
  (Diceroll's design already does, `content-streaming.md:339-347`). Keep the gateway's forced
  `application/octet-stream` + `attachment` on anything served from the console origin
  (`docs/services/release/artifacts.md:62-72`).
- **Pack supply chain.** Packs are code-adjacent: a malicious pack cannot inject scripts only if
  the client mounts with `replace_files=false` and rejects scripts. PKey should enforce
  "data-only" at publish (list the PCK and refuse `.gd/.gdc/.remap`) as defence in depth. The
  pack index signature becomes an A2-class asset.

### 7.2 Web builds and CORS

- **Never host a web build on `key.plrs.im`.** The origin also serves `/manage` (the admin
  console, `__Host-pkey_admin`) and the portal. A game's JS/WASM there is script execution
  against the control plane (the same reason artifacts are forced to `attachment`). A
  `*.plrs.im` sibling is also a poor choice: it is **same-site**, which weakens the SameSite and
  `Sec-Fetch-Site`-based protections the worker relies on (`http.ts:35` comment). Use a different
  registrable domain (for example `diceroll.gg`, or a Pages/R2 custom domain).
- **CORS.** The worker emits no CORS headers anywhere (a grep for `access-control-allow` finds
  nothing). A web build fetching discovery, the config document, the pack index or packs
  cross-origin needs an **operator-allowlisted** origin list (a manifest-declared `web.origins`,
  gated the way `OIDC_ISSUER_ALLOWLIST` gates custom issuers, `linkRepo.ts:86-134`):
  - `Access-Control-Allow-Origin: <exact>`, no credentials for public packs;
  - `Authorization` in `Access-Control-Allow-Headers` if device tokens are sent;
  - `Access-Control-Expose-Headers: Content-Range, Accept-Ranges, ETag, Content-Length` for
    resumable pack loads;
  - preflight caching.
- **COOP/COEP.** Diceroll's web build is `nothreads` (`RELEASE.md:41`), so no COOP/COEP is
  needed. A threads build would need them on the _game_ origin, and every cross-origin pack
  response would then also need `Cross-Origin-Resource-Policy: cross-origin`.

### 7.3 Store API credentials inside PKey

- **Asset ranking.** An App Store Connect key (App Manager role), a Play service account with
  release rights, or Partner Center credentials can **ship a build to every store user**. That is
  asset **A3** severity (`THREAT-MODEL.md:24-36`), above A5 (the current "product secrets"
  bucket). Centralizing them in PKey also means a KEK compromise (A1) now yields store publishing
  for every tenant.
- **Storage.** `keyvault.ts` seals AES-256-GCM with the AAD `pkey:v2:<product>:<kind>:<id>`, where
  `kind ∈ {signing-key, product-secret}` (`keyvault.ts:65-78`). Adding a kind needs no envelope
  version bump; the AAD is designed for it. Values fit the 64 KiB admin body (`respond.ts:73`):
  `.p8` ≈ 250 B, Play JSON ≈ 2.3 KB.
- **The edge-mint escalation (must fix before storing any store key).**
  - `edgeMint[].signingKeySecret` is repo-authored. It is validated only for name shape
    (`shared-manifest/src/index.ts:1195-1204`), and `handleMintToken` opens **any** `product-secret`
    by that name (`services/config/mint.ts:228-234`).
  - The template may set `iss` and arbitrary claims such as `scope`; only `iat/exp/nbf/aud` are
    stripped, and `aud` comes from the recipe's `audience` (`mint.ts:169-181,253-260`).
  - The route is gated only by _a device token of this product_ (`mint.ts:214-219`). Under `open`
    registration anyone can get one.
  - So a repo writer, or a mistaken recipe, can turn a stored `.p8` into a **public App Store
    Connect token mint**. The recipe would be `alg: ES256`, `kid: <keyId>`,
    `claimsTemplate: {iss: <issuerId>}`, `audience: appstoreconnect-v1`, `ttlSeconds: 1200`.

  **Requirements:**
  1. Store outlet credentials under a distinct sealed kind (`outlet-credential`) in their own
     table.
  2. Make them unreachable from `openProductSecret` and edge-mint.
  3. Accept writes only from the platform admin (never from the manifest).
  4. Audit every use.
  5. Scope them least-privilege: Play SA "release to testing tracks" per app; an ASC role able to
     read build and review status if PKey only _observes_, keeping write keys in CI.

- **Who can trigger a submission.** Keep "submit to review / promote to production" either in CI
  (reviewed workflow + GitHub environment protection) or behind an explicit console action. It
  should never follow automatically from a `.pkey/` push. `.pkey/` is already an attacker-reachable
  control-plane input (`THREAT-MODEL.md:66-73`).

### 7.4 Reusing `mint.ts` to mint App Store Connect and Google tokens

**Reusable:** `signEs256` (`mint.ts:93-116`) and `signRs256` (`mint.ts:119-142`, PKCS#1 → PKCS#8
wrap at `77-90`).

- **App Store Connect.**
  - Required header: `{alg: ES256, kid: <Key ID>, typ: JWT}`. Payload: `iss` = issuer ID
    (team keys; individual keys use `sub: "user"`), `iat`, `exp` ≤ 20 minutes,
    `aud: "appstoreconnect-v1"`, optional `scope` (Apple's "Generating Tokens for API Requests").
  - `signEs256` emits exactly that header, and a `.p8` is already a PKCS#8 PEM, so
    `pemToDer` → `importKey("pkcs8")` works unchanged.
- **Google Play (service account).**
  - An RS256 JWT with header `{alg: RS256, typ: JWT, kid: private_key_id}` and claims
    `{iss: client_email, scope: "https://www.googleapis.com/auth/androidpublisher", aud: "https://oauth2.googleapis.com/token", iat, exp ≤ 1h}`,
    then a POST (`grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer`) for an access token.
  - `signRs256` handles the SA's PKCS#8 `private_key`.
  - Missing pieces: SA-JSON parsing, the token exchange, and a KV cache of the access token.
- **Microsoft Partner Center / Store submission.** Entra client credentials (tenant, client id,
  secret); no signing is needed. A certificate-credential variant needs an RS256 client assertion
  with an `x5t`/`x5t#S256` header that `signRs256` cannot currently emit (its header is fixed).
- **Steam / itch.** Not JWT-based; keep them in CI.
- **Do not reuse the route or `edge_mint_config`.** Extract the primitives into `core/jwt.ts`
  (RS256 is duplicated today in `services/release/githubApp.ts:67-120`) and call them from a
  server-side outlet connector that never returns a token to a client.

### 7.5 Threat-model updates

- `THREAT-MODEL.md:178-184` lists "a second release channel or artifact type is added" as a review
  trigger. This work hits it several times over.
- Add assets: outlet credentials (A3-class), the pack index key, R2 write credentials.
- Add adversaries/inputs: CI OIDC claims (semi-trusted, like `groups`), store webhooks (App Store
  Server Notifications, Play RTDN) if ever consumed, and the web-build origin.
- Extend AT-3 ("ship malicious code") with store submission and pack paths.
- Record the resync-overwrites-`entitled` finding (§2.3). It is a policy downgrade triggered by
  repo write, the same class as R6-03.

---

## 8. Reference index

- Manifest types/validator: `packages/shared-manifest/src/index.ts:13-47,85-245,267-284,380-411,462-1458,1460-1639`
- Schemas: `packages/shared-manifest/schemas/v1/{product,release,schema}.schema.json`
- Parity gate: `packages/shared-manifest/test/schema-parity.test.ts:1-17,228-678,740-760`
- Services authority: `packages/worker/src/core/services.ts`, `core/servicesAdmin.ts`, `core/registry.ts`, `core/discovery.ts`, `router.ts:41-47`, `mount.ts`
- Ingest: `services/release/{linkRepo,resync,sync,manifestFiles}.ts`, `core/ingest.ts`, `githubWebhook.ts`
- Release model: `services/release/{assets,store,channels,routes,surfaces,config,health,gateway,github}.ts`
- Update: `services/update/{index,feed,eligibility,admin}.ts`
- Edge mint / custody: `services/config/mint.ts`, `keyvault.ts`, `core/products.ts` (`openProductSecret`)
- Console: `packages/admin/src/{route,api}.ts`, `views/{Releases,UpdateSettings,ProductOverview,Identity}.tsx`, `views/licenses/DevicesSection.tsx`, `views/services/ServicesCard.tsx`
- Portal: `packages/admin/src/portal/{App,api}.tsx/ts`, `packages/worker/src/services/identity/portal/{index,api,repo}.ts`, `http.ts:64-70`
- CLI: `packages/cli/src/{index,manifest,bundle}.ts`
- Docs: `start/{concepts,service-model,architecture,quickstart}.md`, `build/{onboarding,registering}.md`, `build/manifest/*`, `admin/*`, `users/*`
- Ops/security: `docs/RUNBOOK.md`, `docs/DEPLOYMENT.md:132-151`, `docs/security/THREAT-MODEL.md`
- Diceroll: `README.md:25-38`, `docs/RELEASE.md:36-165`, `docs/design/2026-09-29-content-streaming.md:180-347,444-484`, `tools/ci/{altstore_source,update_manifest,stamp_version}.py`, `export_presets.cfg:34,105,109,267`, `.github/workflows/release.yml:126-130,189-190,286-341`
