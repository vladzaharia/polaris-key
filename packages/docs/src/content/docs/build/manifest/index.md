---
title: "The .pkey/ manifest"
description: "Up to four files, JSON or YAML, that describe a product as data — the schema catalog, product metadata, release coordinates, and distribution outlets."
sidebar:
  order: 2
  label: "The .pkey/ manifest"
---

A Polaris Key product is **data, not code**: everything the control plane needs to run it —
its config catalog, its metadata, its release coordinates — lives in a `.pkey/` directory in
the product's own repo, and the Worker, the admin SPA, and every SDK read that data. `.pkey/`
is the **only** manifest directory; there is no fallback location and no second copy that
could disagree with it.

## The files

| File             | Base name                      | Required when                                          | Carries                                                                                                            |
| ---------------- | ------------------------------ | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| **schema**       | `schema.{json,yaml,yml}`       | always (content validated only when Config is enabled) | the config catalog: `{ schemaVersion, entries[] }`                                                                 |
| **product**      | `product.{json,yaml,yml}`      | always                                                 | metadata, enabled services, device registration policy, browser origins, OIDC, profiles, tiers, provisioning hooks |
| **release**      | `release.{json,yaml,yml}`      | Release is enabled                                     | provider coordinates + channel/install/appcast/edge-mint settings                                                  |
| **distribution** | `distribution.{json,yaml,yml}` | never (absent = one implicit `direct` outlet)          | outlets and their store identities, transports per deliverable, the store listing                                  |

Each file's **base name** selects its role; the **extension** is a pure format preference,
resolved independently per file in the fixed order `.json`, then `.yaml`, then `.yml` — so a
repo may keep `product.yaml` next to `schema.json`. Full field-by-field authoring guidance,
using djdl as the worked example, is at [Authoring the manifest](/docs/build/manifest/authoring/).

## Size and depth caps

Manifest ingest runs from a **GitHub push webhook on a third party's repo** — the bytes are
attacker-chosen, so cost is bounded before the parser ever sees them. Each document is
capped independently at **64 KiB** and **32 levels of nesting**; a YAML file's
anchor/alias expansion is separately bounded to keep a "billion laughs" payload from costing
more than its encoded size suggests. The real manifests in this repo run about 1.5 KB, so 64
KiB is two orders of magnitude of headroom — and it keeps a single parse to roughly a tenth of
a second regardless of what a hostile repo sends. A file over either cap is refused outright,
not truncated.

## Both module vocabularies

`.pkey/product`'s `modules` block accepts two vocabularies, and a manifest may mix them. The
current one is the six service slugs; the pre-suite names are translated to slugs at ingest,
so only slugs are ever stored:

| Declared (legacy) | Enables                               | Note                                                                                                                                                       |
| ----------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `licensing`       | `license`                             | rename                                                                                                                                                     |
| `releases`        | `release` + `distribution` + `update` | the legacy module meant "distributes software", which the suite splits into the truth store (`release`), delivery (`distribution`) and the feed (`update`) |
| `oidc`            | `identity`                            | rename                                                                                                                                                     |
| `edgeMint`        | `config`                              | edge-minting is a secret-**delivery** capability of Config, not a service of its own                                                                       |

The current names — `license`, `config`, `release`, `distribution`, `update`, `identity` — need
no translation
and may appear in the same block alongside legacy ones.

A manifest that declares no `modules` block — or one where nothing is `enabled: true` — runs
**license + config**, matching every product's behavior before the service suite existed. These
coherence rules are enforced at ingest and by the live enablement API alike:
`distribution_requires_release`, `update_requires_distribution`, `invalid_registration_policy`,
and `config_without_activation` (a
warning at ingest, promoted to an error by the enablement API for the one combination that is
genuinely unreachable). The full list, with JSON-pointer paths, is at
[Manifest validation codes](/docs/reference/validation-codes/).

## Resync vs. admin ownership

> The full ownership model — claim-on-PATCH, revert-hands-back, and the four projections —
> is specified once on [The service model](/docs/start/service-model/); this is the manifest
> author's view of it.

The files are a **baseline**, not the live state. A resync (re-link, or a signed GitHub push
webhook) updates product metadata, service enablement, fingerprint and auto-issue policy,
catalog shape, OIDC, release settings, profiles, tiers, and provisioning — but five blocks can
be **claimed** by an admin from the console (`services_source`, `fingerprint_policy_source`,
`auto_issue_source`, and from Update → Feed `compat_source` for the compatibility window and
`access_source` for the metadata access mode), and a resync skips whichever ones an admin
already owns. The operator-only artifact policy — the Sparkle signature requirement and the
minimum macOS version — has no manifest spelling at all, so no push can write or erase it. "Revert to
manifest" hands ownership back without changing the values, so the manifest re-applies on the
next resync rather than immediately — an operator's escape hatch that never depends on a
GitHub round trip succeeding. Everything else an admin sets — secrets, per-profile/tier/
license/device management state and values, operational overrides — lives in the platform's
own storage and is never overwritten by a resync at all; it isn't manifest-owned to begin with.

## In this section

- **[Authoring the manifest](/docs/build/manifest/authoring/)** — the field-by-field guide,
  the `ConfigEntry` shape, and the fingerprint/auto-issue/registering flows, worked through
  djdl.
- **[Distribution: outlets, transports and listing](/docs/build/manifest/distribution/)** — the
  optional fourth file: where the product is distributed, its store identities, and the
  `pkey distribution outlet-ids` bridge into a Godot export.
- **[JSON Schema & editor setup](/docs/build/manifest/json-schema/)** — machine-readable
  schemas for completion and validation while you edit, and how they stay honest.
