---
sidebar:
  order: 10
title: "Snap Store"
description: "Declare a snap in .pkey/distribution and let the publish step run snapcraft upload for the .snap you build."
type: "reference"
lastReviewed: "2026-10-28"
---

The Snap Store takes builds only through `snapcraft`, whose credentials stay in CI and never reach Polaris Key. The publish step runs it for the Snap Store channel you declare.

## Declare it

```sh title="Terminal"
pkey channel add snap --field name=your-snap \
  --field 'channels={"stable":"stable","beta":"beta"}'
```

`channels` maps each release track to the one snap channel (`[<track>/]<risk>[/<branch>]`) it may release to. A step for a release track with no entry is refused before `snapcraft` starts, and again by Polaris Key. See [Distribution manifest](/docs/build/manifest/distribution/).

## The secret

`SNAPCRAFT_STORE_CREDENTIALS`, a scoped, expiring login, as a secret in the publish job's GitHub environment:

```sh title="Terminal"
snapcraft export-login --snaps your-snap --channels stable,beta \
  --acls package_push,package_release \
  --expires 2027-01-01 snap-credentials.txt
```

Never grant `package_manage` (collaborators) or `package_upload`. The allow-list never runs `close`, `release`, `promote` or a collaborator command. Without the secret the step is skipped, naming the variable.

## The publish step runs it

With `channels: auto`, an app `release publish` is followed by `pkey channel sync`. If `dir` holds a `.snap`, it runs `snapcraft upload <snap> --release=<snap channel>`. Build the snap before the publish step. See [Channels that run in CI](/docs/features/ship-builds/channels/#channels-that-run-in-ci).

Two metadata steps stay out of sync. Run them as the Action's `command`: `snap metadata` before the build, because `upload-metadata` reads the text from the snap itself.

- **`pkey storefront snap metadata --yaml snapcraft.yaml`** writes the listing's Snap summary and description into `snapcraft.yaml`. It needs a listing in the console; a missing summary or a value over the Snap Store's limit stops the step with the field named. Title, screenshots and banner stay in the Snap Store dashboard.
- **`pkey storefront snap upload-metadata --snap file.snap`** sends the summary, description and icon the snap carries.

`--dry-run` prints the checked command lines and runs nothing. A step already done in this run is skipped.

In the console, the channel's page (**Ship builds → Channel setup → Snap Store**) shows its status and releases.
