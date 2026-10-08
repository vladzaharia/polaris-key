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
