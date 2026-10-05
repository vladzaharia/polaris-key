# P3-09 Update feeds: Sparkle extensions, WinSparkle, Velopack, `.appinstaller`, zsync, extended `/version`

| Field       | Value                                                                                           |
| ----------- | ----------------------------------------------------------------------------------------------- |
| Phase       | P3: Signed feed, decision, feeds (wire v4)                                                      |
| Size        | 1.5–2 engineer-weeks                                                                            |
| Depends on  | [P3-03](P3-03-feed-composition.md), [P0-10](P0-10-sparkle-hardening.md), [P0-05](P0-05-cors.md) |
| Unblocks    | [P3-10](P3-10-godot-updater.md), [SP-09](SP-09-velopack-auth-redirect.md)                       |
| Role        | `pkey-implementer`                                                                              |
| Plan mode   | no. The feeds are unsigned routes; only a new `shared-protocol` type would be plan-mode         |
| Gates       | rule 10 (OpenAPI + `routeCoverage`); generated `reference/routes.mdx`                           |
| Human input | none required. A manual smoke test with real updater clients is recommended (see Verify)        |
| Repo        | `vladzaharia/polaris-key`                                                                       |

## Goal

Update renders every app-updater feed in README §3.6 from the same release records and per-outlet
state that the signed channel feed uses: an extended Sparkle appcast (build numbers,
`criticalUpdate`, `phasedRolloutInterval`, deltas, `hardwareRequirements`, universal DMGs), a
WinSparkle appcast, Velopack `releases.<channel>.json`, an MSIX `.appinstaller` (2021 schema),
stable per-channel AppImage `.zsync` URLs and an extended `/update/version`. Each is a pure
renderer with snapshot tests, a route in the OpenAPI spec, and the right content type and caching.
A halted rollout or a yanked release disappears from every feed at once.

## Why

"One canonical release record, many feeds": a new outlet is a renderer, never a new architecture
([README §8](../../README.md#8-carrying-the-concepts-to-the-other-sdks-and-products) item 1).
Today Update emits one DMG item with `sparkle:version` equal to the short version and nothing
else ([notes/A1 §2](../../notes/A1-release-update.md), `services/update/appcast.ts:141-166`), so
Windows and Linux builds have no feed, and djdl gets no build numbers, critical flag or deltas.
Diceroll's desktop code updates need full-app updaters with deltas now that 4.6+ templates ignore
`--main-pack` ([README §5.6](../../README.md#56-code-updates-without---main-pack),
[§11](../../README.md#11-decisions-needed) decision 6), and [P3-10](P3-10-godot-updater.md) hands
off to exactly these feeds.

## Read first

- `AGENTS.md` rule 10; `plans/P3-01.md` (the extended `/update/version` shape, if it fixed one).
- [README §3.6](../../README.md#36-update-what-an-installed-app-should-do-next) (the feed table),
  [§4.3](../../README.md#43-macos), [§4.4](../../README.md#44-windows),
  [§4.5](../../README.md#45-linux).
- [notes/E3](../../notes/E3-windows-linux-web.md) §A2 (`.appinstaller`: `Uri` must equal the
  served URL, at most one query pair, `application/appinstaller`, Range), §A3.1 (Velopack feed
  shape and client query parameters), §A3.2 (WinSparkle `sparkle:os`, `installerArguments`, no
  channels), §A4 (Scoop `checkver` jsonpath; winget needs direct, non-redirecting URLs), §B1
  (AppImage `zsync|…` update information, absolute `URL:` in the `.zsync`).
- [notes/E1](../../notes/E1-apple.md) (Sparkle 2.9–2.10 elements: `criticalUpdate`,
  `phasedRolloutInterval`, `sparkle:deltas`, `hardwareRequirements`, `minimumAutoupdateVersion`;
  keep signed feeds off because feeds are rendered dynamically).
- Code: `services/update/{feed,appcast,routes,eligibility,index}.ts`,
  `services/release/{gateway,sparkle,assets}.ts` (`ReleaseKind`, `CACHEABLE_KINDS`,
  `releaseCacheKey`, `accessModeFor` in `config.ts:130-150`), `test/updateFeed.test.ts`.
- What [P3-03](P3-03-feed-composition.md) exposes: stored records, the per-outlet view (target,
  rollout, halt, availability), and what P2-03/P2-05/P2b-04 landed (builds, artifact roles,
  delivery URLs and content types).

## Scope

**In:**

- **Sparkle** (extend `appcast.ts`/`feed.ts`): `sparkle:version` from the build number;
  `criticalUpdate` from the channel's `critical` and floor; `phasedRolloutInterval` when the
  `direct` outlet's rollout is active; a halted rollout serves the previous release;
  `sparkle:deltas` from `delta` artifacts; `hardwareRequirements` for arm64-only builds;
  universal DMGs matched for both architectures.
- **WinSparkle**: a per-channel appcast with `sparkle:os` and `sparkle:installerArguments`
  enclosures and CI-provided `sparkle:edSignature`, reusing the renderer.
- **Velopack**: `releases.<velopack-channel>.json` (`Assets` with `PackageId`, `Version`, `Type`,
  `FileName` as absolute distribution URLs, `SHA1`, `SHA256`, `Size`, notes), per Polaris channel
  and OS/arch. Velopack clients append `arch`, `os`, `rid`, `id` and `localVersion`; key the cache
  only on the ones the renderer reads.
- **App Installer**: an `.appinstaller` per channel in the `2021` namespace with `MainPackage`
  identity from `.pkey/distribution` and the build's 4-part version, `OnLaunch`,
  `ShowPrompt` and `AutomaticBackgroundTask` as the operator configures them;
  `application/appinstaller`.
- **zsync**: a stable per-channel `.zsync` URL for each AppImage build whose `URL:` header points
  at the current AppImage's Range-capable distribution URL.
- **Extended `/update/version`**: keep `version`, `tag` and `url` (today the GitHub release page);
  add `build`, `sha256`, `size`, `downloadUrl`, `minOS` and `critical` (the field names
  `plans/P3-01.md` §6 fixes), selectable with `?platform=&arch=&outlet=`, documented in OpenAPI
  only. No `shared-protocol` type, so this package stays non-plan-mode; SDKs keep reading the v3
  fields in `check()` and use the signed feed for everything else.
- Routes (proposed; final names in the PR and the spec): `/{product}/update/{channel}/winsparkle.xml`,
  `/{product}/update/{channel}/velopack/releases.{file}.json`,
  `/{product}/update/{channel}/app.appinstaller`,
  `/{product}/update/{channel}/{name}.AppImage.zsync`. New gateway kinds with their access mode,
  cache key inputs and cache headers; OpenAPI, `SERVICE_PATHS`, discovery `endpoints`, and
  `reference/routes.mdx`.
- Docs: `packages/docs/src/content/docs/services/update/` (a page per feed family, or one page
  with a section each).

**Out** (and where it belongs instead):

- The signed channel feed and record routes (→ [P3-03](P3-03-feed-composition.md)).
- Storefront feeds: AltStore, F-Droid, Obtainium, Scoop and Flathub manifests (→ [P2b-05](P2b-05-storefront-feeds.md)).
- Native updater bridges in Godot (→ [P5-07](P5-07-desktop-plugins.md)); the GDScript hooks that
  call them (→ [P3-10](P3-10-godot-updater.md)).
- Signed Sparkle feeds (`SURequireSignedFeed`): not with dynamic rendering (notes/E1).

## Design notes

- **Renderers are pure.** Each takes records, builds and the per-outlet view and returns bytes,
  deterministically, as `renderAppcast` does today, so each gets a snapshot test. Never read the
  clock inside a renderer.
- **The Worker never signs an updater payload.** Sparkle and WinSparkle signatures come from CI
  (in the release descriptor or record) and are checked at ingest; Velopack relies on hashes and
  Authenticode; MSIX on the publisher certificate; AppImage on zsync hashes. Do not buffer whole
  installers to re-verify them in the isolate: `sparkle.ts` buffers up to 256 MiB in a 128 MB
  isolate today (README §9.1 #11). Use [P0-10](P0-10-sparkle-hardening.md)'s `streamingEd25519Check` / `streamingEd25519Verify` (`services/release/ed25519Stream.ts`; negatives are memoised for 24 h, and it refuses small-order keys), or the record's SHA-256 plus a
  streaming digest.
- **Enclosure and asset URLs are immutable and Range-capable**, served by distribution. winget
  and some updaters reject redirects; use the streaming path where the notes say so.
- **Feeds are channel-scoped and device-neutral**, so they cache like the appcast
  (`APPCAST_CACHE`) with a synthetic cache key over only the inputs that change the body
  (`releaseCacheKey`). Access modes apply as they do to the appcast today.
- **Keep old URLs working.** The appcast paths and their permanent aliases keep their meaning; an
  unparameterised appcast still serves `arm64` (`feed.ts:45`).
- **`.appinstaller` constraints**: the `Uri` attribute must equal the URL the file is served from,
  with at most one query pair; a per-channel package identity name allows side-by-side channels.
- **Velopack SHA-1** is not in the release record: take it from artifact metadata that ingest
  verified, or compute it with a streaming digest; never pass through an unverified value.
- **Rollout mapping.** Sparkle's phased rollout is client-side in seven groups and cannot express a
  basis-point bucket; document the mapping you choose. Feeds without any rollout concept serve the
  previous release until the rollout completes, or the new one to everybody; state which per feed.
- **CORS** on `/update/version` comes from [P0-05](P0-05-cors.md)'s allowlist; this package does
  not add its own.

## Steps

1. Confirm P3-03 is `done`; branch `wp/P3-09-updater-feeds`. P0-05 (CORS) and P0-10 (streaming
   Sparkle verification) are not graph dependencies but this package relies on them; if either
   is missing, say so in the PR and leave CORS or signature re-verification to it.
2. Extend the Sparkle renderer and its tests.
3. WinSparkle, then Velopack, then `.appinstaller`, then zsync: renderer, route, gateway kind,
   spec entry and snapshot test for each, one commit per feed.
4. Extend `/update/version`; keep the old fields.
5. Discovery, OpenAPI, `SERVICE_PATHS`, docs; regenerate `routes.mdx`. Green gate; set `in-review`.

## Acceptance criteria

- [ ] Snapshot tests for every renderer, including: a build number differing from the short
      version; a critical release; an active and a halted rollout; a delta; a universal DMG; a
      Windows x64 installer; a Velopack full and delta pair; an `.appinstaller` whose `Uri` equals
      its route; a `.zsync` whose `URL:` is the current AppImage.
- [ ] A yanked or halted release is absent from every feed, tested once per feed.
- [ ] `/update/version` still returns `version`, `tag` and `url`, and returns the new fields when
      asked for a platform, arch or outlet.
- [ ] Content types: `application/xml` (appcasts), `application/json` (Velopack, `/version`),
      `application/appinstaller`, and the zsync type the PR documents.
- [ ] OpenAPI and `routeCoverage` updated; `reference/routes.mdx` regenerated; `docs gen:check`
      passes.
- [ ] The green gate passes (`AGENTS.md`), including the workerd smoke job.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- updateFeed
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm --filter @polaris-key/worker test:workerd
mise exec node@22 -- pnpm --filter @polaris-key/docs gen:check
```

Recommended once deployed to a preview: point a Sparkle test app, WinSparkle, a Velopack sample,
App Installer and `appimageupdatetool` at the preview routes, and record the result in the PR.

## Corrections from implementation

Where the code disagreed with this brief, the code won:

- **The extended `/update/version` answer needs `?platform=`.** `?arch=`, `?outlet=` and
  `?build=` refine it and are discarded on their own, so every legacy URL keeps its three-field
  answer (acceptance row 3 reads "when asked for a platform").

- **Update may not import Distribution** (AGENTS.md rule 6), so P2b-05's selection and cache are
  reused through Core. Distribution's `delivery` hook gained the read-only `feedSelection`
  (P2b-05's `selectFeed` with declarative filters: arches, build ids, payload suffixes, an
  allowlist of release ids, `rollouts: "phase"` and the build's other artifacts) and `feedStamp`.
  The generic feed cache moved to `core/feedCache.ts`.
- **"From the same release records" is literal.** A feed lists only releases with a stored
  `release_records` row. The appcast therefore keeps its legacy GitHub path, byte for byte, for a
  product that has no record.
- **Signatures are not in the descriptor or the record.** CI's `<file>.sig` sidecar (a
  `signature` artifact, which the CLI already uploads) is read and checked against its recorded
  SHA-256, then verified over the stored payload with `verifyEd25519OverBytes`, the generalised
  P0-10 verifier, memoised. It is checked at first render, not at ingest.
- **Sparkle deltas need `sparkle:deltaFrom`**, which nothing carried. The descriptor gained
  `deltaFrom` on `delta` artifacts (validator code `invalid_delta_from`, schema, mutation entries),
  stored in `release_artifacts.metadata_json`. The record mapping drops it.
- **The App Installer identity needs `Publisher`**, which `packageFamilyName` does not carry. The
  `app-installer` outlet gained `publisher` and `updateSettings` in `.pkey/distribution`. The
  update settings are the manifest owner's, not a console setting.
- **zsync** needs the control file uploaded. `pkey release publish` now picks up a `.zsync`
  sidecar as a `checksum` artifact.
- **Extended `/update/version`** also takes `?build=<buildId>`, because a platform can have
  several builds.

## Hand-off

- The route paths and discovery endpoints for each feed, which [P3-10](P3-10-godot-updater.md)'s
  hooks and [P5-07](P5-07-desktop-plugins.md)'s native bridges point at, and which D-03 wires into
  Diceroll's exports (`SUFeedURL`, Velopack base URL, AppImage update information).
- The renderer functions, reusable by [P2b-05](P2b-05-storefront-feeds.md) for storefront JSON.
- `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P3-09 done` in the PR
  that completes the work.
