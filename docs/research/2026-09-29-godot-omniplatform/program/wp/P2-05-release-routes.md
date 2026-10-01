# P2-05 Per-platform resolution, channel policy operations, generic and blob routes, GitHub caching

| Field       | Value                                                                                                                                       |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | P2: Release truth and publishing                                                                                                            |
| Size        | 1–1.5 engineer-weeks                                                                                                                        |
| Depends on  | [P2-01](P2-01-blob-store.md), [P2-03](P2-03-release-data-model.md)                                                                          |
| Unblocks    | [P2-06](P2-06-publish-cli-action.md), [P2-07](P2-07-console-builds.md), [P2b-04](P2b-04-rollouts-delivery.md), [P6-04](P6-04-hosted-web.md) |
| Role        | `pkey-implementer`                                                                                                                          |
| Plan mode   | no                                                                                                                                          |
| Gates       | rule 10 (OpenAPI + `SERVICE_PATHS` in `routeCoverage`; regenerated `reference/routes.mdx`); `test/attack/R6-release.test.ts` stays green    |
| Human input | none (without P2-01's buckets, the blob route answers not-found and tests use the R2 fake)                                                  |
| Repo        | `vladzaharia/polaris-key`                                                                                                                   |

## Goal

Release resolves "which release of deliverable D does channel C serve on platform P / arch A"
from the truth store with the research's rules: version-scheme order, `includes`, pointers and
pins, yanks, and per-platform fallback. Operators (console) and CI (`pkeyci_` tokens) can promote,
pin, unpin, yank and unyank, and set a floor and the critical flag. Three new byte routes serve any
declared build, any exact file of a release, and any content-addressed blob of the product, from
R2 or GitHub. Legacy downloads, the appcast and `/version` apply the same yanks and pins and cost
at most one GitHub API call per miss.

## Why

Today "newest" is GitHub list order, a release missing one platform's build blanks that platform,
nothing can be yanked or pinned, and only extension-less binaries and `.dmg` files are routable
([notes/A1 §1.3, §2, §7](../../notes/A1-release-update.md#13-channel-model),
[README §0.4](../../README.md#04-findings-that-should-change-plans-now) item 2). Every download and
Range chunk costs two to four GitHub calls against a quota shared by every product
([§9.1](../../README.md#91-polaris-key-worth-fixing-regardless-of-godot) issue #3). The resolution
rules are in [README §3.4](../../README.md#34-release-the-record-of-everything-that-exists) and
the caching and redirect advice in [§3.5](../../README.md#35-storage-and-byte-delivery).

## Read first

- `AGENTS.md` (rules 6 and 10), `CLAUDE.md`.
- [README §3.4](../../README.md#34-release-the-record-of-everything-that-exists) "Resolution rules",
  [§3.5](../../README.md#35-storage-and-byte-delivery) "GitHub as a source",
  [§3.9](../../README.md#39-rollouts-halts-and-telemetry) (pointer, floor, critical and yank are
  release's; rollout is not).
- [notes/A1 §2, §4, §6.2, §7](../../notes/A1-release-update.md#2-every-route-and-what-it-emits);
  [notes/E3 §F](../../notes/E3-windows-linux-web.md) item 1 (winget refuses redirects; App
  Installer and zsync need Range).
- Hand-offs of [P2-01](P2-01-blob-store.md) (landed: `blobResponse(req, bucket, key, {sha256, gated, host, contentType?, disposition?, filename?})` in `core/blobs.ts`; the bytes-host allowlist `BYTE_ROUTES` in `mount.ts`, consumed by `dispatchBytesHost(req, env, db, routes)` in `core/bytesHost.ts`),
  [P2-03](P2-03-release-data-model.md) (`model.ts`, policy semantics), [P2-02](P2-02-trusted-publisher.md)
  (`requireCiScope`), and the landed [P0-02](P0-02-release-resolution.md) (comparator, tag filter).
- Code: `packages/worker/src/services/release/gateway.ts` (the pipeline, `resolveSelector`, the
  rate-limit lanes, `CACHEABLE_KINDS`), `routes.ts:23-50`, `surfaces.ts`, `channels.ts:44-160`,
  `github.ts:116-245` (`resolveRelease`, `listReleases`, `streamAsset`), `access.ts`,
  `admin.ts:42-79`; `test/routeCoverage.test.ts:63-89`; `test/attack/R6-release.test.ts`
  (R6-08 redirects, R6-10 downgrade); `openapi/polaris-key.v3.yaml`.

## Scope

**In:**

- **Resolution** in `services/release/resolve.ts` (name proposed):
  `resolveBuild(db, product, {deliverable, selector, platform?, arch?, buildId?})` over P2-03's
  tables, implementing the rules in Design notes, with a pure core that is unit-tested on fixtures.
- **Legacy routes agree.** `resolveSelector` in `gateway.ts` applies yanks and pinned pointers from
  `release_channel_policy`, so `/release/dl`, `/update/appcast.xml` and `/update/version` never
  offer a yanked release on a moving selector and follow a pin. The R6-10 attack test asserts it.
- **Byte routes** (rule 10):
  - `GET /{product}/release/builds/{selector}/{buildId}`: the payload of that build in the
    resolved release (`?deliverable=` defaults to `app`; `?checksum=sha256` as the legacy route);
  - `GET /{product}/release/files/{releaseId}/{name}`: one exact file of one release (sidecars
    included), immutable;
  - `GET /{product}/release/blobs/sha256/{hash}`: a content-addressed object, only if an artifact
    of **this** product references it.
    All three answer `GET` and `HEAD`. Location order: R2 (`blobResponse`) → GitHub
    (`streamAsset`) → `external` (302). A
    `?redirect=1` request for a public artifact of a public repository may get a 302 to GitHub
    instead of a stream. Register all three in `mount.ts` `BYTE_ROUTES` as `ByteRoute`s with `service: "release"` (`match(pathname)` returns `{product, params}`; `handle(req, ctx)`). The bytes host does not go through `dispatchService`, so the `service` field is what makes Release-off serve nothing; its not-found is the flat `{"error":"not_found"}`, and CORS and hardening are applied by the dispatcher, not the route.
- **GitHub caching:** release resolution cached 60–120 s per (product, selector), and GitHub's
  signed asset URL cached per asset for less than its lifetime, so a Range chunk costs no API call.
- **Channel policy operations**, one implementation in `services/release/policy.ts`, reached by:
  - CI routes (rule 10), `pkeyci_` token with `release:promote`:
    `POST /{product}/release/channels/{channel}/promote`, `…/pin`, `…/unpin` (body
    `{deliverable?, releaseId}`); with `release:yank`:
    `POST /{product}/release/releases/{releaseId}/yank` (`{reason}`);
  - admin routes (narrative-only): `GET …/release/channels`, `PUT …/release/channels/{channel}`
    (pointer, pin, floor, critical), `POST …/release/channels/{channel}/revert`,
    `POST`/`DELETE …/release/releases/{releaseId}/yank`.
    Every change is audited with its actor (`admin:<sub>` or `ci:<subject>`).
  - Channel policy rows and operations use canonical names only (P0-04 plan §10). A `staging` route
    segment resolves through `CHANNEL_ALIASES` to `beta` unless the product declares a manual
    `staging` channel, and `staging` is never stored.
- **Admin read model:** `GET …/release/releases` adds builds (platform, arch, format, build number,
  min OS), artifact role, SHA-256, locations and the yank; `GET …/release/channels` returns the
  policy per deliverable with `source`. P2-07 renders these.
- Discovery: release's fragment advertises `endpoints.builds` and `endpoints.blobs` (templated),
  on the bytes host when `BLOB_ORIGIN` is set.
- Docs: `services/release/artifacts.md`, a `services/release/channels.md` page; `docs gen`.
- **Wave-1 sync:** **Harden `dispatchBytesHost`.** It has no try/catch; once routes exist, a throw from `loadProduct` or a route becomes Cloudflare's own HTML 1101 page on `dl.plrs.im`, without `nosniff` or the sandbox CSP. Catch inside `dispatchBytesHost` (around `answer`) and return a hardened platform-JSON 500 that goes through `hardenBytesHostResponse`.
- **Wave-1 sync:** **Derive the host, do not trust it.** `blobResponse` must compute `host` from `req.url` via `isBytesHost(url, env)` instead of trusting `opts.host`, so a console route can never ask for the bytes-host type/inline relaxation.
- **Wave-1 sync:** **Fail closed on locked keys.** `blobResponse` must answer not-found when a locked-prefix (`blobs/`, `bundles/`, `deltas/`, `gated/`) object has no stored checksum instead of serving it with ETag and `Repr-Digest` from `opts.sha256`; everything `putVerified` writes has one.
- **Wave-1 sync:** **Gated cache header.** Gated responses use `private, no-store, no-transform` (today `private, no-store`), so the edge cannot recompress `application/wasm` and break `Content-Length`, Range and `Repr-Digest`; correct P2-01's brief line and its test.
- **Wave-1 sync:** **Slimmer byte-route context (optional, least privilege).** `dispatchBytesHost` runs `loadProduct` (a PLATFORM_KEK unseal of the signing key) on every download and hands the PEM to routes in `ctx.product`; byte routes never need it. Pass a context without the key if `loadProduct` allows it.
- **Wave-1 sync:** **Resolution cache (from P0-02).** Health and download paths now pay a full live GitHub resolution plus one per floored channel that looks below its floor; the 60–120 s resolution cache here must cover them (issue #3).
- **Wave-1 sync:** **`BLOB_ORIGIN` guard.** A `BLOB_ORIGIN` equal to the console hostname 404s every console path, and a missing `BLOB_ORIGIN` with the `dl*` route deployed serves the full console on the same-site sibling (host isolation fails open). Add a config guard that refuses it, or a line in `docs/DEPLOYMENT.md` that the route and the var are removed together.

**Out** (and where it belongs instead):

- Console views (→ [P2-07](P2-07-console-builds.md)); CLI commands (→ [P2-06](P2-06-publish-cli-action.md)).
- Moving byte serving and access into distribution, and outlet rollouts (→ [P2b-04](P2b-04-rollouts-delivery.md)).
- Per-deliverable access gating and the `gated/` prefix on reads (→ P2b-04, P4-05).
- CORS: P0-05 applies its allowlist centrally in `dispatch` (`core/cors.ts`); check that the new
  byte routes fall inside its covered-path list, nothing per route.
- Sparkle, WinSparkle and other updater-feed changes, including universal DMGs in the appcast
  (→ P3-09). Mirroring GitHub assets into R2 (no owner yet).

## Design notes

- **Resolution rules** (README §3.4, every deliverable):
  1. Candidates are the deliverable's releases that are members of the channel or of any channel
     it `includes` (beta ⊇ stable), plus the channel's pointer. Membership is
     `release_metadata.channel`, else GitHub's `prerelease` flag and manual-channel regexes.
  2. Remove yanked releases, except a pinned pointer (README: "yanked releases resolve only by
     explicit pin"). A pinned version selector (`/…/1.2.3/…`) is explicit too.
  3. Order by the deliverable's version scheme (`semver` | `semver+build` | `4part`, P0-02's
     comparator), ties by `seq`. Tags outside `stableTagPattern` or in `ignoreTags` are never app
     candidates.
  4. Pinned channel: only releases at or below the pointer. Unpinned: the newest candidate.
  5. **Per platform:** keep only releases with a build for the requested platform and a matching
     arch (`universal` and `any` match every arch), so a release missing the iOS build does not
     blank iOS. Whether it is live on an outlet is distribution's question (P2b).
- **Floors and `critical`** are stored and returned by the admin read and the `releaseCatalog`
  hook (P2b-01); nothing device-facing enforces them until the signed feed (P3-03). Keep P0-02's
  `…/release/channels/<channel>/floor` endpoint for its anti-rollback high-water mark and call the
  device floor `minSupported` in the `PUT` body, so the two never share a name (P2-03).
- **Cross-tenant blobs.** The blob route serves a key only if P2-01's `blob_refs` holds a ref from
  this product (`hasRef`); otherwise it returns the not-found body. Access is the product's
  `artifacts_access` mode (operator-owned through P0-01's `access_source`), enforced with
  `enforceReleaseAccess`.
- **Winget refuses redirects** and App Installer and zsync need Range, so streaming stays the
  default; redirect is opt-in per request and only for public artifacts of public repositories.
- **Cache keys** are synthesised, never `req.url` (`gateway.ts:120-140`), and non-public modes are
  not cached. A cached GitHub signed URL is a bearer credential for a private asset: keep it in KV
  under the product scope with a TTL shorter than its expiry, and re-check `isAllowedStorageHost`
  on use (R6-08).
- **Rate-limit lane.** The new byte routes count against the artifact lane, not metadata
  (`gateway.ts`, `isArtifact`).
- **Enablement.** All routes are in the release namespace, so a product with Release off exposes
  none of them. CI routes refuse a token without the scope with `forbidden` and a `reason`.

## Corrections from the code (recorded during implementation)

- **No CI credential store yet.** P2-02 (`requireCiScope`, `ci_tokens`) is not done; it depends
  on P2-04. P2-05 adds `core/ciScope.ts` `requireCiScope(req, env, db, product, scope, now)` over a
  one-function seam, `core/ciTokens.ts` `lookupCiToken`, which knows no token until P2-02 fills
  it. Until then the CI routes answer 401 to every request (fail closed); the suites mock only
  that seam. P2-02 should implement `lookupCiToken` (or re-export its own) and keep the shape.
- **`CHANNEL_ALIASES` has not landed** (P0-04 is in progress). `services/release/resolve.ts`
  carries `LEGACY_CHANNEL_ALIASES` with the plan's values (`staging → beta`, `latest → stable`)
  and `canonicalChannel`; swap in the shared constant when P0-04 merges. `classifyChannel` is
  left to P0-04.
- **No version scheme is declared anywhere yet.** Resolution reads `versionScheme` from the
  deliverable's `def_json` (`semver` | `semver+build` | `4part`), default `semver`; P2-04's
  manifest work can declare it.
- **`blobResponse` takes `env`.** Deriving the host needs `BLOB_ORIGIN`, so the options gain
  `env`; `host` stays optional and can only force the console treatment, never widen it.
- **Least privilege done, not optional:** `loadProductPublic` / `ProductPublic` (no signing key)
  is what byte routes receive; the Core download checks take `ProductPublic`.
- **The resolution cache covers health.** `resolveMovingSelector` is cached per channel and
  release generation and always applies yanks; `test/releaseResolution.test.ts`'s regression
  case now bumps the generation to see a deletion nobody reported, and the R10-05 CONTRAST test
  uses a fresh KV per request so it still measures only the edge cache.
- **`?checksum=sha256` on the bytes host** answers `application/octet-stream` (the host serves
  no `text/*`); the console keeps `text/plain`.
- **`BLOB_ORIGIN` guard** is a test over the committed `wrangler.toml` (no `dl*` route without the
  var; the var never names a console host) plus a `docs/DEPLOYMENT.md` line.

## Steps

1. `resolve.ts` with a table-driven test over fixtures: includes, pointer, pin, yank, a release
   missing one platform, `universal` and `any`, scheme ordering, the tag filter.
2. `policy.ts` and the admin and CI routes; audit rows; source guard from P2-03.
3. Make `resolveSelector` apply yanks and pins; update the R6-10 attack test.
4. Byte routes over `blobResponse` and `streamAsset`; bytes-host registration; OpenAPI entries,
   `SERVICE_PATHS` rows, `docs gen`.
5. GitHub caching with a test that counts fetches: one miss, then Range chunks with no API call.
6. Admin read model, discovery fields, docs pages.

## Acceptance criteria

- [x] The resolution table test passes, including "iOS falls back to the newest release with an iOS
      build" and "beta includes stable".
- [x] After a yank, `/update/version`, the appcast and `/release/dl/latest/…` stop offering the
      release; after a pin, all three and `/release/builds/stable/…` serve the pinned release.
- [x] CI routes refuse a token without `release:promote` or `release:yank`; admin and CI changes
      write audit rows; an operator change survives a resync.
- [x] The blob route refuses a hash no artifact of this product references, and serves 206, 304 and
      416 correctly from the R2 fake.
- [x] With caching, a download miss makes at most one GitHub API call, and a following Range
      request makes none (fetch-counting test).
- [x] `routeCoverage` passes with the new paths; `docs gen:check` is clean.
- [x] The green gate passes (`AGENTS.md`), including `test/attack/R6-release.test.ts`.
- [x] A throw inside a registered byte route or `loadProduct` answers a JSON 500 with `X-Content-Type-Options: nosniff` and the sandbox CSP on the bytes host (test).
- [x] `blobResponse` ignores a caller-supplied `host: "bytes"` on a console-host request; a locked key with no stored checksum answers not-found; a gated response carries `no-transform`.
- [x] With Release off for a product, the three release byte routes answer the bytes host's flat not-found (test).

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- resolve policy release updateFeed routeCoverage R6-release
mise exec node@22 -- pnpm --filter @polaris-key/docs gen:check
mise exec node@22 -- pnpm typecheck
```

## Hand-off

- `resolveBuild` and `policy.ts` are what the `releaseCatalog` hook exposes (P2b-01) and what the
  signed feed composes from (P3-03). P2-06 calls the CI routes; P2-07 renders the admin model.
- P2b-04 moves the three byte routes, `/release/dl` and `install.sh` into distribution and keeps
  these paths as permanent aliases, so do not advertise them anywhere that cannot follow.
- Set the status: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P2-05 done`.
