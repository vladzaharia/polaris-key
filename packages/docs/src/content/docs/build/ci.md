---
title: "Publishing from CI"
description: "pkey release publish and the polaris-key/publish GitHub Action — publishing a release or a content pack from a release job with no secret in the repository, content stamps, dry runs, channel commands and troubleshooting."
sidebar:
  order: 3.7
---

A release job publishes to Polaris Key in one step: `pkey release publish`, or the
`polaris-key/publish` GitHub Action that wraps it. The step exchanges the job's GitHub OIDC token
for a short-lived `pkeyci_` token, matches the built files against your `.pkey/release` artifact
map, hashes them, uploads what Polaris Key does not already hold, and submits a **release
descriptor**. No long-lived secret is stored in your repository.

The step is not a build server. It never exports, signs binaries, notarises or uploads to a store:
your existing export, signing and vendor-tool steps (fastlane, `msstore`, `butler`, `steamcmd`, …)
run first, unchanged, and this step records what they produced. The underlying routes, and the
rules the Worker applies, are on [Artifacts](/docs/services/release/artifacts/#trusted-publishing).

## Before the first publish

1. **Release is on** for the product, and the repository is linked in the console.
2. **`.pkey/release` declares an artifact map** (`deliverables.app.artifacts`): one entry per
   build, each with the `match` glob that names its file. Files are classified only by that map,
   never by sniffing names. See
   [the release manifest](/docs/build/manifest/authoring/#trusted-publishing-publishingtrustedpublisher).
3. **`.pkey/release` names the publisher**, the workflow file and (optionally) the environment:

   ```yaml
   publishing:
     trustedPublisher:
       workflow: .github/workflows/release.yml
       environment: release # the default
   ```

4. **A ruleset protects the ref the job runs on.** Polaris Key accepts the job's token only when
   GitHub reports `ref_protected: true`, which it does only when a branch or tag **ruleset**
   covers the ref. A tag-triggered release needs a tag ruleset over your release tags (for
   example `v*`); a branch-triggered one needs a branch ruleset.
5. **The job runs in that environment** on a **GitHub-hosted** runner, triggered by `push`,
   `release` or `workflow_dispatch`. Give the environment required reviewers if not every writer
   may publish.

## The workflow

```yaml
name: Release
on:
  push:
    tags: ["v*"]

jobs:
  build:
    # … your export and signing jobs, uploading their outputs with actions/upload-artifact …

  publish:
    needs: build
    runs-on: ubuntu-latest
    environment: release
    permissions:
      contents: read
      id-token: write # lets the step request the job's OIDC token
    steps:
      - uses: actions/checkout@v4 # the step reads .pkey/ from the workspace
      - uses: actions/download-artifact@v4
        with:
          path: dist # one subdirectory per artifact; the step searches recursively
      - uses: vladzaharia/polaris-key/actions/publish@<commit-sha>
        with:
          product: your-product
          tag: ${{ github.ref_name }}
          channel: beta
          dir: dist
          release-key: ${{ secrets.PKEY_RELEASE_KEY }} # when .pkey/release declares releaseKeys
```

Until the Action is listed as `polaris-key/publish@v1`, reference it by a full commit SHA of this
repository, as above. It runs on the current Node runtime GitHub supports and needs no install
step.

| Input               | Default               | Meaning                                                                                                                   |
| ------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `product`           | (required)            | The product slug; must equal `.pkey/product`'s.                                                                           |
| `dir`               | (required)            | The built files, searched recursively, relative to the workspace.                                                         |
| `tag`               |                       | The git tag, which is also the release id. It must spell the version (the tag minus a leading `v`).                       |
| `version`           | `tag` without its `v` | The version; must parse under the deliverable's version scheme.                                                           |
| `channel`           |                       | The canonical channel the release is published to: `stable`, `beta`, or one the product declares.                         |
| `deliverable`       | `app`                 | `app`, or a pack id `.pkey/release` declares ([Publishing a pack](#publishing-a-pack)).                                   |
| `source`            | `r2`                  | `r2` uploads the bytes to Polaris Key. `github` uploads nothing and locates every file on the tagged GitHub release.      |
| `meta`              |                       | A JSON file of per-build facts (below).                                                                                   |
| `base-url`          | `https://key.plrs.im` | The Polaris Key origin.                                                                                                   |
| `release-key`       |                       | The release key's PEM (an environment secret). Required when `.pkey/release` declares `releaseKeys`.                      |
| `min-supported-seq` |                       | The record's `minSupportedSeq`: installs below that release on its platforms are prompted (never blocked).                |
| `content-stamp`     |                       | App only, when packs are declared: the `pkey-content.json` the build embedded ([App releases](#app-releases-with-packs)). |
| `embedded`          |                       | App only: compute the content from the pack markers under this directory instead of `content-stamp`.                      |
| `pins`              |                       | App only: `<packId>@<version>` pins for packs the build does not embed, separated by spaces, commas or newlines.          |
| `out`               |                       | Pack only: keep the signed record and payloads at `<out>/<packId>/<version>/` for the next publish's `bases`.             |
| `bases`             |                       | Pack only: the earlier releases `out` kept; the newest ones Polaris Key confirms get deltas.                              |
| `script-extensions` |                       | Pack only (`godot.pck`): extensions the lint refuses as scripts beside `.gd`, `.gdc`, `.cs` (a GDExtension language).     |
| `script-types`      |                       | Pack only (`godot.pck`): that language's script class names (`LuaScript`), refused as markers and as reference types.     |
| `dry-run`           | `false`               | `true` uploads, signs and writes no release ([Dry runs](#dry-runs)); it still requests upload tickets.                    |

The step sets two outputs: `release-id` and `outcome` (`created`, `enriched`, or `unchanged`). A
refusal fails the step with the server's reason as an error annotation.

### Without the Action

The same command runs anywhere Node 20 or later does. The CLI is published to Polaris Key's own
package feeds (see [Install from the feeds](/docs/build/install-from-feeds/)), so a repository
with no `node_modules` (a Godot project) points the `@polaris-key` scope at the npm feed and runs
it with `npx`:

```sh
echo "@polaris-key:registry=https://pkg.plrs.im/npm/polaris-key/" >> ~/.npmrc
npx --yes -p @polaris-key/cli pkey release publish --product your-product \
  --tag "$GITHUB_REF_NAME" --channel beta --dir dist --meta builds.json
```

Pin a version with `-p @polaris-key/cli@<version>`. `npx -p @polaris-key/cli pkey validate` checks
`.pkey/` locally the same way, and `npx -p @polaris-key/cli pkey manifest schemas --out
.pkey/schemas` vendors the manifest JSON Schemas, so an editor's `yaml-language-server: $schema=`
header can point at a local copy.

The [`pkey` image](/docs/build/install-from-feeds/#the-pkey-image),
`pkg.plrs.im/polaris-key/pkey`, carries the same CLI with Node 22 for jobs that run containers:
mount the project at `/work` (`docker run --rm -v "$PWD:/work" pkg.plrs.im/polaris-key/pkey:latest
validate`). To publish from inside it, pass the job's `GITHUB_*` and `ACTIONS_ID_TOKEN_REQUEST_*`
variables through, since the OIDC exchange reads them.

## What the step does

1. **Match.** Every file under `dir` is tested against each artifact-map entry's `match`. An entry
   that matches no file is a warning, and that build is left out of the release (a platform you
   did not build this time). An entry that matches more than one file is an error, as is one file
   matched by two entries. A `<file>.sig` beside a matched file rides along as its `signature`,
   and a `<file>.sha256` as its `checksum`.
2. **Hash.** Each file is hashed with a streamed SHA-256, so a 2 GiB export does not need 2 GiB of
   memory. One uploaded file is at most 5 GiB less 5 MiB (a single upload).
3. **Describe.** The descriptor carries the version, tag, channel, every build and its files with
   their roles, sizes and SHA-256s, and provenance: the commit (`GITHUB_SHA`) and the workflow
   run's URL. It is validated locally with the same function the Worker uses, so a mistake fails
   before anything is sent. Its `seq` is the one the upload ticket answers for the release (the
   stored one on a re-run, so a re-run is still the same descriptor).
4. **Upload.** The step asks for an upload ticket, which says which files the product already
   holds; only the others are uploaded, each as one PUT carrying its SHA-256, which the blob store
   checks on arrival.
5. **Sign.** With a release key, the descriptor is moved into a release record
   (`pkey-release+jws`: the same fields, minus file locations), signed with the key under the
   `.pkey/release` `releaseKeys` entry whose public key matches, and checked with the claims every
   v4 SDK runs. The key is never printed or sent. A product that declares `releaseKeys` and runs
   without the key fails here (pass `--no-record` to publish an unsigned release on purpose).
6. **Submit.** The Worker verifies every uploaded object, checks the descriptor against your
   declaration and the record against the descriptor and your declared keys
   (`release_record_rejected` with a reason otherwise), and only then writes the release. Only
   releases with a record appear in the [signed feed](/docs/services/update/signed-feed/).

**The release key.** `pkey release keys generate --kid ci-2026 --out release-key.pem` writes a new
key and prints the `releaseKeys` entry for `.pkey/release`; store the file's contents as the
publishing environment's secret `PKEY_RELEASE_KEY` and delete the file. Apps pin the same public
key. See [Release keys](/docs/build/manifest/authoring/#release-keys-releasekeys).

**Build metadata.** For an `ios` build whose format is `ipa`, and an `android` build whose
format is `apk`, the step reads the facts the
[storefront feeds](/docs/services/distribution/feeds/#build-metadata) need from inside the
payload and records them in the descriptor:

- from an IPA: the bundle id, the versions, the minimum OS, the entitlements and the privacy
  strings;
- from an APK: the package, the version code and name, the SDK levels, the ABIs and the signer.

If a payload cannot be read, the step prints a warning and the build is published without
metadata.

**`meta`** supplies what a file cannot: per build id, a `buildNumber` (a string, or a whole number
written as one), a `minOS`, and a `requires` object. An unknown build id or field is an error,
because it is almost always a typo.

```json
{
  "android": { "buildNumber": 130, "minOS": "8.0" },
  "ios": { "buildNumber": "130", "minOS": "16.0" }
}
```

**Re-running is safe.** Publishing the same release again is a no-op (`outcome: unchanged`): the
same descriptor is recognised and nothing is uploaded or written. A different descriptor for a
release that already exists is refused `release_exists`. Re-running a failed job keeps its run
URL, so it describes the same release; publishing one tag from a second workflow run does not.

### Dry runs

`dry-run: true` (or `--dry-run`) does everything except upload and write a release: it prints the
descriptor, validates it locally, asks for a ticket and submits it with `dryRun: true`, then prints
the server's verdict, such as "would be created as v0.3.0". Files that are not uploaded yet are
judged as if they were. Without any CI credential (on a laptop), it stops after the local
validation and says so.

A dry run is not free of side effects on Polaris Key: it **mints upload tickets**, one for the
app's files and, for a pack, one per 256 objects. Each ticket is a short-lived row (with
temporary upload credentials) that is never redeemed by a dry run and expires within the hour,
with the CI token at the latest. A pack dry run asks for no server verdict (see
[Publishing a pack](#publishing-a-pack)).

### `source: github`

With `source: github` nothing is uploaded: every file is located as an asset of the tagged GitHub
release. That release must be an **immutable release**, and Polaris Key checks that each asset's
GitHub digest and size match the descriptor. Use it when GitHub releases already carry your files.

## Publishing a pack

A content pack ([Packs](/docs/services/release/packs/)) is published by the same step with
`deliverable: <packId>` (or `--deliverable <packId>`). A pack release is one **signed release
record** (`kind: pack`), so the step needs `release-key`, and the zstd CLI 1.5.5 or later on the
runner (GitHub's hosted runners carry it; the Action installs it with `apt-get` when it is
missing on Linux).

```yaml
- uses: actions/cache@v4
  with:
    path: pack-cache
    key: pkey-pack-diceroll.core3d-${{ github.run_id }}
    restore-keys: pkey-pack-diceroll.core3d-
- uses: vladzaharia/polaris-key/actions/publish@<commit-sha>
  with:
    product: diceroll
    deliverable: diceroll.core3d
    version: 1.4.0
    dir: packs/diceroll.core3d # <variant key or "default">/ per variant
    out: pack-cache
    bases: pack-cache
    release-key: ${{ secrets.PKEY_RELEASE_KEY }}
```

**Where the payloads are.** Each variant the pack declares has its payload at
`<dir>/<variant key>/`, or `<dir>/default/` for a pack without variants: for `godot.pck` the one
`.pck` file there (your `--export-pack` output), for `files.tree` the directory itself. The
variant key is the variant's `axis=value` pairs sorted by axis and joined with `;`, for example
`texture=s3tc` or `locale=fr;texture=astc`.

What the step does, in order:

1. **Check, strip and lint.** A `godot.pck` must be a PCK v2–v4 with no encrypted directory, no
   sparse bundle and no encrypted or patch entry. The step removes the two files `--export-pack`
   always adds, `project.binary` and `.godot/global_script_class_cache.cfg` (mounted, they replace
   the game's own copies), keeping the PCK's header, and then admits only: entries under the
   pack's `handler.prefixes` with their `.remap` and `.import` files, the `.godot/exported/` and
   `.godot/imported/` files those name, and `.godot/uid_cache.bin`. Scripts (`.gd`, `.gdc`, `.cs`,
   a `.remap` of one), native libraries, GDExtensions and anything outside the prefixes fail with
   their path: a pack carries data only. So does a resource that may carry a script, judged by content with rules
   that fail closed: any entry whose bytes start `RSRC` (a binary resource under any extension)
   and any text scene or resource (`.tscn`, `.tres`, `.escn`, or a `[gd_scene`/`[gd_resource`
   head) that names `GDScript`, `CSharpScript`, `ScriptExtension`, `script/source` or
   `source_code` anywhere; a text resource with a NUL byte, invalid UTF-8 or a `\u` escape; and a
   compressed `RSCC` resource that cannot be decompressed within the bounds below, or whose body
   fails the binary rule. A `.remap` or `.import` whose `path` lines
   are not plain `path[.<x>] = "res://…"` literals fails too, and so does one with a backslash or a
   control byte anywhere: an escaped quote in a node name under `_subresources` is enough, so
   rename that node in the source asset and re-import. Godot writes an imported 3D scene
   (`.glb`, `.gltf`, `.blend`, `.fbx`) as a compressed `.scn` (`RSCC`). The lint and the device
   decompress it and scan the body like any binary resource, so packs that carry imported models
   are admitted. The decompression is bounded: zstd only (Godot's default; another compression
   mode fails), at most 64 MiB uncompressed per resource and 512 MiB across a pack's compressed
   resources, blocks of 4 KiB to 1 MiB, each block one zstd frame (as Godot writes them) that
   decodes to exactly its declared size, and nothing after the closing magic. A model that needs
   more than 64 MiB uncompressed (a 980,000-triangle mesh imports to about 59 MB) fails, and so
   does the compressed resource that takes a pack past 512 MiB; split the model or the pack.
   Every resource's references outside the pack are checked too: a reference to a script the game
   already ships (`[ext_resource type="Script" …]`, or a binary resource's external entry) fails
   unless `.pkey/release` lists it in `deliverables.app.content.attachable` (exactly, or under a
   listed `res://…/` directory), and so does a `uid://` reference the pack's own uid cache does
   not register unless the UID is listed. A reference the check cannot read the way the engine
   would (an `ext_resource` tag that is not one plain line, an inline `Resource("…")`, a relative
   or non-normal path, a non-canonical UID) fails, and so does a resource that sets
   `resource_path`. The device runs the same check with its `PKeyOptions.pack_attachable`, so
   keep the two lists equal. The device can also resolve an app UID and read an app resource's
   real type; the lint cannot, so it refuses every UID outside the pack's cache that is not
   listed. Godot 4.4+ writes a UID on every reference, so list the UIDs of the app resources
   your packs reference (a shared texture or scene) as well as the scripts; the device admits
   those UIDs without the list. The lint knows `.gd`, `.gdc` and
   `.cs` and the built-in script types; for another script language (a GDExtension) pass
   `script-extensions` and `script-types` (CLI: `--script-extensions`, `--script-types`) so CI
   refuses what the device, which asks its engine, refuses. The header's engine must be `requires.engine`; more than
   1,000 entries warns and more than 20,000 fails, because mounting stalls longer with the entry
   count. A `files.tree` must keep the [path rules](/docs/build/wire/packs/#path-rules) and hold no symbolic links.
2. **Build the objects.** A `full` object (the whole payload, one zstd frame), the `pkey-files/1`
   index with a blob per file, the gaps object of a PCK (every byte no entry covers), and against
   each delta base a whole-payload `zstd --patch-from` delta and a packed per-file delta set. Every
   object is stored raw when compressing does not make it smaller. The step proves the index and
   the gaps rebuild the payload byte for byte, and that every delta decodes to its target, before
   anything is sent; an index above 8 MiB is refused.
3. **Ask first.** Before uploading anything, the step asks Polaris Key for the release's `seq`,
   the pack's **delivery gate** and the record hashes of the cached releases. If `.pkey/release`
   asserts an `entitlement` the gate does not have, it stops: an operator gates a pack under
   Distribution → Access first. Otherwise every object is uploaded under the gate and the gate is
   signed into the record.
4. **Delta bases** come from your own cache: `out` keeps each release's record and payloads, and
   `bases` reads them back. A cached release counts only when its record's SHA-256 is the one
   Polaris Key stores and its payload matches that record, and `patch.deltaBases` (default 1) of
   the newest such releases get deltas. A missing cache only means bigger downloads for that
   release, never a failed publish. The step lists entries that look like re-import noise (a Godot
   cache rewritten in another order, a few changed bytes) as warnings.
5. **Chunk indexes.** A PCK variant of 4 MiB or more also gets a chunk index and chunk bundles
   ([Chunk indexes and shared bundles](/docs/services/release/packs/#chunk-indexes-and-shared-bundles))
   when `patch.strategies` lists `chunk` (the default) and Polaris Key advertises
   `release.chunks`. `out` keeps each index (`<variant>/chunks.<sha256>`) and `bases` continues
   its chain, so an update uploads only the bundles of the chunks that changed; a bundle Polaris
   Key no longer holds is packed again. The step proves every new chunk decodes to its bytes with
   the device decoder and the index parses against the payload; an index above 8 MiB is left out
   with a warning.
6. **Upload and submit.** Objects go up in rounds of at most 256, each object only when the
   product does not hold it yet, so an unchanged file costs nothing; then the record is submitted.
7. **Write the marker.** The stripped PCK is written back in place, and a marker
   (`pkey-marker/1`, the signed record) is written beside each payload: `X.pck.pkey.json` beside
   a PCK, `D/.pkey/pack.json` inside a tree. Embed both in the app export.

`dry-run: true` prints the lint results, the strip, the gate, the objects (new and already
stored), the bytes each update strategy costs, the chunks (with the new bundles and the bytes
reused from earlier bundles), skipped deltas and the unsigned record, and
uploads, signs and writes nothing. It submits nothing either, so there is no server verdict on
the record: the checks it shows are the CLI's own, the preflight's (seq, gate, cached bases) and
the tickets' `present` answers, for which it mints one upload ticket per 256 objects (rows that
expire within the hour). A published pack version is never rewritten: publish a new
version.

Store builds take packs through the store's own transport (Background Assets, Play Asset
Delivery, Steam depots): after the publish, a `transport` step packages the cached release for
it. See [Platform pack transports](/docs/build/pack-transports/).

## App releases with packs

When `.pkey/release` declares packs, every app release states which pack releases it pins. The
build learns them from a **content stamp** (`pkey-content.json`) it embeds, so write the stamp
before the export:

```sh
node pkey.mjs release content-stamp --product diceroll --out pkey-content.json \
  --embedded packs --pin diceroll.l10n@2.0.1
```

The stamp's pins come from the markers under `--embedded` (each verified against your
`releaseKeys`, and refused when the payload beside it is not one of the record's variants) and
from `--pin <packId>@<version>` for packs the build does not embed, which Polaris Key resolves to
the stored record. `contentApi` comes from `deliverables.app.content`, and each pin's `required`
and `delivery` from the pack's declaration. Every `required` and every `baseline: embedded` pack
must be pinned. Then publish the app with the same stamp:

```yaml
- uses: vladzaharia/polaris-key/actions/publish@<commit-sha>
  with:
    product: diceroll
    tag: ${{ github.ref_name }}
    dir: dist
    content-stamp: pkey-content.json
    release-key: ${{ secrets.PKEY_RELEASE_KEY }}
```

The stamp becomes the release descriptor's `content`, and each build's `embeds` comes from the
artifact map (`artifacts[].embeds`, or every `baseline: embedded` pack when omitted); the signed
record is moved from that descriptor, so it carries both. `embedded` and `pins` compute the same
content inside the publish instead, for a build that embeds no stamp. Polaris Key must advertise
`release.packs` in its discovery document, or the step refuses to stamp or publish a pack.

## Channel commands

The same credential drives channel policy from CI:

```sh
pkey release promote v0.3.0 --channel stable --product your-product
pkey release pin v0.3.0 --channel beta --product your-product
pkey release unpin --channel beta --product your-product
pkey release yank v0.3.0 --reason "crashes on launch" --product your-product
```

Promote, pin and unpin need the `release:promote` scope, which the default grant includes. Yank
needs `release:yank`, which an operator adds to the product's publisher policy in the console.
`--deliverable` selects a pack's channel pointers.

`pkey feeds prune --product your-product` is the package feeds' retention backfill. For each
package, it deletes the builds of main below the package's newest stable release. It is a dry
run that prints what would go, with counts and bytes, unless you pass `--apply`. With `--apply`
it lists any version it skipped (a channel took hold of it since the plan, so it was kept) and
exits non-zero if any version failed. It needs `release:yank` as well. Once the product turned
retention on (it is off by default), a stable publish runs the same prune for its own package; see
[Install from the feeds](/docs/build/install-from-feeds/#builds-of-main-are-pruned-once-released).

## Distribution commands

The same credential reports what a store says and drives outlet rollouts:

```sh
pkey distribution report availability --product your-product --outlet app-store \
  --release v0.3.0 --build ios --state in-review
pkey distribution report submission --product your-product --outlet app-store \
  --release v0.3.0 --state submitted
pkey distribution report key --product your-product --purpose android-app-signing \
  --sha256 "$SIGNING_CERT_SHA256"
pkey distribution rollout --product your-product --outlet direct --channel stable \
  --release v0.3.0 --bp 2500
pkey distribution halt --product your-product --outlet direct --channel stable   # also resume, pause, complete
```

The reports need `distribution:report`, which the default grant includes; a key report whose
fingerprint is not in the product's key inventory is flagged and exits 1. See
[Availability, submissions and keys](/docs/services/distribution/availability/). The rollout
commands need `distribution:rollout`, which an operator adds deliberately; see
[Rollouts and halts](/docs/services/distribution/rollouts/).

## Storefront feeds

The AltStore, Obtainium, Scoop and Flathub feeds need nothing from CI beyond the publish: the
Worker renders them from the release. The F-Droid repository is the exception, because it is
signed with a repo key the Worker never holds:

```yaml
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
[Storefront feeds](/docs/services/distribution/feeds/#the-f-droid-repository).

## Listing assets

`pkey listing assets` makes every store's listing art from three images a person draws: a square
icon master (1024×1024 is best), key art with no logo on it, and the wordmark on transparency.
Export them in sRGB: an image with another embedded colour profile is converted first, and that
conversion is not guaranteed to give identical bytes on every machine. It needs the `sharp` image
library beside `pkey` (`npm install sharp`):

```yaml
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
product's [shared listing](/docs/admin/storefront-listing/). It needs `distribution:listing`,
which an operator adds deliberately. Only `ok` and `warn` outputs go up: a red output (an icon-only
fallback, a title slot with no wordmark, a file over the store's size limit) stays in `--out` and is
listed as not uploaded, as are `human` and `missing` slots and pending proposals. It never pushes
anything to a store, and it never replaces an image an operator uploaded in the console. Rerunning with the same `--out` replaces only the files
the last run wrote.

## Storefront steps (itch.io and Snap)

itch.io and the Snap Store take builds only through their own CLIs, `butler` and `snapcraft`,
whose credentials stay in CI and never reach Polaris Key. The Action runs them for you with the
`storefront` input, and only as commands the store's **CI allow-list** admits. Each step is
reported to Polaris Key before and after it runs, so the store's ledger shows CI steps beside the
console's.

```yaml
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
  `target` is the outlet's `user/game`; a snap is released only to the snap channels its outlet's
  `channels` map declares for `channel` (see
  [Distribution manifest](/docs/build/manifest/distribution/)). A step for an undeclared game or
  channel is refused before the tool starts, and again by Polaris Key.
- **`storefront-outlet` picks the outlet** when `.pkey/distribution` declares more than one of the
  store's kind (two itch.io games, say): set it to the outlet's id. With one outlet of that kind,
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

  ```sh
  snapcraft export-login --snaps your-snap --channels stable,beta \
    --acls package_push,package_release --expires 2027-01-01 snap-credentials.txt
  ```

  Never grant `package_manage` (collaborators) or `package_upload`; the allow-list never runs
  `close`, `release`, `promote` or a collaborator command.

### Other store tools

`pkey storefront exec` runs any other allow-listed command, with its arguments after `--`, and
reports it the same way (`pkey storefront allow-list` prints every list):

```sh
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

```yaml
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
  and `scoopBucket` (`<owner>/<repo>`) on the `direct` outlet, `packageIdentifier` on the `winget`
  outlet and `appId` on the `flathub` outlet (see
  [Distribution manifest](/docs/build/manifest/distribution/)). A tap or bucket of the `Homebrew` or
  `ScoopInstaller` organisation is refused: the official `homebrew/cask` has its own rules and
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
  in the pull request yourself for now.
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

## Other CI systems

Outside GitHub Actions there is no OIDC token to exchange. An operator issues a **static**
`pkeyci_` token for the product in the console (shown once, expiring at most 90 days out); the CI
stores it as a secret and exports it as `PKEY_CI_TOKEN`. When `PKEY_CI_TOKEN` is set, the commands
use it instead of exchanging. `pkey auth github-oidc --product <slug>` performs the exchange
explicitly and exports `PKEY_CI_TOKEN` to the job's later steps, for a workflow that calls `pkey`
several times.

Every token, ticket and temporary upload credential is masked in the job log, and none is ever
printed.

## Troubleshooting

A refused step prints the HTTP status, the server's machine-readable `reason`, its message, and
any detail the reason carries.

| Reason                                            | What it means and what to do                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `policy_mismatch`                                 | The job's token does not satisfy the publisher policy; `failing claim` names the check. `ref_protected`: no ruleset covers the ref. `environment`: the job does not run in the declared environment. `job_workflow_ref`: the workflow file is not the declared one. `runner_environment`: a self-hosted runner. `event_name`: another trigger. |
| `publisher_not_configured`                        | The product has no publisher policy. Add `publishing.trustedPublisher` to `.pkey/release` and resync, or have an operator configure it.                                                                                                                                                                                                        |
| `invalid_oidc_token`                              | The token's signature, issuer, audience or lifetime was refused. The step requests the right audience itself; check `base-url`.                                                                                                                                                                                                                |
| `oidc_token_replayed`                             | An OIDC token can be exchanged once. Another step reused it.                                                                                                                                                                                                                                                                                   |
| `rate_limited`                                    | Too many exchanges. The step backs off and retries; if it still fails, wait a minute and re-run.                                                                                                                                                                                                                                               |
| `missing_scope`                                   | The CI token lacks the operation's scope (`release:yank` is opt-in). An operator grants scopes.                                                                                                                                                                                                                                                |
| `invalid_descriptor`                              | The descriptor does not fit the schema or your declaration; each finding is printed with its path and code.                                                                                                                                                                                                                                    |
| `release_exists`                                  | The release already exists from a different descriptor. If the refusal says it is retryable (another writer won a race), the step resends it on its own.                                                                                                                                                                                       |
| `staged_object_missing`, `staged_object_mismatch` | An upload did not arrive, or arrived with other bytes. Re-run the job; if it recurs, check that nothing rewrites the files between the build and this step.                                                                                                                                                                                    |
| `ticket_expired`, `ticket_redeemed`               | The ticket outlived its token (30 minutes for an OIDC token) or was already used. Re-run the step; it requests a fresh ticket.                                                                                                                                                                                                                 |
| `gated_mismatch`, `distribution_disabled`         | A pack's objects were requested under another delivery gate than the pack's, or Distribution is off for the product. Re-run the step; it asks for the gate first.                                                                                                                                                                              |
| `promote_failed`                                  | A transient failure moving an upload into the blob store. The step retries it automatically.                                                                                                                                                                                                                                                   |
| 404 on the uploads call                           | The blob store is not configured on this Polaris Key, or Release is off for the product.                                                                                                                                                                                                                                                       |

Every refusal fails the job, so a release that did not land never looks as if it did.
