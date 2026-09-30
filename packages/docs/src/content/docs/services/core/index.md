---
title: "Core"
description: "The always-on substrate: the device principal, trust and signing, discovery, rate limits, and the error taxonomy."
sidebar:
  order: 1
---

Core is the substrate every product gets and no product can switch off. It is **not a
service** — it never appears in an enablement set, it has no slug, and a product that has
enabled nothing at all still registers devices, serves its JWKS, and answers discovery.

What Core owns:

- the **product registry** — loading a product, its signing key, and its enablement set;
- the **Device principal** — registration, `pkeyt_` tokens, the device roster, fingerprints,
  and facts;
- **trust & signing** — the per-product Ed25519 keypair, the JWKS, and the signed trust
  manifest;
- **discovery** — the one public document that describes a product honestly;
- **rate limiting**, the **error taxonomy**, **audit**, and **manifest-ingest dispatch**.

Everything else is one of the five opt-in services — [License](/docs/services/license/),
[Config](/docs/services/config/), [Release](/docs/services/release/),
[Update](/docs/services/update/), [Identity](/docs/services/identity/) — addressed under
`/<product>/<slug>/…` and mounted through a registry Core owns.

## The core routes

These exist under every registration policy and every enablement set. They are matched in
`packages/worker/src/router.ts` before the service namespaces, so a service slug can never
shadow them.

| Route                                                     | What it is                                                                         |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `GET /<p>/.well-known/polaris.json`                       | The [discovery document](/docs/services/core/discovery/)                           |
| `GET /<p>/.well-known/jwks.json`                          | The product's public signing keys                                                  |
| `GET /<p>/.well-known/polaris-trust.jws`                  | The signed [trust manifest](/docs/services/core/trust/)                            |
| `POST /<p>/devices/register`                              | Keyless [device registration](/docs/services/core/device-principal/), policy-gated |
| `GET /<p>/devices` · `GET/PATCH/DELETE /<p>/devices/<id>` | The device roster; mutations are self-only                                         |
| `POST /<p>/devices/report`                                | Device facts and probe telemetry                                                   |

`/manage/*`, `/docs/*`, and the root customer portal are platform surfaces, reserved ahead of
product slugs in the same matcher. The full public route table — every service included — is
generated at [Public route table](/docs/reference/routes/).

## Enablement is Core's, and dispatch is where it bites

`products.services_json` is the single authority for which services a product runs. Core
checks that column **before** consulting a service descriptor, so a disabled service's code
never runs: it cannot read a row, write an audit entry, spend a rate-limit token, or make a
timing difference that distinguishes "off" from "absent".

```
dispatchService(registry, slug, services, ctx)
  services[slug].enabled === false  ->  404
  no descriptor registered          ->  404
  descriptor.handle() returned null ->  404      (same body, all three)
```

The parser behind that column is strict and fail-safe at once: anything structurally wrong —
bad JSON, an unknown slug with a malformed value, a non-boolean `enabled`, a `registration` value outside the three
policies — discards the **whole** record and reads as the defaults (License and Config on, the
rest off). Half-honouring a typo is how a typo turns into a silently disabled service.

## What a product that enables nothing still gets

The degenerate case is the useful test of "always on". With all five flags off, a product still:

- resolves — `loadProduct` finds the row and opens its sealed signing key;
- serves discovery, JWKS, and a signed trust manifest;
- mints device tokens, if its effective registration policy allows it (with License off and
  Identity off, the derived policy is `open`);
- lists, renames, and deauthorizes devices, and accepts facts reports;
- is rate-limited, audited, and answers the same error taxonomy as any other product.

What it does not get is any signed _service_ document — there is nothing to put in one. That is
why a client's license gate reports `not-applicable` rather than `needs-activation` for a product
with License off: a config-only or release-only product boots usable rather than claiming it
needs an activation it will never have.

## Where Core's state lives

Core owns nine D1 tables: `products`, `product_keys`, `product_secrets`, `devices`,
`device_fingerprints`, `device_facts`, `audit`, `product_sync_state`, and
`schema_index_assertion`. Ownership is **logical** — everything lives in one database, and a
service may only touch another's tables through Core-mediated seams, which the worker's boundary
test enforces. Column lists are generated at [D1 data model](/docs/reference/data-model/).

## The seam: Core never imports a service

A service may import `core/`. Core may not import a service. Where Core genuinely needs an
answer only a service can give, it declares a narrow hook on `ServiceDescriptor` and asks the
registry for it:

- `discoveryFragment(ctx)` — the service's own block of the discovery document. Core knows who
  to ask, not what the answer looks like.
- `authorizeRegistration(ctx)` — "may this caller be given a device credential?" This is the
  one authorization decision Core delegates, and it exists because one registration policy is
  named after a service. Everything about what a _refusal_ looks like stays Core's.
- `manifestIngest(parsed, product)` — the rows a service wants written when a `.pkey/` manifest
  is ingested.
- `handle(ctx)` returns `null`, never a 404, when nothing inside the service matched — only
  Core knows whether "no match" should be a 404, an alias fall-through, or a redirect.

Every hook fails closed. A descriptor that omits `authorizeRegistration` is one Core can never
satisfy a policy with, which is the correct default: an unimplemented hook must not read as an
open door.

## Hide, don't reveal

An unauthenticated prober must not be able to map which products run which services. That
posture shows up in three places, and each is a deliberate loss of detail:

- one 404 for a disabled service, an unregistered slug, and an unmatched route;
- one `403 registration_closed` for all four reasons registration can be refused;
- a discovery document whose disabled entries carry the enabled flag and nothing else.

See [Errors and limits](/docs/services/core/errors/) for the exact bodies.

## In this section

- **[The device principal](/docs/services/core/device-principal/)** — registration policies,
  `pkeyt_` tokens, the roster, and the report surface.
- **[Fingerprints](/docs/services/core/fingerprints/)** — the seven components, drift, modes,
  and what `unverified` means.
- **[Trust and signing](/docs/services/core/trust/)** — pinned keys, the trust manifest, and
  why Core owns refresh scheduling.
- **[Discovery](/docs/services/core/discovery/)** — what the public document says and what it
  deliberately does not.
- **[Errors and limits](/docs/services/core/errors/)** — the two wire error shapes, the 404
  policy, and rate limiting.

Terminology throughout follows [Concepts & terminology](/docs/start/concepts/); the normative
wire rules are `docs/security/WIRE-CONTRACT-V3.md` in the repo, cited here as "the wire contract
(§N)".
