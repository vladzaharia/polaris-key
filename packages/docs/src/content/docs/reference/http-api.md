---
title: "HTTP API"
description: "Base URL, authentication, error shape, versioning and pagination of the public HTTP API, with the OpenAPI spec and route table."
type: "reference"
lastReviewed: "2026-10-16"
sidebar:
  order: 7
---

The public API is the product-scoped wire API: Core's routes, one namespace per service and four permanent aliases. The machine-readable description is [`/docs/openapi/polaris-key.v3.yaml`](/docs/openapi/polaris-key.v3.yaml), an OpenAPI 3.1 file. [Routes](/docs/reference/routes/) renders the same routes as one table, generated from the spec. Point any OpenAPI tool at the spec; it is a static file.

## Base URL

`https://key.plrs.im` on the hosted platform, or the origin of a self-hosted one. A product's routes are under `/<product>/`, such as `/<product>/license/document`. The issuer in every signed document is the literal `key.plrs.im`, whichever origin served it ([The protocol](/docs/reference/protocol/#identifiers-you-can-rely-on)).

## Authentication

A route names the credential it takes. The spec's security schemes are:

| Scheme           | Credential                                        | Presented as                                      |
| ---------------- | ------------------------------------------------- | ------------------------------------------------- |
| `deviceToken`    | The per-device token, `pkeyt_` plus 43 characters | `Authorization: Bearer`                           |
| `licenseKey`     | The customer's license key, `pkey_<product>_…`    | `Authorization: Bearer`, on activation only       |
| `ciToken`        | A CI token, `pkeyci_`, scoped to a product        | `Authorization: Bearer`                           |
| `adminApiToken`  | An admin API token, `pkeya_`                      | `Authorization: Bearer`, for `pkey bundle` and CI |
| `browserSession` | The per-product sign-in session cookie            | A cookie, on the sign-in routes only              |
| `adminSession`   | The console session cookie                        | A cookie, with a CSRF token, on the console API   |

A license key is redeemed once per device for a device token. Send it to no other route.

## Errors

An error is JSON with a stable `code`. Two shapes exist, and each operation in the spec names the one it answers with:

- Nested: `{"error":{"code":"unauthorized"}}`.
- Flat: `{"error":"unauthorized"}`.

In both, extra fields such as `message`, `allowedRange` or `limit` sit at the top level, never inside `error`. An unknown product, a service that is off and an unknown route all answer the same `404`. [Errors and limits](/docs/reference/protocol/errors/) covers the shapes and rate limiting, and [Wire error codes](/docs/reference/error-codes/) lists every code.

## Versioning

The spec's file name, `v3`, versions the API description. The signed documents carry their own version, `PROTOCOL_VERSION` 4, in the protocol ([The protocol](/docs/reference/protocol/)). Neither appears in a path: a change that breaks a response shape bumps the protocol version and ships to every SDK together.

## Pagination

A list route that pages takes `limit` and `cursor`, and answers a page with a `nextCursor`. Pass the previous page's `nextCursor` as `cursor` to get the next page. A `nextCursor` of `null` is the last page. A `cursor` or `limit` outside its range is a `422`.

## The console and portal APIs

`/manage/api/*` and `/api/*` are session-authenticated browser surfaces for the platform's own screens. They are not in the OpenAPI spec, except the admin token roster, the create probes and the portal's library, product and media routes. They are documented by task: [Operate](/docs/operate/console/tour/) for the console, and the library and account tasks in [Help](/docs/help/) for the portal.
