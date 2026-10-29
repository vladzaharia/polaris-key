---
sidebar:
  order: 9
title: "itch.io"
description: "Declare an itch.io game in .pkey/distribution and let the publish step run butler push for each matched platform build."
type: "reference"
lastReviewed: "2026-10-28"
---

itch.io takes builds only through its own CLI, `butler`, whose key stays in CI and never reaches Polaris Key. The publish step runs it for the itch.io channel you declare.

## Declare it

```sh title="Terminal"
pkey channel add itch --field target=your-name/your-game
```

`target` is the game's `user/game` slug. `gameId` (digits) is optional; it lets the console match itch.io receipts. See [Distribution manifest](/docs/build/manifest/distribution/). With two itch.io games, give each its own id with `--outlet-id`.

## The secret

`BUTLER_API_KEY`, from your itch.io account's API keys, as a secret in the publish job's GitHub environment. It is **unscoped**: it can push to every game of the account, so give that environment required reviewers. Without it the step is skipped, naming the variable.

## The publish step runs it

With `channels: auto` (the Action's default), an app `release publish` is followed by `pkey channel sync`. For each build in `dir` that matches a platform (a zip, or an apk on android) it runs `butler push <dir> <target>:<platform[-track]> --userversion <version>`. Install `butler` in the job first. See [Channels that run in CI](/docs/features/ship-builds/channels/#channels-that-run-in-ci).

- **The itch.io channel name tags the platform.** It starts with the platform word (`windows`, `linux`, `mac`, `android`); a release track other than `stable` suffixes it (`windows-beta`), so each keeps its own file on the page.
- **There is no review.** A pushed channel is live.
- **The target comes from `.pkey/distribution`, never the workflow.** A push for an undeclared game is refused before `butler` starts, and again by Polaris Key. Each step is reported into the store's ledger beside the console's.
- **A step already done in this run is skipped**, so re-running a failed job does not push twice.

To push by hand, or with other flags: `pkey storefront itch push --platform linux --dir build/linux --version 1.2.0 [--channel beta] [--outlet id]` (as the Action's `command: storefront itch push`). `--dry-run` prints the checked command line and runs nothing.

In the console, the channel's page (**Ship builds → Channel setup → itch.io**) shows its status and releases.
