---
title: "Product manifest"
description: "Declare the product, its services, origins, presentation, licensing and sign-in settings in .pkey/product."
type: "reference"
lastReviewed: "2026-10-16"
sidebar:
  order: 2
---

A product is data. `.pkey/product` holds its identity, the services it runs, browser origins, presentation, device policy, licensing defaults and sign-in settings. The Worker, the console and every SDK read that data, so changing a product never needs a Worker deploy.

This page covers `.pkey/product`. The catalog is on [Catalog](/docs/build/manifest/catalog/), releases and packages on [Release manifest](/docs/build/manifest/release/), and store listings on [Distribution](/docs/build/manifest/distribution/). The words are defined on [Concepts](/docs/start/concepts/).

## Where the file lives

`.pkey/product` is one of the manifest's files, in `.json`, `.yaml` or `.yml`. [The `.pkey/` manifest](/docs/build/manifest/) lists the files and what each carries, and [Register a product](/docs/build/manifest/register/) links the repository. The file is required. Runtime changes made in the console, such as secrets, license and device overrides, service switches and operator policy, live separately and survive a resync.

Polaris Key parses the files, reports **all** validation errors at once, and compiles the schema before anything is stored, so a malformed fragment fails at link or resync, not in a client request.

`pkey init` writes `product.yaml` and `schema.yaml` every time (plus `release.yaml` when releases
are selected): ingest requires the schema even when Config is off, and `pkey validate` applies the
same rule as link/resync, reporting a missing one as `missing_schema`. Without the `config`
module the scaffolded catalog is empty (`schemaVersion: 1`, `entries: []`). The scaffolded tier
names its profile with `profileId` and sets `policyDeviceLimit: 5` and no expiry; a tier `deviceLimit` is ignored and a tier
`maxOfflineDays` sets the license expiry (`policyExpiryDays`), not offline grace, so `pkey
validate` warns with `tier_ignored_field` for either. A tier's offline grace default is
`policyOfflineGraceDays` (0 to 365 days; omitted, the product default applies).

A device limit is a whole number of devices: `licensing.defaultDeviceLimit` and a tier's
`policyDeviceLimit` take 0 to 1000 (`MAX_DEVICE_LIMIT` in `@polaris-key/manifest`). A larger value
fails validation with `invalid_device_limit` and the whole manifest is refused, never clamped,
because the number bounds the work every activation does to find room for another device. The console and the
settings API hold the same ceiling.

A tier's `rank` (an integer from 0, default 0, not unique) says which tier is better. When an
identity's groups map to several tiers, sign-in picks the highest-ranked one; equal ranks keep the
first match. With `oidc.syncTierOnSignIn: upgradeOnly`, a sign-in moves an existing license to a
higher-ranked tier and never changes its expiry.

## Deprecated spellings

Some fields have more than one spelling, because the manifest grew in steps. Every spelling below
still validates and still means what it always meant: when a document sets both the old and the
canonical spelling, the reader keeps the precedence it has always had. `pkey validate` (and an
editor that reads the published JSON Schemas, which mark each old spelling `deprecated`) warns
instead:

- `deprecated_spelling`: the document uses an old spelling. The message names the canonical one.
- `conflicting_spelling`: the document sets both. The message names the value that is used.

The canonical layout is the one `pkey init` writes: `product:` for identity and compatibility,
`licensing:` for license defaults and tiers, `profiles:` at the root, and `release:` in `.pkey/release`. The
list is `DEPRECATED_SPELLINGS` in `@polaris-key/manifest` (`packages/shared-manifest/src/spellings.ts`),
and it is what the validator, the schemas and the settings registry's parity test all read.

| Document     | Old spelling                                                  | Write instead                                                                                   | When both are set                                                                |
| ------------ | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| product      | `slug`, `name` at the root (a flat document)                  | `product.slug`, `product.name`                                                                  | the canonical value is used                                                      |
| product      | `compatMin`, `compatMax` at the root                          | `product.compatMin`, `.compatMax`                                                               | the canonical value is used                                                      |
| product      | `defaultDeviceLimit` at the root or under `product:`          | `licensing.defaultDeviceLimit`                                                                  | the old value is used                                                            |
| product      | `defaultMaxOfflineDays` at the root or under `product:`       | `licensing.defaultMaxOfflineDays`                                                               | the old value is used                                                            |
| product      | `tiers` at the root                                           | `licensing.tiers`                                                                               | the old value is used                                                            |
| product      | `licensing.profiles`                                          | `profiles` at the root                                                                          | the canonical value is used                                                      |
| product      | tier `profile`                                                | tier `profileId`                                                                                | the canonical value is used                                                      |
| product      | tier `expiryDays`                                             | tier `policyExpiryDays`                                                                         | the canonical value is used                                                      |
| product      | profile `label`                                               | profile `name`                                                                                  | the canonical value is used                                                      |
| product      | `oidc.clientSecretRef`                                        | `oidc.clientSecretSecret`                                                                       | the canonical value is used                                                      |
| product      | `release` (the release document inlined)                      | the `.pkey/release` document                                                                    | `.pkey/release` is used                                                          |
| product      | `modules` names `licensing`, `releases`, `oidc`, `edgeMint`   | the service slugs `license`, `release` (with `distribution` and `update`), `identity`, `config` | both are read                                                                    |
| schema       | `catalog`                                                     | `entries`                                                                                       | `entries` is used                                                                |
| release      | the release body at the document root (no `release:` wrapper) | the same fields under `release:`                                                                | the wrapper is used; the root is ignored                                         |
| release      | `ghOwner`, `ghRepo`                                           | `provider: { type: github, owner, repo }`                                                       | the old value is used                                                            |
| release      | `stableTagPattern`, `ignoreTags` in the release body          | `deliverables.app.versioning.*`                                                                 | refused: `conflicting_versioning`; no warning on its own yet                     |
| release      | `edgeMint` in the release document                            | `edgeMint` in `.pkey/product`                                                                   | `.pkey/product`'s is used; under `release:` it is never read                     |
| distribution | `listing.iconUrl`, `listing.headerUrl`                        | `listing.icon`, `listing.header`                                                                | refused: `listing_field_conflict`; alone it warns `listing_url_field_deprecated` |

The file extension is not a spelling: `product.json`, `product.yaml` and `product.yml` are a
format preference. Keep one file per document, though: when more than one exists only the first
of `json`, `yaml`, `yml` is read, and `pkey validate` says so.

Refusing the old spellings is a later, separate decision. Until then a manifest that validated
before keeps validating, with warnings.

## Display names

The customer's sign-in card says "<App> wants you to sign in" and names the developer, so the
names an app is shown by are checked (): `product.name`, and the `.pkey/distribution`
document's `listing.name` and `listing.developerName`.

- **`invalid_display_text`** (always an error). The name holds a control character, a zero-width
  character or a bidirectional-formatting character (an override such as U+202E, an isolate, a
  mark), or it starts or ends with whitespace. Per-outlet listing names are held to this rule
  too. The JSON Schemas carry it as a pattern, so editors flag it as you type.
- **`reserved_display_name`**. The name contains a platform or store name as whole words:
  Polaris, Polaris Key, plrs, Apple, App Store, Google, Google Play, Steam, Valve, Epic Games,
  Microsoft, Xbox, PlayStation, Nintendo or itch.io. Case, width, accents, look-alike letters
  (Cyrillic and Greek), `0` for `o`, `1` for `l`, `rn` for `m` and separators are folded first,
  so `P0laris-Key` and `ＳＴＥＡＭ` match, and a multi-word term written as one word (`GooglePlay`)
  matches too. `Applesauce Games` and `Steamroller` do not. It is a **warning** by default (`pkey
validate` prints it and link and resync accept it); the platform setting
  `IDENTITY_RESERVED_DISPLAY_NAMES` (platform admins) turns
  it into an error after a window of two minor releases or 60 days, whichever is later. Either
  way, the sign-in card shows such a product by its slug in a neutral frame.

## Enabled services: `modules`

Polaris Key's opt-in services — **license, config, release, distribution, update, identity, sync**
— run over an always-on Core substrate. `.pkey/product` declares which services the product runs,
and that declaration is persisted into `products.services_json`, the single authority every other
surface projects from.

```jsonc title=".pkey/product"
{
  // Every entry is `{ "enabled": <boolean> }`. Unknown module names are ignored so a manifest
  // can survive a newer service table; known services are validated as one set.
  "modules": {
    "license": { "enabled": true },
    "config": { "enabled": true },
    "release": { "enabled": true },
    "distribution": { "enabled": true },
    "update": { "enabled": true },
    "identity": { "enabled": true },
  },
}
```

**Defaults.** A manifest with no `modules` block — or one whose every entry is off — gets
`license` + `config` enabled and the rest off, which is how every product behaved before the
block was persisted.

**Requirements.** A manifest that enables a service without what it requires is refused. [How it works](/docs/start/how-it-works/#coherence-rules) has the one table of rules, codes and severities. The console follows the same rule: turning a requirement off cascades to its enabled dependents in one audited change, and turning it back on restores none of them. To enable a chain, enable each service first, or use a feature action such as **Ship builds**, which writes Release, Distribution and Update together.

**Device registration is derived.** It is not a `product` manifest setting. The effective policy
is `requires-license` when License is on; otherwise `requires-identity` when Identity is on;
otherwise `open`. See [The device principal](/docs/reference/protocol/device-principal/) for the
wire behavior.

**The legacy vocabulary still parses, and is deprecated.** The pre-suite module names are
translated to service slugs at ingest and only slugs are stored:

| Declared    | Enables                               | Note                                                                                      |
| ----------- | ------------------------------------- | ----------------------------------------------------------------------------------------- |
| `licensing` | `license`                             | rename                                                                                    |
| `releases`  | `release` + `distribution` + `update` | the old module meant "distributes software", so it maps to the complete Ship builds chain |
| `oidc`      | `identity`                            | rename                                                                                    |
| `edgeMint`  | `config`                              | edge-minting is a secret-**delivery** capability of Config, not a unit of its own         |

**Live changes.** Services can also be changed from the admin panel; a live edit claims the
column (`services_source` flips `manifest` → `admin`) so a later push cannot silently turn a
service back on. **Revert to manifest** flips ownership back and changes nothing else; the
manifest re-applies at the next resync.

## Cloud Sync storage

`.pkey/product` has no `cloudSync` block, and `pkey validate` refuses one. A person's storage is
the `pkey.cloudSync.bytes` entitlement, read from the anchor license: a tier, a license override
or an add-on sets it, and 256 MiB applies when nothing does. A signed-in person with no usable
license gets 1 MiB and no files. Declaring a `cloudSync` block, or a `user` block that syncs,
while the `sync` service is off is a warning, not an error: settings stay on the device until it
is on.

```jsonc title=".pkey/product"
{
  "modules": {
    "config": { "enabled": true },
    "identity": { "enabled": true },
    "sync": { "enabled": true },
  },
}
```

## Browser origins: `web.origins`

`web.origins` lists up to 16 exact origins, such as `https://play.tidewater.example` or `http://localhost:8060`, that may read this product's device-facing responses from a browser with `fetch`. A link writes the list and every resync rewrites it; dropping the block clears it.

To set the list without a repository, open **Core → Settings → Web origins** and edit **Allowed origins**. An edit there takes the field from the manifest, so later pushes leave it alone. **Revert to manifest** hands it back, and the manifest's list applies at the next resync.

Entries must be spelled exactly as a browser sends `Origin`, and ingest refuses anything else (`invalid_web_origins`, `invalid_web_origin`). Credentials are never allowed, and the cookie-bearing identity routes, the console, Polaris Locker and the docs never answer CORS. The rules, headers and covered routes are at [Web apps and CORS](/docs/build/web-apps/).

```jsonc title=".pkey/product"
{
  "web": {
    "origins": ["https://play.tidewater.example", "http://localhost:8060"],
  },
}
```

## Presentation: `presentation`

`presentation` is how the product shows itself: its `icon`, its `accent` color and its
`accentDark` color for a dark ground (each `#rrggbb`). It lives in `.pkey/product`, so a product
without the Distribution service still has an icon. Every member is optional. A malformed block
or color is `invalid_presentation`.

The icon is an **asset ref**, the same grammar as the store listing's art:

- an https URL of at most 2048 characters; or
- a path in the product's own repository, read at the commit being synced, so it works for a
  private repository. A repo path may start with `./`, never with `/`, has no `.` or `..`
  segment, has at most 512 characters, and ends in `.png`, `.jpg`, `.jpeg`, `.webp`, `.gif` or
  `.avif` (lower case). SVG is never accepted.

Either form may be written as an object `{ src, sha256 }`, where `sha256` (64 lower-case hex
digits) pins the bytes. A malformed ref is `invalid_asset_ref`. Validation never fetches the
file.

```yaml title=".pkey/product"
presentation:
  icon: .pkey/art/icon.png
  accent: "#2ED6E6"
  accentDark: "#7FE9F2"
```

## Device policy: fingerprinting + auto-issued licenses

Both blocks live in `.pkey/product` and are applied on link/resync. Either can also be changed
live from the admin panel; a live edit takes ownership of that block so a later resync cannot
silently revert it (`fingerprint_policy_source` / `auto_issue_source`). "Revert to manifest"
hands ownership back.

```jsonc title=".pkey/product"
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

```jsonc title=".pkey/product"
{ "tiers": [{ "id": "pro", "label": "Pro", "policyFingerprint": "strict" }] }
```

See [Privacy](/docs/help/your-data/) for exactly what a fingerprint contains and how long it is kept.

## Licensing settings: `licensing.*`

How licenses, grants and entitlements combine for the product. Each is optional, declared under
`licensing:` in `.pkey/product`, and applied on link and resync. Each can also be changed in the
console (**License → Settings**): a console change claims that one setting, so later resyncs
leave it alone until **Revert to manifest** hands it back and applies the manifest's value at
once. Dropping a setting from the manifest returns it to its default.

```jsonc title=".pkey/product"
{
  "licensing": {
    // legacy: a device sees its own license's entitlements (today's model).
    // combined: a device sees the combined entitlements of every license and grant its holder
    // has. Undeclared: legacy for products registered before 2026-10-06, combined after.
    "entitlementModel": "combined",
    // device (default): the account signed in on the device. owner: the license owner's whole
    // set, so anyone with a shared key reaches everything the owner holds.
    "entitlementHolder": "device",
    // End offline grace no later than the license's expiry (default true).
    "clampGraceToExpiry": true,
    // Which of a holder's licenses a device runs on: rank-first (default), most-free-seats, oldest.
    "anchorPolicy": "rank-first",
    // When a device may move to a better license: never, or onActivation (default).
    "reanchor": "onActivation",
    // Hours a refunded grant keeps working before it is revoked, 0 to 168 (default 0).
    "refundGraceHours": 0,
    // Days a subscription grant keeps working while the store retries a renewal, 0 to 30
    // (default 0). Stored, not yet shown in the console.
    "dunningGraceDays": 0,
  },
}
```

Each setting is checked by its own validation code (`invalid_licensing_<field>`, see
[Manifest validation codes](/docs/reference/validation-codes/)). The behavior behind each
setting arrives in stages; until it does, a saved value changes nothing devices see. The
[settings reference](/docs/reference/settings/) lists every setting with its default and the
confirmation a console change needs.

## Product OIDC

`oidc.provider` selects the product's single OIDC login provider:

- `platform` is the default. The product uses `PLATFORM_OIDC_ISSUER` and
  `PLATFORM_OIDC_CLIENT_ID`; the manifest keeps product-scoped redirect allowlists,
  `groupRoleMap`, and provisioning hooks.
- `custom` uses the product's own `issuer`, `clientId`, optional `clientSecretSecret`,
  redirect allowlist, `groupRoleMap`, and provisioning hooks.

SDK discovery only reports whether OIDC is enabled and which generic auth URLs to call. It
does not expose whether a product uses platform or custom OIDC.

`oidc.syncTierOnSignIn` decides whether a sign-in may move a license to the tier its
`groupRoleMap` groups map to: `off` (the default) or `upgradeOnly`, which never lowers a tier. It
is a claimable setting like the [licensing settings](#licensing-settings-licensing): a change on
**App sign-in** claims it until you revert it.

## Identity settings: `identity`

An Identity product no longer needs an `oidc` block. The optional `identity:` block declares the
settings of signing in and of key entry through the product. It applies only while the `identity`
service is on; declared with it off, `pkey validate` warns `identity_block_without_service`.

```yaml title=".pkey/product"
identity:
  keyEntry: { limit: 10, claimByKey: false }
  terms: { version: "2026-10", url: "https://example.com/terms" }
  redirectPaths: ["/auth/callback"]
  platformSignIn:
    google:
      serverClientId: "1234-web.apps.googleusercontent.com"
      clientIds: ["1234-and.apps.googleusercontent.com"]
    apple:
      teamId: "ABCDE12345"
      bundleIds: ["com.example.nightfall.mac"]
  nearby: true
```

- `keyEntry.limit`: how many times the key of a license in no account may be entered on new
  devices (1 to 100, default 10).
- `keyEntry.claimByKey`: whether a license that carries a buyer email may join an account by its
  key alone. Off by default. On, anyone holding a leaked key can add an email-bound license to
  their own account.
- `terms`: the product's terms, accepted once per version by a person signing in through the
  product. `version` is 1 to 32 characters of `A-Z a-z 0-9 . _ -`; `url` is an https URL.
- `redirectPaths`: the paths a web app's sign-in may return to, matched exactly with an origin
  from `web.origins` (up to 16, each rooted at `/`, with no `?`, `#`, `*`, `//` or `..`).
- `platformSignIn`: the native audiences a sign-in with Google or Apple on the device is checked
  against. `google.serverClientId` is the web client id (the token's audience); `google.clientIds`
  are your Android and iOS client ids (up to 8) and need it. `apple.teamId` is your 10-character
  team id; `apple.bundleIds` (up to 16) are added to the bundle ids of your App Store and
  TestFlight outlets, and need `teamId`.
- `nearby`: whether a signed-in device nearby may approve a sign-in on a new one. On when
  absent; it needs no Cloud Connect.

Each member is a claimable setting (`identity.keyEntry.limit`, `identity.keyEntry.claimByKey`,
`identity.terms`, `identity.redirectPaths`): a console change claims it until you revert it.

## Cloud Connect settings: `connect`

The optional `connect:` block declares two switches of Cloud Connect. It applies only while the
`connect` service is on; declared with it off, `pkey validate` warns `connect_block_without_service`.
A member other than `relay` or `interAccount`, or one that is not true or false, fails with
`invalid_connect`.

```yaml title=".pkey/product"
modules:
  identity: { enabled: true }
  connect: { enabled: true }
connect:
  relay: true
  interAccount: false
```

- `relay`: whether the relay carries the product's device traffic when the local network cannot.
  On when absent.
- `interAccount`: whether devices of different accounts may connect. Off when absent.

Each member is a claimable setting (`cloudConnect.relay.enabled`, `cloudConnect.interAccount`): a
console change claims it until you revert it. A person's relay bytes per UTC day are the reserved
entitlement `pkey.cloudConnect.relayBytes`, set by a tier, a license override or an add-on: 256 MiB
when unset, 16 MiB for a device with no usable license, never more than 4 GiB. A product's relay is
capped at 500 GiB a month. The local network is never metered.
