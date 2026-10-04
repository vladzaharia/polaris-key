# F-04 npm feed: packuments, tarballs, dist-tags, deprecation and scope enforcement

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

The npm feed serves every package the owner's feed holds, rendered by a `RegistryRenderer` in
`services/distribution/registry/npm/`, with the endpoints of
[plan §6.8](../plans/F-01.md#68-per-ecosystem-read-endpoints-and-the-real-client-matrices). Scoped names only, with the scope equal to the feed's. Its
real-client matrix runs green in `registry-clients.yml`.

## Why

npm clients read a packument and follow `dist.tarball` literally. Eight of our SDK packages are npm packages that ship to GitHub Packages today ([S-12 §6.4](../../notes/S-12-package-feeds.md#64-how-todays-sdks-get-onto-the-feeds)).

## Read first

- [`plans/F-01.md`](../plans/F-01.md) §6.2, §6.5–§6.8; [S-12 §4.1](../../notes/S-12-package-feeds.md#41-summary-table) (the npm row and its notes).
- pacote's registry fetcher (`Accept`, integrity order), npm-package-arg (`escapedName`), the npm registry docs on package metadata ([S-12 §13](../../notes/S-12-package-feeds.md#13-sources)).
- F-02's `RegistryRenderer` and the harness; F-03's `packageVersions` hook and the npm extractor.

## Scope

**In:**

- `GET` packument (both `%2f` spellings) in full and abbreviated form, chosen by `Accept`; tarballs under `…/-/<file>.tgz`; `dist-tags` from channels; `deprecated` from the state.
- Its `REGISTRY_PATHS` rows and the OpenAPI entries (rule 10).
- Golden-file tests for every rendered document, from a fixture with a stable and a beta version,
  one yanked version and one deprecated where the protocol allows.
- Its section of `services/distribution/package-feeds.md` and its snippet input for F-12.

**Out:**

- Auth challenges beyond the tier-1 refusal (→ F-21).
- Native publish (→ F-22).
- Settings UI (→ [F-12](F-12-console-feed-settings.md)).

## Design notes

- `dist.integrity` is SHA-512 and `dist.shasum` SHA-1, both from F-03's digests. `dist.tarball` is absolute on `PKG_ORIGIN`.
- npm has no yank: a yanked version stays installable by exact version but leaves `dist-tags`, and gets a `deprecated` message.

## Steps

1. The renderer and its golden files.
2. The routes, headers, negotiation and errors.
3. The client matrix job; then the docs.

## Acceptance criteria

- [ ] Matrix green: npm 10 and 11, pnpm 9 and 10, Yarn Berry 4, Bun.
- [ ] Yank, deprecate and channel-tag behaviour match plan §6.7 and the protocol.
- [ ] The headers of plan §6.7 are on every answer. Nothing outside `REGISTRY_HOST_TYPES` is served.
- [ ] `routeCoverage` passes. The green gate passes (`AGENTS.md`).

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- registry/npm routeCoverage
gh workflow run registry-clients.yml -f ecosystem=npm
```

## Corrections (recorded while implementing, against the code)

Where the code disagreed with this brief or plans/F-01.md, the code was the fact. None of these
changes a wire shape, the corpus or `PROTOCOL_VERSION`.

1. **Nothing drains the render queue yet.** F-02 left `registryMaterialiser` and the drain to
   F-03 ("the queue table does not exist"), and F-03 left them to F-02's framework, so neither
   `dispatch.ts` nor `scheduled.ts` calls `drainRegistry`. A render-on-write feed would then
   serve its first render forever. `registry/catalogSource.ts` `freshRegistryObject` compares the
   stored object's render stamp with the stamp of the package's current rows on every Cache API
   miss (at most once a minute per edge and document): a match is served from R2, anything else
   is rendered, answered and written back. It is ecosystem-neutral, for F-05 to F-09 too. Wiring
   the drain stays a follow-up (proposed owner: F-02's framework, or F-11).
2. **`catalogSource.ts` is the shared `PackageSource`** over `releaseCatalog`
   (`packageDeliverables`, `packageVersions`, `packageChannelHeads`) that F-02 said F-03 would
   implement. It maps channels to tags once for every ecosystem (`stable` → `latest`).
3. **Tarball URLs are conventional**, `…/npm/<owner>/@scope/name/-/name-<version>.tgz`, whatever
   the uploaded file was called: Yarn Berry rebuilds that exact path for a conventional URL
   instead of storing it.
4. **`dist.integrity` falls back to SHA-256 SRI** when the ingest could not read a tarball's
   SHA-512 (F-03 then stores none), so every version always carries an integrity string.
5. **`latest` always exists while a non-yanked version does.** npm clients expect it; when no
   channel provides one (or its head is yanked), it is the newest non-yanked release version, else
   the newest non-yanked prerelease.
6. **Range resolution and yanks.** npm (verified) prefers a non-deprecated version for a range,
   so a yanked version is never picked by `^1.0.0` there. Clients that ignore `deprecated` for
   ranges still never get a yanked version from a tag; the matrix asserts the range rule only for
   npm.
7. **The harness seeds its fixture directly, not through `pkey release publish`.** The publish
   path hands out R2 temporary credentials for the S3 API, which local R2 does not serve, and
   F-03 did not extend `seed.mjs`. `seed.mjs` now runs every `fixtures/<ecosystem>.mjs`
   (`fixtures/npm.mjs` writes the rows the ingest writes, with real digests, and the tarballs into
   the local bucket), and gives the fixture owner the active key row `loadProductPublic` needs
   (F-02's seed lacked it, which no route had exercised). The real publish path is covered by the
   worker test, which publishes through the submit route.
8. **`registry-clients.yml` gains the `ecosystem` input** the Verify line uses, and one row per
   client release (npm 10 and 11, pnpm 9 and 10, Yarn 4, Bun).
9. **Two F-02 tests asserted that no ecosystem route existed** (`registryHost.test.ts`,
   `registryFeeds.test.ts`); they now assert every route is Distribution's and its renderer's
   ecosystem. The host-isolation test that fetches through the whole Worker has no D1, so its
   npm probe is now an unscoped name, which no route matches; the scoped not-found is pinned by
   `test/registry/npm.test.ts` with a database.

10. **Yarn Berry does not check `dist.integrity`** when it first fetches a tarball: 4.18 installs
    the harness's tampered fixture. It pins its own archive checksum in `yarn.lock` and checks that
    on later installs, so the Yarn row asserts the pinned checksum and skips the mismatch check.
    npm 10 and 11, pnpm 9 and 10 and Bun refuse the tampered tarball. Yarn 4 also quarantines
    versions younger than its `npmMinimalAgeGate` (from the packument's `time`), so the fixture's
    versions are thirty days old; the docs say so.
11. **pnpm spells the escape `%2F`**, npm `%2f`, and both are one cache key and one document, as
    planned. Bun sends the unescaped `@scope/name`.

## Hand-off

- F-10 publishes our npm packages to this feed.
- F-12 renders this feed's setup snippets and settings panel.

The role agent sets `--set F-04 in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set F-04 done`.
