# F-08 OCI registry pull at `/v2/` and image-layout publish through upload tickets

| Field       | Value                                                                                               |
| ----------- | --------------------------------------------------------------------------------------------------- |
| Phase       | F: Package feeds (pkg.plrs.im) (tier-1)                                                             |
| Size        | 1.5–2.5 engineer-weeks                                                                              |
| Depends on  | [F-02](F-02-registry-host.md), [F-03](F-03-package-releases.md)                                     |
| Unblocks    | [F-10](F-10-sdks-onto-feeds.md), [F-12](F-12-console-feed-settings.md), [F-23](F-23-docker-push.md) |
| Role        | `pkey-implementer`                                                                                  |
| Plan mode   | no                                                                                                  |
| Gates       | rule 10; workerd lane (Range, HEAD); Action-bundle drift (CLI extractor)                            |
| Human input | none                                                                                                |
| Repo        | `vladzaharia/polaris-key`                                                                           |

## Goal

The OCI feed serves every package the owner's feed holds, rendered by a `RegistryRenderer` in
`services/distribution/registry/oci/`, with the endpoints of
[plan §6.8](../plans/F-01.md#68-per-ecosystem-read-endpoints-and-the-real-client-matrices). `/v2/` sits at the host root and serves anonymous public pulls, and `pkey` publishes an OCI image layout through upload tickets. Its
real-client matrix runs green in `registry-clients.yml`.

## Why

The owner asked for Docker/OCI explicitly. OCI's reference grammar puts no path in the registry host, so it must own `/v2/` at the root ([S-12 §4.1](../../notes/S-12-package-feeds.md#41-summary-table) notes).

## Read first

- [`plans/F-01.md`](../plans/F-01.md) §6.2, §6.5–§6.8; [S-12 §4.1](../../notes/S-12-package-feeds.md#41-summary-table) (the OCI row and its notes).
- The OCI distribution spec, the reference grammar, and `cloudflare/serverless-registry` as a reference for the pull path ([S-12 §9](../../notes/S-12-package-feeds.md#9-open-source-reuse)).
- F-02's `RegistryRenderer` and the harness; F-03's `packageVersions` hook and the OCI extractor.

## Scope

**In:**

- `GET /v2/`; `GET`/`HEAD` manifests by tag or digest; blobs with `Range`; `tags/list` with pagination; OCI error bodies; `/v2/token` answering 404 until F-21.
- The CLI's OCI extractor: read an image layout, upload every blob through tickets (5 GiB per blob), and describe the index and manifests in the descriptor (up to 4,096 files).
- Its `REGISTRY_PATHS` rows and the OpenAPI entries (rule 10).
- Golden-file tests for every rendered document, from a fixture with a stable and a beta version,
  one yanked version and one deprecated where the protocol allows.
- Its section of `services/distribution/package-feeds.md` and its snippet input for F-12.

**Out:**

- Auth challenges beyond the tier-1 refusal (→ F-21).
- Native publish (→ F-22).
- Settings UI (→ [F-12](F-12-console-feed-settings.md)).

## Design notes

- Version tags never move; channel tags do. Manifests by digest are immutable.
- The Bearer challenge shape is fixed in plan §6.6 even though tier 1 only refuses.
- Reference only: do not vendor `serverless-registry` here (its upload state machine is F-23's).

## Steps

1. The renderer and its golden files.
2. The routes, headers, negotiation and errors.
3. The client matrix job; then the docs.

## Acceptance criteria

- [x] Matrix green: the OCI conformance pull suite; `docker pull`, `podman pull` and `crane pull`, multi-arch.
      Run locally through `registry:clients`: the conformance pull suite (14 of 14), crane (ls,
      digest, pull of linux/amd64 and linux/arm64, validate) and docker (both platforms) green.
      podman is not installed on this machine: its client is written and runs in the workflow,
      which first runs on the PR.
- [x] Yank, deprecate and channel-tag behaviour match plan §6.7 and the protocol (see
      Corrections; pinned by `test/registryOci.test.ts` and every client).
- [x] The headers of plan §6.7 are on every answer. Nothing outside `REGISTRY_HOST_TYPES` is served.
- [x] `routeCoverage` passes. The green gate passes (`AGENTS.md`).

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- registryOci routeCoverage
mise exec node@22 -- pnpm --filter @polaris-key/worker test:workerd
mise exec node@22 -- pnpm --filter @polaris-key/worker registry:clients -- --client oci --client oci-crane --client oci-docker --client oci-conformance
gh workflow run registry-clients.yml -f ecosystem=oci
```

## Corrections (recorded while implementing, against the code)

- **The render drain is not wired yet, so OCI reads check freshness themselves.** F-02 shipped
  `drainRegistry` behind an interface and said the `registryMaterialiser` member was F-03's;
  F-03 shipped the queue helpers and said the drain was F-02's framework. Neither wired it into
  `dispatch.ts` or `scheduled.ts`, so nothing renders on write today. Render-on-miss alone would
  serve a stale tag list forever after the second publish. The OCI routes therefore compute the
  package's render stamp from D1 on every (Cache API-missed) read, serve the stored R2 object only
  when its `x-pkey-render-stamp` matches, and otherwise render now and write back through the
  framework's own `materialise` (in `waitUntil`). Once the drain is wired, reads hit the stored
  object. Wiring it is a proposed follow-up for the lead (the F-02/F-03 gap), not F-08's.
- **Two rendered documents per repository**, `registry/oci/<owner>/<repository>/_tags.json` (the
  tag list) and `_refs.json` (tag → `{digest, mediaType, size}`). The leading `_` cannot start an
  OCI path component, so a nested repository never collides with them. Manifests and blobs are
  not rendered: they are the published blobs, read from `blobs/sha256/<hex>`.
- **Blobs bypass the Cache API.** `cachedRegistryAnswer` keys on the URL without `Range` and
  stores whole 200s, which would answer a ranged request with the whole blob and try to cache up
  to 5 GiB. `serveFeedRead` gains one option, `cacheApi: false`: the access ladder still runs
  first, then the route answers straight from R2 through `core/blobs.ts` `blobResponse` (Range,
  `If-Range`, `If-None-Match`, checksum check). Its `Cache-Control` is §6.7's
  `public, max-age=31536000, immutable` plus `no-transform` (the edge must not recompress bytes
  whose digest and ranges are fixed).
- **Yank and deprecate in OCI terms.** OCI has neither. A yanked version loses its tag (it leaves
  `tags/list`, and `manifests/<version>` is `MANIFEST_UNKNOWN`) but its manifests and blobs stay
  pullable by digest, so pinned references keep working (PEP 592's rule for exact pins); a
  deprecated version is served exactly like a live one, because a manifest cannot be annotated
  without changing its digest. Channel tags come from `releaseCatalog.packageChannelHeads`
  (`stable` → `latest`), which already excludes yanks; a channel tag spelled like a version tag is
  dropped, because version tags never move.
- **Repository resolution precedes the ladder.** The repository is resolved to its deliverable
  (a `releaseCatalog` read, not a cache read) before `serveFeedRead`, so the ladder applies the
  package's own delivery mode; an unknown repository passes `null` (the feed's mode alone) and then
  answers `NAME_UNKNOWN`. Release off for the owner reads as an unknown repository.
- **Accept negotiation.** A manifest whose stored media type the client's `Accept` excludes (it
  lists only other manifest types, with no wildcard) answers `MANIFEST_UNKNOWN`, distribution's
  answer; the check runs after the cache, so the cached entry stays type-independent.
- **`/v2/token` is the dispatcher's not-found, documented as a `host` row** in `REGISTRY_PATHS`
  and in the OpenAPI spec, until F-21. Core's OCI not-found and 405 also gain
  `Docker-Distribution-API-Version: registry/2.0`, so every answer under `/v2/` carries it.
- **The CLI extractor was already F-03's** (`packages/cli/src/package/oci.ts`): it reads the
  layout, types every reachable object by how it is referenced, and the publish path uploads each
  blob through the ticket. Nothing in the CLI changed, so the Action bundle did not move. Two
  bounds are tighter than the brief states: one upload is a single-part PUT of at most
  5 GiB − 5 MiB (`MAX_SINGLE_PUT_BYTES`), and the 64 KiB descriptor cap holds a few hundred file
  entries, well below the 4,096-file count limit.
- **The harness cannot run the real `pkey release publish` locally.** Its upload ticket hands out
  R2 S3 credentials that `wrangler dev` cannot emulate. `seeds/oci.ts` (run by `run.mjs`, which
  now runs every `seeds/*.ts` before the Worker starts) builds a real multi-arch OCI image layout,
  reads it with the CLI's own extractor, stores each blob with its SHA-256 checksum and runs the
  Worker's own package ingest, yank and deprecate in-process, against the same local state.
- **F-02's harness seed was missing the product key row.** `loadProductPublic` needs an active
  `product_keys` row, so every owner read as unknown once a route actually loaded one;
  `seed.mjs` now inserts an inert one.
- **F-02's "no routes yet" assertions** in `test/registryHost.test.ts` and
  `test/registryFeeds.test.ts` became "every route is Distribution's, from a renderer registered
  under its own ecosystem"; the database-less isolation test now probes an unmatched OCI path.
- **The Verify filter** is `registryOci` (the test file), not `registry/oci`.

## Hand-off

- F-10 publishes our OCI packages to this feed.
- F-12 renders this feed's setup snippets and settings panel.

The role agent sets `--set F-08 in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set F-08 done`.
