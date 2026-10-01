# P2b-05 Storefront feeds: AltStore/SideStore/PAL, Obtainium, F-Droid, Scoop/Flathub JSON

| Field       | Value                                                                                                                                                                                                                           |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | P2b: Distribution core                                                                                                                                                                                                          |
| Size        | 2–3 engineer-weeks                                                                                                                                                                                                              |
| Depends on  | [P2b-03](P2b-03-availability-keys.md), [P2b-04](P2b-04-rollouts-delivery.md), [S-07](S-07-policy-recheck.md)                                                                                                                    |
| Unblocks    | [D-03](D-03-diceroll-after-p3.md)                                                                                                                                                                                               |
| Role        | `pkey-implementer`                                                                                                                                                                                                              |
| Plan mode   | no                                                                                                                                                                                                                              |
| Gates       | rule 10 (feed routes and one CI route); D1 migration + `TABLE_OWNERS` (`dist_feed_files`); rule 9 for two optional `.pkey/distribution` fields and the descriptor's `metadata` (neither in the graph's gates); `docs gen:check` |
| Human input | none (the F-Droid repo keystore stays in the product's CI secrets; Polaris Key never holds it)                                                                                                                                  |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                       |

## Goal

For each declared outlet of the right kind, distribution serves a per-channel storefront feed
rendered from release's truth and distribution's state: an **AltStore/SideStore source**, an
**AltStore PAL source**, an **Obtainium** add-link config, a **F-Droid** repository (index files
generated and signed in CI, relayed by the Worker), a **Scoop** app manifest and a **Flathub**
`x-checker-data` JSON. Each lists only releases that are live on that outlet, not yanked, and not
held back by a paused or halted rollout. Diceroll's AltStore source and F-Droid repo can come from
Polaris Key (the P2b milestone with P2b-06).

## Why

Diceroll generates its AltStore source and update manifest with its own scripts today, and the
beta source never receives stable releases (README [§9.2](../../README.md#92-diceroll-for-the-diceroll-side)
items 4 and 14). The research makes storefront feeds distribution routes rendered from registered
data ([§3.8](../../README.md#38-distribution-distribution-service) "Storefront feeds", table),
with each client's quirks documented in notes/E1 (AltStore, SideStore, PAL), notes/E2 (Obtainium,
F-Droid) and notes/E3 (Scoop, Flathub). F-Droid's index is signed by CI with the repo key, which
Polaris Key never holds.

## Read first

- `AGENTS.md` (rules 5, 6, 10), `CLAUDE.md`.
- [README §3.8](../../README.md#38-distribution-distribution-service), [§3.6](../../README.md#36-update-what-an-installed-app-should-do-next)
  (the app-updater feeds are update's, not these), [§6.3](../../README.md#63-player-end-user).
- [notes/E1 §B1–§B6](../../notes/E1-apple.md#b1-source-json-schema-current) (source schema,
  newest-first versions, SideStore's legacy top-level fields and its refusal of `marketplaceID`,
  deep links, no authenticated sources); [notes/E2 §B3](../../notes/E2-android.md#b3-obtainium)
  and [§C2](../../notes/E2-android.md#c2-self-hosted-f-droid-compatible-repo) (Obtainium sources and
  deep links, index-v2, `entry.jar` signing with `apksigner`, one repo per channel);
  [notes/E3 §A4 and §B2](../../notes/E3-windows-linux-web.md#a4-package-manager-surfaces-winget-scoop-chocolatey)
  (Scoop `checkver`/`autoupdate`, Flathub `x-checker-data`); [notes/A4](../../notes/A4-diceroll-mapping.md)
  (Diceroll's `altstore_source.py`).
- [S-07](S-07-policy-recheck.md) rows 1–5, 12 and 14, read in [notes/S-07-policy-recheck](../../notes/S-07-policy-recheck.md) (re-checked 2026-09-30, all
  unchanged): F-Droid may now host an upstream developer-signed package beside its own (row 3);
  AltStore PAL serves the EU, Japan and Brazil with a 5% Core Technology Commission in each
  (rows 4–5); Flathub forbids AI-generated or AI-assisted manifest content and any AI tool opening
  or automating a submission pull request (row 12); winget wants the final, unredirected,
  per-version publisher URL (row 14). Re-run those rows with
  `prototype/policy-recheck/recheck.mjs --rows 1,2,3,4,5,12,14` if more than a month has passed.
- Hand-offs: [P2b-03](P2b-03-availability-keys.md) (availability, keys), [P2b-04](P2b-04-rollouts-delivery.md)
  (`deliveryUrl`, rollouts, access), [P2b-02](P2b-02-distribution-manifest.md) (outlet identities,
  listing), [P2-02](P2-02-trusted-publisher.md) (upload tickets), [P2-04](P2-04-release-descriptor.md)
  (descriptor), [P2-06](P2-06-publish-cli-action.md) (CLI plumbing).
- Code: `packages/worker/src/services/distribution/`, `src/core/hooks.ts`, `src/http.ts:21-26`
  (`isSafeAssetPath`), `src/services/update/appcast.ts` (a renderer to imitate), `openapi/polaris-key.v3.yaml`.

## Scope

**In:**

- **Routes** (rule 10), all `GET` and public, rendered per channel (with `includes`):
  - `/{product}/distribution/altstore/{channel}/source.json` (Classic and SideStore flavour);
  - `/{product}/distribution/altstore-pal/{channel}/source.json` (PAL flavour);
  - `/{product}/distribution/obtainium/{channel}.json`;
  - `/{product}/distribution/fdroid/{channel}/repo/{path}` (the static relay: `entry.jar`,
    `entry.json`, `index-v2.json`, `diff/*.json`, `icons/*`, and APKs by file name through
    `deliveryUrl`);
  - `/{product}/distribution/scoop/{channel}.json`;
  - `/{product}/distribution/flathub/{channel}.json`.
- **CI route** (rule 10): `POST /{product}/distribution/feeds/fdroid/{channel}` registers the file
  set CI uploaded (`{files: [{path, sha256, size}]}`), scope `distribution:feeds`; P2-02's uploads
  route accepts that scope for feed objects.
- **Table** `dist_feed_files(product, feed, channel, path, sha256, size, content_type, updated_at)`
  (migration, `TABLE_OWNERS` under `distribution`).
- **CLI** `pkey feeds fdroid --product <slug> --channel <c> --out <dir> [--keystore … --alias …]`:
  builds `index-v2.json`, `entry.json` and diffs from Polaris Key's releases, runs `apksigner` for
  `entry.jar` with the CI-held key, uploads and registers the files.
- **Build metadata** for the feeds, extracted by `pkey release publish` into the descriptor's
  optional `builds[].metadata` (rule 9 on the descriptor schema): iOS `{bundleIdentifier, version,
buildVersion, minOSVersion, appPermissions: {entitlements, privacy}}` from the IPA; Android
  `{packageName, versionCode, versionName, minSdk, nativecode, signerSha256}` from the APK. The
  Worker validates the shape and never unzips an archive.
- **Manifest fields** (rule 9): optional `scoop {bin, shortcuts}` on a `direct` outlet covering
  Windows; `flathub` uses its `appId` identity.
- Docs: `services/distribution/feeds.md` and a `users/downloads.md` section on adding a source.

**Out** (and where it belongs instead):

- The download page, deep links and QR codes (→ [P2b-06](P2b-06-download-page-matrix.md)).
- App-updater feeds (Sparkle, WinSparkle, Velopack, `.appinstaller`, zsync, extended `/version`)
  (→ P3-09); reuse its renderer helpers if it lands first.
- The winget REST source (README §3.8 "later"; no owner). Secret per-user AltStore sources for
  private betas (README §3.8; no owner). Hosting AltStore PAL's ADP files beyond relaying an
  artifact the release declares.
- Diceroll deleting `altstore_source.py` and switching URLs (→ D-03).

## Design notes

- **Which releases appear.** For outlet O and channel C: releases resolved for C (release's rules,
  through `releaseCatalog`), with a build for O's platform or O's `artifact`, `live` on O
  (`delivery.availability()`; self-hosted outlets are live by derivation), not yanked, newest
  first. These clients cannot bucket installs, so a release whose rollout on O is `paused` or
  `halted`, or below 10000 bp, is left out until `complete` (keep the previous one).
- **AltStore / SideStore (E1 §B1–§B4).** Versions newest first, each differing in `version` or
  `buildVersion`; `appPermissions` from build metadata (AltStore refuses an install whose
  permissions do not match the IPA). Emit **both** `versions[]` and the legacy top-level
  `version`, `versionDate`, `versionDescription`, `downloadURL`, `size` (SideStore issue #735).
  The Classic/SideStore flavour must **not** carry `marketplaceID`; the PAL flavour must.
  Short cache (`max-age=300`); strong `ETag` of the body hash.
- **Obtainium (E2 §B3).** When the channel has an `fdroid-repo` outlet, point the config at that
  repo (versionCode, arch selection, stable/beta); otherwise use the Direct APK Link to the
  `builds` route, whose strong `ETag` equals the SHA-256 so pseudo-versioning is stable.
  `additionalSettings` is a JSON **string**. `overrideSource` and other key names are unverified in
  E2: check them against a real Obtainium export before merging and record the check in the PR.
- **F-Droid (E2 §C2).** One repository per channel (`/fdroid/<channel>/repo`, beta including
  stable), `versionCode` strictly monotonic across channels, one repo key per product. CI signs
  `entry.jar` (`apksigner`, v1 scheme, min SDK 23); the Worker only serves registered files and
  refuses any `path` failing `isSafeAssetPath`. The repo fingerprint for users comes from the key
  inventory (`fdroid-repo` purpose, P2b-03).
- **Scoop and Flathub (E3).** The Scoop manifest carries `version`, `architecture.{64bit,arm64}`
  `{url, hash}`, `bin`/`shortcuts`, and `checkver`/`autoupdate` pointing back at itself, so a
  bucket can track it or a user can install by URL. Flathub's checker JSON is
  `{version, releases: [{arch, url, sha256, size}]}` for `type: json` (`extra-data`).
- **Access.** None of these clients can authenticate, so a feed renders only when the
  deliverable's `dist_access` is `public`; otherwise the route is not-found.
- **Flathub renderer is deterministic** (a template over release data, no generated prose). Its
  output is checker JSON, not a manifest, and Polaris Key never opens, comments on or automates a
  Flathub pull request (S-07 row 12).
- **URLs** are bytes-host URLs from `deliveryUrl` when `BLOB_ORIGIN` is set, and immutable per
  version (winget-style clients and hash-pinned manifests need that). A winget `InstallerUrl` must
  also be the final URL: a redirect fails winget's `Validation-Indirect-URL` check (S-07 row 14),
  so serve installer bytes directly at that URL when it is meant for winget.
- **CORS**: native clients ignore it; web tools (source browsers) need it. P0-05 applies the
  per-product `web.origins` allowlist centrally (`core/cors.ts`, exact origins, no wildcards); the
  feeds get whatever that gives them. Do not add a per-route wildcard.
- **Products are data.** No product or store name in code beyond the outlet-kind vocabulary.

## Steps

1. Build-metadata extraction in the CLI and the descriptor `metadata` schema; tests on fixture
   IPA and APK files (small synthetic archives).
2. AltStore and PAL renderers with golden fixtures, including the SideStore quirks.
3. Obtainium config; Scoop and Flathub renderers; the manifest fields (rule 9).
4. F-Droid: CLI generator and signing step, `dist_feed_files`, the CI register route, the relay.
5. Routes, OpenAPI entries, `routeCoverage`, `docs gen`; docs pages.

## Acceptance criteria

- [ ] Golden-file tests for each feed from a Diceroll-shaped fixture (stable and beta, beta
      including stable, one yanked release, one release halted on the outlet).
- [ ] The Classic source has no `marketplaceID` and has the legacy top-level fields; the PAL
      source has `marketplaceID`; versions are newest first and unique by (`version`, `buildVersion`).
- [ ] A release not `live` on the outlet, yanked, or with a paused, halted or partial rollout is
      absent; the previous release is listed instead.
- [ ] The F-Droid relay serves only registered files with correct content types and refuses
      traversal; `pkey feeds fdroid` produces an index that validates against index-v2's shape and
      an `entry.json` whose index hash matches.
- [ ] A non-public deliverable yields not-found on every feed route.
- [ ] `routeCoverage` passes; `docs gen:check` is clean; the green gate passes (`AGENTS.md`).

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- feeds routeCoverage
mise exec node@22 -- pnpm --filter @polaris-key/cli test -- feeds metadata
mise exec node@22 -- pnpm --filter @polaris-key/manifest test
mise exec node@22 -- pnpm --filter @polaris-key/docs gen:check
mise exec node@22 -- pnpm typecheck
```

## Hand-off

- Feed URLs (and their deep links: `altstore://source?url=`, `sidestore://source?url=`,
  `obtainium://app/<json>`, `fdroidrepos://…?fingerprint=`) are what P2b-06's download page links
  to, and what D-03 switches Diceroll to.
- The build metadata in descriptors is reusable by P3-09 (updater feeds) and P5 connectors.
- Set the status: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P2b-05 done`.
