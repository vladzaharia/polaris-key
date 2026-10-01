---
title: "Concepts & terminology"
description: "The canonical glossary for the Worker, the SDKs, the console and the docs — services, devices, documents, trust, and the config model."
sidebar:
  order: 2
---

This is the source of truth for the vocabulary used across the Worker, the SDKs, the admin
panel, and the docs. When code and this glossary disagree, this glossary wins — open a PR to
reconcile. Consistent names are a feature: they make the system learnable across five languages.

## The suite: Core and services

Polaris Key is **six opt-in services** over an always-on **Core** substrate. A product turns on
only what it needs, and what it left off does not exist for it. That is what lets one app take
signed settings without taking licensing, and another take a release feed without taking either.

- **[Core](/docs/services/core/)** — the substrate every product gets and no product can switch
  off: the product registry, the **Device** principal (registration, `pkeyt_` tokens,
  list/rename/deauthorize, fingerprints, facts), trust & signing, discovery, rate limiting, the
  error taxonomy, audit, and manifest-ingest dispatch. Core is not a service and never appears in
  an enablement set; a product that enables nothing still registers devices and serves its JWKS.
- **service** — one of exactly six opt-in units, each addressed by a singular **slug**. The slug
  is the worker directory (`packages/worker/src/services/<slug>/`), the route namespace
  (`/<product>/<slug>/…`), the SDK sub-client (where one exists), and the console section, so
  there is one word per unit everywhere. The services are declared once, as rows of
  `tools/services.json`:
  - **[license](/docs/services/license/)** — activation and enrollment, the license document,
    licenses and keys, tiers, fingerprint and auto-issue policy.
  - **[config](/docs/services/config/)** — the catalog (schema), the config document, profiles,
    edge-mint secret delivery.
  - **[release](/docs/services/release/)** — GitHub sync, channel resolution, artifacts,
    changelog, install script: the release truth store. It answers _what exists?_
  - **[distribution](/docs/services/distribution/)** — how every release of every deliverable
    reaches devices and outlets, and what state it is in there: outlets, transports,
    availability, rollouts. It answers _how does it reach devices, and is it there yet?_ (The
    word means only this service — never "release + update".)
  - **[update](/docs/services/update/)** — the appcast, `/version`, eligibility: the feed that
    tells an installed copy what to do next. It answers _what should this device do next?_
    `update → release` is the only sanctioned cross-service import; every other pair talks
    through Core (the **descriptor hooks**, below).
  - **[identity](/docs/services/identity/)** — product OIDC, browser sessions, the customer
    portal.

### Enablement

- **`services_json`** — the column on `products` that records which services a product runs, and
  the **single authority** for that answer. Every slug is present with an explicit boolean, plus
  an optional `registration` key:

  ```json
  {
    "license": { "enabled": true },
    "config": { "enabled": true },
    "release": { "enabled": false },
    "distribution": { "enabled": false },
    "update": { "enabled": false },
    "identity": { "enabled": false },
    "registration": "open"
  }
  ```

  A record that is not fully understood — bad JSON, an unknown slug with a malformed value, a non-boolean `enabled`, a
  `registration` outside the three policies — is discarded **whole** and read as the defaults
  (`license` + `config` on, the rest off), never partially honoured: half-honouring a typo is how
  it turns into a silently disabled service. The defaults are also what a product that has never
  declared anything gets, which is exactly how every product behaved before the column existed.

- **`services_source`** — who owns that column: `manifest` (a resync re-applies `.pkey/product`)
  or `admin` (an operator claimed it live). The guard is the `UPDATE`'s own `WHERE` clause, so a
  push cannot quietly undo a 3am toggle. `POST …/services/revert` hands ownership back and does
  nothing else — the live values stay put until the next resync re-applies the manifest. Same
  machinery as `fingerprint_policy_source` and `auto_issue_source`.

**The four projections.** Enablement used to be re-derived by four surfaces, each guessing from
the presence of some child row, so the discovery document could advertise a service whose routes
404ed. All four now read the one column and infer nothing:

- **route mounting** — Core checks the flag _before_ consulting the service descriptor, so a
  disabled service's code never runs: it cannot read a row, write an audit entry, or spend a
  rate-limit token. Disabled, unregistered, and no-such-route return one identical 404, because
  telling them apart is the reconnaissance being refused.
- **the discovery document** — `/<product>/.well-known/polaris.json` carries a `services` object
  keyed by the six slugs. An enabled service contributes its own fragment; a disabled one is
  `{"enabled": false}` and nothing else, so a disabled service's endpoints cannot be read out of
  a public document.
- **the admin product view** — one projection (`serviceStateOf`) stamps `services`,
  `registration`, `effectiveRegistration`, and `servicesSource` onto the row the console shell
  already loads, so the nav is drawn from enablement rather than appearing after the page it
  frames.
- **portal capabilities** — `/api/capabilities` and the portal's release listing conjoin the
  per-product portal toggles with `services_json`. Gating only the capability would hide the nav
  item while leaving the endpoint enumerating a non-Release product's releases to anyone who
  deep-links it; the nav is a courtesy, the listing is the disclosure.

**Coherence.** An enablement set is validated as a set, not flag by flag — every one of these
faults is a _relationship_ between two toggles, so no single flag can be blamed for it. The
enablement API (`PATCH /manage/api/products/<slug>/services`) refuses all four, and returns
stable codes rather than prose so the API, the console, and the manifest validator can each
render them their own way:

- `distribution_requires_release` — Distribution on with Release off. Distribution delivers what
  Release says exists; with Release off there is nothing to deliver.
- `update_requires_distribution` — Update on with Distribution off. The feed would answer every
  client with an empty document rather than an error, which is a silent failure. Together with
  the rule above it implies Release is on whenever Update is, so the older
  `update_requires_release` is retired.
- `registration_requires_identity` — a declared `requires-identity` policy with Identity off.
  There is no login to stand behind, so the product has taken registration away rather than
  restricted it.
- `config_without_activation` — Config on, License off, and a declared `requires-license` policy.
  That closes the only mint path such a product has, leaving the service enabled and unreachable.

Manifest ingest enforces its own share of these; see
[Authoring the manifest](/docs/build/manifest/) for which are errors there and which are
warnings, and [The service model](/docs/start/service-model/) for where each rule is applied.

### Device registration policy

- **registration policy** — `devices.registration`, one of `open`, `requires-identity`, or
  `requires-license`. It decides who may mint a device token at `POST /<product>/devices/register`
  — a **Core** route that exists under every policy, because a device is substrate, not a
  licensing concept.
  - `open` — mint for any caller. Rate-limited by edge IP, fingerprint optional.
  - `requires-identity` — same endpoint, but only for a caller carrying a live product browser
    session. Core cannot answer "is a human signed in to this product", so it asks the Identity
    descriptor through a narrow predicate rather than importing the service.
  - `requires-license` — refuse permanently. Activation and enrollment are the only mint paths,
    which is the pre-suite behavior.

  Every refusal is the same `403 registration_closed`. A caller learns that it may not register
  and nothing about why: distinguishing the policies, or an expired session from an absent one,
  would let a prober map which products run which services.

- **derived default** — the policy is optional, and undeclared means "follow the services", not
  "somebody chose `open`". The derivation is `requires-license` if License is enabled, else
  `requires-identity` if Identity is, else `open` — ordered by how much the product already knows
  about the caller. Undeclared is stored as _absent_ rather than resolved at ingest, so a product
  that later turns License off moves to the derived `open` instead of staying pinned to a value
  nobody wrote. The policy lives inside `services_json` rather than in a column of its own
  precisely because its default is a function of the same value; reading a policy from one place
  while deriving its default from another is how the two drift.

### The old module vocabulary

A `.pkey/product` `modules:` block may still use the pre-suite names. The parser translates them
to service slugs and stores only slugs, so no manifest in the field has to be rewritten on the
day the server learns the new words, and a block may mix the two vocabularies:

`licensing → license` · `config → config` · `releases → release + distribution + update` ·
`oidc → identity` · `edgeMint → config`

The two non-obvious rows: `releases` meant "this product distributes software", which the suite
splits into the truth store (Release), delivery (Distribution) and the feed (Update) — mapping it
to `release` alone would take the appcast away from every product already serving one. And `edgeMint` is a secret-delivery
_capability_ of Config, not a unit of its own, so declaring it turns Config on.

### Descriptor hooks

A service may import only Core and itself (the one exception is `update → release`). When one
service needs another's state, it asks **Core**, which asks the service that provides it:

- **`releaseCatalog`** (provided by Release) — deliverables, releases, builds, artifact records,
  channel policy and yanks, read-only.
- **`delivery`** (provided by Distribution) — transports, availability and, later, rollout and
  delivery URLs per outlet.
- **`outletCapabilities`** (provided by Distribution) — what one outlet permits.

A hook answers `null` while the service that provides it is off for the product — its code never
runs — and the consumer degrades explicitly. A hook never writes: a write across services would
be an import in disguise.

## Core nouns

- **product** — one tenant of Polaris Key, addressed by its `slug` (e.g. `djdl`). Every D1 row,
  KV key, signature, and admin route is product-scoped. (Not "app" or "gateway".)
- **license** — an account that holds entitlements. Created manually by an admin or minted on
  OIDC sign-in. Has a status, optional tier/profile, optional expiry, and per-license overrides.
- **key** — a `pkey_<product>_…` activation secret a user redeems to activate a device. Shown to the
  user exactly once; stored only as a (peppered) hash.
- **device** — an authorized install of the product, bound to a per-device bearer token
  (`pkeyt_…`). The data layer, APIs, SDKs, docs, and UI all use **device**. A device is a **Core**
  principal, not a licensing one: under an `open` or `requires-identity` registration policy a
  device holds a token with no license behind it, and still fetches config documents.
- **tier** — a named plan: an optional profile plus policy (default expiry, device limit, and —
  from the channels work — default upgrade channels and version window). (Not "plan".)
- **profile** — a reusable managed-payload baseline that a tier or license can attach.
- **channel** — a named release stream a build belongs to and a license may be granted, one
  vocabulary for the license build gate, Release and every SDK (WIRE-CONTRACT-V3 §5.1): `stable`
  (always granted), `beta`, `pr-<n>` (one pull request; a `pr` grant covers every PR), a
  product's manual channels, and `dev`, the gate's pseudo-channel for `0.0.0-dev*` builds (Release
  has none). `staging` is the legacy spelling of `beta` and `latest` names `stable`; both are
  accepted, and no SDK sends them. Names match `^[a-z0-9][a-z0-9-]{0,63}$`. A license's channels
  are the `channels` entitlement.
- **entitlement** — a capability flag or value delivered to the client (the `flag` config kind),
  e.g. `polarisVpn`, `channels`, `app.minVersion`. Entitlements ride the **license** document and
  only it; the config document carries no grant data.
- **enrollment** — a keyless activation that auto-issues a license under a product's auto-issue
  policy. Distinct from **activation**, which redeems a `pkey_…` key.
- **origin** — how a license came into existence: `admin` (an operator created it), `oidc`
  (minted on sign-in), or `enroll` (auto-issued, keyless, bound to a machine).
- **auto-issue policy** — a product's opt-in to issuing licenses without a credential. Names
  the tier, and a **mode**: `anonymous` (opens `POST /<product>/license/enroll`), `oidcDefault`
  (an authenticated user matching no IdP group lands on that tier instead of a 403), or `both`.
  Off unless a product opts in; a policy naming no tier counts as off.
- **claim / migrate** — the two merge outcomes when a signed-in identity meets an auto-issued
  license. _Claim_: the identity is attached to the same row, so devices and local state
  survive. _Migrate_: the identity already had a license, so the enrolled row's devices move
  onto it and the enrolled row is retired. The only merge is the device-code holder's opt-in at
  `/device/poll`, after the device was shown the signed-in identity (`confirmIdentity` →
  `confirm` → `attachLicense`); a sign-in alone merges nothing. See
  [attaching the device's anonymous license](/docs/services/identity/device-flow/#attaching-the-devices-anonymous-license) and
  [claim and migrate](/docs/services/license/enrollment/#claim-and-migrate).
- **re-licensing** — changing a license's `tier_id`. Running clients pick up the new
  entitlements on their next license-document refresh; nothing is pushed. A downgrade below the
  active device count **grandfathers** existing devices and refuses new activations until the
  count drops.

## Device identity

- **fingerprint** — the set of per-component hashes a device reports about its hardware. Raw
  hardware values are hashed on-device and never transmitted.
- **component** — one hashed hardware signal within a fingerprint: `machineUuid` (the
  **anchor**), `boardSerial`, `cpuModel`, `primaryMac`, `bootVolumeUuid`, `ramBucket`,
  `machineModel`. A component that cannot be read is omitted, never substituted.
- **hwid** — the composite hash over a device's present components, in canonical order; the
  coarse dedupe key. The server always recomputes it and never trusts the client's copy.
- **drift** — how many components differ between a device's stored and presented fingerprint.
  A component that was stored and is now missing or different counts as drift; a _newly_
  reported one does not, so an SDK upgrade that learns to read more components is free.
- **fingerprint mode** — per-tier enforcement strength, falling back to the product default:
  `off` (collect, never enforce) · `lenient` (4) · `normal` (2, the default) · `strict` (0, and
  a fingerprint becomes mandatory). A matching anchor widens a non-zero tolerance by one.
- **device facts** — a device's current software snapshot: OS, runtime, hardware summary, and
  probe results. Overwritten on each report; no history is kept.
- **probe** — a product-declared check for a companion application, answered by the client as
  present/absent plus an optional version. There is no full installed-application enumeration.

Note that **profile** is already taken twice — the reusable managed-payload baseline above, and
`DocProfile` in the signed payload. Do not overload it a third time for device data.

## Config model

- **config / secret / flag** — the three `ConfigKind`s of a catalog entry. `config` → plaintext
  client setting; `secret` → redacted, delivered in the signed config document (the SDK caches it in a `0600` file; only the device token is in the OS keyring); `flag` → an entitlement.
- **management state** — per-value enforcement, one of:
  - **default** — the server suggests a value; the client (user/local override or environment)
    may override it.
  - **enforced** — the server value wins and the client cannot override it (shown read-only).
  - **hidden** — `enforced` **and** withheld from user-facing enumeration (still applied
    internally).
- **scope** — where a catalog key is meaningful (the `UiHints.scopes` field): one or more of
  `profile`, `license`, `device`.
- **manifest** — the files in a product's repo that describe it: `schema` (the config catalog),
  `product` (metadata + enabled services + registration policy + OIDC + tiers + provisioning),
  and `release` (release config + minters), each in JSON or YAML. They live in exactly one
  directory, **`.pkey/`** — there is no second candidate directory and no fallback between two.

## Release model

The release truth store's nouns (see [Truth store](/docs/services/release/truth-store/)). "App"
here names only the deliverable kind `app`, the product's own executable; it is never a synonym
for product.

- **deliverable** — something a product releases: its `app` (kind `app`, id `app`) or a pack
  (kind `pack`, with a pack type). Ids are lower-case, dot-separated segments of at most 64
  characters (`app`, `diceroll.core3d`). Every release belongs to exactly one deliverable, and
  carries a **seq**: its position in that deliverable's publication order (not version order, so
  a backport can have a higher seq than a newer version).
- **build** — one compiled form of a release for a (platform, arch, format), with a **build
  number** (iOS `CFBundleVersion`, Android `versionCode`, MSIX four-part, Sparkle
  `sparkle:version`). Platforms are `macos`, `ios`, `android`, `windows`, `linux`, `web`; arches
  `arm64`, `x86_64`, `universal`, `armv7`, `wasm32`, `any` (`universal` and `any` match every
  arch).
- **platform** — the OS family a running binary was built for, as a client sends it in
  `X-PKey-Platform` (WIRE-CONTRACT-V3 §5.2): `macos`, `ios` (iPadOS too), `android`, `windows`,
  `linux` or `web`. An SDK maps its runtime's own spelling (`darwin`, `win32`, `Windows`) to
  these through one table, and omits the header for a spelling the table lacks.
- **arch** — the CPU architecture a running binary was built for, sent in `X-PKey-Arch`:
  `arm64`, `x86_64`, `armv7` or `wasm32`. A browser sends none. (`universal` and `any` are
  artifact values, never header values.)
- **SDK id** — which SDK made a request, sent in `X-PKey-SDK`: `node`, `react`, `python`,
  `swift` or `godot`. The SDK's version travels separately, in `X-PKey-SDK-Version`.
- **artifact role** — what an artifact (a file of a build, or a sidecar) is for: `payload`,
  `files-index`, `chunk-index`, `chunk-bundle`, `delta`, `signature` or `checksum`.
- **promote / pin / yank** — move a channel's pointer to a release (which makes it a member of
  the channel) / freeze the channel at its pointer / make a release unservable except through an
  explicit pin. A yank never deletes anything, and a release deleted on GitHub is not a yank.
  "Yank", not "revoke": keys and licenses revoke.
- **channel policy** — the per-deliverable, per-channel record of pointer, pin, included
  channels, **minimum supported** version (the device floor the signed feed will carry) and the
  critical flag. Owned by the manifest until an operator or CI changes it, then by `admin` until
  it is reverted — the `services_source` precedent. Not the same as a release **channel floor**,
  the sync's anti-rollback high-water mark.

## Distribution model

Distribution's nouns (see [Distribution](/docs/services/distribution/)). The service ships them as
vocabulary first; the records arrive with the distribution manifest and the packages after it.

- **outlet** — a venue a build reaches players through, and that owns (or delegates) its updates:
  `direct`, `app-store`, `testflight`, `play`, `steam`, `itch`, `ms-store`, `flathub`, `web`, …
  Not "surface" (a Release/Update route kind) and not "distribution" (the service).
- **transport** — how a deliverable's bytes arrive on an outlet: `pkey-cdn` (Polaris Key's own
  CDN, the default), `embedded`, `apple-ba`, `play-pad`, `steam-depot`, `msix-optional`,
  `flatpak-ext`, `web`. One deliverable, many transports.
- **availability** — "release V of deliverable D is live on outlet O since T": a distribution
  record, the answer to "is it in the store yet?".
- **submission** — a build's review lifecycle at a store outlet (App Store Connect, Play,
  Microsoft Store states).
- **rollout** — percentage exposure of a release on one outlet; distribution state, carried into
  Update's feed. Distinct from a **channel**, which is Release's.
- **listing** — store-page metadata (name, subtitle, description, icon, screenshots, category)
  that feeds storefront sources and the download page.
- **outlet capabilities** — what an outlet permits: `binaryUpdates` (`self` | `store` | `none`),
  `codeUpdates`, `dataUpdates`, `channelSwitch`, `commerce`, `downloadedScripts`. The
  security-relevant bits are operator-owned, never manifest-writable.

## Layering & precedence

Effective managed config is computed server-side by merging payload layers
`tier(profile) → license(profile) → license overrides → device overrides` (later layers win;
this is legitimate admin authority). On the **client**, a value's source is resolved as:

```
enforced | hidden (remote)  >  user/local override  >  environment  >  remote default  >  schema default
```

So an `enforced`/`hidden` value always comes from the server; a `default` value can be overridden
locally or by environment variables.

## Signed documents

Wire contract v3 replaced the one fused document with **two**, one per service, so a product can
take either without the other. Both carry the same envelope — `iss` (`key.plrs.im`), `aud` (the
product slug), `deviceId`, `issuedAt`, `expiresAt`, `graceUntil` — and are domain-separated by
their JOSE `typ`, which is rejected when unknown or missing.

- **license document** (`pkey-license+jws`, `GET /<product>/license/document`) — `licenseId`, an
  optional `profile` (`DocProfile`), and `entitlements`. Tier and admin policy arrives in
  `entitlements` as enforced entries — `license.tier`, `license.tierLabel`, `channels`,
  `app.minVersion`, `app.maxVersion`, `deviceLimit` — beside the catalog's `flag` keys.
- **config document** (`pkey-config+jws`, `GET /<product>/config/document`) — `config`, `secrets`,
  and the catalog's `schemaVersion` (the product's, not the wire's). It carries no license fields
  at all: a product with Config on and License off issues one to any registered device, which is
  the wire-level guarantee that the services are independent.
- **trust manifest** (`pkey-trust+jws`, `GET /<product>/.well-known/polaris-trust.jws`) — the key
  set. Always verified against **pinned keys only**, on both the network and the reload path.
- **offline bundle** (`pkey-bundle+jws`) — an operator-minted, device-bound file for air-gapped
  installs: `bundleId`, `deviceId`, `docs` (a license document, a config document, or both), and
  the trust manifest. Imported all-or-nothing — the bundle verifies against pins, then its trust
  manifest, then each inner document, and only then is the cache written — so no partial import
  exists. A verified bundle satisfies activation with no `pkeyt_` token anywhere.
- **channel feed** (`pkey-feed+jws`, wire contract v4, `GET /<product>/update/<channel>/feed.jws`)
  — a device-less document, signed by the product key, that says what each platform of one
  canonical channel should run: per platform target, the pinned **release record** (by hash,
  `seq` and version), the platform's floor and, per outlet, what is live there. Its `seq` grows
  per (product, channel), and a client refuses a lower one (a rollback); it is stale after its
  TTL plus the clock skew, and a stale feed never updates anything.
- **release record** (`pkey-release+jws`, wire contract v4, `GET /<product>/release/records/<sha256>`)
  — a release's descriptor (builds, artifacts with sizes and digests) signed in CI by a
  **release key**, fetched by the SHA-256 of its exact bytes, which the feed pins, and checked
  against that hash before any signature work.

**License status** is the terminal gate state a client renders: `ok`, `grace`, `expired`,
`revoked`, `needs-activation`, `version-too-old`, `version-too-new`, `channel-not-entitled`, and
**`not-applicable`** — returned when the product does not enable License. `isUsable` is true for
`ok`, `grace`, and `not-applicable`, so a config-only or release-only product boots usable rather
than claiming it needs an activation it will never have. Status is never carried in a document;
the client derives it.

## Trust & keys

- **release key** — an Ed25519 key held by a product's CI that signs its release records. The
  app pins its release keys separately from its product keys, a release key is never a product
  key, and the Worker never holds one, so the Worker alone cannot ship bytes no release key
  signed (the two-signer model). Not a **signing key**.
- **signing key** — a per-product Ed25519 keypair. The private key is envelope-encrypted at rest
  in D1 under the platform **KEK** (a single Worker secret) and never leaves the Worker. The
  public key is served at `/<product>/.well-known/jwks.json` and pinned by SDKs.
- **edge-mint / minter** — a per-product recipe that mints a short-lived third-party token
  (e.g. an Apple MusicKit developer token); described by `alg`, claims template, key, and audience.
  Edge-minting is a **Config** capability, not a service: a catalog secret selects it with
  `delivery: edgeMint`, and the routes are `/<product>/config/mint/<id>/{token,auth}`.
