---
title: "API reference"
description: "Where the machine-readable OpenAPI spec lives, and where the admin and portal APIs are documented instead."
sidebar:
  order: 7
---

This is a pointer page, not a rendered reference — the machine-readable spec and the generated
route table already exist and are kept honest by tests, so this page just tells you where to
find each one rather than restating either.

## The OpenAPI spec

[`/docs/openapi/polaris-key.v3.yaml`](/docs/openapi/polaris-key.v3.yaml) is OpenAPI 3.1, and it
covers exactly the **public, product-scoped wire API** — wire contract v3: Core's routes plus
the six service namespaces and the four permanent pre-namespace aliases. Point any OpenAPI
tool (Redoc, Swagger UI, an SDK generator for a language this repo doesn't ship) at that URL
directly; it's a static file, not an authenticated endpoint.

It's pinned against the actual router by `packages/worker/test/routeCoverage.test.ts` in three
directions: every route kind is mapped in the spec or explicitly marked narrative-only, every
canonical route and alias exists with the right method, and the spec contains no path outside
what the router actually serves — so a route can't be added to the router without the spec
following in the same change, and the spec can't claim a route the router doesn't actually
serve either. A small number of operations still carry `x-polaris-status: skeleton`: correct
paths, methods and auth, with full request/response schemas and examples still landing.

For the same routes rendered as one table instead of a spec file, see
[Public route table](/docs/reference/routes/) — generated from the spec itself, so the two
can't disagree.

## The admin and portal APIs are narrative-only

`/manage/api/*` (the admin console) and `/api/*` (the customer portal) are **not** in the
OpenAPI document, on purpose: both are session-authenticated browser surfaces for this
platform's own UIs, not a wire contract any SDK speaks or any third party integrates against.
They're documented as procedure instead of as a spec:

- the admin API, throughout **[Administer](/docs/admin/)** — what each console screen actually
  does on the wire, one page per feature area (products, licenses and devices, secrets and
  keys, services and enablement, offline bundles, activity);
- the customer portal API, throughout **[For users](/docs/users/)** — activation, the device
  list, downloads, and what the platform collects.

If you're integrating a product with Polaris Key, the OpenAPI spec and the route table above
are what you want; reach for Administer or For users only when you're building against the
console or the portal themselves, which is a different thing.
