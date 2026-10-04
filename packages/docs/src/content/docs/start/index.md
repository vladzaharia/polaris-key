---
title: "What is Polaris Key?"
description: "The platform in one page: products as data, six opt-in services over an always-on Core, and signed documents a client verifies against pinned keys."
sidebar:
  order: 1
---

Polaris Key is a multi-product **licensing + remotely-managed-config + release-delivery**
platform. It is one Cloudflare Worker at `key.plrs.im`, plus SDKs for **Node, React, Python, Swift,
Godot and Kotlin**, and it is built so that a product can take exactly the parts it wants: one app takes
signed settings without taking licensing, another takes a release feed without taking either.

Five ideas carry the whole system. If you read nothing else here, read these.

## 1. A product is data, not code

Onboarding a product does not mean writing worker code or shipping a deploy. A product describes
itself in a **`.pkey/` directory in its own repository**, an operator links that repo in the
console, and the worker fetches, validates and persists it. From then on a push to the default
branch re-syncs it through a signed GitHub webhook. **Adding or changing a product never requires
a worker redeploy.**

`.pkey/` is the only manifest directory — there is no second candidate and no fallback between
two — and it holds up to three independent documents. The base name selects the role; the
extension is a pure format preference, tried `.json`, then `.yaml`, then `.yml`, resolved per
document, so a repo may keep `product.yaml` next to `schema.json`.

| File      | What it carries                                                                                   |
| --------- | ------------------------------------------------------------------------------------------------- |
| `schema`  | the config catalog: `schemaVersion` plus `entries[]`                                              |
| `product` | metadata, **which services this product runs**, device registration policy, OIDC, profiles, tiers |
| `release` | release-provider coordinates, channels, install/appcast settings, edge-mint recipes               |

Everything the manifest declares is a _baseline_. Runtime admin state — secret values,
per-license and per-device overrides, operator-claimed policy blocks — lives in Polaris Key and
survives every resync. See [Authoring the manifest](/docs/build/manifest/).

## 2. One worker: an always-on Core plus six opt-in services

The worker is a **modular monolith**: an always-on `core/` substrate and one directory per
service. Core is what every product gets and no product can switch off — the product registry,
the **device** principal (registration, `pkeyt_` tokens, list/rename/deauthorize, fingerprints,
facts), trust and signing, discovery, rate limiting, the error taxonomy and audit. Core is _not_
a service: it never appears in an enablement set, and a product that enables nothing still
registers devices and serves its JWKS.

Over that substrate sit exactly six opt-in services. Each is addressed by a singular **slug**
that is the same word everywhere — the worker directory, the route namespace
(`/<product>/<slug>/…`), the SDK sub-client (where there is one), and the console section.

| Service                                      | Owns                                                                                      |
| -------------------------------------------- | ----------------------------------------------------------------------------------------- |
| [Core](/docs/services/core/)                 | always on — devices, trust, signing, discovery, rate limits, audit                        |
| [License](/docs/services/license/)           | activation and enrollment, the license document, licenses and keys, tiers, entitlements   |
| [Config](/docs/services/config/)             | the catalog, the config document, profiles, edge-minted secret delivery                   |
| [Release](/docs/services/release/)           | GitHub sync, channels, artifacts, changelog, install script — the release **truth store** |
| [Distribution](/docs/services/distribution/) | how releases reach devices and outlets — transports, availability, rollouts               |
| [Update](/docs/services/update/)             | the Sparkle appcast, `/version`, eligibility — the **feed** rendered over Release         |
| [Identity](/docs/services/identity/)         | product OIDC, browser sessions, the customer portal                                       |

A service a product has not enabled does not return an error — **from the outside it does not
exist.** Disabled, unregistered and no-such-route all return one identical `404`, because telling
them apart is the reconnaissance being refused.

## 3. `services_json` is the single enablement authority

Which services a product runs is one column, `products.services_json`, fed by the manifest's
`modules` block. Four surfaces that used to guess at enablement — route mounting, the discovery
document, the console nav, and portal capabilities — are now **projections of that one column**
and infer nothing. That is what stops a discovery document from advertising a service whose
routes 404.

Read [The service model](/docs/start/service-model/) for the column, its ownership rules, the
four projections, and the coherence rules an enablement set is validated against.

## 4. Each service issues its own signed document

Every artifact Polaris Key hands a client is a compact **JWS (EdDSA / Ed25519)**, and the wire
contract splits what used to be one fused document into **one document per service**. That split
is what makes the services independent _on the wire_, not just in the router: a config document
mentions no license at all.

All documents share an envelope — `iss` (`key.plrs.im`), `aud` (the product slug), `deviceId`,
`issuedAt`, `expiresAt`, `graceUntil` — and are domain-separated by their JOSE `typ`, which is
rejected when unknown or missing.

| Document       | `typ`              | Endpoint                                       |
| -------------- | ------------------ | ---------------------------------------------- |
| License        | `pkey-license+jws` | `GET /<product>/license/document`              |
| Config         | `pkey-config+jws`  | `GET /<product>/config/document`               |
| Trust manifest | `pkey-trust+jws`   | `GET /<product>/.well-known/polaris-trust.jws` |
| Offline bundle | `pkey-bundle+jws`  | minted out-of-band by an operator              |

The verifying key is selected by the header `kid` **from a trust set, never from the document**,
and `alg` is asserted `EdDSA` before any signature math runs. The trust manifest itself is always
verified against **pinned keys only**, on both the network and the cache-reload path — pins are
terminal, which is what stops a compromised server from re-rooting a client's trust. The
byte-for-byte encoding is the subject of [the wire contract](/docs/build/wire/).

## 5. Six SDKs, one corpus, and it works offline

The SDKs are **six packages — Node, React, Python, Swift, Godot, Kotlin** (Kotlin's verified core
first; its service modules follow) — each composing Core with one
sub-client per service (`client.license`, `client.config`, `client.release`, `client.update`,
`client.devices`). They do not agree on the wire by code review: the worker and all six SDKs
drive the **same conformance corpus** (`conformance/corpus/v2/`), vector for vector, and
`pnpm gen:corpus -- --check` is a CI drift gate. That is how the encoding stays byte-identical
across TypeScript, Python, Swift, GDScript and Kotlin through a wire change — the A1 identifier flip re-signed every
vector and the gate stayed green.

Offline is a supported mode at three depths, not a degraded one:

- **Offline-tolerant.** After activation a client runs with zero network: a verified cache,
  pins-only reload, grace until `graceUntil`, and a monotonic clock floor
  (`effectiveNow = max(systemClock, highWaterMark)`) so winding the system clock back cannot
  resurrect an expired grant.
- **Air-gapped.** An operator mints a device-bound `pkey-bundle+jws` in the console or with the
  `pkey` CLI; the file crosses on a USB stick and `importBundle()` verifies it against pins,
  then its trust manifest, then each inner document, and only then writes the cache. There are
  no partial imports, and a verified bundle satisfies activation with **no `pkeyt_` token
  anywhere**.
- **Local-only.** A build profile with no network code paths active at all — on Swift by not
  linking the network-bearing targets, so "no update traffic" is a link-time guarantee rather
  than a runtime setting.

:::note[A config-only product boots usable]
`LicenseStatus` carries **`not-applicable`**, returned when the product does not enable License,
and `isUsable` is true for it. So a config-only or release-only app boots working rather than
claiming it needs an activation it will never have.
:::

## Where to go next

- **[Concepts & terminology](/docs/start/concepts/)** — the canonical glossary. When code and
  that page disagree, that page wins.
- **[The service model](/docs/start/service-model/)** — enablement, its four projections, and
  the coherence rules.
- **[Architecture](/docs/start/architecture/)** — the worker's layout, the service descriptor,
  and how the boundaries are enforced.
- **[Quickstart by goal](/docs/start/quickstart/)** — the smallest manifest for licensing only,
  config only, releases only, or everything.
- **[Building on Polaris Key](/docs/build/)** — onboarding, manifest authoring, SDK
  integration, the wire contract.
