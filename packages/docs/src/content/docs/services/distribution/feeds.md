---
sidebar:
  order: 6
title: "Storefront feeds"
description: "The per-channel feeds third-party storefronts read: AltStore and SideStore sources, an AltStore PAL source, Obtainium configs, an F-Droid repository signed by CI, a Scoop manifest and Flathub checker JSON."
---

Sideload stores and package managers do not ask Polaris Key "what should I install?" — they read
a document in their own format. Distribution renders one per channel from what Release knows and
what Distribution tracks, so a product publishes a release once and every storefront follows.

| Feed                        | URL (under `/<product>/distribution/`) | Outlet kind    | Client                                   |
| --------------------------- | -------------------------------------- | -------------- | ---------------------------------------- |
| AltStore / SideStore source | `altstore/<channel>/source.json`       | `altstore`     | AltStore Classic, SideStore              |
| AltStore PAL source         | `altstore-pal/<channel>/source.json`   | `altstore-pal` | AltStore PAL (EU, Japan, Brazil)         |
| Obtainium app config        | `obtainium/<channel>.json`             | `obtainium`    | Obtainium                                |
| F-Droid repository          | `fdroid/<channel>/repo`                | `fdroid-repo`  | F-Droid, Droid-ify, Neo Store, Obtainium |
| Scoop manifest              | `scoop/<channel>.json`                 | `direct`       | Scoop                                    |
| Flathub checker JSON        | `flathub/<channel>.json`               | `flathub`      | Flathub's External Data Checker          |

A feed exists only when the product declares a live outlet of its kind in `.pkey/distribution`.
With several outlets of one kind (`altstore` and `altstore-beta`, say), add `?outlet=<id>`; by
default the outlet whose id is the kind is used, else the first by id. The feeds are served on
the console host, never on the bytes host. The bytes they point at are served from the bytes
host.

## Which releases appear

For outlet O and channel C, a feed lists the releases that pass all five checks:

1. **C serves them**, by Release's own rules: membership in C or a channel it includes (beta
   includes stable), newest first. A yanked release is removed, except a pinned pointer, and a
   pinned channel stops at its pointer.
2. **They have a build for O.** That is O's artifact-map id when its identity names one
   (`artifact: ipa-sideload`), otherwise a build for the feed's platform: iOS, Android, Windows or
   Linux.
3. **They are live on O.** A self-hosted outlet (`altstore`, `obtainium`, `fdroid-repo`,
   the Polaris Key outlet `direct`) is live by derivation as soon as its bytes are stored. A store outlet (`altstore-pal`)
   is live only once it has been reported live — see
   [Availability](/docs/services/distribution/availability/). Flathub is the exception: its checker
   tells Flathub where Polaris Key's bytes are, so the test there is that the bytes are served.
4. **They are not held back on O.** These clients cannot bucket installs, so a release whose
   [outlet rollout](/docs/services/distribution/rollouts/) is paused, halted, or active below
   10000 bp is left out until the rollout completes. The previous release is listed instead.
5. **Their payload has an immutable delivery URL**, `files/<releaseId>/<name>`, on the bytes host
   when there is one.

A feed lists at most 20 versions. Scoop and Flathub list only the newest version.

**Access.** None of these clients can authenticate. A feed therefore exists only while the app's
[delivery access](/docs/services/distribution/delivery/) is `public`. Under `authenticated`,
`licensed` or `entitled`, every feed route, the F-Droid relay included, answers not-found.
Release notes appear only when the product's metadata access is public too.

**Responses.** Every feed is `application/json` with `Cache-Control: public, max-age=300`, because
AltStore makes an update live the moment it reads the source. Each one has a strong `ETag` (the
SHA-256 of the body), so a client revalidates cheaply. Browser tools such as source browsers get
CORS only through the product's `web.origins` allowlist; no feed route answers with a wildcard.

The Worker keeps each rendered feed in its cache for the same five minutes, so a new release can
take up to five minutes to appear. A rollout change (a halt, a pause, a completion), a yank, an
availability report, an outlet change or a new F-Droid registration takes effect on the next
request, and so does making the app non-public. A feed lists at most the 20 newest qualifying
versions, and looks for them among the 100 newest releases of the channel.

## Build metadata

Some feeds need facts that are inside the archive. AltStore checks a source's `appPermissions`
against the IPA and refuses the install when they differ. F-Droid needs an APK's version code,
ABIs and signer. The Worker never unzips an archive, so `pkey release publish` reads these facts
in CI and puts them in the release descriptor's optional `builds[].metadata`:

- **iOS:** `bundleIdentifier`, `version`, `buildVersion` and `minOSVersion` from `Info.plist`,
  and `appPermissions.entitlements` / `appPermissions.privacy` from the main executable's code
  signature and the `NS…UsageDescription` keys.
- **Android:** `packageName`, `versionCode`, `versionName` and `minSdk` from the binary
  manifest, `nativecode` from `lib/<abi>/`, and `signerSha256` from the APK signing block.

The descriptor validator checks the shape; see
[validation codes](/docs/reference/validation-codes/) (`invalid_build_metadata`). An iOS
release without metadata is left out of the AltStore sources, because its permissions are
unknown.

## AltStore, SideStore and AltStore PAL

The **Classic** source, which SideStore also reads, follows the clients' documented quirks:

- versions are newest first and unique by (`version`, `buildVersion`);
- the newest version is also copied to the legacy app-level fields `version`, `versionDate`,
  `versionDescription`, `downloadURL` and `size`, which SideStore requires;
- there is **no** `marketplaceID`, because SideStore refuses a source that has one.

The **PAL** source is the same document **with** `marketplaceID`, taken from the outlet's
`marketplaceId`. Its download URL is the build's payload as the release declares it. Polaris Key
does not host alternative-distribution packages beyond that file.

Users add a source with `altstore://source?url=<encoded source URL>`, or
`sidestore://source?url=…` for SideStore. The download page links to these.

## Obtainium

`obtainium/<channel>.json` is the app config that an `obtainium://app/<url-encoded JSON>` link
carries. The key names were checked against Obtainium's own source. `additionalSettings` is a JSON
**string**.

- When the product has a live `fdroid-repo` outlet, the config tracks that repository
  (`overrideSource: FDroidRepo`). This gives real version codes, ABI selection, and a stable
  channel that prefers stable versions.
- Otherwise it is a direct APK link (`overrideSource: DirectAPKLink`) to the channel's
  `builds/<channel>/<buildId>` URL. Its strong ETag is the payload's SHA-256, so ETag
  pseudo-versioning changes exactly when the bytes do. The builds route resolves the channel's
  newest release itself, so outlet holds do not apply to this form. Prefer the F-Droid
  repository.

## The F-Droid repository

There is one repository per channel, at `/<product>/distribution/fdroid/<channel>/repo`. The beta
repository includes stable. It is a **static repository signed by CI**: Polaris Key never holds
the repo key.

1. CI runs `pkey feeds fdroid --product <slug> --channel <c> --out <dir> --keystore … --alias …`.
   The CLI reads the generator's inputs from `GET …/distribution/feeds/fdroid/<channel>` (the APKs
   the channel lists, with their metadata, and the files registered now). It writes
   `index-v2.json`, `entry.json` and a diff against the current index, then signs `entry.jar` with
   `apksigner` (v1 scheme, minimum SDK 23) using the CI-held key.
2. It uploads the files through an upload ticket. P2-02's uploads route accepts
   `distribution:feeds`. Only a file that is already one of the channel's registered files skips
   the upload. Any other object must come from the ticket, even one the product already stores
   for a release.
3. It registers the set with `POST …/distribution/feeds/fdroid/<channel>`. The set must include
   `entry.jar`, `entry.json` and `index-v2.json`. Each path must pass the safe-path check and end
   in `.json`, `.jar`, `.png`, `.jpg`, `.jpeg`, `.webp` or `.asc`. No file may be an object that a
   non-public deliverable's release carries, such as a paid pack's payload (`not_public`). The
   registration replaces the channel's previous set in one batch, so a client never reads a new
   `entry.jar` beside an old index.

The relay then serves **only registered files**, using the content type the Worker chose for
each extension, never a type sent by CI. Every answer carries `nosniff` and a sandbox CSP. An APK
that the registered `index-v2.json` names, and that the channel's feed still selects, is a `302`
to its immutable delivery URL. The relay finds an APK by its file name, so each listed release's APK needs a distinct name (put the version in it, as in
`Diceroll-1.2.0-android.apk`); `pkey feeds fdroid` refuses a set where two releases share one.
Anything else, including a path that fails the safe-path check, is not-found. So is a registered
file once a non-public deliverable's release carries the same bytes.

Grant `distribution:feeds` to the product's CI token deliberately. Like `distribution:rollout`,
it is not in the default grant.

The repository URL users add needs the repo key's fingerprint. Record the key in the
[key inventory](/docs/services/distribution/availability/) under the `fdroid-repo` purpose. The
CI read route returns it, and the download page shows
`fdroidrepos://<host>/<product>/distribution/fdroid/<channel>/repo?fingerprint=<sha256>`. Keep
`versionCode` strictly increasing across channels, and keep one repo key per product: rotating the
key forces every user to add the repository again.

## Scoop

`scoop/<channel>.json` is a Scoop app manifest for the newest Windows release on the Polaris
Key outlet (`direct`). It contains:

- `architecture.64bit` and `architecture.arm64`, each with an immutable `url` and a SHA-256
  `hash`;
- `bin` and `shortcuts` from the outlet's optional `scoop` identity in `.pkey/distribution`;
- `checkver` and `autoupdate` pointing back at the manifest itself.

A bucket can track it, or a user can run `scoop install <url>` directly.

```yaml
outlets:
  direct:
    platforms: [macos, windows, linux]
    scoop:
      bin: Diceroll/diceroll.exe
      shortcuts: [[Diceroll/diceroll.exe, Diceroll]]
```

A `direct` outlet that declares `platforms` must include `windows` before it may carry `scoop`.

## Flathub

`flathub/<channel>.json` is `{version, releases: [{arch, url, sha256, size}]}` for the newest
Linux release. It is the JSON that a Flathub manifest's `x-checker-data` (`type: json`) reads for
an extra-data source:

```yaml
x-checker-data:
  type: json
  url: https://key.plrs.im/<product>/distribution/flathub/stable.json
  version-query: .version
  url-query: '.releases[] | select(.arch == "x86_64") | .url'
```

The output is a deterministic template over release data, and it is checker JSON, not a
manifest. Polaris Key never opens, comments on or automates a Flathub pull request: Flathub
forbids AI-generated or AI-assisted manifest content and any AI tool opening or automating a
submission pull request. Writing and submitting the manifest is the developer's job.

## Routes

| Method   | Path (under `/<product>/distribution/`) | Auth                             |
| -------- | --------------------------------------- | -------------------------------- |
| GET      | `altstore/<channel>/source.json`        | public                           |
| GET      | `altstore-pal/<channel>/source.json`    | public                           |
| GET      | `obtainium/<channel>.json`              | public                           |
| GET      | `fdroid/<channel>/repo/<path>`          | public                           |
| GET      | `scoop/<channel>.json`                  | public                           |
| GET      | `flathub/<channel>.json`                | public                           |
| GET/POST | `feeds/fdroid/<channel>`                | `pkeyci_` + `distribution:feeds` |

The full contract is in the [route reference](/docs/reference/routes/).
