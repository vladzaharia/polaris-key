---
title: "App-updater feeds"
description: "The extended Sparkle appcast, WinSparkle, Velopack, MSIX App Installer and AppImage zsync feeds, and the extended version check, all rendered from the release records."
sidebar:
  order: 4
---

Polaris Key SDKs decide updates from the [signed feed](/docs/services/update/signed-feed/). A
desktop app that updates itself with a native updater reads that updater's own feed instead.
Update renders each of those feeds from the same CI-signed release records and the same
per-outlet state as the signed feed. A new updater only needs a new renderer, never a new
architecture.

| Feed                                                                       | Updater                                   | Content type                      |
| -------------------------------------------------------------------------- | ----------------------------------------- | --------------------------------- |
| `/<product>/update/appcast.xml`, `/<product>/update/<channel>/appcast.xml` | Sparkle (macOS direct)                    | `application/xml; charset=utf-8`  |
| `/<product>/update/<channel>/winsparkle.xml`                               | WinSparkle (Windows installers)           | `application/xml; charset=utf-8`  |
| `/<product>/update/<channel>/velopack/releases.<velopackChannel>.json`     | Velopack (Windows, macOS, Linux)          | `application/json; charset=utf-8` |
| `/<product>/update/<channel>/app.appinstaller`                             | Windows App Installer (MSIX)              | `application/appinstaller`        |
| `/<product>/update/<channel>/<buildId>.AppImage.zsync`                     | AppImageUpdate / `appimageupdatetool`     | `application/x-zsync`             |
| `/<product>/update/version?platform=…`                                     | simple clients, Scoop `checkver`, scripts | `application/json; charset=utf-8` |

Discovery advertises the templates under `update.endpoints` (`winsparkle`, `velopack`,
`appInstaller`, `zsync`). A product's exports point at them: `SUFeedURL` for Sparkle, the
WinSparkle appcast URL, the Velopack base URL `…/update/<channel>/velopack`, the
`.appinstaller` link, and the AppImage update information
`zsync|https://key.plrs.im/<product>/update/<channel>/<buildId>.AppImage.zsync`.

## What every feed lists

A feed lists only releases that have a **stored release record**. Those are the releases the
signed feed can pin. The releases are chosen by the same rules as the
[storefront feeds](/docs/services/distribution/feeds/):

- the channel's history from Release (beta includes stable; a pinned channel serves its pointer);
- a build of the feed's platform that the outlet delivers (the `direct` outlet by default, or the
  `app-installer` outlet for App Installer; `?outlet=` picks another of that kind);
- live on that outlet, with an immutable delivery URL on the bytes host;
- not **yanked**, and not **held** by a rollout on that outlet.

A yank or a halt removes a release from every feed at once. A cached feed is keyed by a stamp
of the rollouts, yanks, availability, outlets and channel policies, so a change to any of them
is a new key. The previous release is listed instead. A new release reaches the feeds within
five minutes (`Cache-Control: public, max-age=300`).

**Rollouts.** Only Sparkle phases a rollout on the client. Every other feed has no rollout
concept, so it serves the previous release until the rollout completes:

| Feed                                                   | Active rollout                                       | Paused or halted |
| ------------------------------------------------------ | ---------------------------------------------------- | ---------------- |
| Sparkle                                                | listed, with `phasedRolloutInterval` (mapping below) | previous release |
| WinSparkle, Velopack, App Installer, zsync, `/version` | previous release until complete                      | previous release |

**Sparkle's mapping.** Sparkle puts each install in one of seven groups, and it cannot express a
basis-point bucket. An active rollout of `bp` therefore opens `ceil(bp × 7 / 10000)` groups (at
least one) and holds them there. The interval is one year, and `pubDate` is backdated to
`startedAt − (groups − 1) × interval`, so exactly that many groups qualify until the operator
changes `bp`. So 1–14 % opens one group, 15–28 % opens two, and so on. At 100 % (or `complete`)
the interval goes and the real date comes back. A release that is critical to everyone is never
phased.

## Signatures and hashes

The Worker never signs an updater payload and never passes through a value it did not check.

- **Sparkle and WinSparkle.** `sparkle:edSignature` is CI's `<file>.sig` sidecar, which
  `pkey release publish` uploads as a `signature` artifact. The Worker reads the sidecar, checks
  it against its recorded SHA-256, and verifies the signature over the payload's stored bytes
  with the streaming verifier. Final verdicts are memoised, so a release costs one streamed read,
  not one per request. With a configured Sparkle key, an enclosure whose signature does not verify
  is left out. Without a key, enclosures are listed unsigned only when an operator has turned off
  `requireSparkleSignature`.
- **Velopack.** `SHA256` comes from the record. `SHA1` is not in the record, so the Worker
  computes it with a streaming digest that also checks the recorded SHA-256 and size, and
  memoises it by that SHA-256.
- **MSIX** relies on the publisher certificate, and **AppImage** on the zsync block hashes.

Nothing is buffered except a small sidecar or a zsync control file.

## Sparkle, extended

For a product that publishes release records, the appcast routes render up to three releases with
a macOS build for `?arch=` (`arm64` by default, as before). A universal DMG serves both
architectures. Each item carries:

- `sparkle:version`: the build number (`builds[].buildNumber`, else the version);
  `sparkle:shortVersionString`: the version;
- `sparkle:minimumSystemVersion`: the build's `minOS`, else the operator's minimum;
- `sparkle:hardwareRequirements` `arm64` for an Apple-silicon-only build;
- `sparkle:criticalUpdate`: with no attribute for the channel's critical pointer release, and with
  `sparkle:version` set to the floor's build number for a release above the channel's
  `min_supported`;
- `sparkle:phasedRolloutInterval` during an active rollout (see above);
- `<sparkle:deltas>`: one enclosure per `delta` artifact that names its `deltaFrom` in the release
  descriptor (the build number the delta updates from), each with its own verified signature.

A product without release records keeps the [legacy appcast](/docs/services/update/appcast/),
byte for byte. Signed Sparkle feeds (`SURequireSignedFeed`) stay off, because the feed is
rendered dynamically.

## WinSparkle

WinSparkle has no channels, so it gets one appcast URL per channel. Each release is one item,
with one enclosure per Windows **installer** build (`.exe` or `.msi` payloads only, because
WinSparkle runs what it downloads), x64 first. Each enclosure carries:

- `sparkle:os` (`windows-x64`, `windows-arm64`, or `windows` for a universal build);
- the versions, repeated on the enclosure;
- CI's verified signature;
- `sparkle:installerArguments`, from the build's format: `msi` → `/passive`,
  `inno` → `/SILENT /SP- /NOICONS`, `nsis` → `/S`. A bare `exe` gets none.

## Velopack

Velopack clients request `<base>/releases.<channel>.json`, where the channel is the one the app
was packed with (`vpk pack --channel`). Use `…/update/<polaris channel>/velopack` as the base
URL. The Velopack channel's first token is the OS (`win`, `osx`, `linux`). If the second token is
`x64` or `arm64` it sets the architecture; otherwise the client's `?arch=` does, and the default
is x64. Velopack's other query parameters change nothing.

`Assets` lists the newest release's `-full.nupkg` payload (`Type: Full`) and the `-delta.nupkg`
delta artifacts (`Type: Delta`) of up to ten releases. Velopack applies deltas to the full package
it already holds, so older full packages are not listed. `PackageId` comes from the package file name, and
`FileName` is the absolute delivery URL (Velopack downloads an absolute URL as it is).

## MSIX App Installer

The `.appinstaller` uses the 2021 schema. Its `Uri` is exactly the URL it is served from, because
App Installer re-polls it. App Installer refuses a `Uri` with more than one query pair, so the
route reads at most one: `?arch=x64|arm64` or `?outlet=<id>`. The main package (a `MainBundle`
for a bundle, otherwise a `MainPackage` with its architecture) takes its identity from the
`app-installer` outlet in `.pkey/distribution`:

```yaml
outlets:
  app-installer:
    packageFamilyName: Acme.Game_1a2b3c4d5e6f7 # its <Name> half is the package Name
    publisher: "CN=Acme Corporation, O=Acme Corporation, C=US" # the certificate subject, exactly
    updateSettings:
      hoursBetweenUpdateChecks: 12 # OnLaunch, 0-255 (App Installer's default is 24)
      showPrompt: true
      updateBlocksActivation: false # only with showPrompt: true
      automaticBackgroundTask: true # check every 8 hours in the background
```

The version is the build's four-part build number, or else the release's `major.minor.patch.0`.
An outlet without `publisher` has no file. `ForceUpdateFromAnyVersion` is not offered, because it
permits downgrades. For side-by-side channels, declare a second `app-installer` outlet with its
own package family name and pick it with `?outlet=`.

## AppImage zsync

`<buildId>` is the artifact-map id of a Linux build whose payload is an `.AppImage`, so the URL
stays the same across versions. The body is CI's `<AppImage>.zsync` control file (the
`appimagetool -u` / `zsyncmake` output, uploaded as a `checksum` artifact) for the current
release. Its `URL:` header is rewritten to the AppImage's absolute, Range-capable delivery URL. A
control file whose `Length:` is not the AppImage's size is refused.

## The extended version check

`/update/version` keeps its three fields (`version`, `tag`, `url`) and adds `build`, `sha256`,
`size`, `downloadUrl`, `minOS` and `critical` when the request names `?platform=` (required for
the extended answer), and optionally `?arch=`, `?outlet=` or `?build=`. The answer is the newest
recorded release that the outlet delivers for that platform, with one build of it (the exact arch
before a universal build, or the named build). These fields are documented in the API reference
only. The SDKs read the three v3 fields in `check()` and use the signed feed for everything else.

## Access

The appcasts and the four new feeds are governed by the app's delivery access, as the appcast
always was. The version check is governed by the metadata access mode. A `public` answer is
cached and carries `public, max-age=300` (120 for the version check). Under any other mode the
request must carry a licence the mode admits, and the answer is `private, no-store`. Most native
updaters cannot send one. Every answer has a strong `ETag` and answers `If-None-Match` with 304.
No CORS is added for these routes, because only native updaters read them.
