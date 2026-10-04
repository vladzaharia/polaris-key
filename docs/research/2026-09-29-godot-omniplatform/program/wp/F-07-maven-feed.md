# F-07 Maven feed: repository layout, generated `maven-metadata.xml`, checksum sidecars and `.module`

| Field       | Value                                                                  |
| ----------- | ---------------------------------------------------------------------- |
| Phase       | F: Package feeds (pkg.plrs.im) (tier-1)                                |
| Size        | 1 engineer-weeks                                                       |
| Depends on  | [F-02](F-02-registry-host.md), [F-03](F-03-package-releases.md)        |
| Unblocks    | [F-10](F-10-sdks-onto-feeds.md), [F-12](F-12-console-feed-settings.md) |
| Role        | `pkey-implementer`                                                     |
| Plan mode   | no                                                                     |
| Gates       | rule 10 (its `REGISTRY_PATHS` rows and spec entries)                   |
| Human input | none                                                                   |
| Repo        | `vladzaharia/polaris-key`                                              |

## Goal

The Maven feed serves every package the owner's feed holds, rendered by a `RegistryRenderer` in
`services/distribution/registry/maven/`, with the endpoints of
[plan §6.8](../plans/F-01.md#68-per-ecosystem-read-endpoints-and-the-real-client-matrices). `maven-metadata.xml` and the checksum sidecars are generated, never uploaded. Its
real-client matrix runs green in `registry-clients.yml`.

## Why

The Kotlin AAR and the Godot Android binding are not published anywhere today. Maven's layout is fully static once the metadata is derived.

## Read first

- [`plans/F-01.md`](../plans/F-01.md) §6.2, §6.5–§6.8; [S-12 §4.1](../../notes/S-12-package-feeds.md#41-summary-table) (the Maven row and its notes).
- The Maven repository layout, Gradle repository filtering and Gradle's checksum order ([S-12 §13](../../notes/S-12-package-feeds.md#13-sources)).
- F-02's `RegistryRenderer` and the harness; F-03's `packageVersions` hook and the Maven extractor.

## Scope

**In:**

- The static layout for every file of a publication; `maven-metadata.xml` per artifact; `.md5`, `.sha1`, `.sha256` and `.sha512` sidecars for every file and for the metadata; `.module`.
- Its `REGISTRY_PATHS` rows and the OpenAPI entries (rule 10).
- Golden-file tests for every rendered document, from a fixture with a stable and a beta version,
  one yanked version and one deprecated where the protocol allows.
- Its section of `services/distribution/package-feeds.md` and its snippet input for F-12.

**Out:**

- Auth challenges beyond the tier-1 refusal (→ F-21).
- Native publish (→ F-22).
- Settings UI (→ [F-12](F-12-console-feed-settings.md)).

## Design notes

- XML goes out as `application/octet-stream` with `attachment`. If any matrix client fails on that, **stop and ask**. Never add `xml` to the allowlist.
- `-SNAPSHOT` versions are refused at ingest (F-03).

## Steps

1. The renderer and its golden files.
2. The routes, headers, negotiation and errors.
3. The client matrix job; then the docs.

## Acceptance criteria

- [x] Matrix green: Gradle 8.x and 9.x with `exclusiveContent`, Maven 3.9 with checksum policy `fail`.
      (Run locally through the harness: Gradle 8.14.5, Gradle 9.8.0, Maven 3.9.16, all green, each
      reading the XML and POMs as `application/octet-stream` attachments. The CI rows are added.)
- [x] Yank, deprecate and channel-tag behaviour match plan §6.7 and the protocol.
- [x] The headers of plan §6.7 are on every answer. Nothing outside `REGISTRY_HOST_TYPES` is served.
- [x] `routeCoverage` passes. The green gate passes (`AGENTS.md`).

## Corrections (recorded while implementing, against the code)

None of these changes a wire shape, the corpus or `PROTOCOL_VERSION`.

1. **Nothing drains the render queue yet, so the read path also heals staleness.** F-02 left the
   drain, `registryMaterialiser` and the cron hook to F-03, and F-03 left them to F-02's
   framework (both briefs' corrections), so nothing calls `drainRegistry` today. Render-on-miss
   alone would serve a stale `maven-metadata.xml` forever after the first read. The Maven route
   therefore compares the stored object's render stamp with the package's current state before
   answering, and renders again when it differs (`freshRenderedObject`, beside the routes). It
   still reads from R2 under `registry/maven/<owner>/` and counts misses. The query cost is
   bounded by the Cache API (60 s). **Follow-up (lead / F-02 owner):** wire the drain and the cron
   self-check. `freshRenderedObject` stays correct after that, and other renderers can share it.
2. **Package state reaches the route through `ctx.hooks.releaseCatalog()`.** No Distribution
   `PackageSource` exists, so `registryPackageOf` (in `maven/routes.ts`) builds the
   `RegistryPackage` from `packageDeliverables`, `packageVersions` and `packageChannelHeads`
   (`stable` → the `latest` tag). It is kept in the Maven directory so the sibling feeds touch
   disjoint files. **Follow-up:** hoist it to `registry/` once a second feed needs it.
3. **The deliverable is looked up before `serveFeedRead`** so the ladder can apply its delivery
   mode: one D1 read per request, ahead of the cache. An unknown artifact passes `null` (the list
   rule) and answers the not-found from inside, so a non-public feed answers the same 401 for a
   package it holds and for one it does not.
4. **Files are served from `blobs/sha256/<hex>`** through `blobResponse`. `files_json` carries no
   storage key, and F-03 addresses package files by digest. The CLI always uploads ungated, so a
   hand-made descriptor naming a `gated/` key would answer the not-found. Their `Cache-Control` is
   blobResponse's `public, max-age=31536000, immutable, no-transform`. That is plan §6.7's value
   plus `no-transform`, because the edge must not recompress bytes whose checksums are published.
5. **Yank and deprecate (Maven has neither, S-12 §8):** a yanked version leaves `<versions>`,
   `<latest>` and `<release>`, so no dynamic version or meta-version resolves to it, but its files
   stay downloadable by exact coordinates (PEP 592's semantics, so pinned builds keep working).
   This is "refuse a yanked version" in the matrix. A deprecated version stays listed. There is
   no `yankHidesFromIndex` toggle yet: `RenderContext` carries no feed settings and the render
   stamp hashes only the package. **Follow-up (F-11/F-12):** pass `ext` into renders and the
   stamp if the toggle is wanted. The THREAT-MODEL records that a yank is not a takedown.
6. **`<release>` is the `latest` tag, and `<latest>` is the newest listed version of any channel.**
   Gradle's `latest.release` reads the publication's own status (`.module`), not `<release>`, so
   the fixture marks its beta `milestone`, as a real beta publication would.
7. **The harness could not publish through `pkey release publish`.** Upload tickets hand out R2
   S3 credentials, which a local run does not have. So `fixtures.mjs` runs each
   `fixtures/<ecosystem>.mjs` against the same local state through wrangler's `getPlatformProxy`
   (real D1 and R2, so blobs carry the SHA-256 checksum the byte path requires). Those files write
   the rows the ingest writes. `run.mjs` calls it after `seed.mjs`. `seed.mjs` also needed an
   active `product_keys` row: without one `loadProductPublic` answers null and every registry
   route answered the not-found (F-02's smoke client could not notice).
8. **Client containers run with `-Djava.net.preferIPv4Stack=true`**. Some Docker hosts (OrbStack
   here) forward host-network loopback for IPv4 sockets only, and the JVM opens dual-stack ones.
   They also run as the invoking user, and Maven's local-repository work happens inside a single
   container.
9. **Verify line:** `registry-clients.yml` has no `ecosystem` input. The Maven rows are matrix
   clients `gradle8`, `gradle9` and `maven`, so `gh workflow run registry-clients.yml` runs them
   with the rest. Locally:
   `mise exec node@22 -- pnpm --filter @polaris-key/worker registry:clients -- --client gradle8 --client gradle9 --client maven`.
   The worker test filter is `test/registry/maven` (the new `test/registry/` directory).
10. **Two F-02 tests asserted that no ecosystem route exists.** They now check that every route
    is Distribution's and comes from its ecosystem's renderer. `registryHost.test.ts`'s DB-less
    "unknown repositories" list drops the Maven path, which `test/registry/maven.test.ts` pins
    with a database.
11. **Rule 10:** three `REGISTRY_PATHS` rows (`mavenMetadata` twice, for the document and its
    `.{checksum}` sidecar; `mavenFile`) and the matching spec paths. `{groupPath}` spans one or
    more segments, which OpenAPI path templates cannot express; its parameter description says
    so.
12. **F-12's snippet input** is the Gradle (`exclusiveContent` + `includeGroupAndSubgroups`) and
    Maven (`checksumPolicy fail`) blocks in `services/distribution/package-feeds.md` § Maven,
    with `<owner>` and `<groupPrefix>` as the placeholders `renderFeedSetup` fills.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- registry/maven routeCoverage
gh workflow run registry-clients.yml -f ecosystem=maven
```

## Hand-off

- F-10 publishes our Maven packages to this feed.
- F-12 renders this feed's setup snippets and settings panel.

The role agent sets `--set F-07 in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set F-07 done`.
