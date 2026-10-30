---
sidebar:
  order: 11
title: "winget"
description: "Declare a winget package in .pkey/distribution and let the publish step open the pull request to microsoft/winget-pkgs."
type: "reference"
lastReviewed: "2026-10-28"
---

winget is written through files in `microsoft/winget-pkgs`. The publish step generates the version's manifests from the release and the listing and opens the pull request from a fork.

## Declare it

```sh title="Terminal"
pkey channel add winget --field packageIdentifier=Publisher.Package
```

See [Distribution manifest](/docs/build/manifest/distribution/).

## The secret

`PKEY_PR_TOKEN`: a fine-grained token if it can open the pull request, otherwise a classic token with `public_repo`. A classic token reaches every public repository the account can write, so keep it in its own environment with required reviewers. Without it the step is skipped, naming the variable.

## The publish step runs it

With `channels: auto`, an app `release publish` is followed by `pkey channel sync`, which opens the pull request for the track's newest release. The pull request writes the manifests at schema 1.12.0: version, installer (the release's HTTPS download URLs), default locale and one file per further locale. The [pull-request rules](/docs/features/ship-builds/channels/#pull-request-channels) apply.

- **Every version is reviewed.** Microsoft's pipeline validates the manifests, then a moderator reviews them. The console shows the pull request and its labels (`Needs-Author-Feedback`, `Validation-…`), never a date.
- **The listing fills the locale files.** A missing required field or one over the store's limit stops the step with the field named.
- **A `.zip` build needs `--portable`**, the executable inside the archive; `--license` sets the `License` field (default `Proprietary`). Sync takes neither, so run the step yourself: `pkey storefront winget pr --channel stable --portable Dice/dice.exe` (as the Action's `command: storefront winget pr`).

In the console, the channel's page (**Ship builds → Channel setup → winget**) shows its status and releases.
