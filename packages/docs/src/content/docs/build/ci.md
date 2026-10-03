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
| `dry-run`           | `false`               | `true` uploads, signs and writes no release ([Dry runs](#dry-runs)); it still requests upload tickets.                    |

The step sets two outputs: `release-id` and `outcome` (`created`, `enriched`, or `unchanged`). A
refusal fails the step with the server's reason as an error annotation.

### Without the Action

The same command runs anywhere Node 20 or later does. In a repository with no `node_modules` (a
Godot project), download `pkey.mjs` from the `@polaris-key/cli` GitHub release and run it
directly; it is the Action's own bundle:

```sh
node pkey.mjs release publish --product your-product --tag "$GITHUB_REF_NAME" \
  --channel beta --dir dist --meta builds.json
```

`node pkey.mjs validate` checks `.pkey/` locally the same way, and
`node pkey.mjs manifest schemas --out .pkey/schemas` vendors the manifest JSON Schemas, so an
editor's `yaml-language-server: $schema=` header can point at a local copy.

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
   does the compressed resource that takes a pack past 512 MiB; split the model or the pack. A reference to a script the game
   already ships (`[ext_resource type="Script" …]`) names none of these and passes. The lint knows
   the built-in script set only; for another script language (a GDExtension) the device check,
   which asks its engine what a script is, is the one that refuses it. The header's engine must be `requires.engine`; more than
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
