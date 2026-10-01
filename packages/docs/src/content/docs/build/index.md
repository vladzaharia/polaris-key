---
title: "Building on Polaris Key"
description: "Onboard a product, author the manifest, integrate an SDK, go offline, read the wire contract."
sidebar:
  order: 1
---

This section is for the side that **adopts** Polaris Key: the team shipping a product that
wants licensing, managed config, releases, distribution, updates, or identity, and needs to know what to
write, what to run, and what to link against. If you want to know what a service actually does
on the wire, start at [Services](/docs/services/core/) instead; if you're operating an
already-deployed Polaris Key instance, that's [Administer](/docs/admin/).

Building on Polaris Key has one recurring shape, whichever of the six services you turn on: a
**product** is registered as data (a `.pkey/` manifest), the control plane signs documents
against it, and a **client** — one of four SDKs, or a CLI built from the same core — verifies
those documents and gates the app on them. Everything below is one of those three moving parts.

## In this section

| Page                                              | What it covers                                                                                                                     |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| [The .pkey/ manifest](/docs/build/manifest/)      | The three files, the `ConfigEntry` catalog shape, editor tooling, and how a resync reconciles the manifest with admin overrides    |
| [Onboarding a product](/docs/build/onboarding/)   | The end-to-end walkthrough — stand up the platform, declare services, register, integrate, ship — using djdl as the worked example |
| [Registering a product](/docs/build/registering/) | How a product becomes a row: repo-link vs. manual create, and the `modules`/`devices.registration` switches                        |
| [SDKs](/docs/build/sdks/)                         | One wire contract, five surfaces — Node, React, Python, Swift, and the CLI                                                         |
| [The wire contract](/docs/build/wire/)            | The frozen JWS envelope your client verifies, for debugging a rejection or porting a fifth SDK                                     |
| [Going offline](/docs/build/offline/)             | The three offline depths: grace, air-gapped bundles, and local-only builds                                                         |
| [API reference](/docs/build/api/)                 | Where the machine-readable OpenAPI spec and the full route table live                                                              |

Most integrations read the manifest and onboarding pages once, pick an SDK, and only come back
for [Going offline](/docs/build/offline/) if the product ships somewhere that can't always
reach `key.plrs.im`. The wire contract and API reference are lookup material, not a reading
order — reach for them when something needs to match byte-for-byte.

## Before you start

Two decisions precede any code: which of the six services — **License**, **Config**,
**Release**, **Distribution**, **Update**, **Identity** — your product turns on, and how its devices get a
credential (`devices.registration`). Both live in `.pkey/product`'s `modules` block, both are
projected everywhere else a client or an operator looks — route mounting, the discovery
document, every SDK's capability map — and neither has a default you should leave unexamined
without reading why: [Registering a product](/docs/build/registering/) covers the first, and
[Onboarding a product](/docs/build/onboarding/) covers the derivation rules for the second.
