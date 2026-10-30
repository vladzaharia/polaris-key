---
sidebar:
  order: 14
title: "Flathub"
description: "Declare a Flathub app in .pkey/distribution and let the publish step open the update pull request to its flathub repository."
type: "reference"
lastReviewed: "2026-10-28"
---

Flathub updates are pull requests to `flathub/<appId>`. The publish step moves each `extra-data` source of the app's manifest to the new build and refreshes the MetaInfo. The checker JSON Flathub's `x-checker-data` reads is on [Install sources](/docs/features/ship-builds/channels/feeds/#flathub).

## Declare it

```sh title="Terminal"
pkey channel add flathub --field appId=com.example.YourApp
```

`appId` is the Flatpak application id. See [Distribution manifest](/docs/build/manifest/distribution/).

## The secret

`PKEY_PR_TOKEN`: the maintainer's token, with write access to `flathub/<appId>` (an account with two-factor authentication, invited to the app repository). Without it the step is skipped, naming the variable. Polaris Key issues no GitHub token for `flathub/<appId>`; `distribution:pr` covers Homebrew and Scoop only. Between pull requests, Flathub's external-data checker follows the [checker JSON](/docs/features/ship-builds/channels/feeds/#flathub) and needs no token.

## The first submission is yours

`pkey storefront flathub init --out flathub` writes the manifest skeleton (its `extra-data` sources carry `x-checker-data` for Flathub's external-data checker), the MetaInfo and a desktop entry, on the current Freedesktop runtime. `--runtime-version` picks another branch; Flathub refuses an end-of-life one. Add the icon, open the pull request to `flathub/flathub` against `new-pr` and see it through review.

## The publish step runs it

After that first submission, `channels: auto` runs `pkey channel sync` after each app `release publish`, and the [pull-request rules](/docs/features/ship-builds/channels/#pull-request-channels) apply.

- **MetaInfo screenshots come only from Polaris Key's image host.** A MetaInfo never names your own screenshot URLs or a download blob. Until hosted copies of your listing images are served, it has no `<screenshots>` and the step warns; Flathub requires at least one, so add them in the pull request yourself.
- **The listing fills the MetaInfo.** A missing required field or one over the limit stops the step with the field named.
- **A dry run needs no token.** The manifest update is then shown as the MetaInfo only.

In the console, the channel's page (**Ship builds → Channel setup → Flathub**) shows its status and releases.
