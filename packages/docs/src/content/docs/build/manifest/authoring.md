---
sidebar:
  order: 2
title: "Authoring the manifest"
description: "The .pkey/ files and the ConfigEntry shape — schema, product, and release — using djdl as the worked example."
---

A Polaris Key product is **data, not code**. Its catalog, metadata, and release coordinates
live in a `.pkey/` directory in the product's own repo. The Worker, the admin SPA, and all
five SDKs read that data;
adding or changing a product never requires a Worker redeploy.

This doc is the source of truth for the `.pkey/` files and the `ConfigEntry` shape, using
**djdl** (the first product) as the worked example. The canonical terminology lives at
[Concepts & terminology](/docs/start/concepts/); the byte-for-byte wire contract lives in
`docs/security/WIRE-CONTRACT-V3.md`.

## The `.pkey/` directory

`.pkey/` is the **only** manifest directory. There is no second candidate directory and no
fallback between two: an interim design renamed it, and the dual-read that rename needed meant
every miss cost a second GitHub round trip and made "which file is actually live" a question you
had to trace through a fallback chain. Both were withdrawn.

The directory holds up to **four independent files**. The base name (no extension) selects the
role; the extension is a pure format preference, tried in the fixed order **`.json`, then
`.yaml`, then `.yml`**, resolved per document independently — so a repo may keep `product.yaml`
next to `schema.json`. The files are the **manifest baseline**: they describe intended product
defaults. Runtime admin changes such as secrets, license/device overrides, live service toggles,
and operator policy overrides live separately in Polaris Key and are preserved across resync.

| File        | Base name                 | Maps to                                                                                                                    | What it carries                                                                                                                                                |
| ----------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **schema**  | `schema.{json,yaml,yml}`  | `product_schema` row                                                                                                       | the config catalog: `{ schemaVersion, entries[] }` (**required**)                                                                                              |
| **product** | `product.{json,yaml,yml}` | `products` (incl. `services_json`, `web_origins_json`) + `oidc_config` + `profiles` + `tiers` + `provisioning_config` rows | product metadata, enabled services, device registration policy, OIDC, profiles, tiers, provisioning hooks (**required**)                                       |
| **release** | `release.{json,yaml,yml}` | provider-backed `release_config` + `release_deliverables` + `edge_mint_config` rows                                        | release provider coordinates + channel/install/appcast/edge-mint settings + the app deliverable and its artifact map (required only when releases are enabled) |

The fourth, optional file — **distribution** (`distribution.{json,yaml,yml}`, mapping to
`dist_outlets` + `dist_transports`) — declares the product's outlets, their store identities,
the transport per deliverable and the store listing. It has its own page:
[Distribution: outlets, transports and listing](/docs/build/manifest/distribution/).

In this repo the same data lives split for fixture clarity as `products/djdl/catalog.json`
(the schema) and `products/djdl/product.json` (product + release + edge-mint inlined). When
a product hosts its own `.pkey/`,
`packages/worker/src/services/release/manifest.ts#parseManifest` — Release's re-export of
`@polaris-key/manifest`, since repo ingest is a release-service path — parses the files,
aggregates **all** validation errors, and returns a `ParsedManifest` ready for D1 insertion. The
schema is compiled through `@polaris-key/catalog` before anything is written so malformed
JSON-Schema fragments fail during import/resync, not during a client request.

`pkey init` writes `product.yaml` and `schema.yaml` every time (plus `release.yaml` when releases
are selected): ingest requires the schema even when Config is off, and `pkey validate` applies the
same rule as link/resync, reporting a missing one as `missing_schema`. Without the `config`
module the scaffolded catalog is empty (`schemaVersion: 1`, `catalog: []`). The scaffolded tier
sets `policyDeviceLimit: 5` and no expiry; a tier `deviceLimit` is ignored and a tier
`maxOfflineDays` sets the licence expiry (`policyExpiryDays`), not offline grace, so `pkey
validate` warns with `tier_ignored_field` for either.

## The catalog: `ConfigEntry`

The schema file is a `ProductCatalog`: a `schemaVersion` (bumped on incompatible shape
changes; it matches the signed doc's `schemaVersion`) and an `entries` array. Each entry is a
`ConfigEntry` (`packages/shared-catalog/src/types.ts`) — a dotted `key`, a `kind`
(`config` plaintext setting · `secret` redacted, delivered in the config document · `flag` entitlement),
grouping/label/description for settings UIs, a Draft-07 JSON-Schema `schema` the value
validates against, a `default`, and — on `config`/`secret` keys — a `managementDefault`
(`default` · `enforced` · `hidden`) seeding the state a freshly-minted key gets:

```jsonc
// config — overridable by default
{
  "key": "run.concurrency",
  "kind": "config",
  "category": "Run",
  "label": "Parallel downloads",
  "schema": { "type": "integer", "minimum": 1, "maximum": 8 },
  "default": 3,
  "managementDefault": "default",
  "ui": { "widget": "stepper" },
}
```

On the **client**, a value resolves through one fixed precedence, honoring whichever
management state the signed document carries for that key:

```
enforced | hidden (remote)  >  local override  >  environment  >  remote default  >  fallback
```

`enforced`/`hidden` lock the remote value — local and env overrides never apply, and `hidden`
additionally withholds the key from `listUserConfig`/enumeration while `getConfig` still
applies it internally. A `default` (or an absent entry) falls through the rest of the chain to
the caller's `fallback`. The env override for a key is `PKEY_CONFIG_` + the key with dots →
`__` (`run.concurrency` → `PKEY_CONFIG_run__concurrency`).

The full field reference (`ui`/`dependsOn`/`accessor`/`appliesTo` and the rest), worked
`secret`/`flag` examples, and how management states are set and overridden per
tier/license/device live at [The config catalog](/docs/services/config/catalog/). The
`ConfigEntry` type itself, reproduced verbatim, is at
[ConfigEntry — the catalog item shape](/docs/reference/config-entry/).

## Enabled services: `modules` + `devices.registration`

Polaris Key is six opt-in services — **license, config, release, distribution, update,
identity** — over an
always-on Core substrate (see [Concepts & terminology](/docs/start/concepts/)). `.pkey/product` declares which of them the
product runs, and that declaration is persisted verbatim into `products.services_json`, the
single authority every other surface projects from. It used to be validated and then thrown
away, which is how four surfaces each ended up re-deriving enablement from the presence of some
child row.

```jsonc
{
  // Every entry is `{ "enabled": <boolean> }`; a key present with `enabled` anything other than
  // literal `true` counts as off. Unknown module names are ignored rather than fatal — a
  // manifest naming a service this build has not heard of is not a reason to refuse the product.
  "modules": {
    "license": { "enabled": true },
    "config": { "enabled": true },
    "release": { "enabled": true },
    "distribution": { "enabled": true },
    "update": { "enabled": true },
    "identity": { "enabled": true },
  },

  "devices": {
    // Who may mint a device token at POST /<product>/devices/register (a Core route, present
    // under every policy). OPTIONAL — omit it to follow the services.
    //   open              → any caller, rate-limited by edge IP, fingerprint optional
    //   requires-identity → only behind a live product browser session
    //   requires-license  → refused; activation/enrollment are the only mint paths
    "registration": "requires-license",
  },
}
```

**Defaults.** A manifest with no `modules` block — or one whose every entry is off — gets
`license` + `config` enabled and the rest off, which is exactly how every product behaved before
the block was persisted. `devices.registration` is optional and stays optional in storage:
undeclared means "derive from the services" (`requires-license` if license is on, else
`requires-identity` if identity is, else `open`), which is a different thing from someone having
chosen `open`. A product that later turns license off must move to the derived `open`, not stay
pinned to a value nobody wrote.

**The legacy vocabulary still parses.** The pre-suite module names are translated to service
slugs at ingest and only slugs are stored, so a manifest in the field does not have to be
rewritten on the day the server learns the new words, and one block may mix both spellings:

| Declared    | Enables                               | Note                                                                                                                                          |
| ----------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `licensing` | `license`                             | rename                                                                                                                                        |
| `releases`  | `release` + `distribution` + `update` | the old module meant "distributes software"; mapping it to `release` alone would take the appcast away from every product already serving one |
| `oidc`      | `identity`                            | rename                                                                                                                                        |
| `edgeMint`  | `config`                              | edge-minting is a secret-**delivery** capability of Config, not a unit of its own                                                             |

**Validation at ingest.** `parseManifest` aggregates every error before it refuses, and a refusal
applies nothing:

- `distribution_requires_release` — **error**. Distribution delivers what Release says exists,
  so Distribution on with Release off has nothing to deliver.
- `update_requires_distribution` — **error**. Update's feed tells a device what to do next over
  what Distribution delivered, so Update on with Distribution off would answer every client with
  an empty document rather than an error. A `releases` manifest can never trip either rule: the
  mapping brings the whole chain with it. A manifest naming `release` and `update` without
  `distribution` does trip this one. (These two replaced `update_requires_release`, which they
  imply.)
- `invalid_registration_policy` — **error**. An unrecognised `devices.registration` is refused
  rather than coerced; silently falling back to a default would answer "requires-license" with
  "open" for the one manifest that most meant it.
- `config_without_activation` — **warning**, when `config` is on with neither `license` nor
  `identity`. It stays a warning because a config-only product issuing config documents to
  registered devices is the wire-level proof that the services are independent, not a mistake.
  The enablement API applies the same code as a hard **error** for the one combination that is
  genuinely unreachable — `config` on, `license` off, and a declared `requires-license` policy,
  which closes the only mint path such a product has.
- `registration_requires_identity` is enforced by the enablement API
  (`PATCH /manage/api/products/<slug>/services`), not at manifest ingest.

**Live toggles.** Services can also be changed from the admin panel; a live edit claims the
column (`services_source` flips `manifest` → `admin`) so a later push cannot silently turn a
service back on, nor re-open registration after an operator closed it. "Revert to manifest" flips
ownership back and changes nothing else — the manifest re-applies on the next resync, not
immediately, so the operator's escape hatch never depends on a GitHub round trip that can fail.

## Browser origins: `web.origins`

`web.origins` lists up to 16 exact origins, such as `https://play.acme.example` or
`http://localhost:8060`, that may read this product's device-facing responses from a browser
with `fetch`. It is persisted to `products.web_origins_json`. Link writes it and every resync
rewrites it; dropping the block clears it. There is no console override. Entries must be spelled
exactly as a browser sends `Origin`, and ingest refuses anything else (`invalid_web_origins`,
`invalid_web_origin`). Credentials are never allowed, and the cookie-bearing identity routes,
the console, the portal and the docs never answer CORS. The rules, headers and covered routes
are at [Web clients and CORS](/docs/build/web-cors/).

```jsonc
{
  "web": {
    "origins": ["https://play.acme.example", "http://localhost:8060"],
  },
}
```

## Device policy: fingerprinting + auto-issued licenses

Both blocks live in `.pkey/product` and are applied on link/resync. Either can also be changed
live from the admin panel; a live edit takes ownership of that block so a later resync cannot
silently revert it (`fingerprint_policy_source` / `auto_issue_source`). "Revert to manifest"
hands ownership back.

```jsonc
{
  "fingerprint": {
    // On by default. Set false to collect no hardware components at all.
    "enabled": true,
    // Drift tolerance a tier inherits unless it sets its own `policyFingerprint`:
    //   off (never enforce) · lenient (4) · normal (2, default) · strict (0, and required)
    "defaultMode": "normal",
    // Companion apps this product cares about. Clients answer only these — there is no
    // installed-application enumeration. Omit a platform to skip the probe there rather
    // than reporting a misleading "not installed".
    "probes": [
      {
        "id": "rekordbox",
        "label": "rekordbox",
        "macos": "/Applications/rekordbox 7.app",
        "windows": "C:\\Program Files\\Pioneer\\rekordbox 7\\rekordbox.exe",
      },
    ],
  },

  "autoIssue": {
    // Off unless you opt in. A policy naming no tier counts as off.
    "enabled": true,
    "tierId": "free",
    // anonymous  → opens POST /<product>/license/enroll (keyless, one license per machine)
    // oidcDefault→ an authenticated user matching no IdP group lands on this tier
    // both       → both paths
    "mode": "both",
    "rateLimitPerHour": 10,
  },
}
```

A tier can tighten fingerprint enforcement for itself:

```jsonc
{ "tiers": [{ "id": "pro", "label": "Pro", "policyFingerprint": "strict" }] }
```

See [Privacy](/docs/users/privacy/) for exactly what a fingerprint contains and how long it is kept.

## Release deliverables: `deliverables.app` and the artifact map

A `.pkey/release` document may declare the product's **app deliverable** and an **artifact
map** that says what every file of a release is. Without the block the product keeps the
implicit `app` deliverable and its release files are classified by filename, as before (a
`.dmg` is macOS, `-arm64` is arm64, and an `.apk`, `.ipa`, `.exe` or `.pck` is just `other`).
With it, files are classified **by declaration, not by sniffing**:

```yaml
# .pkey/release.yaml
release:
  provider: { type: github, owner: vladzaharia, repo: diceroll }
  deliverables:
    app:
      kind: app
      versioning:
        scheme: semver # or semver+build, 4part
        stableTagPattern: "v\\d+\\.\\d+\\.\\d+"
        ignoreTags: [channels, packs]
        buildNumber: descriptor # or none
      channels:
        beta: { includes: [stable] } # beta also offers every stable release
      artifacts:
        - {
            id: macos,
            platform: macos,
            arch: universal,
            format: dmg,
            match: "Diceroll-*-macos.dmg",
          }
        - {
            id: win-zip,
            platform: windows,
            arch: x86_64,
            format: zip,
            match: "Diceroll-*-windows-x86_64.zip",
          }
        - {
            id: apk,
            platform: android,
            arch: any,
            format: apk,
            match: "Diceroll-*-android.apk",
          }
        - {
            id: web,
            platform: web,
            arch: wasm32,
            format: zip,
            match: "Diceroll-*-web.zip",
          }
```

- **`kind`** is required. `app` is the product's application; any other id must be
  `kind: pack`, a content pack (below).
- **`versioning.stableTagPattern`** and **`versioning.ignoreTags`** are the same two fields
  the release root already accepts (same rules, same `release_config` columns). Spell them in
  one place: declaring them both at the root and here is `conflicting_versioning`.
- **`channels`** keys are canonical channel names (lower-case letters, digits, `-`; not the
  aliases `staging` or `latest`). `includes` may name `stable`, `beta`, a manual channel or
  another declared channel, by its canonical name, and may not loop
  (`invalid_channel_includes`). A manual channel whose name is not canonical (`Nightly.2`)
  cannot be included.
- **`artifacts`**: each entry is one **build**. `id` is the build id; `platform` is one of
  `macos`, `ios`, `android`, `windows`, `linux`, `web`; `arch` one of `arm64`, `x86_64`,
  `universal`, `armv7`, `wasm32`, `any`; `format` is the file type. `role` defaults to
  `payload`. Installer versus portable is a **format** (`zip` versus `exe`/`msi`), not a role.
  `match` is an anchored, case-sensitive glob: `*` is any run of characters, `?` exactly one,
  everything else literal, at most 128 characters.
- A file named `<payload>.sig` or `<payload>.sha256` is that build's signature or checksum.
  An entry that matches two files of one release classifies neither (it is ambiguous), and a
  file no entry matches has no build.

- **`embeds`** (optional, on an `artifacts` entry) lists the packs that build ships inside
  it: declared pack ids, at most 64 (`invalid_build_embeds`). Omitted means every
  `baseline: embedded` pack; `[]` means none, as for a lean web build.

### Pack deliverables

Any deliverable other than `app` is a content pack (`kind: pack`): data the app loads at run
time, released on its own versions, and pinned by app releases or resolved per live contentApi
level. See [Packs](/docs/services/release/packs/) for what Release does with them. The
validator accepts this set of fields, so a manifest never declares behaviour that is not
delivered:

```yaml
deliverables:
  app:
    kind: app
    content:
      contentApi: 3 # required once any pack is declared
      packChannels: { "diceroll.events.*": events } # optional: route pack families
    artifacts:
      - {
          id: macos,
          platform: macos,
          arch: universal,
          format: dmg,
          match: "Diceroll-*-macos.dmg",
          embeds: [diceroll.core3d],
        }
  diceroll.core3d:
    kind: pack
    type: godot.pck # or files.tree
    binding: pinned # pinned (the default) | compatible | standalone
    baseline: embedded # store builds ship it; default none
    required: true # a required pack is essential and ungated
    delivery: essential # essential | prefetch | on-demand (default)
    handler: { mountOrder: 2, prefixes: ["res://assets/kaykit/"] }
    variants: { texture: [s3tc, etc2, astc] }
    requires: { engine: godot-4.7 }
    patch: { strategies: [delta, file, chunk], deltaBases: 1 }
  diceroll.supporter.skins:
    kind: pack
    type: godot.pck
    delivery: on-demand
    handler: { prefixes: ["res://skins/"] }
    requires: { engine: godot-4.7 }
    entitlement: extras.diceSkins # an assertion of the operator's gate (below)
  diceroll.foes:
    kind: pack
    type: files.tree
    binding: compatible # the newest release whose contentApi range holds each live level
    requires:
      contentApi: { app: ">=3 <5" } # required for compatible, refused for standalone
      packs: { diceroll.l10n: ">=2.0.0" } # other compatible or standalone packs
    conflicts: [diceroll.supporter.skins]
  diceroll.l10n:
    kind: pack
    type: files.tree
    binding: standalone # every level's newest release; no contentApi
    variants: { locale: [en, fr] }
  diceroll.events.halloween:
    kind: pack
    type: files.tree
    binding: compatible
    channels: [events] # where its releases may be published beyond stable and beta
    requires: { contentApi: { app: ">=3" } }
```

- At most **64** packs (`too_many_pack_deliverables`).
- **`type`** is required: `godot.pck` or `files.tree` (`invalid_pack_type`). A `godot.pck`
  pack declares `handler.prefixes` (the `res://` directories it mounts, each ending in `/`),
  activates on `restart`, and declares `requires.engine` (`godot-<major>.<minor>`). A
  `files.tree` pack takes no `prefixes` or `mountOrder` and activates `hot` by default
  (`invalid_pack_handler`, `invalid_pack_requires`).
- **`binding`** is `pinned`, `compatible` or `standalone` (`invalid_pack_binding`): `pinned`
  means each app release pins the exact pack release it ships with; `compatible` means Release
  resolves the newest release whose `requires.contentApi` range holds each live contentApi
  level; `standalone` means the newest release for every level.
- **`baseline`**, **`required`**, **`delivery`** and **`contentPolicy`** (`{ dataOnly: true }`,
  the only v1 value) are `invalid_pack_policy` when malformed; a `required` pack must be
  `delivery: essential` and carry no `entitlement`.
- **`variants`** maps an axis (`texture`, `locale`, `quality`) to 1–16 values; the product of
  the counts is at most 32 (`invalid_pack_variants`). CI publishes one variant per combination.
- **`requires`** is `{ engine?, contentApi?, packs? }` (`invalid_pack_requires`; `features` has
  no meaning yet). `contentApi` is keyed by the app deliverable, `app`
  (`unknown_content_api_app`), each value one to four comparators such as `">=3 <5"`; a
  `compatible` pack declares it (`missing_content_api_range`) and a `standalone` one never does
  (`standalone_with_content_api`). `packs` names other declared compatible or standalone packs,
  each with a version range under that pack's scheme. CI signs these into each variant of every
  pack record.
- **`conflicts`** lists 1–64 other declared packs this one never shares a resolved set with
  (`invalid_pack_conflicts`).
- **`channels`** lists 1–32 canonical channels the pack's releases may be published to beyond
  `stable` and `beta` (`invalid_channel`).
- **`entitlement`** asserts the licence flag that gates the pack; it must name a `flag` entry of
  `.pkey/schema` (`unknown_entitlement_ref`). It is **not** the gate: an operator gates a pack
  under Distribution → Access, and a publish whose gate differs from the assertion is refused.
  No push can gate, un-gate or re-flag a pack.
- **`patch`**: `strategies`, a non-empty subset of `delta`, `file` and `chunk` (default: all
  three; `chunk` gives every container variant of 4 MiB or more a chunk index and shared chunk
  bundles, and an explicit list without it opts out); `deltaBases`, 0–8 (default 1)
  (`invalid_pack_patch`). List `chunk` explicitly only once your Worker and CLI support it: an
  older Worker's resync and an older CLI's validation refuse it.
- **`versioning.scheme`** as for the app (default `semver`).
- **`provides`** and **`removes`** are refused for now (`pack_field_not_supported`).
- **`deliverables.app.content.packChannels`** maps 1–64 pack ids or `prefix.*` patterns to a
  channel (`invalid_pack_channels`); each key must match a declared pack that publishes to that
  channel (`unknown_pack_channels_target`). `content.holds` is never declared: an app release
  holds a pack at publish, in its content stamp (`invalid_app_content`).

Resync writes the declaration to `release_deliverables.def_json` (and each channel's
`includes` to its channel policy, unless an operator owns that channel). The map also defines
what a **release descriptor** may say about a release: see
[Artifacts](/docs/services/release/artifacts/#declared-artifacts-and-release-descriptors).
Every rule above has a code on
[Manifest validation codes](/docs/reference/validation-codes/).

## Trusted publishing: `publishing.trustedPublisher`

To let a GitHub Actions workflow publish releases without a stored secret, name it in
`.pkey/release` (P2-02):

```yaml
publishing:
  trustedPublisher:
    workflow: .github/workflows/release.yml # as GitHub's job_workflow_ref spells it
    environment: release # optional; the default
```

- `workflow` is required: a path under `.github/workflows/` ending in `.yml` or `.yaml`
  (`invalid_trusted_publisher_workflow`).
- `environment` is a GitHub environment name: letters, digits, space, `.`, `_`, `-`, at most
  100 characters, no leading or trailing space (`invalid_trusted_publisher_environment`).
- Nothing else is a field. Link and resync add the repository's numeric id and owner id from
  GitHub; the checks that the ref is protected, the runner is GitHub-hosted and the event is
  `push`, `release` or `workflow_dispatch` are fixed; the scopes (default `release:publish`,
  `release:promote`, `distribution:report`; `release:yank` and `distribution:rollout` are
  opt-in) are an operator setting. A repository cannot
  loosen its own policy.
- The ref the workflow runs on must be covered by a branch or tag ruleset, or GitHub reports
  `ref_protected: false` and the exchange is refused. Give the environment required reviewers
  unless every writer may publish.
- While the policy is manifest-owned, every resync re-applies it (and removing the block removes
  it). An operator who claims it in the console's admin API owns it from then on.

The flow CI follows is on [Artifacts](/docs/services/release/artifacts/#trusted-publishing).

## Release keys: `releaseKeys`

A release record (`pkey-release+jws`) is what CI signs to say a release exists: its version,
`seq` and builds, with each payload's SHA-256 and size. The Worker never holds a release key, so
it can point devices at a release but cannot invent one. Declare the public halves in
`.pkey/release` (P3-03):

```yaml
releaseKeys:
  - kid: ci-2026 # the JWS kid CI signs under
    publicKey: 11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo # raw Ed25519, base64url
```

- `pkey release keys generate --kid ci-2026 --out release-key.pem` prints the entry to paste here
  and writes the private key for a GitHub Environment secret (`PKEY_RELEASE_KEY`). The private
  key never goes in the repository.
- 1 to 4 entries; `kid` matches `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` and `publicKey` is the raw
  32-byte key in unpadded base64url, 43 characters (`invalid_release_key`). Two keys at once is
  a rotation: add the new one, publish with it, then remove the old one.
- A non-canonical or small-order key is refused (`weak_release_key`), and so is a repeated
  `kid` or key (`duplicate_release_key`) and a key equal to `sparkleEd25519Pub`
  (`release_key_reused`: one key must never sign both archive bytes and JWS inputs).
- The sync refuses a release key equal to any of the product's signing keys, current or
  retired (`release_key_is_product_key`), and keeps the previous `releaseKeys`.
- Apps pin the same keys in their binaries; a record verifies only against pinned release
  keys, never against the product's trust set.
- `contentKeys` is not used and draws a warning (`content_keys_not_supported`). The manifest is
  unsigned, so it can never grant trust: delegate a content key with `pkey release delegate`,
  which signs a `kind: delegation` record with the release key. That signed delegation is the
  only grant (P4-19).

Without `releaseKeys` a publish carries no record and the signed update feed offers none of that
product's releases.

## Registering + re-syncing a product

There are three ways the catalog reaches D1. Repo-link is the normal product setup path;
manual create is for early experiments; seed SQL is a fixture tool only.

1. **Repo-link (preferred).** The product hosts a `.pkey/` directory. The admin links the
   repo; the Worker fetches + `parseManifest`s the three files and registers the product.
   Re-linking or a signed GitHub push webhook re-parses and updates the rows. Webhook sync
   is pinned to the pushed commit SHA, records changed `.pkey/` paths, and surfaces applied
   sections or validation errors in the admin Releases view.
2. **Manual schema create.** The admin can create a product with metadata plus a schema
   JSON/YAML document. Polaris Key still mints the sealed product signing key, but release,
   OIDC, provisioning, profiles, tiers, and edge-mint rows are configured later in admin or
   by linking a repo.
3. **Seed SQL (fixture generation only).** Generate fixture SQL from the monorepo's
   `products/<slug>` files:

   ```sh
   pnpm --filter @polaris-key/products gen-seed djdl > products/djdl/seed.sql
   ```

   Do not use this for live onboarding: it cannot mint sealed `product_keys` or store
   product secret values. Normal product registration must use the admin portal so Polaris Key
   can mint the sealed signing key, return the public trust key, and list missing product
   secrets.

### Product OIDC

`oidc.provider` selects the product's single OIDC login provider:

- `platform` is the default. The product uses `PLATFORM_OIDC_ISSUER` and
  `PLATFORM_OIDC_CLIENT_ID`; the manifest keeps product-scoped redirect allowlists,
  `groupRoleMap`, and provisioning hooks.
- `custom` uses the product's own `issuer`, `clientId`, optional `clientSecretSecret`,
  redirect allowlist, `groupRoleMap`, and provisioning hooks.

SDK discovery only reports whether OIDC is enabled and which generic auth URLs to call. It
does not expose whether a product uses platform or custom OIDC.

### Admin override vs re-sync

Admins set **management state + values** (per profile/tier/license/device) and operational
runtime overrides in the admin SPA. Those values live in D1 and are **not** overwritten by a
re-sync. A re-sync updates the manifest baseline from `.pkey/`: product metadata, service
enablement + registration policy, fingerprint and auto-issue policy, catalog shape, OIDC
baseline, release baseline, profiles, tiers, provisioning, and edge-mint recipes. The three
operator-claimable blocks (`services_source`, `fingerprint_policy_source`, `auto_issue_source`)
are skipped while an admin owns them, and so is the trusted-publisher policy once claimed. So the flow is:

1. Edit `.pkey/schema` in the product repo (add a key, tighten a schema, change a
   `managementDefault`); bump `schemaVersion` only on an incompatible shape change.
2. Re-link / push → the Worker re-parses and updates `product_schema`; SDKs pick up the new
   catalog at `/<product>/config/schema` and the next signed config document at
   `/<product>/config/document`.
3. Existing admin value/state overrides persist; new keys take their `managementDefault`
   until an admin overrides them. The admin UI should label whether a value came from the
   manifest baseline, an admin override, a generated signing key, a configured secret, or a
   provider-discovered runtime value.

When you author a typed mirror for a product that wants compile-time config types, regenerate
it from the catalog with
`pnpm gen:mirrors -- --catalog <catalog.json> --out-dir <mirror-dir>` (and add `--check`
in product-specific CI) — see `CONTRIBUTING.md`. `--lang` picks the targets (`ts`, `python` and
`swift` by default, plus `gdscript` for a Godot game's `catalog_generated.gd`).
