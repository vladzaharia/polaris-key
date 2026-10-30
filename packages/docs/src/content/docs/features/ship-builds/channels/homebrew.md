---
sidebar:
  order: 12
title: "Homebrew"
description: "Declare your Homebrew tap in .pkey/distribution and let the publish step open the pull request that updates the cask or formula."
type: "reference"
lastReviewed: "2026-10-28"
---

Homebrew is your own tap, a GitHub repository. The publish step writes the cask or formula for the track's newest release and opens a pull request to the tap.

## Declare it

```sh title="Terminal"
pkey channel add homebrew --field homebrewTap=your-name/homebrew-tap \
  --field homebrewCask=your-app
```

Use `homebrewCask` for a macOS app and `homebrewFormula` for a command-line tool; declare both and each gets a pull request. `homebrewTap` is `<owner>/homebrew-<name>`. A tap of the `Homebrew` organization is refused: the official `homebrew/cask` has its own rules and needs you, by hand. See [Distribution manifest](/docs/build/manifest/distribution/).

## The secret

`PKEY_PR_TOKEN`: a fine-grained token limited to the tap, with `Contents: Read and write` and `Pull requests: Read and write`. Without it, and without the exchange below, the step is skipped, naming the variable.

No personal token is needed when the publish job's `pkeyci_` token has the `distribution:pr` scope (an operator grants it in the console) and the GitHub App is installed on the tap with Contents and Pull requests write: the step then asks Polaris Key for a one-hour token for the declared tap only. `PKEY_PR_TOKEN` still wins when set.

## The publish step runs it

With `channels: auto`, an app `release publish` is followed by `pkey channel sync`. The [pull-request rules](/docs/features/ship-builds/channels/#pull-request-channels) apply.

- **A cask** (`Casks/<homebrewCask>.rb`) takes the disk image: version, sha256, url, name, desc, homepage, `livecheck`, `auto_updates` and `app`. `livecheck` reads the public download page, so it follows the stable release track. `--app` names the `.app` bundle in the image (default `<name>.app`).
- **A formula** (`Formula/<homebrewFormula>.rb`) takes a `.tar.gz` or `.zip` for macOS and Linux (`on_macos`, `on_linux`, `on_arm`, `on_intel`) and installs `--command` (default the formula name). Linux counts only once the formula is declared.

Sync takes neither flag, so to set them run the step yourself: `pkey storefront homebrew pr --channel stable --command dice` (as the Action's `command: storefront homebrew pr`).

In the console, the channel's page (**Ship builds → Channel setup → Homebrew**) shows its status and releases.
