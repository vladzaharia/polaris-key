---
sidebar:
  order: 13
title: "Scoop"
description: "Declare your Scoop bucket in .pkey/distribution and let the publish step open the pull request that updates the app manifest."
type: "reference"
lastReviewed: "2026-10-28"
---

Scoop is your own bucket, a GitHub repository. The publish step writes `bucket/<app>.json` for the track's newest Windows release and opens a pull request to the bucket. The manifest Polaris Key serves for a bucket to track is on [Install sources](/docs/features/ship-builds/channels/feeds/#scoop).

## Declare it

```sh title="Terminal"
pkey channel add scoop --field scoopBucket=your-name/your-bucket
```

`scoopBucket` is `<owner>/<repo>` on GitHub. A bucket of the `ScoopInstaller` organization is refused. The manifest's `bin` and `shortcuts` come from the Polaris Key channel's `scoop` identity (see [Install sources](/docs/features/ship-builds/channels/feeds/#scoop)). See [Distribution manifest](/docs/build/manifest/distribution/).

## The secret

`PKEY_PR_TOKEN`: a fine-grained token limited to the bucket, with `Contents: Read and write` and `Pull requests: Read and write`. Without it, and without the exchange below, the step is skipped, naming the variable.

No personal token is needed when the publish job's `pkeyci_` token has the `distribution:pr` scope (an operator grants it in the console) and the GitHub App is installed on the bucket with Contents and Pull requests write: the step then asks Polaris Key for a one-hour token for the declared bucket only. `PKEY_PR_TOKEN` still wins when set.

## The publish step runs it

With `channels: auto`, an app `release publish` is followed by `pkey channel sync`. The [pull-request rules](/docs/features/ship-builds/channels/#pull-request-channels) apply.

The manifest is the Scoop feed's, with `checkver` and `autoupdate` pointing at the feed. Polaris-hosted builds have content-addressed URLs with no version in them, so `checkver` captures each architecture's SHA-256 from the feed and `autoupdate` builds the URL from it; the bucket's Excavator can follow the feed between pull requests.

In the console, the channel's page (**Ship builds → Channel setup → Scoop**) shows its status and releases.
