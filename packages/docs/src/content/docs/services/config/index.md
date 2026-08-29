---
title: "Config"
description: "The catalog, the signed config document, management states, profiles, and edge-mint."
sidebar:
  order: 1
---

Config is one of the five opt-in services over Core. It answers one question, asked from several
angles: **what settings, secrets, and toggles does this device get, and who has the last word
over each one?**

Everything it owns follows from that. An operator-authored **catalog** declares which keys exist
and what shapes their values accept. A per-key **management state** decides whether the device,
the user, or the operator wins when they disagree. A **profile** bundles a set of values once and
reuses it across many licenses. The signed **config document** hands the resolved answer to the
client. And **edge-mint** is how a catalog secret that should never leave the Worker as a raw
value still reaches a runtime — as a short-lived token instead of the value itself.

A product that runs Config without License gets all of this. Every route below authenticates with
nothing but a device token — no license anywhere in the picture (D-08). See
[Core](/docs/services/core/) for the device principal, which exists either way, and
[License](/docs/services/license/) for the service Config most often runs alongside.

## Turning it on

`products.services_json` is the single authority for whether a product runs Config, alongside the
other four services. A manifest with no `modules` block at all — or one whose every entry is
off — gets `license` and `config` on and the rest off, which is exactly how every product behaved
before the column existed. Config with License off and a declared `requires-license` registration
policy is the one combination the enablement API refuses outright
(`config_without_activation`): it would close the product's only device-mint path, leaving Config
enabled and permanently unreachable. See [Concepts &
terminology](/docs/start/concepts/) for the full enablement model, shared across all five
services.

## The pages in this section

| Page                                                          | What it covers                                                                                                                                     |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| [The catalog](/docs/services/config/catalog/)                 | Authoring `ConfigEntry` items: kinds, the per-entry JSON-Schema fragment, categories and UI hints, `dependsOn`, `accessor`, and secret `delivery`. |
| [Management states](/docs/services/config/management-states/) | `default` / `enforced` / `hidden`: how `managementDefault` seeds a fresh key, how admin layers merge, and how a client resolves a value.           |
| [The config document](/docs/services/config/document/)        | `GET /<product>/config/document` — the `pkey-config+jws` envelope, its ETag, its grace window, and why it has no build gate.                       |
| [Profiles](/docs/services/config/profiles/)                   | Reusable managed-payload baselines, how they layer under a tier or a license, and the set-vs-blank rules an override batch applies.                |
| [Edge-mint](/docs/services/config/edge-mint/)                 | Minting short-lived third-party tokens from a sealed product secret: recipes, claims templates, and the confused-deputy guard.                     |

## The public surface

Four routes, all under `/<product>/config`. The full generated table — every service included —
is at [Public route table](/docs/reference/routes/).

| Route                                  | Purpose                                                                         |
| -------------------------------------- | ------------------------------------------------------------------------------- |
| `GET /<product>/config/document`       | The signed config document. Device-token auth only.                             |
| `GET /<product>/config/schema`         | The public catalog — the same JSON the admin catalog editor and every SDK read. |
| `/<product>/config/mint/<id>/token`    | Mint a short-lived third-party token. Both `GET` and `POST` work.               |
| `GET /<product>/config/mint/<id>/auth` | The recipe's operator-authored HTML auth page, if it declares one.              |

There is deliberately no bare `GET /<product>/config`. The v2 fused document is gone, split into
this service's `/config/document` and License's `/license/document` — a route that used to return
a signed document must not quietly start returning half of one, so the old spelling 404s like any
other unmatched path.

The discovery document at `/<product>/.well-known/polaris.json` describes this service under
`services.config`: the `document` and `schema` URLs in `endpoints`, the product's
`schemaVersion`, and `mint.available` — a capability bit, never a recipe list, so the two mint
routes are never published as URLs. A product with Config disabled contributes `enabled: false`
and nothing else.

## The admin surface

Two resources under `/manage/api/products/<slug>/config`:

- `catalog` — `GET` the active catalog, `PUT` a new one. A publish compiles every entry's schema
  fragment before anything is written, bumps the version, and flips it active.
- `profiles` — list, create, redacted detail, catalog-validated payload edits, and delete. The
  same batch mechanism — validate against the active catalog, seal anything catalog-secret,
  all-or-nothing — is what License's per-license override endpoint uses too; see
  [Profiles](/docs/services/config/profiles/).

Session, CSRF, rate limiting, and the platform-admin gate all run in Core before either handler is
reached.

## What Config owns, and what it shares

Config logically owns three D1 tables (see [D1 data model](/docs/reference/data-model/)).
Ownership is logical: the tables live in one database, and a service may only reach another's
rows through a Core-mediated seam.

| Table              | Carries                                                                                                                                |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `product_schema`   | The catalog, versioned — `catalog_version`, `catalog_json`, `active`. Only one row is active per product.                              |
| `profiles`         | Reusable managed-payload baselines — `id`, `name`, `description`, `payload_json`.                                                      |
| `edge_mint_config` | Edge-mint recipes — `id`, `alg`, `signing_key_secret`, `kid`, `claims_template_json`, `ttl_seconds`, `audience`, `auth_page_template`. |

The layered merge that turns a catalog, a tier's profile, a license's profiles, license overrides,
and device overrides into one effective payload lives in **Core** (`core/payload.ts`), not here —
License's entitlements and Config's `config` + `secrets` maps are sliced from the _same_ merged
result, by different services, so the walk has to happen once or the two documents could quietly
disagree about precedence. Document **assembly** — stamping the envelope onto that slice — lives
in Core too (`core/documents.ts`), for the same reason offline bundles exist: a bundle may carry a
config document with no license anywhere near it, and Core is the one place allowed to build both
without either service importing the other.

:::note[Terminology]
This section uses the vocabulary in [Concepts &
terminology](/docs/start/concepts/), which wins over code when the two
disagree. In particular: **kind** for `config`/`secret`/`flag` (never "type", which the JSON
Schema fragment already uses for something else), **management state** for
`default`/`enforced`/`hidden`, and **profile** for the reusable payload baseline — a word this
system also reuses for the signed license document's unrelated greeting block, so watch for the
collision.
:::

## How a client uses it

1. Fetch [the document](/docs/services/config/document/): `GET /config/document` with the device
   token from registration or activation, honouring `ETag`/`If-None-Match`.
2. Resolve each key through the client precedence chain: a remote `enforced`/`hidden` value always
   wins; otherwise a local override, then an environment variable, then the remote `default`, then
   the schema's own fallback. See [Management states](/docs/services/config/management-states/).
3. Store `secret`-kind values in the OS keyring, never in plaintext application storage.
4. Re-fetch on the document's own schedule. Config's ETag is computed independently of License's,
   so a settings change never forces a license re-download and a re-licensing never forces a
   settings re-fetch.

A product may run [License](/docs/services/license/) alongside, in which case the client also
fetches `GET /<product>/license/document` — a separate, independently-tagged document. A
config-only product has none of that: no activation, no license document, and this route is the
whole story.

## Config's document next to License's

The two services sign structurally similar documents from the same merged payload, but they
disagree on purpose everywhere it matters:

|                                       | Config (`pkey-config+jws`)             | License (`pkey-license+jws`)                 |
| ------------------------------------- | -------------------------------------- | -------------------------------------------- |
| Auth                                  | Device token only                      | Device token, and the license must be usable |
| Carries                               | `schemaVersion`, `config`, `secrets`   | `licenseId`, `profile`, `entitlements`       |
| Build gate                            | None                                   | Version/channel enforcement (D-20)           |
| ETag                                  | Content-only, independent of License's | Content-only, independent of Config's        |
| Works with the other service disabled | Yes — this is D-08                     | Yes                                          |

Neither document references the other, and a client that wants both simply fetches both. See
[The config document](/docs/services/config/document/) for the full shape.

## Where the guarantees are pinned

Prose is not the contract. Three places are:

- `docs/security/WIRE-CONTRACT-V3.md` — normative for the envelope (§2), the config document
  (§2.2), claim validation and grace (§3), and gate placement (§5).
- `packages/shared-catalog/src/{catalog,validate,regex}.test.ts` — pin the fail-closed schema
  policy, the format table, and the linear-time pattern engine's refusal list byte-for-byte.
- The worker's test suite — `test/licensing.test.ts`, `test/edgeMint.test.ts`, and
  `test/merge.test.ts` pin the document shape and its independent ETag, the mint guards, and the
  layer-merge precedence these pages describe.
