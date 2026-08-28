---
title: "Errors and limits"
description: "The nested wire-v3 error body, the flat shape it co-exists with, the hide-don't-reveal 404 policy, and how rate limiting fails per surface."
sidebar:
  order: 6
---

Core owns the error taxonomy, because a service has to be able to answer at all — the codes and
the response helpers live in `core/` precisely so `services/<slug>/` can import them.

## Two body shapes, on purpose

Wire contract v3 specifies a **nested** error body. The pre-split worker emitted a **flat** one.
Both are in the codebase today, and carrying both across the migration is the point: a handler
that moved without changing its body keeps its behaviour byte-identical, while the surfaces v3
introduced speak the nested shape from their first request.

**Nested (wire v3):**

```json
{ "error": { "code": "registration_closed" } }
```

**Flat (carried from v2):**

```json
{ "error": "not_found", "message": "optional" }
```

Both are `200`-style JSON responses with `content-type: application/json` and
`cache-control: no-store`, differing only in status and body.

Which surface emits which, for the Core routes:

| Surface | Shape |
| --- | --- |
| `POST /<p>/devices/register` | Nested |
| The service-dispatch not-found | Nested |
| `GET/PATCH/DELETE /<p>/devices[/<id>]` | Flat |
| `POST /<p>/devices/report` | Flat |
| Unknown product, unmatched route | Flat |

Mixing the two *inside one handler* is the thing to avoid.

On the nested helper, any extra fields ride at the **top level**, beside `error`, not inside it —
that is where the contract puts `allowedRange` on the 403 build block, and it is also where the
registration 400's `message` lands:

```json
{ "error": { "code": "bad_request" }, "message": "missing or malformed device id" }
```

`405` is the exception to all of the above: it is a plain-text `Method Not Allowed` body with no
JSON envelope.

The full code taxonomy is generated at [Wire error codes](/docs/reference/error-codes/).

## Hide, don't reveal

### One 404 for three causes

Everything under `/<product>/<service>/…` answers the **same** 404 body for three different
causes:

- the product has not enabled that service;
- no descriptor is registered for that slug in this build;
- no route matched inside the service.

```json
{ "error": { "code": "not_found" } }
```

Telling them apart is precisely the reconnaissance being refused. The service's own `handle`
returns `null` rather than a 404 for the third case, so the decision stays in one place and
cannot drift between services.

Enablement is checked **before** the descriptor is consulted, so a disabled service's code never
runs. It cannot read a row, write an audit entry, spend a rate-limit token, or produce a timing
difference that distinguishes "off" from "absent".

:::caution
An unknown product and a completely unmatched path answer `404` with the **flat** body
(`{"error":"not_found"}`), not the nested one. Both are content-free 404s with no message, but
the shapes differ, so the two cases are not byte-identical on the wire today.
:::

### One 403 for four causes

`POST /<p>/devices/register` answers `403` with `registration_closed` for all of:
`requires-license`; `requires-identity` with no session; `requires-identity` on a product whose
Identity service is off; and a device id already bound to a real license.

A caller that could tell them apart could map a product's configuration, and could probe whether
a given device id is licensed — from an endpoint that takes no credential.

### One 401 for every device-auth failure

`validateDeviceToken` returns a single `unauthorized` for a missing token, a wrong-prefix token,
a token whose hash is unknown, a deauthorized device row, a device/token/license disagreement,
and — on a License-enabled product — an unusable license. Core's own surfaces return
`401 unauthorized` for all of them.

## Rate limiting

Abuse protection on the credential-minting hot paths, backed by an atomic per-product Durable
Object so concurrent bursts cannot slip past a non-atomic counter. Limits are keyed by
`(product, bucket, id)`, product-scoped like everything else.

The client identity is the **edge IP** from `cf-connecting-ip`, which Cloudflare sets and a
client cannot spoof. The client-controlled `x-forwarded-for` is deliberately not consulted — it
would let an attacker rotate the limit key freely. Requests with no edge IP share one `unknown`
bucket.

Over-limit is a `429`. On `POST /<p>/devices/register` it is the nested
`{"error":{"code":"rate_limited"}}`; the older surfaces answer the flat shape.

### Buckets on the product-scoped wire

| Bucket | Surface | Limit | Fail mode |
| --- | --- | --- | --- |
| `register` | `POST /<p>/devices/register` | 10 / 60 s per IP | closed |
| `activate` | `POST /<p>/license/activate` | 30 / 60 s per IP | closed |
| `token` | `POST /<p>/license/token` | 30 / 60 s per IP | closed |
| `enroll` | `POST /<p>/license/enroll` | policy `rateLimitPerHour` / 3600 s per IP | closed |
| `mint` | `/<p>/config/mint/<id>/token` | 60 / 60 s per IP | closed |
| `browserSessionLicense` | `POST /<p>/identity/session/license` | 30 / 60 s per IP | closed |
| `release` | Release metadata surfaces | 30 / 60 s per IP | open |
| `releaseArtifact` | Artifact downloads | 120 / 60 s per IP | open |

The OIDC legs, both interactive logins, the portal surfaces, and the admin API have their own
buckets; the authoritative table is the fail-mode map in `packages/worker/src/core/rateLimit.ts`.

### Why the fail mode is per surface

The limiter is a hard dependency of every credential path, and it has real failure modes that
reach production: Durable Object overload, a transient colo error, and — routinely — "Durable
Object reset because its code was updated", which happens on **every deploy** to any request in
flight. Losing it must degrade deliberately, not by accident.

- **Fail closed** for anything that mints or exchanges a credential. An unlimited credential
  endpoint is a brute-force oracle against license keys and magic-link tokens. This reads
  availability-hostile but barely is: the failure is transient and per-request, and the caller
  surfaces a `429` — precisely the signal that makes a client back off and retry, unlike the
  `500` it replaces.
- **Fail open** for read-only and non-credential surfaces, where the limiter protects cost and
  noise rather than a secret, and where the request is already authenticated by something
  stronger. Locking a signed-in operator out of the console because a counter is unhappy trades a
  real outage for no security gain. Release is the clearest case: its limiter guards a GitHub
  API quota, so a limiter outage must not become a software-distribution outage.

**Unknown buckets fail closed.** A new credential endpoint that forgets to register its fail
mode should degrade safely rather than silently opting into "unlimited".

`register` is the strongest case in the table for failing closed: it mints a device token from
nothing — no key, no session, no prior state — so with the limiter gone it is an unbounded
free-credential faucet, and the device and telemetry rows it writes are the amplifier.

One ordering detail worth repeating from
[the device principal](/docs/services/core/device-principal/): on that endpoint the
`requires-license` refusal comes **before** the limiter (a policy that can never say yes must not
have its budget consumed), and the limiter comes **before** the identity exchange (so a flood of
forged cookies cannot turn a rate-limited endpoint into an unmetered session-probing oracle).

## Response hygiene

Every response leaving the worker passes through one hardening step that adds HSTS and, for any
`text/html` body that did not set its own policy, a strict script-free CSP. "There is no
CSP-less HTML on this origin" is therefore a property of the dispatcher rather than something
each handler has to remember.

JSON error and success bodies from the Core helpers always carry `cache-control: no-store`; the
three public read surfaces that are meant to be cached (discovery, JWKS, the trust manifest) set
`public, max-age=300` explicitly.

## See also

- [Wire error codes](/docs/reference/error-codes/) — the generated taxonomy.
- [The device principal](/docs/services/core/device-principal/) — where the 401, 403, and 413
  answers come from.
- [Discovery](/docs/services/core/discovery/) — the other half of hide-don't-reveal.
