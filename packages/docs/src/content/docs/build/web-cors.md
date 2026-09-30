---
title: "Web clients and CORS"
description: "Letting a browser page on your own origin call a product's device-facing routes with fetch — the web.origins allowlist, what it covers, and what it never will."
sidebar:
  order: 6.5
---

A browser page can only read a cross-origin response when the server says it may. The Worker
says so per product, and only for the origins that product lists under `web.origins` in
`.pkey/product`. A Godot web export on `https://play.example.com`, or the React SDK embedded in
a third-party site, can then call that product's device-facing routes with `fetch`. Every other
origin gets no `Access-Control-*` header at all, which is how things behaved before this field
existed.

## Declaring origins

```jsonc
{
  "slug": "acme",
  "name": "Acme",
  "web": {
    // Up to 16 exact origins, spelled the way a browser sends the Origin header.
    "origins": [
      "https://play.acme.example",
      "https://acme.example:8443",
      // Plain http only for local web-export testing, and only on these two hosts.
      "http://localhost:8060",
      "http://127.0.0.1:8060",
    ],
  },
}
```

The list is applied on link and rewritten on every resync. Removing the block clears it, so no
origin is allowed. There is no console override: the manifest owns this field.

Each entry is compared **byte for byte** with the request's `Origin`, so ingest refuses anything
a browser would never send instead of rewriting it:

| Refused                                              | Why                                                |
| ---------------------------------------------------- | -------------------------------------------------- |
| `https://acme.example/`, `https://acme.example/play` | an origin has no path, not even `/`                |
| `https://Acme.example`, `HTTPS://acme.example`       | browsers lower-case scheme and host                |
| `https://acme.example:443`                           | browsers drop the default port                     |
| `https://*.acme.example`, `*`, `null`                | there is no wildcard, and `null` is not an origin  |
| `https://user@acme.example`, `?query`, `#fragment`   | never part of an origin                            |
| `http://acme.example`, `http://[::1]:8060`, `ws://…` | plain http is for `localhost` and `127.0.0.1` only |
| a 17th entry, or a repeated one                      | the cap is 16; a duplicate is always a typo        |

Two validator codes report these: `invalid_web_origins` for the block's shape (not an object,
not an array, more than 16 entries) and `invalid_web_origin` for a single entry, with a
`/web/origins/<i>` pointer. Both appear in the
[validation code reference](/docs/reference/validation-codes/), and the JSON Schema enforces
the same rules in your editor except the default-port case, which only the validator catches.

## What a listed origin gets

On a covered route, a request whose `Origin` is on the list gets:

```http
Access-Control-Allow-Origin: https://play.acme.example
Access-Control-Expose-Headers: ETag, Content-Range, Accept-Ranges, Content-Length, Repr-Digest
Vary: Origin
```

`ETag` lets a poller replay `If-None-Match`, and the range headers let a resumable download
work. `Repr-Digest` is not sent yet but is already exposed, so the change that starts sending it
does not also have to touch CORS.

Once a product lists **any** origin, every response on its covered routes carries
`Vary: Origin`, whichever origin asked and whether or not one did. A shared cache can then never
hand one origin's answer to another.

`Access-Control-Allow-Credentials` is **never** sent. A listed page's `fetch` carries no cookie.
Authenticate with the bearer token the SDK already holds, which is never ambient.

### Preflight

`Authorization` and every `X-PKey-*` header make a request non-simple, so the browser asks
first. `OPTIONS` on a covered path always answers `204`. For a listed origin it adds:

```http
Access-Control-Allow-Origin: https://play.acme.example
Access-Control-Allow-Methods: GET, POST, PATCH, DELETE
Access-Control-Allow-Headers: Authorization, Content-Type, Range, If-None-Match, If-Range, X-PKey-Device, X-PKey-Version, X-PKey-Channel, X-PKey-SDK, X-PKey-SDK-Version, X-PKey-Platform, X-PKey-Arch
Access-Control-Max-Age: 600
Vary: Origin
```

The headers are listed by name because the `*` wildcard does not cover `Authorization`. Any other
origin gets a bare `204`, which the browser treats as a refusal. The answer depends only on the
path's shape and the product's list, never on whether the service behind the path is enabled,
so a preflight cannot be used to probe which services a product runs. An unknown product is a
plain `404`.

## Covered routes

Every product-scoped route in the [public route table](/docs/reference/routes/) is covered
except the seven below. The covered routes include discovery, JWKS, the trust manifest, the
device routes, License, Config (document, schema, mint token), Release (changelog, `install.sh`,
downloads), Update (appcasts, version) and the device-code flow. The four permanent aliases are
covered like the routes they point to.

These stay first-party and never answer CORS. They set or read the per-product browser-session
cookie, or they are top-level navigations:

- `/{product}/identity/session`
- `/{product}/identity/session/license`
- `/{product}/identity/auth/start`
- `/{product}/identity/auth/callback`
- `/{product}/identity/auth/logout`
- `/{product}/identity/auth/device/verify`
- `/{product}/config/mint/{mintId}/auth`

The console (`/manage/*`), the customer portal (`/`, `/api/*`, `/login`, `/download/*`), the
docs site (`/docs/*`) and the GitHub webhook never answer CORS for any origin. They share the
Worker's origin with the admin session cookie.

The OpenAPI spec documents an `options` operation on exactly the covered paths, and
`routeCoverage.test.ts` fails if a covered path lacks one or an excluded path has one. The
generated route table lists only `get`/`post`/`put`/`patch`/`delete`, so it does not show them.

## Why a manifest field is enough

Without credentials, CORS only decides which pages may **read** a response, and anything outside
a browser, such as `curl`, can already fetch it. A repository that adds an origin therefore
cannot reach anything a script could not already reach. That is why this is a manifest field and
not an operator-held allowlist like `OIDC_ISSUER_ALLOWLIST`, whose value decides where the
platform sends a secret. The allowlist is exact and has no wildcard for the same reason that one
is.

## Where the headers are added

The Worker adds these headers in its dispatcher after the route's handler returns, never inside
a handler. The release gateway stores handler responses in the edge cache under a key that does
not include the origin. A header added inside would be replayed from the cache to every later
origin. Added outside, the cached object carries no origin, and each response is decorated for
the request that asked.

Hosting the web build itself, cross-origin isolation for threaded exports, and serving bytes
from a separate domain are separate work and are not part of this field.
