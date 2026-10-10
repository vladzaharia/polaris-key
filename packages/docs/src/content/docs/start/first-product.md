---
title: "Quickstart by goal"
description: "The smallest .pkey/ manifest for four common goals — licensing only, managed config only, releases and updates only, everything — and what each one lights up."
sidebar:
  order: 5
---

Pick the goal, copy the manifest, and read what it turns on. Every section below is a complete,
minimal `.pkey/` declaration — the point of the service model is that a product takes only what it
needs, and what it left off does not exist for it.

This page is the shape of the thing. The full path — GitHub App install, repo link, signing key,
required secrets, verification — is [Onboarding a product](/docs/build/onboarding/).

## Before any of them

Three rules apply to every goal, and skipping them is the usual first failure:

- **Two files are always required at ingest.** `.pkey/product` _and_ `.pkey/schema` must both be
  present, even for a product that runs no Config. A release-only product ships an empty catalog
  (`schemaVersion: 1` with `entries: []`) and never thinks about it again. The catalog's
  _contents_ are only validated when Config is enabled.
- **Only `enabled: true` counts, and an all-false block is not "nothing".** A `modules` block where
  no entry is `true` — like a missing block — falls back to the defaults, **License + Config**. To
  run one service, name that one service and leave the others out.
- **Leave `devices.registration` undeclared unless you mean it.** Undeclared tracks the derivation
  (`requires-license` if License is on, else `requires-identity` if Identity is, else `open`), so
  turning a service off later moves the policy with it. Declaring a value pins it forever.

`pkey init` scaffolds the files and `pkey validate` checks them before you push; `pkey validate`
prints the enabled services in slug vocabulary, so it is also the check that your `modules` block
says what you meant.

## Goal: just licensing

Activation keys, tiers, entitlements, and device seats — no managed settings, no release feed.

```yaml
# .pkey/product.yaml
product:
  slug: acme
  name: Acme
modules:
  license:
    enabled: true
```

Registration derives to **`requires-license`**: `POST /acme/devices/register` refuses with
`403 registration_closed`, and a device becomes a device only by redeeming a key or enrolling.

**Endpoints that light up** (on top of the Core surface every product has —
`/.well-known/polaris.json`, `/.well-known/jwks.json`, `/.well-known/polaris-trust.jws`,
`/devices[/:id]`, `POST /devices/report`):

```
POST /acme/license/activate
POST /acme/license/enroll         (only if you opt into an auto-issue policy)
POST /acme/license/token
POST /acme/license/deauthorize
GET  /acme/license/document       → pkey-license+jws
```

**SDK calls that light up:**

```ts
await client.license.activateWithKey(userEnteredKey);
client.license.status(); // ok | grace | expired | revoked | needs-activation | …
client.license.isEntitled("proFeature");
client.license.getEntitlements();
```

`client.config` throws `PolarisError` with code `service-unavailable` — a sub-client whose service
is off is not silently inert. Entitlements ride the license document and only it: the catalog's
`flag` keys seed the defaults, and admin policy (`license.tier`, `license.tierLabel`, `channels`,
`app.minVersion`, `app.maxVersion`, `deviceLimit`) is stamped on top as enforced entries. Add tiers
and an auto-issue policy to the same `.pkey/product` when you need them — see
[License](/docs/services/license/).

## Goal: just managed config

Signed settings and secrets delivered to **any registered device, with no license anywhere in the
picture.** This is the wire-level proof that the services are independent, and it is the mix most
people are surprised is supported.

```yaml
# .pkey/product.yaml
product:
  slug: acme
  name: Acme
modules:
  config:
    enabled: true
```

```yaml
# .pkey/schema.yaml — always required at ingest; its contents are validated when Config is on
schemaVersion: 1
entries:
  - key: run.concurrency
    kind: config
    category: Run
    label: Parallel downloads
    schema:
      type: integer
      minimum: 1
      maximum: 8
    default: 3
    managementDefault: default
```

With License and Identity both off, registration derives to **`open`**: any caller may mint a
`pkeyt_` device token at `POST /acme/devices/register`, rate-limited by edge IP, fingerprint
optional. That token is all `GET /acme/config/document` needs.

:::caution[Do not declare `requires-license` here]
Config on, License off, and a declared `requires-license` policy is refused as
`config_without_activation`: it closes the only mint path such a product has, leaving the service
enabled and unreachable.
:::

**Endpoints that light up:**

```
POST /acme/devices/register       → a pkeyt_ device token   (Core, opened by the `open` policy)
GET  /acme/config/document        → pkey-config+jws
GET  /acme/config/schema          → the public catalog
GET  /acme/config/mint/<id>/token (only if the catalog declares an edgeMint secret)
GET  /acme/config/mint/<id>/auth
```

**SDK calls that light up:**

```ts
await client.devices.register(); // no key, no license
await client.sync(); // trust refresh → config document → verify → cache
client.config.getConfig<number>("run.concurrency", 3);
client.config.getSecret("proxy.subscriptionUrl");
client.config.listUserConfig(); // for a settings UI; `hidden` entries are withheld
```

The gate reports **`not-applicable`** with `isUsable` true, so the app boots working instead of
sitting on `needs-activation` forever. Values resolve through one fixed precedence —
`enforced | hidden (remote) > local override > environment > remote default > fallback` — so an
`enforced` value always comes from the server and a `default` one can be overridden locally. See
[Config](/docs/services/config/).

## Goal: just releases and updates

A changelog, an install script, signed artifacts, and a Sparkle appcast — no licensing, no managed
settings.

```yaml
# .pkey/product.yaml
product:
  slug: acme
  name: Acme
modules:
  release:
    enabled: true
  distribution:
    enabled: true
  update:
    enabled: true
```

```yaml
# .pkey/release.yaml — required whenever Release is on
release:
  provider: { type: github, owner: acme-inc, repo: acme }
  binaryName: acme
```

The older flat `ghOwner:` and `ghRepo:` fields, and a release body without the `release:`
wrapper, still validate but are deprecated: `pkey validate` warns with `deprecated_spelling`
(see [Deprecated spellings](/docs/build/manifest/authoring/#deprecated-spellings)). GitHub is the
only provider implemented, and `binaryName` is character-class-bounded because it is
interpolated into the published `install.sh`.

Release, Distribution and Update are **three services, not one**: Release is the truth store
(GitHub sync, channel resolution, artifacts, changelog, install script), Distribution is how
releases reach devices and outlets, and Update is the feed that tells an installed copy what to do
next (appcast, `/version`, eligibility). They form a chain — Distribution without Release is
refused as `distribution_requires_release`, Update without Distribution as
`update_requires_distribution` — because the feed would otherwise answer every client with an
empty document rather than an error. The legacy `"releases": { "enabled": true }` spelling still
works and turns on **all three**, which is why it can never trip either rule; it is deprecated,
so `pkey validate` warns on it.

**Endpoints that light up:**

```
GET /acme/release/changelog
GET /acme/release/install.sh                    (alias: /acme/install.sh)
GET /acme/release/dl/<version>/<binary>-<arch>[.dmg]
GET /acme/update/version                        (alias: /acme/version)
GET /acme/update/appcast.xml[?arch=]            (alias: /acme/appcast.xml)
GET /acme/update/<channel>/appcast.xml[?arch=]  (alias: /acme/<channel>/appcast.xml)
```

Both appcast spellings take `?arch=arm64|x86_64`; omitting it serves `arm64`, for continuity with
feed URLs that shipped before per-arch support existed — which is exactly why an SDK sends the
parameter explicitly rather than relying on the default.

**SDK calls that light up:**

```ts
await client.release.changelog();
client.release.installUrl();
client.release.downloadUrl(version, "acme", "arm64"); // built, not fetched — you stream it
await client.update.check({ channel: "stable" });
client.update.appcastUrl({ channel: "stable", arch: "arm64" });
```

On macOS, `PolarisKeyUpdate` wires **Sparkle ≥ 2.9.6** (the
[security floor](/docs/services/update/sparkle/#the-version-floor)) to the feed, taking the feed
URL from discovery rather than a literal. It never verifies updates: `SUPublicEDKey` in the code-signed
`Info.plist` is the terminal anchor, and the target only asserts loudly that it is present.

Metadata and artifact access default to `public` — anonymous update checking is a feature for the
products that want it. Tightening to `authenticated`, `licensed` or the operator-only `entitled`
mode is a console setting, not a manifest one. See [Update](/docs/services/update/) and
[Release](/docs/services/release/).

## Goal: everything

Every service except Cloud Sync, the closed registration policy, and the full manifest set. This
is the shape `djdl` — the first Polaris Key product — actually ships.

```yaml
# .pkey/product.yaml
product:
  slug: acme
  name: Acme
modules:
  license: { enabled: true }
  config: { enabled: true }
  release: { enabled: true }
  distribution: { enabled: true }
  update: { enabled: true }
  identity: { enabled: true }
devices:
  registration: requires-license
oidc:
  provider: platform
  redirectUris:
    - https://key.plrs.im/acme/identity/auth/callback
```

All three manifest files are in play: `.pkey/schema` (the catalog), `.pkey/product` (the block
above, plus tiers, profiles, fingerprint and auto-issue policy, provisioning hooks), and
`.pkey/release` (GitHub coordinates, channels, edge-mint recipes).

Everything from the three sections above lights up, plus Identity:

```
GET  /acme/identity/session
POST /acme/identity/session/license
     /acme/identity/auth/{start,callback,poll,logout}
     /acme/identity/auth/device/{start,verify,poll}
```

`requires-license` is declared here rather than derived. With License on, the derivation would
produce the same answer today — but declaring it says "this is the policy", not "this is whatever
the services imply", which is the right posture for a product that will never want keyless
registration.

Verify the result says what you meant before you integrate anything:

```sh
curl -fsS https://key.plrs.im/acme/.well-known/polaris.json | jq .services
```

A service you turned off appears as `{"enabled": false}` and nothing else — there is no endpoint
list to read a disabled service's shape out of.

## Then: integrate

```ts
import { PolarisKeyClient } from "@polaris-key/node";

const client = await PolarisKeyClient.create({
  productSlug: "acme",
  version: appVersion, // the HOST app's semver — X-PKey-Version, and what the gate reads
  trust: { pinnedKeys }, // kid → raw Ed25519 public key, compiled in
  expectedServices: ["config"], // name what this build ships against
});

await client.discover(); // installs the product's real capability map
await client.sync(); // trust refresh → enabled documents in parallel → verify → cache
```

`create()` performs **no network**: it loads the device id, the token and the cached signed
documents and re-verifies them, so an offline-first host can render its gate before it has ever
reached the control plane. `trust.pinnedKeys` is a _Core_ option, not a License one, because it
verifies config documents, trust manifests and offline bundles too — a product with License
disabled still needs pins.

Capabilities are **fail-closed**: a discovery document loaded this session wins, else
`expectedServices`, else the suite default (License + Config on, the rest off). Name
`expectedServices` for what the build ships against, so an unreachable control plane cannot
silently take a service away.

## Related

- [Onboarding a product](/docs/build/onboarding/) — the full path, end to end.
- [Authoring the manifest](/docs/build/manifest/) — every `.pkey/` field and validation code.
- [The service model](/docs/start/service-model/) — enablement, ownership, coherence rules.
- [The wire contract](/docs/build/wire/) — what the documents you just turned on actually contain.

## Onboarding a product

This guide is a template for bringing a product onto Polaris Key, using **djdl** — the
first Polaris Key product — as the worked example throughout. Substitute your own product
slug, repo, and secrets wherever djdl appears.

Polaris Key is seven opt-in services — **License**, **Config**, **Release**, **Distribution**,
**Update**, **Identity**, **Cloud Sync** — over an always-on **Core** substrate (product registry, the device principal,
trust and signing, discovery, rate limiting, audit). So onboarding starts with two declarations
rather than with code: which of the seven this product runs, and how its devices get a credential.
Which routes exist, what discovery says, and which SDK sub-clients answer are all projections of
those two.

For djdl specifically the onboarding is a **fresh start** — no KV data is migrated, and
users sign in again or activate with newly issued keys.

## 1. Stand up Polaris Key (prod)

See [Deploying to production](/docs/admin/deploy/). In short: create the D1/KV resources with
wrangler, set platform secrets, apply migrations, `wrangler deploy --env prod`, and confirm
`https://key.plrs.im` answers.

## 2. Declare the product's services

`.pkey/product`'s `modules` block is the manifest half of the enablement authority; the Worker
persists it to `products.services_json`, and route mounting, the discovery document, the admin
product view and portal capabilities all read that one column. A disabled service's routes 404 as
if the product had never existed — the same answer an unregistered slug gets, so probing tells a
caller nothing.

The seven service slugs (`license`, `config`, `release`, `distribution`, `update`, `identity`,
`sync`) are the current
vocabulary; the pre-suite module names still validate and are translated, so a manifest may mix
them. `licensing` → license, `oidc` → identity, `edgeMint` → config (edge-minting is a
secret-**delivery** capability of Config, not a service of its own), and `releases` → release,
distribution **and** update, because the old module meant "distributes software", which the suite
splits into the truth store, delivery, and the feed. A manifest that declares no `modules` block — or one where
nothing is `enabled: true` — runs **license + config**, which is what every product ran before the
suite existed.

`devices.registration` says who may mint a device token at `POST /<p>/devices/register`:

| Value               | Behaviour                                                                |
| ------------------- | ------------------------------------------------------------------------ |
| `open`              | keyless, rate-limited, optional fingerprint; mints a `pkeyt_` token      |
| `requires-identity` | the same endpoint, but only behind a valid product identity session      |
| `requires-license`  | `403 registration_closed`; activation/enrollment are the only mint paths |

Leaving it undeclared is meaningfully different from choosing a value: an undeclared product
tracks the derivation — `requires-license` if License is on, else `requires-identity` if Identity
is on, else `open` — so turning License off later moves it rather than leaving it pinned to a
policy nobody wrote. djdl declares every service except Cloud Sync, and the closed policy:

```jsonc
{
  "modules": {
    "license": { "enabled": true },
    "config": { "enabled": true },
    "release": { "enabled": true },
    "distribution": { "enabled": true },
    "update": { "enabled": true },
    "identity": { "enabled": true },
  },
  "devices": { "registration": "requires-license" },
}
```

Four coherence rules are enforced on the manifest and the admin API alike. Release, Distribution
and Update form a chain: `distribution` without `release` is an error
(`distribution_requires_release`), and `update` without `distribution` is an error
(`update_requires_distribution`) — the feed would answer every client with an empty document
rather than a failure. `requires-identity`
without Identity is an error (`registration_requires_identity`): there is no login to stand
behind, so the endpoint could never say yes. Config with License off **and** `requires-license`
declared is an error (`config_without_activation`) — the service is enabled and its devices have
no way to obtain a token; the manifest validator also warns on the softer form, Config enabled
with neither License nor Identity.

Services can also be changed live: `PATCH /manage/api/products/djdl/services` claims the column
for `admin`, after which a `.pkey/` push no longer rewrites it, and `POST …/services/revert`
hands ownership back to `manifest` — it only flips the owner, so the operator's values stand
until the next resync re-applies the manifest.

## 3. Register the product

1. Add `.pkey/product.yaml`, `.pkey/schema.yaml`, and `.pkey/release.yaml` to the product
   repo. `pkey init` can scaffold them; edit them until `pkey validate` passes. `pkey validate`
   prints the enabled services in slug vocabulary, so it is also the check that §2 says what you
   meant.
2. Install the Polaris Key GitHub App on the product repository, then link the repo in the
   admin console. Polaris Key fetches the default-branch `.pkey/` files, validates them, mints a
   sealed Ed25519 product signing key in `product_keys`, and returns the public trust key.
   Confirm the GitHub App webhook is active so future default-branch `.pkey/` changes sync
   automatically and appear in the Releases view with changed paths and validation errors.
3. In Settings, set every required product secret shown by setup health. That can
   include an OIDC client secret and one edge-mint private key per recipe. These are
   write-only admin/API values stored sealed in `product_secrets`; they are not Worker
   secrets and are never echoed back. Set each edge-mint key with usage **Edge-mint signing
   key** (a general secret cannot sign: the token route answers `500 misconfigured`), then
   approve the recipe in the **Edge-mint recipes** card on the Secrets view.
   Until it is approved the token route answers `404`, like an unknown recipe. See
   [Edge-mint](/docs/services/config/edge-mint/#two-operator-conditions).
4. Verify the Core surfaces answer and the services map says what you declared:

   ```sh
   curl -fsS https://key.plrs.im/djdl/.well-known/polaris.json | jq .services
   curl -fsS https://key.plrs.im/djdl/.well-known/jwks.json | jq .
   curl -fsS https://key.plrs.im/djdl/.well-known/polaris-trust.jws >/dev/null
   curl -fsS https://key.plrs.im/djdl/config/schema | jq '.entries | length'
   curl -fsS https://key.plrs.im/djdl/appcast.xml >/dev/null
   ```

   A service you turned off is present in `services` as `{"enabled": false}` and nothing else —
   there is no endpoint list to read a disabled service's shape out of. Then check product
   setup/release health for missing required secrets or release assets.

## 4. Integrate `PolarisKeyClient`

`@polaris-key/node`'s facade composes Core with one sub-client per service. `create()` performs
**no network**: it loads the device id, the token and the cached signed documents and
re-verifies them, so an offline-first host can render its gate before it has ever reached the
control plane.

```ts
import { PolarisKeyClient } from "@polaris-key/node";

const client = await PolarisKeyClient.create({
  productSlug: "djdl",
  version: appVersion, // the HOST app's semver: X-PKey-Version, and what the build gate reads
  trust: { pinnedKeys }, // kid -> raw Ed25519 public key (base64url), compiled in
  expectedServices: ["license", "config", "release", "update"],
  config: { localOverrides: userSettings },
});

await client.discover(); // installs the product's real capability map
await client.sync(); // trust refresh -> enabled documents in parallel -> verify -> cache

if (!client.isLicensed()) {
  const r = await client.license.activateWithKey(userEnteredKey);
  if (r.kind !== "ok") showActivationError(r.kind);
}

const concurrency = client.config.getConfig<number>("run.concurrency", 3);
const vpnUrl = client.config.getSecret("proxy.subscriptionUrl");
const hasVpn = client.license.isEntitled("polarisVpn");
```

Options are split by owner rather than fused into one bag, so a product that disabled a service
never has to think about its inputs:

| Bag                       | Options                                                                                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| top level (`CoreOptions`) | `productSlug`, `version`, `trust.pinnedKeys`, `baseUrl`, `channel`, `trustRefresh`, `store`, `configDir`, `fetchImpl`, `requestTimeoutMs`, `expectedServices` |
| top level (facade)        | `refreshIntervalSeconds`, `onChange`                                                                                                                          |
| `config:`                 | `localOverrides`, `envPrefix`, `env`                                                                                                                          |
| `license:`                | `fingerprint`                                                                                                                                                 |
| `devices:`                | `probes`, `fingerprint`                                                                                                                                       |

`trust.pinnedKeys` is Core's, not License's, because it verifies config documents, trust
manifests and offline bundles too — a product with License disabled still needs pins. `baseUrl`
must be `https:` (or `http://localhost` / `http://127.0.0.1`); anything else throws
`InsecureBaseUrlError` at construction.

The suite's shape is `client.<service>.<verb>`:

| Sub-client       | Verbs                                                                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `client.license` | `activateWithKey` · `enroll` · `deactivate` · `status` · `isLicensed` · `isEntitled` · `getEntitlements` · `getProfile` · `getLicenseId` · `activation` |
| `client.config`  | `getConfig` · `getConfigSource` · `listUserConfig` · `getSecret` · `schemaVersion`                                                                      |
| `client.devices` | `register` · `list` · `rename` · `deauthorize` · `report` · `fingerprint`                                                                               |
| `client.release` | `changelog` · `installUrl` · `downloadUrl`                                                                                                              |
| `client.update`  | `check` · `appcastUrl`                                                                                                                                  |

`status()`, `isLicensed()`, `getConfig()`, `listDevices()`, `getCurrentDevice()`,
`renameDevice()`, `deauthorizeDevice()`, `importBundle()` and `getSyncState()` are kept on the
facade for the calls a host makes before it knows which service it is talking to.

`sync()` replaces v2's `refresh()`, and it is one Core pass rather than a config fetch that
happened to carry everything: trust refresh on Core's own cadence → the **enabled** documents in
parallel with per-document ETag/304 → verification with per-type anti-replay floors → one
read-modify-write of the cache → the monotonic clock floor → best-effort telemetry to
`POST /djdl/devices/report`. Activation does not call it inline; the license client raises an
event and the facade syncs, which is what lets a config-only product activate nothing and still
sync.

Capabilities are **fail-closed**: a discovery document loaded this session wins, else
`expectedServices`, else the suite default (License + Config on, the rest off). A sub-client
whose service is off throws `PolarisError` with code `service-unavailable`, and a product with
License off gates `not-applicable` with `isLicensed() === true` — a config-only product boots
usable instead of sitting on `needs-activation` forever. A config-only product must name
`expectedServices` without `license`: discovery alone can switch the licence gate on but never
off, so an unreachable or hostile control plane cannot take the gate away.

## 5. Engine + app changes (in the djdl repo)

The engine's managed-config client uses `key.plrs.im/djdl`. Every product-scoped route is now
namespaced under the service that owns it:

| File                                                      | Change                                                                                                                                                                                                                                                                                               |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/integrations/remoteConfig/fetch.ts`                  | The fused `/djdl/config` is gone. Fetch `GET /djdl/license/document` and `GET /djdl/config/document` independently, each with its own `ETag`/`If-None-Match` — or drop the hand-rolled client for `@polaris-key/node`.                                                                               |
| `src/integrations/remoteConfig/{activate,report}.ts`      | `/djdl/license/{activate,token,deauthorize}`; telemetry moves to `POST /djdl/devices/report`; update tests.                                                                                                                                                                                          |
| request headers                                           | `X-DJDL-Device/Version/Channel` → `X-PKey-Device/Version/Channel`, plus `X-PKey-SDK`, `X-PKey-SDK-Version`, `X-PKey-Platform`, `X-PKey-Arch`.                                                                                                                                                        |
| `src/integrations/remoteConfig/verify.ts`                 | Set the prod entry in `TRUSTED_KEYS` to the kid → base64url pubkey pair the console returned when it minted the signing key. **Keep** the committed test kid so the checked-in vector still verifies. Expect `iss` `key.plrs.im` and `aud` `djdl`, and `typ` `pkey-license+jws` / `pkey-config+jws`. |
| `macos/project.yml`                                       | `SUFeedURL → https://key.plrs.im/djdl/appcast.xml` (keep `SUPublicEDKey`) — see §6.                                                                                                                                                                                                                  |
| edge-mint clients                                         | Fetch third-party tokens from `https://key.plrs.im/djdl/config/mint/<recipe>/token`; auth page → `…/config/mint/<recipe>/auth`.                                                                                                                                                                      |
| `LicenseGateView.swift` / landing / `CloudSettings.swift` | use the Polaris Key host, `key.plrs.im`; OIDC starts at `/djdl/identity/auth/start` and returns to `/djdl/identity/auth/callback` (register that redirect URI with the IdP).                                                                                                                         |

The macOS app keeps **delegating licensing to the embedded engine** (it is not retrofitted
to the Swift SDK now). Optionally, the engine's `remoteConfig` client can later be replaced
by `@polaris-key/node` — a post-cutover follow-up.

## 6. Updates: Sparkle and the appcast aliases

Four paths predate the namespacing and are compiled into artefacts nobody can recall — shipped
`SUFeedURL` values and published `curl … | sh` lines. They are kept **permanently** and are
implemented by rewriting in the core router, so an alias and its canonical spelling resolve to
the same route with the same segments and cannot answer differently:

The four pre-namespace spellings (`appcast.xml`, `<channel>/appcast.xml`, `install.sh`,
`version`) are permanent aliases of their canonical `update`/`release` routes — the full
table and the reasons they are kept forever live on
[the appcast page](/docs/services/update/appcast/).

`/<p>/changelog` is deliberately **not** on that list — it was never baked into a binary or a
published command, so it moved to `/<p>/release/changelog` outright. Both appcast spellings take
`?arch=arm64|x86_64`; omitting it serves `arm64`, for continuity with feed URLs that shipped
before per-arch support existed, which is exactly why an SDK sends the parameter explicitly
rather than relying on the default.

On macOS, `PolarisKeyUpdate` is the Swift target that wires **Sparkle ≥ 2.9.6** (the security
floor: delta-patch symlink and privilege-escalation fixes) to the product's feed. It is macOS-only in two places at once — the Sparkle
product dependency carries `.when(platforms: [.macOS])` and every Sparkle-touching source file is
`#if os(macOS)`-guarded — because either alone is insufficient: an unguarded import fails to
compile on iOS, and an unconditioned product drags a macOS XCFramework onto an iOS link line.

```swift
#if os(macOS)
import PolarisKeyUpdate

await client.discover()                       // the feed URL comes from DISCOVERY, not a literal
let update = UpdateClient(core: client.core)
let feed = await update.feed(
    channel: "stable",
    entitlements: await client.license.entitlements())

// Throws SparkleAnchorError when the host bundle carries no `SUPublicEDKey`.
let delegate = try PolarisSparkleUpdater.configure(
    updaterController.updater,
    feed: feed,
    headers: await update.feedHeaders())      // the bearer token, for `entitled` feeds
updaterController.updater.delegate = delegate // RETAIN it: `delegate` is weak
#endif
```

It carries the feed URL (from discovery, `?arch=` applied), `httpHeaders` — Sparkle makes its own
HTTP requests, so the device token has to travel on them — and `allowedChannels` from the
license's `channels` entitlement, so a stable-only customer is not offered a beta the server will
then refuse. That last is a UX narrowing, not an enforcement point. It does **not** verify updates:
`SUPublicEDKey` in the code-signed `Info.plist` is the terminal anchor, and `PolarisKeyUpdate`
only asserts it is present, loudly, because an app shipping Sparkle without it shows no symptom
until it installs an unsigned payload.

The `entitled` feed access mode makes the server enforce the same grant. `licensed` asks whether
there is a usable license; `entitled` also asks whether _this_ license holds _this_ channel at
_this_ version, closing the gap where a stable-only key could fetch `/djdl/beta/appcast.xml` and
the build behind it. It is **operator-set, not manifest-declarable** — `.pkey/release`'s
`access` accepts only `public`, `authenticated` and `licensed`:

```sh
curl -X PATCH https://key.plrs.im/manage/api/products/djdl/update/settings \
  -H 'content-type: application/json' \
  -d '{"metadataAccess":"public","artifactsAccess":"entitled"}'
```

`public` stays the default: anonymous update checking is a feature for the products that want it.
The same endpoint owns `compatMin`/`compatMax`, the global window every grant is intersected
with. Saving either block claims it for the operator, so a later `.pkey/` push no longer rewrites
it — `entitled` survives the next resync; `POST …/update/settings/revert` with
`{"fields":["access"]}` hands it back.

## 7. Cut over

1. Land the engine/app edits + README + tests on a branch; merge; tag `vX.Y.Z`. The
   unchanged sign/notarize/appcast pipeline publishes the GitHub Release; Polaris Key
   proxies it. A product with a `deliverables.app` artifact map can instead (or as well) publish
   each release from CI with `pkey release publish` or the `polaris-key/publish` Action, with
   no secret in the repository: see [Publishing from CI](/docs/build/ci/).
2. Verify end-to-end against `key.plrs.im/djdl`: `license/activate` → both documents verify
   under the new kid; anti-replay/device-bind pass; the appcast alias and its canonical
   spelling both serve; Sparkle downloads and verifies; OIDC loopback mints a license + token;
   the console shows the device.
3. Roll forward by fixing the product manifest or release tag and re-running setup health.

## 8. Offline: air-gapped activation and local-only builds

An install that will never reach the control plane activates from a signed `pkey-bundle+jws`
file instead — the classic request-code flow. The app shows its request code (product +
`deviceId`); an operator mints a bundle against it; the file crosses on a USB stick.

```sh
PKEY_ADMIN_COOKIE='__Host-pkey_admin=<console session cookie>' \
  pkey bundle --product djdl --device <deviceId> --grace-days 365
# -> djdl-<first 8 of device id>.pkeybundle
```

The mint (`POST /manage/api/products/djdl/bundles`) signs the license document, the config
document if Config is enabled, and the current trust manifest into one envelope. `--grace-days`
is capped at 365 and enforced at both mint and verify; the bundle **file** has its own, much
shorter 30-day import window, so a stolen file stops being useful long before the install it
would have provisioned runs out.

On the device, `importBundle()` is all-or-nothing: the bundle verifies against **pinned keys
only**, then the inner trust manifest, then each document against the effective set — and only
then is the cache replaced atomically. Any failure imports nothing and throws a `PolarisError`
whose code names the step that refused, because "get a bundle minted for this machine" is a
different remedy from "the mint bound the wrong device".

```ts
import { createBundleClient, createLocalClient } from "@polaris-key/node/local";

// A fresh air-gapped install: verify + install the operator's file, then gate on it.
const { client, imported } = await createBundleClient({
  productSlug: "djdl",
  version: appVersion,
  trust: { pinnedKeys },
  bundle: await readFile(bundlePath, "utf8"),
});
// imported.imported -> ["license", "config"]

// An already-provisioned or config-only install.
const local = await createLocalClient({
  productSlug: "djdl",
  version: appVersion,
  trust: { pinnedKeys },
});
```

The local profile is transportless: `CoreContext.fetcher()` refuses **before** a URL is built or
a header is assembled, so a local-only build cannot dial even by accident, and the refresh timer
is never started. There is still exactly one client type — `client.license.activateWithKey(…)`
exists and rejects with `PolarisError` code `local-only` rather than being absent and forcing the
host to branch on which client it got. `deactivate()` and `devices.report()` swallow the refusal,
because both were already best-effort against a dead network. `LocalOptions` omits `fetchImpl`
and `refreshIntervalSeconds` by construction.

Gate-wise, a verified bundle sets `activation: "bundle"`, which satisfies activation with no
`pkeyt_` token at all; fingerprint enforcement is skipped, since there is no server to dedupe
against. A bundle carrying only `docs.config` imports settings and grants nothing. With no server
to revoke against, the grace bound **is** the revocation lever — re-issue on an annual cadence.
On Swift the same profile is a link-time guarantee rather than a runtime flag: don't link
`PolarisKeyUpdate` and set no `SUFeedURL`, and "no update traffic" is a fact about the binary.

## 9. Optional: free tier and live re-licensing

**Auto-issued licenses.** Declare an `autoIssue` block in `.pkey/product` (see
[Authoring the manifest](/docs/build/manifest/authoring/)) and the client can obtain a license with no key and no sign-in:

```ts
const client = await PolarisKeyClient.create({
  productSlug: "djdl",
  version,
  trust,
});
if (!client.isLicensed()) {
  const r = await client.license.enroll(); // 404 → { kind: "enroll-disabled" }
}
```

One license per machine, deduplicated on the hardware fingerprint. Signing in later _claims_
that license in place, so the user's devices and local state survive.

**Live re-licensing.** Changing a license's tier in the admin console changes what running
clients are entitled to on their next `sync()` — nothing is pushed. Nothing polls by default, so
opt in where you want an upgrade to land without a restart:

```ts
const client = await PolarisKeyClient.create({
  productSlug: "djdl",
  version,
  trust,
  refreshIntervalSeconds: 900,
  onChange: (state) =>
    applyEntitlements(client.license.getEntitlements(), state),
});
// …
client.close(); // stops the timer
```

`onChange` fires only when a document actually changed — it keys off the per-document ETags,
which exclude the per-request timestamps, so a pure re-sign does not wake the app. The current
tier is readable as the `license.tier` / `license.tierLabel` entitlements, which ride the license
document alongside `channels`, `app.minVersion`/`maxVersion` and `deviceLimit`.

**Downgrades grandfather.** Moving a license to a tier with fewer seats never evicts a device:
existing devices keep working and new activations are refused until the count drops below the
new limit. The admin API reports `overLimit` so the UI can say so at the moment of the change.
