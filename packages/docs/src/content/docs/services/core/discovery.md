---
title: "Discovery"
description: "The registry-assembled /.well-known/polaris.json document: honest per-service fragments, the always-on core block, and why an unsigned document is a hint and not a trust root."
sidebar:
  order: 5
---

`GET /<product>/.well-known/polaris.json` is the one public document that describes a product.
It is `GET`-only (anything else is a 405) and served with
`cache-control: public, max-age=300`.

It is assembled by Core from the service registry, and it is **unsigned**.

## The shape

```jsonc
{
  "version": 2,
  "protocolVersion": 3, // PROTOCOL_VERSION — the wire contract
  "schemaVersion": 4, // the PRODUCT's active config catalog version
  "product": "<slug>",
  "slug": "<slug>",
  "name": "…",
  "baseUrl": "https://<host>",

  "core": {
    "registration": "open", // the EFFECTIVE policy, derived or declared
    "compat": { "min": "…", "max": "…" },
    "endpoints": {
      "discovery": "https://<host>/<slug>/.well-known/polaris.json",
      "jwks": "https://<host>/<slug>/.well-known/jwks.json",
      "trustManifest": "https://<host>/<slug>/.well-known/polaris-trust.jws",
      "devices": "https://<host>/<slug>/devices",
      "report": "https://<host>/<slug>/devices/report",
      "register": "https://<host>/<slug>/devices/register", // conditional
    },
  },

  "trust": {
    "jwksUrl": "…",
    "trustManifestUrl": "…",
    "cacheSeconds": 300,
    "pinnedKeys": { "<kid>": "<base64url public key>" },
    "signingKid": "…",
    "signingPub": "…",
    "keys": [
      /* kid, alg, kty, crv, publicKey, status, active */
    ],
  },

  "services": {
    "license": {
      /* the service's own fragment, or just the enabled flag */
    },
    "config": { "enabled": false },
    "release": { "enabled": false },
    "update": { "enabled": false },
    "identity": { "enabled": false },
  },
}
```

`version` is the document's own version and is **2**; `protocolVersion` is the wire contract's
`PROTOCOL_VERSION` (3); `schemaVersion` is the product's active config catalog version, not the
wire version. Three numbers, three owners — they are not expected to agree.

All URLs are absolute and built from the origin the request actually arrived on, so a consumer
never has to implement its own resolution rule against a mix of absolute and relative paths.

## The core block

Core's block answers whatever a product has enabled, **including nothing**. Discovery, JWKS, the
trust manifest, the device roster, and the report surface are always listed, because they always
exist.

`register` is the one conditional entry. It is advertised only when the effective registration
policy could ever say yes — under `requires-license` the endpoint answers a flat 403 to everyone,
and publishing a URL that is defined never to work is how a client ends up implementing a retry
loop against a wall.

`registration` carries the **effective** policy: the declared value if the product declared one,
otherwise the derivation from the enablement set. See
[the device principal](/docs/services/core/device-principal/) for the derivation.

## The services block: honest flags

The v2 document had a `modules` object that each surface re-derived its own way — `release` was
"enabled" if a release-config row existed, `oidc` if an OIDC-config row did, and license/config
were unconditional because every product had them. The document could say a service was on while
its routes 404ed, or off while they answered.

`services` replaces it, keyed by the five service slugs, and every entry is a projection of one
authority, `products.services_json`:

- **enabled** — the service's own `discoveryFragment`. Core does not know what a service
  publishes; it knows who to ask.
- **disabled** — the enabled flag set to `false` and **nothing else**. Not an empty endpoint
  list, not a populated block with a false flag. A client must not be able to read a disabled
  service's configuration out of a public document, and an operator must not be able to mistake
  "advertised" for "reachable".

A slug with **no descriptor** in this build gets the same disabled fragment, and gets it whether
or not the flag is set — so an operator who enables a service this build does not mount sees
"off" rather than a fragment nothing will serve.

That makes the document a fourth projection of the same column that mounts the routes, so it can
no longer disagree with them. A fragment reports **capability**, not just routes — whether this
product has any edge-mint recipes, which channels Release syncs — which is why descriptors are
handed a database handle when they build one.

There is no `modules` compatibility alias. The replacement is clean.

## Unsigned: a hint, not a trust root

Nothing in this document is signed. It is plain JSON over TLS, served from the same host a client
was already told to talk to.

That is deliberate, and it constrains how it may be used. `trust.pinnedKeys`,
`trust.signingPub`, and `trust.keys` are **conveniences** — for a console, an operator running
`curl`, or a first-time integration reading which kid is active. They are not a key source. An
SDK's trust set comes from keys compiled into the host application, and everything else is
learned only from a [trust manifest verified against those pins](/docs/services/core/trust/).

The practical rule: treat discovery as **coordinates and capability**, never as authority.

- Safe to consume: URLs, the registration policy, compatibility bounds, which services are on,
  and a service fragment's endpoint list.
- Never safe to consume: any key material, as a substitute for pinning.

A client that bootstrapped its trust set from this document would be trusting whoever answers
the host — which is precisely the attacker the pinned-keys tier exists to exclude.

:::note
`trust.cacheSeconds` is emitted here as its own literal `300`, matching `TRUST_CACHE_SECONDS`
in the trust module. If one is ever retuned, both have to move.
:::

## See also

- [Trust and signing](/docs/services/core/trust/) — the signed artifact that _is_ a trust root.
- [The device principal](/docs/services/core/device-principal/) — the registration policy this
  document reports.
- [Public route table](/docs/reference/routes/) — every route, generated from the OpenAPI spec
  that the route-coverage test pins to the router.
