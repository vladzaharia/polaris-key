---
title: "How Polaris Key works"
description: "Features and the services behind them, signed documents and pinned keys, and the rules that decide which services a product runs."
type: "concept"
sdks: ["node", "react", "python", "swift", "kotlin", "godot"]
lastReviewed: "2026-10-10"
---

A product takes only the features it needs, and the app checks everything Polaris Key sends against keys it pinned at build time.

## A product is a record

A product is a record with a slug, a signing key and a set of enabled services. Create it in the console under **Products → New product**, or link a repository whose `.pkey/` manifest describes it. A linked product re-syncs on every push to the default branch, so changing it never needs a Polaris Key deploy. See [Registering a product](/docs/build/manifest/register/).

## Features and services

Core is always on. It holds the product registry, devices, signing keys, discovery, rate limits and audit. A product that enables nothing still registers devices and serves its public keys.

Everything else is an opt-in service. The console groups the services into features:

| Feature        | Services                            | What your app gets                                                    |
| -------------- | ----------------------------------- | --------------------------------------------------------------------- |
| Licensing      | `license`                           | Activation, licenses and keys, tiers, entitlements and device limits  |
| Managed config | `config`                            | The config catalog, profiles, overrides and secret delivery           |
| Ship builds    | `release`, `distribution`, `update` | Releases, where they reach devices, and the update feed               |
| Sign-in        | `identity`                          | OIDC sign-in and browser sessions for the product                     |
| Cloud Sync     | `sync`                              | A signed-in person's settings, saves and records across their devices |

A service a product hasn't enabled doesn't exist for it. A disabled service, an unknown service and an unknown route all return the same `404`, so a caller can't tell which services a product runs.

## Signed documents and pinned keys

Each service issues its own signed document, so services stay independent on the wire. A config document mentions no license.

| Document       | Type               | Endpoint                                       |
| -------------- | ------------------ | ---------------------------------------------- |
| License        | `pkey-license+jws` | `GET /<product>/license/document`              |
| Config         | `pkey-config+jws`  | `GET /<product>/config/document`               |
| Trust manifest | `pkey-trust+jws`   | `GET /<product>/.well-known/polaris-trust.jws` |

The SDK verifies each document against signing keys your app pins at build time. It never learns trust from the network, so a compromised server can't replace the keys a shipped app trusts. `pkey sdk` writes the pins into your config file in step 4 of [Your first product](/docs/start/first-product/).

After activation, the SDK keeps working offline from its verified cache until the license document's grace period ends.

## Which services a product runs

A product's enabled services are stored once, and every surface reads that one record: route mounting, the discovery document, the console's navigation and the portal. A product starts with License and Config on and everything else off.

The manifest's `modules` block sets the services. So does **Core → Services** in the console. A console edit takes ownership from the manifest, so later pushes don't rewrite the services. **Revert to manifest…** hands ownership back, and the manifest's values apply at the next resync.

Only `enabled: true` counts in `modules`. A block where nothing is `true` gives the defaults, not no services. To run one service, name it and leave the others out.

A record Polaris Key can't read in full falls back to License and Config on. It is never read in part.

## Coherence rules

Services depend on each other. Distribution needs Release, Update needs Distribution, and Cloud Sync needs Config and Identity. Polaris Key checks an enablement set as a whole. Each fault has one stable code, so every surface reports the same fault.

| Code                             | The fault                                           | `pkey validate` and ingest | Enablement API |
| -------------------------------- | --------------------------------------------------- | -------------------------- | -------------- |
| `distribution_requires_release`  | Distribution on, Release off                        | Error                      | Error          |
| `update_requires_distribution`   | Update on, Distribution off                         | Error                      | Error          |
| `sync_requires_config`           | Cloud Sync on, Config off                           | Error                      | Error          |
| `sync_requires_identity`         | Cloud Sync on, Identity off                         | Error                      | Error          |
| `registration_requires_identity` | `requires-identity` declared, Identity off          | Not checked                | Error          |
| `config_without_activation`      | Config on, License and Identity off                 | Warning                    | Not checked    |
| `config_without_activation`      | Config on, License off, `requires-license` declared | Not checked                | Error          |

A config-only product is valid on purpose: it issues config documents to registered devices with no license anywhere. Ingest doesn't check `registration_requires_identity`, so a repository can push a `requires-identity` policy to a product without Identity. Core asks Identity again on every registration and refuses with `403 registration_closed`.

## Device registration

`devices.registration` decides who gets a device token from `POST /<product>/devices/register`. Core serves that route under every policy.

| Policy              | Who gets a token                                          |
| ------------------- | --------------------------------------------------------- |
| `open`              | Any caller, rate-limited by IP                            |
| `requires-identity` | A caller with a live browser session on the product       |
| `requires-license`  | No one here: activation and enrollment are the only paths |

If you leave the policy undeclared, it follows the services: `requires-license` when License is on, else `requires-identity` when Identity is on, else `open`. A product that later turns License off moves to the derived policy. Declaring a value pins it.

Every refusal is the same `403 registration_closed`, whatever the reason.

## Next steps

- [Concepts and glossary](/docs/start/concepts/)
- [Choose your integration](/docs/start/choose-your-integration/)
- [Public route table](/docs/reference/routes/)
- [Manifest validation codes](/docs/reference/validation-codes/)
