# P0-05 Add a per-product CORS allowlist to the Worker

| Field       | Value                                                                                                                                                                                |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase       | P0: Hygiene, unblockers and code quality                                                                                                                                             |
| Size        | 0.5–0.75 engineer-weeks                                                                                                                                                              |
| Depends on  | none                                                                                                                                                                                 |
| Unblocks    | [P1-12](P1-12-godot-release.md), [P3-09](P3-09-updater-feeds.md), [P6-04](P6-04-hosted-web.md), [D-02](D-02-diceroll-after-p1.md)                                                    |
| Role        | `pkey-implementer`                                                                                                                                                                   |
| Plan mode   | no                                                                                                                                                                                   |
| Gates       | rule 9 (`web.origins` validator + mutation table + schema); rule 10 (`OPTIONS` in spec + `routeCoverage`); D1 migration; generated `validation-codes` and `data-model`; threat model |
| Human input | none                                                                                                                                                                                 |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                            |

## Goal

A browser page served from an origin a product lists in `.pkey/product` (for example
`https://diceroll.gg`) can call that product's device-facing routes with `fetch`: discovery,
JWKS, trust manifest, devices, register, License, Config, Release downloads, Update and the
device-code flow. Preflights succeed, `ETag`/`Content-Range` are readable, and no other origin
gets any `Access-Control-*` header. Nothing on the console, portal, docs or webhook surfaces
changes.

## Why

The Worker emits no CORS header anywhere and has no `OPTIONS` handling, so a request with
`Authorization: Bearer` or any `X-PKey-*` header is preflighted and the preflight 404s (report
[§9.1](../../README.md#91-polaris-key-worth-fixing-regardless-of-godot) issue #10;
[notes/A1 §4](../../notes/A1-release-update.md#4-byte-hosting-model),
[notes/A3 §7.2](../../notes/A3-admin-dx.md#72-web-builds-and-cors)). Godot web exports, the React
SDK on a third-party site and any packs fetched by a browser are blocked. The report's design is
in [§3.11](../../README.md#311-web): a per-product origin allowlist (like
`OIDC_ISSUER_ALLOWLIST`), preflight for `Authorization` and `X-PKey-*`,
`Access-Control-Expose-Headers: ETag, Content-Range, Repr-Digest`, no credentials on public
blobs, and `OPTIONS` handling that goes through the OpenAPI/`routeCoverage` gate.

## Read first

- `AGENTS.md` (rules 9, 10, 11) and the `authoring-pkey-manifests` skill.
- `packages/worker/src/index.ts` (`dispatch`, `PRODUCT_ROUTES`, `secureResponse`),
  `packages/worker/src/router.ts`, `packages/worker/src/securityHeaders.ts`.
- `packages/worker/src/services/release/gateway.ts:92-106,192-203,249-253` (edge cache for public
  surfaces) and `github.ts:182-245` (`streamAsset`, the forwarded response headers).
- `packages/worker/src/services/identity/browserSession.ts:76-99` (cookie-bearing routes) and
  `services/identity/routes.ts:3-16` (the identity route list).
- `packages/worker/src/services/release/linkRepo.ts:86-134` (`manifestIssuerRefusal`, the
  precedent the report points at).
- `packages/shared-manifest/src/index.ts`, `schemas/v1/product.schema.json`,
  `test/schema-parity.test.ts`; `packages/worker/openapi/polaris-key.v3.yaml`,
  `test/routeCoverage.test.ts`.
- `docs/security/THREAT-MODEL.md` §3 (R1-09: one origin serves the console, the portal and the API).

## Scope

**In:**

- **Manifest field** `web.origins` in `.pkey/product`: up to 16 exact origins. Each is
  `https://<host>[:port]` with no path, query, fragment, credentials or wildcard, lower-cased; the
  only `http` origins allowed are `http://localhost[:port]` and `http://127.0.0.1[:port]` for
  local web-export testing. Validator codes (proposed): `invalid_web_origins`,
  `invalid_web_origin`. Persisted as `products.web_origins_json` (manifest-owned; link and
  resync write it; `loadProduct` exposes `product.webOrigins`).
- **Responses.** On a product route whose request `Origin` is in the list: `Access-Control-Allow-Origin: <that origin>`,
  `Vary: Origin`, `Access-Control-Expose-Headers: ETag, Content-Range, Accept-Ranges, Content-Length, Repr-Digest`.
  Never `Access-Control-Allow-Credentials`. `Vary: Origin` is sent on every product-route response
  once any origin is configured, allowed or not.
- **Preflight.** `OPTIONS` on a covered product path returns 204 with the allow-origin header,
  `Access-Control-Allow-Methods: GET, POST, PATCH, DELETE`,
  `Access-Control-Allow-Headers: Authorization, Content-Type, Range, If-None-Match, If-Range, X-PKey-Device, X-PKey-Version, X-PKey-Channel, X-PKey-SDK, X-PKey-SDK-Version, X-PKey-Platform, X-PKey-Arch`
  (listed explicitly, built from the constants in `packages/shared-protocol/src/core.ts:224-230`:
  `*` does not cover `Authorization`), and `Access-Control-Max-Age: 600`. A
  disallowed origin gets 204 with no `Access-Control-*` headers. The answer does not depend on
  whether the service behind the path is enabled, so preflight cannot reveal enablement.
- **Covered paths:** every `CORE_KIND_PATHS` and `SERVICE_PATHS` entry in `routeCoverage.test.ts`
  except the cookie and navigation routes: `/{product}/identity/session`,
  `/{product}/identity/session/license`, `/{product}/identity/auth/start`,
  `/{product}/identity/auth/callback`, `/{product}/identity/auth/logout`,
  `/{product}/identity/auth/device/verify`, `/{product}/config/mint/{mintId}/auth`. The four
  permanent aliases are covered like their targets.
- **Rule 10.** Add an `options` operation that references one shared
  `components.responses.CorsPreflight` to every covered path in `polaris-key.v3.yaml`, and extend
  `routeCoverage.test.ts` so each covered path must document `options` and no excluded path may.
- Docs: a "Web clients and CORS" section in `packages/docs/src/content/docs/build/` (or the
  manifest reference), the skill's field list, and `THREAT-MODEL.md` (the new input).

**Out** (and where it belongs instead):

- The bytes host for R2 and immutable blob paths (→ P2-01, landed as `dl.plrs.im`, same-site with the console, with compensating controls; not a separate registrable domain).
- Hosting web builds, COOP/COEP/CORP for threaded builds (→ [P6-04](P6-04-hosted-web.md)).
- Credentialed (cookie) CORS for the React SDK's browser session: the browser adapter is
  first-party only and stays so.
- An operator override of the manifest's list (not requested; revisit with P2b-02 listings).

## Design notes

- **Where.** Apply CORS in `dispatch` (`index.ts`) for `PRODUCT_ROUTES` after `loadProduct`, and
  answer `OPTIONS` there before `dispatchService`. Never inside a handler: the release gateway
  stores handler responses in `caches.default` keyed without the origin, so an allow-origin header
  added inside would be replayed to every other origin. Adding it after the handler returns keeps
  cached objects origin-free.
  _Correction (implementation):_ `dispatch` and `PRODUCT_ROUTES` moved out of `index.ts` into
  `src/dispatch.ts`, so the whole pipeline (CORS included) runs in the Node test lane with an
  in-memory `Db`. `index.ts` keeps the entry points and wraps `secureResponse` around it.
- **Why a manifest field is enough.** Without credentials, CORS only decides which pages may
  _read_ responses; any non-browser client can already call these routes, and bearer tokens are
  never ambient. So a repo-authored list cannot widen access to anything a script outside a
  browser lacks. The report's comparison with `OIDC_ISSUER_ALLOWLIST` is about shape (an exact
  allowlist, no wildcards); an operator gate is not needed. If review disagrees, add an ingest
  refusal modelled on `manifestIssuerRefusal` with a `CORS_ORIGIN_ALLOWLIST` var.
- **Never** emit CORS on `/manage/*`, `/api/*`, `/docs/*`, `/webhooks/*` or the portal routes.
  Those share the origin with the admin cookie (R1-09).
- `Repr-Digest` is not sent today; exposing it now saves a change when P2-05/P2b-04 add it.
- Migration: one `ALTER TABLE products ADD COLUMN web_origins_json TEXT;` in its own file,
  numbered on rebase (_correction:_ pre-assigned as `0024_product_web_origins.sql`). Regenerate `reference/data-model.mdx` and `reference/validation-codes.mdx`.
- `routes.mdx` is generated from `get|post|put|patch|delete` only (`gen-reference.mjs:215-239`),
  so `OPTIONS` operations do not change it. Say so in the PR.

## Steps

1. Validator rule, mutation entries, `product.schema.json` (`web.origins`), normaliser, skill.
2. Migration, ingest writes (`stmtInsertProduct`, resync's `products` update), `Product.webOrigins`.
3. A small `core/cors.ts`: `corsHeadersFor(product, req)`, `preflight(product, req)`,
   `isCorsCoveredPath(route)`; wire it into `dispatch`.
4. OpenAPI `options` operations and the shared response; extend `routeCoverage.test.ts`.
5. Tests (below), docs, threat model.

## Acceptance criteria

- [ ] Test: `OPTIONS /<p>/license/document` from a listed origin with
      `Access-Control-Request-Headers: authorization, x-pkey-version` → 204 with the exact origin,
      methods, headers and max-age; from an unlisted origin → 204 with no `Access-Control-*`.
- [ ] Test: `GET /<p>/release/dl/…` from a listed origin carries the allow-origin and expose
      headers and `Vary: Origin`, including on a `206` range response.
- [ ] Test: a cached public appcast fetched from origin A then origin B returns B's (or no)
      allow-origin header, never A's.
- [ ] Test: `/manage/api/me`, `/api/capabilities`, `/<p>/identity/session` and `/docs/` never carry
      `Access-Control-*` headers, even with a listed `Origin`.
- [ ] `schema-parity.test.ts` covers both new codes (schema can express the URL shape: `rejects`).
- [ ] `routeCoverage.test.ts` fails if a covered path lacks `options` or an excluded path has it.
- [ ] Generated docs are fresh (`gen:check`); the green gate passes, including `test:workerd`.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- routeCoverage router release updateFeed portal cors linkRepo
mise exec node@22 -- pnpm --filter @polaris-key/worker test:workerd
mise exec node@22 -- pnpm --filter @polaris-key/manifest test
mise exec node@22 -- pnpm --filter @polaris-key/docs gen:check
```

## Hand-off

P1-02 (Godot web transport), P1b-05 (Chromium runner) and P6-04 (hosted web builds) rely on:
the `web.origins` field and its validation rules, `Product.webOrigins`, the covered-path list,
the exact allow/expose header sets and `core/cors.ts`. P2-01 moved bytes to `dl.plrs.im` (a same-site sibling; `dispatchBytesHost` applies `core/cors.ts` itself) and
applies the same allowlist there. When done:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P0-05 done`.
