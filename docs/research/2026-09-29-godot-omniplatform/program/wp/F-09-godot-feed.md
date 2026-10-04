# F-09 Godot feed: the ≤ 4.6 Asset Library API, the 4.7 Asset Store API and the GodotEnv index

| Field       | Value                                                                  |
| ----------- | ---------------------------------------------------------------------- |
| Phase       | F: Package feeds (pkg.plrs.im) (tier-1)                                |
| Size        | 1–1.5 engineer-weeks                                                   |
| Depends on  | [F-02](F-02-registry-host.md), [F-03](F-03-package-releases.md)        |
| Unblocks    | [F-10](F-10-sdks-onto-feeds.md), [F-12](F-12-console-feed-settings.md) |
| Role        | `pkey-implementer`                                                     |
| Plan mode   | no                                                                     |
| Gates       | rule 10 (its `REGISTRY_PATHS` rows and spec entries)                   |
| Human input | none                                                                   |
| Repo        | `vladzaharia/polaris-key`                                              |

## Goal

The Godot feed serves every package the owner's feed holds, rendered by a `RegistryRenderer` in
`services/distribution/registry/godot/`, with the endpoints of
[plan §6.8](../plans/F-01.md#68-per-ecosystem-read-endpoints-and-the-real-client-matrices). It serves both editor API shapes, because the SDK supports Godot 4.4 to 4.7. Its
real-client matrix runs green in `registry-clients.yml`.

## Why

Godot 4.7 renamed the setting and moved to a new Asset Store API that verifies no hash. Releases up to 4.6 compare `download_hash`. The Godot addon ships through a GitHub Release and manual store uploads today.

## Read first

- [`plans/F-01.md`](../plans/F-01.md) §6.2, §6.5–§6.8; [S-12 §4.1](../../notes/S-12-package-feeds.md#41-summary-table) (the Godot row and its notes).
- The godot-asset-library `API.md`, the 4.7 Asset Store OpenAPI, the editor's `asset_library_editor_plugin.cpp`, and GodotEnv ([S-12 §13](../../notes/S-12-package-feeds.md#13-sources)).
- F-02's `RegistryRenderer` and the harness; F-03's `packageVersions` hook and the Godot extractor.

## Scope

**In:**

- The ≤ 4.6 API (`configure`, `asset` search, `asset/<id>` with `download_hash`); the 4.7+ `search/query/`, `assets/…` and `releases/…`; `index.json` for GodotEnv; zips and PNG icons under content-addressed paths.
- The search endpoints filter a short list in memory. They are the only per-request computation.
- Its `REGISTRY_PATHS` rows and the OpenAPI entries (rule 10).
- Golden-file tests for every rendered document, from a fixture with a stable and a beta version,
  one yanked version and one deprecated where the protocol allows.
- Its section of `services/distribution/package-feeds.md` and its snippet input for F-12.

**Out:**

- Auth challenges beyond the tier-1 refusal (→ F-21).
- Native publish (→ F-22).
- Settings UI (→ [F-12](F-12-console-feed-settings.md)).

## Design notes

- Document that 4.7+ installs rely on TLS alone.
- The manual editor check is done by `pkey-godot-engineer`, one install per editor shape, and recorded in the PR.

## Steps

1. The renderer and its golden files.
2. The routes, headers, negotiation and errors.
3. The client matrix job; then the docs.

## Acceptance criteria

- [x] Matrix green: GodotEnv `"source": "zip"`; HTTP contract tests on both shapes (run locally,
      `registry:clients -- --client godot`, GodotEnv 2.17.0). **Manual editor installs: open** — one
      per editor shape, by `pkey-godot-engineer`, recorded on the PR (correction 8).
- [x] Yank, deprecate and channel-tag behaviour match plan §6.7 and the protocol.
- [x] The headers of plan §6.7 are on every answer. Nothing outside `REGISTRY_HOST_TYPES` is served.
- [x] `routeCoverage` passes. The green gate passes (`AGENTS.md`).

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- registry/godot routeCoverage
gh workflow run registry-clients.yml -f ecosystem=godot
```

## Corrections (recorded while implementing, against the code)

Where the brief or plans/F-01.md disagreed with the code or the clients, the code and the clients
were the fact. None of these changes a wire shape of the device protocol, the corpus or
`PROTOCOL_VERSION`.

1. **The 4.7 editor needs three more store paths.** Godot 4.7's `asset_library_editor_plugin.cpp`
   first requests the API root (`<base>/`, a repository check), then `tags/?featured_only=true`
   and `licenses/` in parallel, before it searches. The feed serves them (`godotStoreOverview`,
   `godotStoreTags` always `[]`, `godotStoreLicenses`), each with its `REGISTRY_PATHS` row and spec
   entry. The store paths answer with or without their trailing slash.
2. **The editors' exact field contracts.** ≤ 4.6 reads `asset_id`, `author_id` and `category_id`
   as 32-bit C++ ints and keys its category map by the JSON value, so every value is a string (as
   the official library sends) and the asset id is a stable 31-bit FNV-1a fold of the deliverable
   id (a collision inside one owner drops both from id lookup). The ≤ 4.6 pager reads `total`,
   which the official API does not send, so the search answer carries `total` beside
   `total_items`. Godot 4.7 (`asset_store/available_urls`) requires `name`, `slug`, `store_url`,
   `license_type`, `reviews_score`, `body_bbcode`, `source` and `publisher` on an asset, and
   `download_url`, `version`, `stable`, `min_godot_version` and `max_godot_version` on a release.
3. **The renderer needs the feed's settings.** Godot's documents carry the publisher, category,
   support level and license, which live in `dist_registry_feeds`, not in the package rows. F-02's
   framework gains, additively: `RenderContext.feed` and `MaterialiseDeps.feed` (optional), a
   `renderStamp(pkg, feed?)` that covers the settings when given (unchanged when not), and
   `readFreshRegistryObject`. Without settings the Godot renderer renders nothing.
4. **No drain is wired on main.** F-02 left the drain and `registryMaterialiser` to F-03, and F-03
   left them to F-02's framework, so nothing re-renders on publish yet. The Godot routes therefore
   read their per-package documents through `readFreshRegistryObject`, which stamps the package
   and settings from D1 and re-renders a stored object whose stamp differs before serving it
   (behind the 60 s Cache API). A yank or settings change is never hidden by a stale render.
   Wiring the drain is a follow-up (below).
5. **Owner-wide documents are composed per request.** The materialiser renders per package, and
   `configure`, both searches, `tags/`, `licenses/` and `index.json` span every package of the
   feed, so `routes.ts` composes them from the same pure functions on each uncached request.
   Only the per-package documents (`asset/<id>`, `assets/…`, `releases/…`) are rendered into R2.
6. **No `PackageSource` existed.** `materialise.ts`'s `PackageSource` had no implementation over
   `releaseCatalog`; `godot/source.ts` implements it (generic over the ecosystem) and stays in the
   Godot directory so feed packages touch disjoint files.
7. **Godot `ext_json` gains `license` and `minGodotVersion`** beside the plan's `categoryId` and
   `supportLevel` (plus `featured` read as `official`, as the API does): ≤ 4.6 `cost` and 4.7
   `license_type` are required fields, and `godot_version` / `compatibility` filtering needs a
   lower bound. Malformed values fall back to the defaults (Tools, `community`, `Unspecified`,
   no bound).
8. **The harness could not publish through `pkey release publish`.** F-02's seed left publishing
   fixture packages to F-03, which did not add it, and a publish needs upload tickets (S3
   credentials for R2) that `wrangler dev` has no local equivalent for. `run.mjs` gains a
   per-client seed hook (`clients/<name>.seed.ts`, run before the Worker starts), and
   `godot.seed.ts` calls the same `ingestPackageDescriptor` the publish route calls, through
   `getPlatformProxy` over the harness's local D1 and R2. F-02's seed also lacked the active
   `product_keys` row `loadProductPublic` needs, which made every owner-scoped registry route the
   not-found; the Godot seed inserts an inert one (`INSERT OR IGNORE`).
9. **Verify line.** `registry-clients.yml` has no `ecosystem` input; it runs every matrix row
   (`gh workflow run registry-clients.yml`), and locally
   `pnpm --filter @polaris-key/worker registry:clients -- --client godot`. The Godot row installs
   .NET 8 and GodotEnv and sets `REQUIRE_GODOTENV=1`, so it fails rather than skips without it.
10. **Two placeholder tests asserted no routes** (`registryHost.test.ts`, `registryFeeds.test.ts`);
    they now assert the general invariant (routes are the renderers', each in its ecosystem, unique
    names, never a reserved ecosystem), and the host test's "unknown repository" Godot path is one
    no Godot route matches.

## Snippet input for F-12

- **Godot 4.4 to 4.6:** Editor Settings → `asset_library/available_urls`, a name (for example
  "Polaris Key (`<owner>`)") → `<PKG_ORIGIN>/godot/<owner>/asset-library/api`.
- **Godot 4.7+:** Editor Settings → `asset_store/available_urls` →
  `<PKG_ORIGIN>/godot/<owner>/store/api/v1`.
- **GodotEnv:** `addons.json` entry per package: `{"<id>": {"url": <zip URL>, "source": "zip",
"subfolder": "addons/<id>"}}`, ready-made in `<PKG_ORIGIN>/godot/<owner>/index.json`
  (`packages[].godotenv`). No trailing slash on either editor URL.
- **Settings panel:** `namespace.publisher` (required; `^[a-z0-9][a-z0-9_-]{0,63}$`), `ext.categoryId`
  (an addon category of `GODOT_CATEGORIES`, default `5`), `ext.supportLevel`
  (`official` | `community` | `testing`), `ext.license` (≤ 64 chars, default `Unspecified`),
  `ext.minGodotVersion` (`4.4` or `4.4.1`, optional). Warn that 4.7+ installs verify no hash.
  `godot/documents.ts` exports `godotFeedView`, `GODOT_CATEGORIES` and `GODOT_DEFAULTS`.

## Follow-ups

- **Wire the drain** (`registryMaterialiser`, `dispatch.ts` after an enqueue, `scheduled.ts`) with
  `MaterialiseDeps.feed` set — owner: F-02's framework (the lead assigns; F-03's correction 3 and
  F-02's correction disagree on who). The Godot read path stays correct either way.
- **Hoist `godot/source.ts`** beside `materialise.ts` once a second feed uses it (F-04 to F-08).
- **Fix `seed.mjs`'s missing `product_keys` row** for every client (F-02's harness).
- **Manual editor installs**, one per shape (4.6 and 4.7), by `pkey-godot-engineer`, on the PR.

## Hand-off

- F-10 publishes our Godot packages to this feed.
- F-12 renders this feed's setup snippets and settings panel.

The role agent sets `--set F-09 in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set F-09 done`.
