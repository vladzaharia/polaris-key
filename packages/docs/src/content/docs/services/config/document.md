---
title: "The config document"
description: "GET /<product>/config/document: the pkey-config+jws envelope, its ETag, its grace window, and why it carries no build gate."
sidebar:
  order: 4
---

`GET /<product>/config/document` returns the signed **config document** —
`typ: "pkey-config+jws"`, wire contract v3 §2.2. It is the other half of what used to be one
fused v2 document at `/<product>/config`; that route is gone rather than aliased, because a route
that used to return a signed document must not quietly start returning half of one.

## Authentication: a device token, and a usable license when License is on

The route calls `core.validateDeviceToken`. On a product with License **off**, that is the
whole check — no license lookup, no usability check:

```
GET /<product>/config/document
Authorization: Bearer pkeyt_…
```

This is the wire-level proof of D-08, service independence: a product can run Config with License
**disabled**, its devices register and hold real `pkeyt_` tokens, and every one of them still gets
a config document. See [the device principal](/docs/services/core/device-principal/) for exactly
what `validateDeviceToken` checks.

On a product that **runs** License, the device's license must also be usable — active, and not
past its expiry. The document carries the product's secrets, so a device whose license an
operator disabled, or that expired, or that no longer exists gets a `401` with the code
`license_unusable` instead, and stops receiving them. The check runs before the ETag comparison,
so such a device is never told its copy is current. The rule follows the enablement flag, not the
presence of a license row, exactly like Core's `/devices` surfaces and the
[edge-mint guard](/docs/services/config/edge-mint/).

It is a `401`, like the one [`GET /<product>/license/document`](/docs/services/license/document/)
answers for the same license, and not a `403`: a `403` on a document is the build gate's status,
which a client reads as a version or channel block. On the `401` a client makes its single
`POST /<product>/license/token` re-acquire, which an unusable license fails too, and its license
state becomes `revoked`. The `sync-config-license-unusable` transcript pins that conversation.

A missing or invalid token is `401 unauthorized`. Anything but `GET` is `405`.

## The body

The envelope shared with every other signed document, plus Config's own two maps:

```jsonc
{
  "iss": "key.plrs.im",
  "aud": "<product-slug>",
  "deviceId": "<the caller's device id>",
  "issuedAt": 1756252800,
  "expiresAt": 1756256400,
  "graceUntil": 1758844800,

  "schemaVersion": 4,
  "config": {
    "run.concurrency": {
      "state": "default",
      "value": 3,
      "updatedAt": 1756252800,
    },
  },
  "secrets": {
    "proxy.subscriptionUrl": {
      "state": "hidden",
      "value": "…",
      "updatedAt": 1756252800,
    },
  },
}
```

| Field                    | Meaning                                                                           |
| ------------------------ | --------------------------------------------------------------------------------- |
| `iss`                    | Always `key.plrs.im` — a fixed string, never derived from the request's base URL. |
| `aud`                    | The product slug this document is scoped to.                                      |
| `deviceId`               | The caller's device id, matched against the local device on verify.               |
| `issuedAt` / `expiresAt` | `expiresAt = issuedAt + DOC_EXPIRY_SECONDS` (3600s) on the network path.          |
| `graceUntil`             | `issuedAt + maxOfflineDays × 86400` — see below.                                  |
| `schemaVersion`          | The product's active **catalog** version.                                         |
| `config`                 | Dotted catalog key → `ManagedEntry` for every resolved `config`-kind key.         |
| `secrets`                | Dotted catalog key → `ManagedEntry` for every resolved `secret`-kind key.         |

`schemaVersion` is the product's **catalog** version — bumped on an incompatible shape change —
never the wire protocol version. `config` and `secrets` are both maps of dotted catalog key to a
`ManagedEntry` (`state`, `value`, `updatedAt`); every key present has already been resolved
through the full [management-state merge](/docs/services/config/management-states/) and pruned
against the active catalog.

There is no `licenseId`, no `profile`, no `entitlements` — not blanked, **absent**. That absence
is what lets a config-only product exist on the wire at all, and it is why a config edit never
forces a license re-download: the two documents' ETags are computed independently (below).

## No build gate

Wire contract v3 names exactly one enforcement point for version and channel blocking: the license
document, because that gate is a **license grant** (D-20). This route has none. A product with no
License service has no version window to be outside of in the first place, and gating settings
delivery on a license policy would re-couple two services the whole split exists to keep
apart. A device that is `version-too-old` or `channel-not-entitled` on its license document still
gets its config document — "should this build even run" and "what are its settings" are answered
independently.

## `graceUntil`, with or without a license

`graceUntil = issuedAt + maxOfflineDays × 86400`, exactly as every other signed document computes
it (§3.3). `maxOfflineDays` is:

```
license?.max_offline_days ?? product.defaultMaxOfflineDays
```

A real, usable license's own override still wins when one is present. When there is none — no
License service, or a config-only device — the **product's** own default offline-days setting
answers instead. A config-only install is entitled to an offline grace window exactly like a
licensed one; §3.3's 365-day ceiling (`MAX_GRACE_SECONDS`) applies at verify time regardless of
which source set the day count.

## The ETag is Config's own

`configDocETag` hashes a canonical JSON of `{ iss, aud, deviceId, schemaVersion, config, secrets }`
— deliberately excluding `issuedAt`/`expiresAt`/`graceUntil`, the per-request timestamps, so the
tag only changes when the _content_ does. It is computed independently of the license document's
tag, so:

- a re-tier or a re-licensing never forces a settings re-fetch, and
- a config publish or an override edit never forces a license re-fetch.

```
If-None-Match: "<etag>"   matches    ->  304, no body
                          mismatches ->  200, a fresh pkey-config+jws, cache-control: no-store
```

A `200` carries `content-type: application/jwt`; a `304` carries only the `etag` header.

## Fails closed, never unsigned

`resolveConfigPayload` returns `null` in exactly one case: an active catalog row **exists** but
cannot be parsed. That is different from having no catalog row at all — a product with no active
schema simply passes the merged payload through unpruned, since there is nothing yet to enforce.
The unparseable case answers:

```json
{
  "error": { "code": "catalog_unavailable" },
  "message": "active catalog could not validate the config payload"
}
```

with status `500`, and it answers **before** the document is assembled or signed. There is no code
path on this route that produces a document — signed or not — without a successfully interpreted
catalog behind it.

## Responses at a glance

| Status                    | When                                                        |
| ------------------------- | ----------------------------------------------------------- |
| `200`                     | A fresh `pkey-config+jws`, `content-type: application/jwt`. |
| `304`                     | `If-None-Match` matched the current ETag. No body.          |
| `401 unauthorized`        | Missing or invalid device token.                            |
| `405`                     | Anything but `GET`.                                         |
| `500 catalog_unavailable` | An active catalog row exists but could not be parsed.       |

## Discovery

`/<product>/.well-known/polaris.json` advertises this route at `services.config.endpoints.document`,
alongside the product's current `schemaVersion` — so a client can decide whether to expect a
catalog it doesn't yet understand before it ever fetches a document. A product with Config
disabled contributes `enabled: false` and no `endpoints` at all.

## What's not here

`/config/report` is gone from this namespace. Device telemetry — OS, runtime, hardware summary,
probe results — lives at `POST /<product>/devices/report`, a Core surface: it was always anti-fraud
data that had merely been living under a config path. See
[the device principal](/docs/services/core/device-principal/).

## See also

- [Public route table](/docs/reference/routes/) — every route with its owning service.
- [Wire error codes](/docs/reference/error-codes/) — `unauthorized`, `catalog_unavailable`.
- [Management states](/docs/services/config/management-states/) — how the `config`/`secrets` maps
  in this document were resolved before signing.
- [Edge-mint](/docs/services/config/edge-mint/) — the delivery path for a secret whose value
  should never appear in this document at all.
- `packages/worker/test/licensing.test.ts` — pins that this document carries settings and no
  license fields at all, and that its ETag is independent of the license document's.
