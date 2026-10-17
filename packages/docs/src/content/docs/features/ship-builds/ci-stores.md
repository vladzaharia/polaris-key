---
title: "Publish to stores from CI"
description: "Build store feeds, derive listing assets, push to itch.io and Snap, and open pull requests for winget, Homebrew, Scoop and Flathub from a release job."
type: "reference"
lastReviewed: "2026-10-16"
sidebar:
  order: 3.8
---

Store and package-manager steps run in the same release job as [Publishing from CI](/docs/features/ship-builds/ci/): they use the same `pkeyci_` token exchange and the `polaris-key/publish` action.

## Storefront feeds

The AltStore, Obtainium, Scoop and Flathub feeds need nothing from CI beyond the publish: the
Worker renders them from the release. The F-Droid repository is the exception, because it is
signed with a repo key the Worker never holds:

```yaml title=".github/workflows/release.yml"
- run:
    node pkey.mjs feeds fdroid --product your-product --channel stable --out fdroid
    --keystore fdroid.keystore --alias repo
  env:
    PKEY_FDROID_KS_PASS: ${{ secrets.FDROID_KS_PASS }}
```

The command builds `index-v2.json`, `entry.json` and a diff from the channel's releases, signs
`entry.jar` with `apksigner` (from `$ANDROID_HOME/build-tools`, or `--apksigner`), checks the
signer against the `fdroid-repo` key in the product's key inventory, then uploads and registers
the files. It needs `distribution:feeds`, which an operator adds deliberately. Without
`--keystore` it writes the unsigned files and stops. `--out` must be a directory of its own: the
command replaces only the files it writes there, and refuses the working directory, a parent of
it, or a directory that holds anything else (keep the keystore and the APKs outside it). See
[Storefront feeds](/docs/features/ship-builds/channels/feeds/#the-f-droid-repository).

## Listing assets

`pkey listing assets` makes every store's listing art from three images a person draws: a square
icon master (1024×1024 is best), key art with no logo on it, and the wordmark on transparency.
Export them in sRGB: an image with another embedded color profile is converted first, and that
conversion is not guaranteed to give identical bytes on every device. It needs the `sharp` image
library beside `pkey` (`npm install sharp`):

```yaml title=".github/workflows/release.yml"
- run: |
    npm install sharp
    node pkey.mjs listing assets --out listing --icon art/icon.png --key-art art/key-art.png \
      --key-art-portrait art/key-art-portrait.png --wordmark art/wordmark.png --focal 0.4,0.35 \
      --screenshots art/screenshots --accept play/phone-portrait/01-menu \
      --upload --product your-product
```

- **Icons** are derived from the master: Google Play 512, the Microsoft tile 300, Steam's 184 JPG
  and 256 icons, and Flathub, Snap, winget and F-Droid. Android's adaptive layers are derived only
  when the mark sits inside the central 66 of 108 dp (about 61 %); otherwise the report marks them
  `human`, for you to draw.
- **Store art** is composed: the key art is cropped to each slot's shape around `--focal` (x,y as
  fractions), and the wordmark is placed only on slots that allow a title. The Steam library hero,
  the page background and the Microsoft super hero never get text. With no key art, every slot
  gets an icon-only fallback marked red. A title slot with no wordmark is marked red too.
- **Screenshots** sit under `--screenshots`, one directory per size class (`phone-portrait`,
  `tablet`, `desktop-16x9`, `desktop-16x10`, `tv`, `wear`, `xr`). Each is checked for the App
  Store, Google Play, the Microsoft Store and Steam. One that does not fit gets a crop or pad
  proposal: an iPhone 6.9″ shot is over Play's 2:1, and a Mac 16:10 shot is not Steam's 16:9. The
  proposal is previewed under `--out/proposals/` and used only for the images you name with
  `--accept <store>/<class>/<name>` (the crop) or `--pad <store>/<class>/<name>`.

Everything lands under `--out`: one directory per store, `report.json` (every slot's status, size,
alpha, format and digest), `preview.html` to look at, and a ZIP per store under `packs/` (Steam has
no listing API, so its pack is what you upload by hand). `--upload` stores the images in the
product's [shared listing](/docs/features/ship-builds/channels/polaris-key/). It needs `distribution:listing`,
which an operator adds deliberately. Only `ok` and `warn` outputs go up: a red output (an icon-only
fallback, a title slot with no wordmark, a file over the store's size limit) stays in `--out` and is
listed as not uploaded, as are `human` and `missing` slots and pending proposals. It never pushes
anything to a store, and it never replaces an image an operator uploaded in the console. Rerunning with the same `--out` replaces only the files
the last run wrote.

## Hosted assets

Some art is not on the web: an icon made for the store, screenshots CI captures. `pkey assets push`
and the Action's `assets` input send such files to Polaris Key, which hosts a copy and serves it
from its image host, exactly like the files a manifest names (`.pkey/product`
`presentation.icon`, the `.pkey/distribution` listing's `icon`, `header` and `screenshots`).

```yaml title=".github/workflows/release.yml"
- uses: vladzaharia/polaris-key/actions/publish@<sha>
  with:
    product: diceroll
    assets: |
      art/icon.png: presentation.icon
      # numbered 1, 2, 3, … in path order
      art/screens/*.png: listing.screenshot
      art/play-feature.png: play:feature-graphic@de-DE
```

Each line is `<glob>: <slot>[@<locale>]`. A slot is `presentation.icon`, `listing.icon`,
`listing.header`, `listing.screenshot:<1-16>` or a store slot of the
[shared listing](/docs/features/ship-builds/channels/polaris-key/) (`icon-master`, `play:feature-graphic`, …).
Every glob must match exactly one file, except for the unnumbered `listing.screenshot`, whose
matches become screenshots 1 to n. Globs resolve against `dir` when it is set, else the workspace.
From a shell, one file at a time:

```sh title="Terminal"
pkey assets push art/icon.png --slot presentation.icon --product diceroll
```

- **Files.** PNG, JPEG, WebP, GIF or AVIF, decided from the file's first bytes (never SVG); up to
  10 MiB for icon slots and 20 MiB for the rest. A refused file fails the step and changes
  nothing.
- **Who wins a slot.** An upload in the console, then the manifest, then CI. A slot an operator
  uploaded, or one the manifest names, is reported as kept and left as it is; that is not a
  failure. See [Presentation](/docs/operate/console/presentation/).
- **Credentials.** The token needs `assets:write`, which an operator adds deliberately (it is not
  a default scope). The files go up through the same upload ticket as a release, so Release must
  be on for the product.

## Storefront steps (itch.io and Snap)

itch.io and the Snap Store take builds only through their own CLIs, `butler` and `snapcraft`,
whose credentials stay in CI and never reach Polaris Key. The Action runs them for you with the
`storefront` input, and only as commands the store's **CI allow-list** admits. Each step is
reported to Polaris Key before and after it runs, so the store's ledger shows CI steps beside the
console's.

```yaml title=".github/workflows/release.yml"
jobs:
  itch:
    runs-on: ubuntu-latest
    environment: itch # holds BUTLER_API_KEY; add required reviewers for production
    permissions: { id-token: write, contents: read }
    steps:
      - uses: actions/checkout@v4
      # … export the Linux build into build/linux, install butler …
      - uses: vladzaharia/polaris-key/actions/publish@<sha>
        with:
          product: your-product
          storefront: itch-push
          itch-platform: linux # windows, linux, mac or android
          dir: build/linux
          version: ${{ github.ref_name }}
          channel: beta # stable pushes to "linux"; beta pushes to "linux-beta"
        env:
          BUTLER_API_KEY: ${{ secrets.BUTLER_API_KEY }}

  snap:
    runs-on: ubuntu-latest
    environment: snap # holds SNAPCRAFT_STORE_CREDENTIALS
    permissions: { id-token: write, contents: read }
    steps:
      - uses: actions/checkout@v4
      - uses: vladzaharia/polaris-key/actions/publish@<sha>
        with: { product: your-product, storefront: snap-metadata, dir: . }
      # … snapcraft pack into dist/ …
      - uses: vladzaharia/polaris-key/actions/publish@<sha>
        with:
          {
            product: your-product,
            storefront: snap-upload,
            dir: dist,
            channel: beta,
          }
        env:
          SNAPCRAFT_STORE_CREDENTIALS: ${{ secrets.SNAPCRAFT_STORE_CREDENTIALS }}
      - uses: vladzaharia/polaris-key/actions/publish@<sha>
        with:
          { product: your-product, storefront: snap-upload-metadata, dir: dist }
        env:
          SNAPCRAFT_STORE_CREDENTIALS: ${{ secrets.SNAPCRAFT_STORE_CREDENTIALS }}
```

| `storefront`           | Runs                                                                                    |
| ---------------------- | --------------------------------------------------------------------------------------- |
| `itch-push`            | `butler push <dir> <target>:<itch-platform[-channel]> --userversion <version>`          |
| `snap-metadata`        | Writes the listing model's Snap summary and description into `snapcraft.yaml`           |
| `snap-upload`          | `snapcraft upload <snap> --release=<snap channels>`                                     |
| `snap-upload-metadata` | `snapcraft upload-metadata <snap>` (the summary, description and icon the snap carries) |

- **The target and channels come from `.pkey/distribution`, never from the workflow.** itch's
  `target` is the distribution channel's `user/game`; a snap is released only to the snap channels its distribution channel's
  `channels` map declares for `channel` (see
  [Distribution manifest](/docs/build/manifest/distribution/)). A step for an undeclared game or
  channel is refused before the tool starts, and again by Polaris Key.
- **`storefront-outlet` picks the distribution channel** when `.pkey/distribution` declares more than one of the
  store's kind (two itch.io games, say): set it to the distribution channel's id. With one distribution channel of that kind,
  leave it unset.
- **itch.io channel names tag platforms.** The channel starts with the platform word (`windows`,
  `linux`, `mac`, `android`); a release channel other than `stable` suffixes it (`windows-beta`),
  so each keeps its own file on the page. Uploads have no review: a pushed channel is live.
- **`snap-metadata` runs before the snap is built**, because `upload-metadata` reads the text
  from the snap itself. It needs a listing in the console (the Listing editor); a missing summary
  or a value over the Snap Store's limit stops the step with the field named. Title, screenshots
  and banner stay in the Snap Store dashboard.
- **A step already done in this run is skipped**, so re-running a failed job does not push twice.
  `dry-run: true` checks and prints the command lines and runs nothing.

### Credentials

Keep each store's credential in its own GitHub environment, with required reviewers for the jobs
that release to production channels:

- **itch.io:** `BUTLER_API_KEY` from your itch.io account's API keys. It is **unscoped**: it can
  push to every game of the account, which is why the environment and its reviewers matter.
- **Snap Store:** a scoped, expiring login, stored as `SNAPCRAFT_STORE_CREDENTIALS`:

  ```sh title="Terminal"
  snapcraft export-login --snaps your-snap --channels stable,beta \
    --acls package_push,package_release \
      --expires 2027-01-01 snap-credentials.txt
  ```

  Never grant `package_manage` (collaborators) or `package_upload`; the allow-list never runs
  `close`, `release`, `promote` or a collaborator command.

### Other store tools

`pkey storefront exec` runs any other allow-listed command, with its arguments after `--`, and
reports it the same way (`pkey storefront allow-list` prints every list):

```sh title="Terminal"
node pkey.mjs storefront exec steam run-app-build --op uploadBuild -- \
  +login "$STEAM_BUILDER" +run_app_build build/app_480.vdf +quit
node pkey.mjs storefront exec msstore publish --op uploadBuild -- \
  publish build/Dice.msixupload --appId 9NBLGGH4R315
```

A Steam build script may set a build live only on a named branch, never `default` or `public`.
`msstore publish` is refused while the console has a Microsoft Store draft staged for the product.
Epic's `BuildPatchTool` may only `-mode=UploadBinary`, with its secret passed by
`-ClientSecretEnvVar`.

## Pull-request steps (winget, Homebrew, Scoop and Flathub)

winget, your own Homebrew tap, your own Scoop bucket and Flathub are written through files in a
GitHub repository. `pkey storefront <store> pr` generates the store's manifest for the channel's
newest release, from the release and the listing model, and opens a pull request with a GitHub
token from CI; `pkey storefront <store> status` reads the pull request back. Both are reported to
Polaris Key, so the store's ledger shows each PR with its state and review labels.

```yaml title=".github/workflows/release.yml"
jobs:
  packages:
    runs-on: ubuntu-latest
    environment: package-managers # holds PKEY_PR_TOKEN
    permissions: { id-token: write, contents: read }
    steps:
      - uses: actions/checkout@v4
      - run: |
          node pkey.mjs storefront homebrew pr --channel stable
          node pkey.mjs storefront scoop pr --channel stable
          node pkey.mjs storefront winget pr --channel stable \
            --portable Dice/dice.exe --command dice
        env:
          PKEY_PR_TOKEN: ${{ secrets.PKEY_PR_TOKEN }}
```

| Store      | Repository                           | What the pull request writes                                                                                                                     |
| ---------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `winget`   | `microsoft/winget-pkgs`, from a fork | The version's manifests at schema 1.12.0: version, installer (the release's HTTPS download URLs), default locale and one file per further locale |
| `homebrew` | `direct.homebrewTap`                 | `Casks/<homebrewCask>.rb`: version, sha256, url, name, desc, homepage, livecheck, auto_updates, app                                              |
| `scoop`    | `direct.scoopBucket`                 | `bucket/<app>.json`: the Scoop feed's manifest, with `checkver` and `autoupdate` pointing at the feed                                            |
| `flathub`  | `flathub/<appId>`                    | The app repository's manifest with each `extra-data` source moved to the new build, and the MetaInfo                                             |

- **The repositories come from `.pkey/distribution`.** Set `homebrewTap` (`<owner>/homebrew-<name>`)
  and `scoopBucket` (`<owner>/<repo>`) on the `direct` distribution channel, `packageIdentifier` on the `winget`
  distribution channel and `appId` on the `flathub` distribution channel (see
  [Distribution manifest](/docs/build/manifest/distribution/)). A tap or bucket of the `Homebrew` or
  `ScoopInstaller` organization is refused: the official `homebrew/cask` has its own rules and
  needs you, by hand.
- **One pull request per version.** If a pull request for the package and version is already open
  or merged, the step records it and opens nothing; re-running a job never opens a second one.
- **Every winget version is reviewed.** Microsoft's pipeline validates the manifests and then a
  moderator reviews them, so the console shows the pull request and its labels
  (`Needs-Author-Feedback`, `Validation-…`), never a date. A `.zip` build needs `--portable`, the
  executable inside the archive; `--license` sets the `License` field (default `Proprietary`).
- **The listing model fills the text.** winget's locale files and Flathub's MetaInfo come from the
  Listing editor; a missing required field or one over the store's limit stops the step with the
  field named.
- **MetaInfo screenshots come only from Polaris's image host.** A MetaInfo never names your own
  screenshot URLs or a download blob. Until hosted copies of your listing images are served, the
  MetaInfo has no `<screenshots>` and the step warns; Flathub requires at least one, so add them
  in the pull request yourself.
- **The Scoop manifest's `autoupdate`**: Polaris-hosted builds have content-addressed URLs with
  no version in them, so `checkver` captures each architecture's SHA-256 from the feed and
  `autoupdate` builds the URL from it; the bucket's Excavator can follow the feed between pull
  requests.
- **The Homebrew cask's `livecheck`** reads the public download page's model, so it follows the
  stable channel. `--app` names the `.app` bundle in the disk image (default `<name>.app`).
- **Flathub's first submission is yours.** `pkey storefront flathub init --out flathub` writes the
  manifest skeleton (its `extra-data` sources carry `x-checker-data` for Flathub's external-data
  checker) on the current Freedesktop runtime (`25.08`; `--runtime-version` picks another branch,
  since Flathub refuses an end-of-life one), the MetaInfo and a desktop entry; add the icon, then open the pull request to
  `flathub/flathub` against `new-pr` and see it through review. After that, the checker or
  `pkey storefront flathub pr` opens the update pull requests.
- **`--dry-run`** prints the plan; with `--out <dir>` it also writes the generated files there.
  It needs no GitHub token (Flathub's manifest update is then shown as the MetaInfo only).

### The GitHub token

`PKEY_PR_TOKEN` is a CI environment secret and never reaches Polaris Key:

- **Tap and bucket:** a fine-grained token limited to those two repositories, with
  `Contents: Read and write` and `Pull requests: Read and write`.
- **winget:** a fine-grained token if it can open the pull request; otherwise a classic token with
  `public_repo`. A classic token reaches every public repository the account can write, so keep it
  in its own environment with required reviewers.
- **Flathub:** the maintainer's token, with write access to `flathub/<appId>` (an account with
  two-factor authentication, invited to the app repository).

The step never merges, closes or deletes anything, and never force-pushes.
