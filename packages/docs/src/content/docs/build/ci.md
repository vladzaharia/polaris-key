---
title: "Publishing from CI"
description: "pkey release publish and the polaris-key/publish GitHub Action — publishing a release from a release job with no secret in the repository, dry runs, channel commands and troubleshooting."
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

| Input               | Default               | Meaning                                                                                                              |
| ------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `product`           | (required)            | The product slug; must equal `.pkey/product`'s.                                                                      |
| `dir`               | (required)            | The built files, searched recursively, relative to the workspace.                                                    |
| `tag`               |                       | The git tag, which is also the release id. It must spell the version (the tag minus a leading `v`).                  |
| `version`           | `tag` without its `v` | The version; must parse under the deliverable's version scheme.                                                      |
| `channel`           |                       | The canonical channel the release is published to: `stable`, `beta`, or one the product declares.                    |
| `deliverable`       | `app`                 | Only `app` until pack releases land.                                                                                 |
| `source`            | `r2`                  | `r2` uploads the bytes to Polaris Key. `github` uploads nothing and locates every file on the tagged GitHub release. |
| `meta`              |                       | A JSON file of per-build facts (below).                                                                              |
| `base-url`          | `https://key.plrs.im` | The Polaris Key origin.                                                                                              |
| `release-key`       |                       | The release key's PEM (an environment secret). Required when `.pkey/release` declares `releaseKeys`.                 |
| `min-supported-seq` |                       | The record's `minSupportedSeq`: installs below that release on its platforms are prompted (never blocked).           |
| `dry-run`           | `false`               | `true` prints the descriptor (and the release record, unsigned) and the server's verdict, and writes nothing.        |

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

`dry-run: true` (or `--dry-run`) does everything except upload and write: it prints the
descriptor, validates it locally, asks for a ticket and submits it with `dryRun: true`, then prints
the server's verdict, such as "would be created as v0.3.0". Files that are not uploaded yet are
judged as if they were. Without any CI credential (on a laptop), it stops after the local
validation and says so.

### `source: github`

With `source: github` nothing is uploaded: every file is located as an asset of the tagged GitHub
release. That release must be an **immutable release**, and Polaris Key checks that each asset's
GitHub digest and size match the descriptor. Use it when GitHub releases already carry your files.

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
`--deliverable` selects another deliverable once packs exist.

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
| `promote_failed`                                  | A transient failure moving an upload into the blob store. The step retries it automatically.                                                                                                                                                                                                                                                   |
| 404 on the uploads call                           | The blob store is not configured on this Polaris Key, or Release is off for the product.                                                                                                                                                                                                                                                       |

Every refusal fails the job, so a release that did not land never looks as if it did.
