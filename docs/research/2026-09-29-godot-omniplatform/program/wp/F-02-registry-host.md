# F-02 Registry host `pkg.plrs.im`: `core/registryHost.ts`, `authorizeFeedRead`, the materialiser and the client-matrix harness

| Field       | Value                                                                                                                                                                                                                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase       | F: Package feeds (pkg.plrs.im) (tier-1)                                                                                                                                                                                                                                                                |
| Size        | 1.5–2 engineer-weeks                                                                                                                                                                                                                                                                                   |
| Depends on  | [F-01](F-01-feeds-plan.md)                                                                                                                                                                                                                                                                             |
| Unblocks    | [F-04](F-04-npm-feed.md), [F-05](F-05-pypi-feed.md), [F-06](F-06-swift-registry.md), [F-07](F-07-maven-feed.md), [F-08](F-08-oci-registry.md), [F-09](F-09-godot-feed.md), [F-20](F-20-registry-credentials-plan.md), [F-30](F-30-cargo-feed.md), [F-31](F-31-go-proxy.md), [F-32](F-32-nuget-feed.md) |
| Role        | `pkey-implementer`                                                                                                                                                                                                                                                                                     |
| Plan mode   | no separate plan: this package executes the approved [`plans/F-01.md`](../plans/F-01.md) exactly, and stops to ask if the code disagrees with it                                                                                                                                                       |
| Gates       | workerd lane (`DigestStream` algorithms, the dispatcher); THREAT-MODEL §3 new section; `wrangler.toml` custom domains and `PKG_ORIGIN`; rule 10 (`REGISTRY_PATHS` in `routeCoverage`, the host's `GET /`)                                                                                              |
| Human input | the `pkg.plrs.im`, `pkg-staging.plrs.im` and `pkg-dev.plrs.im` custom domains on the `plrs.im` zone. Until they exist, test against `wrangler dev` with a `PKG_ORIGIN` override                                                                                                                        |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                                                              |

## Goal

The Worker answers on `PKG_ORIGIN` through `core/registryHost.ts` and nothing else. Every rule in
[plan §6.1](../plans/F-01.md#61-the-registry-host-isolation-contract-f-02) is test-pinned.
`authorizeFeedRead` and `feedPrincipal` exist, with the credential extractor tested and only
`anonymous` admitted. The render-on-write framework writes and serves `registry/…` objects through
the Cache API with the headers of §6.7. `registry-clients.yml` can stand up a seeded local Worker
for the ecosystem packages to plug their client matrices into.

## Why

Feeds need JSON, `text/x-swift` and OCI's root `/v2/`, which `dl.plrs.im`'s promise forbids
([S-12 §5.1](../../notes/S-12-package-feeds.md#51-what-the-existing-hosts-allow)). A third same-site host is acceptable only
with the bytes host's compensations kept unchanged and its one widening reviewed once.

## Read first

- [`plans/F-01.md`](../plans/F-01.md) §6.1, §6.2, §6.5–§6.7, §6.10, §6.11, §7.3.
- `packages/worker/src/core/bytesHost.ts`, `core/bytesHostname.ts`, `core/bytesLanding.ts`,
  `core/blobs.ts:753-830`, `dispatch.ts:80`, `mount.ts:44-62`, `test/bytesHost.test.ts`,
  `services/distribution/access.ts`, `services/distribution/feeds/cache.ts` (the Cache API pattern).

## Scope

**In:**

- `core/registryHost.ts`, `core/registryHostname.ts`, `core/registryLanding.ts`;
  `REGISTRY_ROUTES` in `mount.ts`; `PKG_ORIGIN` in `Env` and in each `[env.*.vars]`; the
  `[[env.*.routes]]` custom domains.
- `REGISTRY_HOST_TYPES`, `REGISTRY_CSP`, the inert-HTML admission and the never-served list.
- `services/distribution/registry/`: `authorize.ts` (`feedPrincipal`, `authorizeFeedRead`),
  `materialise.ts` (the `RegistryRenderer` interface, R2 writes under `registry/`, render stamps,
  render-on-miss), `cache.ts`, and `settings.ts` (the 30 s per-isolate settings cache). The
  queue drain is wired once F-03's queue table exists. Coordinate through the hand-off; F-02 ships
  the drain behind an interface.
- The `routeCoverage` `REGISTRY_PATHS` table and the spec's `servers` override for `pkg.plrs.im`.
- `registry-clients.yml` and its seeding script, with one smoke client (`curl`) until F-04 lands.
- A workerd test that `crypto.DigestStream` supports SHA-1, SHA-512 and MD5.
- THREAT-MODEL §3 "The registry host and package feeds"; DEPLOYMENT §2, §3 and §11;
  `services/distribution/package-feeds.md`.

**Out:**

- Ecosystem renderers and routes (→ F-04 to F-09).
- Tables and ingest (→ [F-03](F-03-package-releases.md)).
- Token principals (→ [F-21](F-21-registry-auth.md)).

## Design notes

- The dispatcher mirrors `dispatchBytesHost` exactly, including the not-found used for "off".
  The enablement order is policy, then `packageFeeds`, then the feed's `enabled`, then access,
  and it all runs **before** the cache lookup.
- `GET`/`HEAD` only. `OPTIONS` answers 405. No route ever gets CORS.
- Never add `xml` or `text/html` to `REGISTRY_HOST_TYPES`. The PyPI HTML page is admitted by
  `inertDocumentPolicy` alone.

## Steps

1. Hostname, dispatcher and landing page, with tests copied from `bytesHost.test.ts` and adapted.
2. Type allowlist, CSP and header hardening, plus the override tests.
3. `authorizeFeedRead` and the extractor, with unit tests for every `Authorization` shape.
4. The materialiser framework, the Cache API and render-on-miss, tested with a fake renderer.
5. Rule 10 rows, the workerd test, the CI harness, then docs and the threat model.

## Acceptance criteria

- [x] Every row of plan §6.1 has a test, including the console paths that 404 on the host and the
      overridden `Set-Cookie`, HTML, SVG, XML and CORS answers (`test/registryHost.test.ts`).
- [x] A disabled feed or a tightened mode stops a cached immutable object from being served within
      the settings TTL (`test/registryFeeds.test.ts`, "access runs before the cache").
- [x] `routeCoverage` passes with `REGISTRY_PATHS`; `test:workerd` passes.
- [x] `registry-clients.yml` runs green on the smoke client: its runner
      (`pnpm --filter @polaris-key/worker registry:clients -- --client curl`) was run green
      locally; the workflow itself first runs on the PR.
- [x] The green gate passes (`AGENTS.md`).

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- registryHost routeCoverage registry
mise exec node@22 -- pnpm --filter @polaris-key/worker typecheck:workerd
mise exec node@22 -- pnpm --filter @polaris-key/worker test:workerd
mise exec node@22 -- pnpm typecheck
```

## Corrections from the code (recorded during implementation)

- **Two test files, not one.** `test/registry.test.ts` already exists (Core's service registry),
  so the framework's tests are `test/registryFeeds.test.ts`; `test/registryHost.test.ts` pins the
  host. The Verify line's `registry` filter matches all three.
- **The `/v2/` root is a host answer, not a route.** OCI's base endpoint is owner-less and the
  same for everyone, so `core/registryHost.ts` answers it itself (like `/`), before any route and
  regardless of the OCI kill switch: it discloses nothing, and challenges are made per repository
  (§6.6). F-08 owns everything below it. `REGISTRY_PATHS` marks `/` and `/v2/` as `host` rows.
- **Where each enablement step runs.** The dispatcher (Core) refuses a route whose service is off
  for the owner, from the loaded product, as `dispatchBytesHost` does. The rest of the ladder
  (kill switch, `packageFeeds`, the feed, the mode) reads `dist_*` state, which Core may not, so
  it runs in Distribution's `authorizeFeedRead`, which every route reaches through
  `registry/serve.ts` `serveFeedRead` before the cache. `authorizeFeedRead` re-checks
  Distribution. Every step answers the identical not-found, so the order is unobservable.
- **`ChallengeKind` includes `"not-found"`**, so the plan's `{ ok: false, challenge }` result also
  carries ladder steps 1 and 2 without a third shape. The others are `"basic"` and
  `"oci-bearer"`; `feedRefusal` builds each answer. The challenge realm is the deployment's own
  registry host name (`pkg-dev.plrs.im` on dev), with `pkg.plrs.im` as the fallback.
- **Settings before F-03.** `registry/settings.ts` reads `dist_registry_policy`,
  `dist_registry_owners` and `dist_registry_feeds` with §6.4's column names. Until F-03's
  migration creates them, "no such table" reads as no row, so every feed fails closed (the
  not-found). `test/registryFeeds.test.ts` creates §6.4's DDL in-test to pin the reads; F-03 keeps
  the column names or updates that test with its migration.
- **The drain, the self-check and Release state sit behind interfaces.** `materialise.ts` ships
  `PackageSource` (F-03 implements it over `releaseCatalog.packageVersions`), `RegistryQueue`
  (F-03 implements it over `core/registryQueue.ts`), `drainRegistry` and `selfCheck`. Nothing is
  wired into `dispatch.ts` or `scheduled.ts` yet, and the `registryMaterialiser` descriptor member
  is F-03's, because the queue table does not exist.
- **Render records.** Each render also writes `registry/<eco>/<owner>/.render/<deliverable>.json`
  (its stamp and keys), which the self-check heads instead of re-rendering to compare.
  `registry.render_miss` is a per-isolate counter (`registryCounters.renderMiss`): the Worker
  has no metrics pipeline and logs no request data.
- **Methods off the registry paths.** `OPTIONS` is 405 on every path of the host (no preflight is
  ever answered). Other non-GET/HEAD methods are 405 under `/v2/` and `/<ecosystem>/`, and the
  plain not-found elsewhere, as on the bytes host.
- **Error shapes.** Not-found is the flat `{"error":"not_found"}`, `problem+json` for Swift and
  OCI's `NAME_UNKNOWN` under `/v2/`; F-06 and F-08 may add their protocol headers
  (`Content-Version`, `Docker-Distribution-API-Version`) on top.
- **The harness needed a wrangler environment.** `wrangler.toml` had no `[env.test]`; F-02 adds a
  local-only one (no routes, `workers_dev = false`, placeholder ids). `run.mjs` passes
  `PKG_ORIGIN` with `--var` (it names the port) and an empty `--assets` root, so the harness does
  not need the admin or docs builds. `seed.mjs` inserts the fixture owner with Distribution on;
  creating feed rows and publishing fixture packages through `pkey release publish` is F-03's.
- **`DigestStream` supports SHA-1, SHA-512 and MD5 on workerd** (`test-workerd/registry.test.ts`),
  so F-03 needs no JS fallback.
- **The landing page reuses the bytes host's art, stylesheet and policy** (`bytesLanding.ts` now
  exports `landingArt` and `escapeHtml`), with the title "Polaris Key Delivery" (BRAND §8) and its
  own two sentences; BRAND §8 gains "The registry host, pkg.plrs.im".
- **The generated route table shows a registry path with its host** (`gen-reference.mjs` prefixes
  a path-level `servers` URL), so `GET /` is never read as the console's root.

## Hand-off

- F-04 to F-09 implement `RegistryRenderer` and add their `REGISTRY_PATHS` rows and matrix jobs.
- F-20 and F-21 extend `feedPrincipal` and `authorizeFeedRead` without changing their signatures.

The role agent sets `--set F-02 in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set F-02 done`.
