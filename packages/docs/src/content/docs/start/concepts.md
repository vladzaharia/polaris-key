---
title: "Concepts and glossary"
description: "The words the console, Polaris Locker and these docs use, the identifiers they keep in code and on the wire, and the nouns behind documents, devices and keys."
type: "concept"
lastReviewed: "2026-10-19"
---

This is the canonical glossary. The console, Polaris Locker and the docs use one word per concept and one concept per word, spelled in US English and sentence case. A word in the first column is what a reader sees. The identifier in the third column is what code, manifests and the wire call it. Identifiers keep their names when a word changes.

## UI words and the identifiers they keep

### Products and features

| UI word              | What it means                                                                                                                                                                              | Identifier (kept)                                  | Not in the UI          |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------- | ---------------------- |
| **Product**, **app** | The product is the record in Polaris Key: the console's product, the manifest, the API. The app is the developer's build that embeds an SDK, and what consumers use                        | `slug`                                             | "app" for the record   |
| **Feature**          | A group of services you turn on for a product: **Licensing**, **Managed config**, **Ship builds**, **Sign-in**, **Cloud Sync**. A feature turns on only while the features it needs are on | the service slugs in `modules` and `services_json` | "module", "capability" |

### Licensing

| UI word                   | What it means                                                                                                                                        | Identifier (kept)                                                                 | Not in the UI                   |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------- |
| **License in an account** | A license whose holder is an account                                                                                                                 | list filter `inAccount`                                                           | owned, bound                    |
| **Waiting license**       | A license assigned to an email no account has verified yet. An account that verifies the address takes it in                                         | list filter `waiting`                                                             | pending holder                  |
| **Floating license**      | A license with no holder: whoever has its key activates devices                                                                                      | list filter `floating`                                                            | unbound                         |
| **Automatic grant**       | A license the access policy issued. The only use of "grant". End users see it as "Sign-in" in the kits and Polaris Locker                            | origin `oidc`                                                                     | "From signing in"               |
| **Tier**                  | A named license template                                                                                                                             | `tiers`, `tier_id`                                                                | plan                            |
| **Add-on**                | A sub-license: an in-app purchase, DLC, feature pack, device pack or consumable                                                                      | `grants`, `addon_id`                                                              | grant, store mapping            |
| **Entitlement**           | A named right a device gets from its license                                                                                                         | catalog `flag` entries                                                            | flag                            |
| **Limits**                | Device limit, offline days, release tracks, version window, fingerprint mode. The license wins over its tier, and the tier over the platform default | `device_limit`, `max_offline_days`, `channels_json`, `min_version`, `max_version` | terms, policy, effective policy |
| **Duration**              | How long a license runs                                                                                                                              | `expires_at`                                                                      | term, perpetual                 |
| **Access policy**         | Who gets a license automatically                                                                                                                     | `license.autoIssue`, `groupRoleMap`                                               | auto-issue, enrollment settings |

### Managed config

| UI word                                   | What it means                                                      | Identifier (kept)                                                      | Not in the UI                 |
| ----------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------- | ----------------------------- |
| **Profile**                               | A named set of config and secret values: Default plus one per tier | `profiles`                                                             | license profile               |
| **Setting**, **Secret**, **Minted token** | The three config entry types                                       | catalog `kind`: `config`, `secret`, `secret` with `delivery: edgeMint` | edge-mint, "config" as a type |
| **Editable**, **Read-only**, **Hidden**   | A setting's visibility in the app                                  | `ManagementState`: `default`, `enforced`, `hidden`                     | management state              |

### Ship builds

| UI word                            | What it means                                                                                                                                             | Identifier (kept)                                                  | Not in the UI                    |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | -------------------------------- |
| **Channel** (distribution channel) | A place builds reach customers: a store, a package manager, a sideload source, the web, Polaris Key's own downloads                                       | `outlet`; `direct` is Polaris Key's own                            | "outlet"                         |
| **Storefront**                     | The selling side of a channel: App Store, Google Play, Steam, Microsoft Store, itch.io, Polaris Locker                                                    | store adapters                                                     | storefront for a delivery place  |
| **Offer**, **SKU**                 | What is sold; its id on one storefront                                                                                                                    | `dist_store_products`                                              | store product mapping            |
| **Install source**                 | A catalog a customer adds: AltStore, F-Droid, Obtainium, a Scoop bucket, Flathub                                                                          | storefront feeds                                                   | storefront feed                  |
| **Release track**                  | `stable`, `beta`, `dev` and your own lanes a release joins                                                                                                | `channel`, `X-PKey-Channel`                                        | update channel                   |
| **Packages**, **Updates**          | The package feeds on `pkg.plrs.im`; the update feeds and updater setup                                                                                    | `registry`; the `update` service                                   | Feed                             |
| **Access mode**                    | Who may fetch a download, a feed or a version check: **Public**, **Authenticated**, **Licensed** or **Entitled**. Package feeds offer Public and Licensed | `ReleaseAccess`: `public`, `authenticated`, `licensed`, `entitled` | "Signed-in devices", "Customers" |
| **Pack**                           | A content deliverable for a game or app                                                                                                                   | deliverable kind `pack`                                            | content pack                     |

### Sign-in, accounts and the console

| UI word                             | What it means                                                                                                                                                                                                                         | Identifier (kept)                                                                                                     | Not in the UI                       |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| **Polaris Locker**, then **Locker** | The customer side: the customer site (Library, Discover, Account, the sign-in card, the device page), customer mail, Help, kit presentation and partner badges; its name reaches customers when the Worker's `CUSTOMER_ORIGIN` is set | `portal*` routes and handlers, `portal_*` tables, `accountPortal`, `CUSTOMER_ORIGIN`                                  | "customer portal", "portal"         |
| **Polaris Key**                     | The platform and its backend: the Polaris Key Console at `key.plrs.im`, the developer docs, the CLI, the API and every identifier                                                                                                     | `@polaris-key/*`, `polaris-key`, `PolarisKey`, `pkey`, `.pkey/`, `pkey_*` tokens, `X-PKey-*`, `PKEY_*`, `key.plrs.im` | "Polaris Key" for the customer site |
| **Connection**                      | An upstream sign-in provider, configured once                                                                                                                                                                                         | `PLATFORM_OIDC_*`, `identity.oidc`                                                                                    | custom issuer                       |
| **Sign-in surface**                 | A place a person signs in: the web card, a native redirect, a device code, a store                                                                                                                                                    | `/api/signin/*`, `/<product>/identity/auth/*`                                                                         | sign-in channel                     |
| **Screen name**                     | The account's public name                                                                                                                                                                                                             | `accounts.display_name`                                                                                               | "Your name"                         |
| **Member**, **Role**, **Area**      | A console user; a built-in permission set; a stable permission id                                                                                                                                                                     | area ids on admin routes                                                                                              | admin group                         |
| **Service token**                   | A `pkeyci_` CI token with only `packages:read`: it reads a product's private feeds, for CI and servers                                                                                                                                | `pkeyci_`                                                                                                             | product token                       |

### One meaning each

- **terms**: legal terms only. A license's metadata is its **Limits**, and how long it runs is its **Duration**.
- **Channel**: a distribution channel only. A release's lanes are **Release tracks**.
- **Storefront**: the selling side of a channel, never a place builds are delivered.
- **Sign-in surface**: a place a person signs in, never a "sign-in channel".
- **Feature**: a product-level group of services. "Capability" is not a UI word.
- **Profile**: a named set of config values. A person's public name is their **Screen name**.

### Console copy rules

These words leave every console string, because the UI names each of those things with another word:

| Leaves the UI               | The UI says                                                                                          |
| --------------------------- | ---------------------------------------------------------------------------------------------------- |
| "outlet"                    | **Channel**                                                                                          |
| "storefront feed"           | **Install source**                                                                                   |
| "grant"                     | **Add-on**, or a plain verb (give, add). **Automatic grant** is the one kept use                     |
| "capability"                | The feature, the switch, or what the channel allows                                                  |
| "portal", "customer portal" | **Polaris Locker**, then **Locker**. The console and docs say "Polaris Locker" for the customer site |
| `"licence"`                 | **License**: US spelling, noun and verb. Identifiers and file names keep their spelling              |

The identifiers keep them (`outlet`, `dist_outlets`, `grants`, `outletCapabilities`, `portal*`). A code span in copy is an identifier, not a word.

## Core nouns

- **product**: what an app is licensed and configured through, addressed by its `slug`. Every row, key, signature and admin route is product-scoped.
- **license**: an access contract for one product. It carries entitlements and optionally belongs to an account. An admin creates it, or sign-in mints it.
- **key**: the `pkey_<product>_…` secret a person redeems to activate a device. It is shown once and stored only as a hash.
- **device**: an authorized install of the product, bound to a bearer token (`pkeyt_…`). A device belongs to Core, not to licensing: with an `open` or `requires-identity` policy it holds a token with no license behind it.
- **profile**: a reusable managed-payload baseline that a tier or license attaches.
- **entitlement**: a named right or value a device gets from its license, for example `channels` or `app.minVersion`. Entitlements ride the license document only.
- **keyless activation**: activation with no key, which auto-issues a license under the product's access policy (identifier `enroll`). **Activation** with a key redeems a `pkey_…` key.
- **origin**: how a license came to exist: `admin`, `oidc` (minted at sign-in) or `enroll`.
- **re-licensing**: changing a license's tier. Running clients pick up the change at their next license-document refresh. A downgrade below the active device count keeps existing devices and refuses new activations until the count drops.
- **account**: one person across every product, with a primary verified email and its sign-in methods. Customers know it as their Polaris Locker account. Developers see a **pairwise subject** (`ps_…`) instead of the account id.
- **fingerprint**: per-component hashes a device reports about its hardware. Raw values are hashed on the device and never sent.

## Config model

A catalog entry has one of three kinds: `config` (a plaintext setting), `secret` (delivered in the signed config document) and `flag` (an entitlement). Effective config merges layers in this order, later layers winning:

```text title="Server layers"
catalog defaults → tier profile → license profile → store grants
  → license overrides → account overrides → device overrides
```

On the client, a value's source resolves in this order:

```text title="Client precedence"
enforced or hidden (remote) > user or local override > environment
  > remote default > schema default
```

An `enforced` or `hidden` value always comes from the server. A `default` value can be overridden on the device.

## Signed documents

Each service issues its own signed document, and a client derives the license status from the license document.

| Document       | Type               | Carries                                                                  |
| -------------- | ------------------ | ------------------------------------------------------------------------ |
| License        | `pkey-license+jws` | `licenseId`, an optional profile, `entitlements`                         |
| Config         | `pkey-config+jws`  | `config`, `secrets`, the catalog's `schemaVersion`                       |
| Trust manifest | `pkey-trust+jws`   | The key set, verified against pinned keys only                           |
| Offline bundle | `pkey-bundle+jws`  | A device-bound license and config document, imported whole or not at all |
| Channel feed   | `pkey-feed+jws`    | What each platform of a release track should run                         |
| Release record | `pkey-release+jws` | A release's builds and artifacts, signed in CI                           |

**License status** is the state a client renders: `ok`, `grace`, `expired`, `revoked`, `needs-activation`, `version-too-old`, `version-too-new`, `channel-not-entitled` and `not-applicable`. The last applies when the product doesn't enable License, and it counts as usable.

## Trust and keys

- **signing key**: a per-product Ed25519 key. Its private half is sealed at rest and never leaves the Worker. Its public half is served at `/<product>/.well-known/jwks.json` and pinned by SDKs.
- **release key**: an Ed25519 key held by the product's CI that signs release records. The Worker never holds one, so it can't ship bytes no release key signed.
- **minter**: a recipe that mints a short-lived third-party token. The UI word is **Minted token**.
- **trust level**: how far a device has proved it is a genuine install of the app. Every device is `basic`; one that passes App Attest or Play Integrity is `attested`. It lives on the device record, never in a signed document.
- **trust policy**: a product's rule for which operations need an `attested` device, such as minted tokens or gated delivery. Without `enforce` it only reports what it would refuse.

## Cloud Sync data

**Cloud Sync** stores a signed-in person's settings, records and files for one product. It needs Config and Identity. A **synced setting** is an editable catalog `config` key. A **record** is one JSON value in a **collection**, and a **save** is a record of the `saves` collection template. The SDKs name the namespace `cloudSync`.

## Cloud Connect

**Cloud Connect** lets one signed-in person's devices find each other and open an encrypted channel, on the local network or through a relay. It needs Identity. A **linked device** is a device on that person's roster, one the person is signed in on; removing a device unlinks it. A **relay** carries a channel's ciphertext between two linked devices that the local network does not connect, within a per-person day quota and a per-product month ceiling. End users know a linked device as a nearby device in Polaris Locker.

## Release model

A **deliverable** is something a product releases: its app, a **pack** or a package. Each release belongs to one deliverable and has a position, its `seq`, in that deliverable's publication order. A **build** is one compiled form of a release for a platform, architecture and format. To **promote**, **pin** or **yank** is to move a release track's pointer, freeze it, or withdraw a release. A yank never deletes anything.

### Packs

A pack is a deliverable of kind `pack`: data the app loads at run time, never code. A **pack release** is its CI-signed record. A **variant** is one form of it for a combination of axis values such as `texture` or `locale`.

### Packages

A package is a library or image that other software installs from a **package feed**. The SDKs are packages of the platform's own product, `polaris-key`. Each package version is unique forever.

## Distribution model

A **channel** (identifier `outlet`) is a place a build reaches customers. A **transport** is how a deliverable's bytes arrive on a channel. **Availability** says that release V is live on channel C. A **rollout** is the percentage of devices that see a release on one channel.
