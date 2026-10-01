---
title: "Distribution"
description: "How every release of every deliverable reaches devices and outlets: the sixth service, its place in the release ← distribution ← update chain, and the descriptor hooks it provides."
sidebar:
  order: 1
---

Distribution answers one question for every product that turns it on: **how does a release reach
devices and outlets, and what state is it in there?** [Release](/docs/services/release/) says what
exists; [Update](/docs/services/update/) tells an installed copy what to do next; Distribution sits
between them and owns delivery.

## The chain: release ← distribution ← update

The three services split everything a product delivers — its app and, later, its content packs —
into three questions:

| Service      | Answers                                                    |
| ------------ | ---------------------------------------------------------- |
| Release      | _what exists?_ — deliverables, releases, builds, artifacts |
| Distribution | _how does it reach devices and outlets, and is it there?_  |
| Update       | _what should this installed copy do next?_                 |

Enablement follows the chain. Two coherence rules, enforced by the enablement API and by manifest
ingest alike:

- `distribution_requires_release` — Distribution on with Release off. There is nothing to deliver.
- `update_requires_distribution` — Update on with Distribution off. Update's feed would have no
  delivery behind it. Together the two rules imply the retired `update_requires_release`.

The legacy `releases` module name enables all three, so a manifest written before the split keeps
meaning "this product distributes software":

```yaml
# .pkey/product.yaml — either spelling
modules:
  releases: { enabled: true }
# or
modules:
  release: { enabled: true }
  distribution: { enabled: true }
  update: { enabled: true }
```

A manifest that names `release` and `update` without `distribution` is refused with
`update_requires_distribution`. Every product that had Release on when Distribution shipped had it
switched on by a migration, so its stored state keeps serving while its manifest is fixed.

## What it does today

Distribution ships as the foundation the later work builds on. Today it has:

- **No routes.** Every `/<product>/distribution/…` path answers the platform's single not-found
  response, the same answer a disabled service gives. Storefront feeds, byte delivery and the
  download page arrive as routes in later packages.
- **A discovery fragment** that says the service is on but not yet configured:

  ```json
  { "enabled": true, "configured": false, "endpoints": {} }
  ```

- **Two descriptor hooks** (below), with no outlets declared yet: every deliverable travels by
  the default transport, `pkey-cdn`, and there are no availability records.
- **A console section**, shown only while Distribution is on, with an overview of the chain and
  of which hook answers for the product.

Because it now owns the `distribution` path segment, a manual release channel named
`distribution` loses the short `/<product>/distribution/appcast.xml` alias; its canonical
`/<product>/update/distribution/appcast.xml` keeps working.

## Descriptor hooks

A service may import only Core and itself — `update → release` is the single historical
exception — so services read one another through **descriptor hooks** that Core declares and
gates. Distribution consumes one and provides two:

| Hook                 | Provided by  | Read by      | Answers                                                                         |
| -------------------- | ------------ | ------------ | ------------------------------------------------------------------------------- |
| `releaseCatalog`     | Release      | Distribution | deliverables, releases, builds, artifact records, channel policy, yanks         |
| `delivery`           | Distribution | Update       | the default transport and availability; later rollouts, halts and delivery URLs |
| `outletCapabilities` | Distribution | Update       | what one outlet permits; nothing until outlets can be declared                  |

Every accessor **fails closed**: while the providing service is off for the product it answers
`null`, the provider's code never runs, and the consumer degrades explicitly — Update without a
delivery hook serves no per-outlet state. Hooks are read-only; a cross-service write would be an
import in disguise.

## Outlet credentials

A store connector signs in to its store with an **outlet credential** — an App Store Connect API
key, the App Store webhook secret, a Google service account or a Partner Center app. Those live
in Core, in their own sealed table, and Distribution is the only service that can open one
(`core/outletCredentials.ts`, held to that by a test); every open is audited. The JWTs and access
tokens a connector mints from them (`core/outletTokens.ts`) are cached, sealed, so a credential
is opened only when a fresh token is needed. Operators set them on the Secrets tab — see
[Outlet credentials](/docs/admin/secrets-and-keys/#outlet-credentials). No connector uses them
yet; the App Store, Play and Microsoft Store connectors arrive in later packages.

## Vocabulary

Distribution's nouns — **outlet**, **transport**, **availability**, **submission**, **rollout**,
**listing** and **outlet capabilities** — are defined in
[Concepts & terminology](/docs/start/concepts/#distribution-model). "Distribution" names this
service and nothing else.
