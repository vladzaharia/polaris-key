---
title: "Install packages with a personal token"
description: "Create a personal token, find the setup for an app's packages, and what to do when a development build is gone."
type: "help"
status: "shipped"
lastReviewed: "2026-10-17"
sidebar:
  order: 7
---

Some apps publish packages for people whose license includes them: a library, a command-line tool, a container image or an add-on. A personal token is a read-only credential from your account that installs every package your licenses include.

## Find the setup

Open **Account → Packages** at key.plrs.im. It shows the setup for each app whose license includes private packages.

## Create a personal token

Make one per computer.

1. Choose **Create personal token**, name it, and pick how long it lasts.
2. If asked, confirm it's you.
3. Copy the personal token. It is shown once. If you lose it, revoke it and make another.
4. Set `PKEY_REGISTRY_TOKEN` to it, then follow the setup on the page.

**Check it worked.** It is in your list, with its last use after an install.

It only reads, and works while the license is active.

## Use Godot

The Godot editor can't use a personal token. Under **Package type**, choose Godot, then **Create Godot editor URL**. The 30-day URL is shown once. Paste it into Editor Settings, as the page says.

## Revoke a personal token

Choose **Revoke** next to it, then confirm. Anything using it stops within 30 seconds. Older single-app ones and Godot URLs work until they expire; revoke them in the page's per-app group.

## Which versions stay available

When the developer publishes a release of a package, such as `1.4.0`, Polaris Key's cleanup removes that package's development builds up to that version. Development builds are versions published ahead of a release. Their names end in `-main.` or `-dev.` and a number, such as `1.4.0-main.7`. Python names them like `1.4.0.dev7`.

| Version                               | Example                       | After `1.4.0` is released |
| ------------------------------------- | ----------------------------- | ------------------------- |
| Release                               | `1.4.0`                       | Stays                     |
| Beta                                  | `1.4.0-beta.1`                | Stays                     |
| Development build of `1.4.0` or older | `1.4.0-main.7`, `1.3.2-dev.2` | Removed                   |
| Development build of a newer version  | `1.4.1-main.2`                | Stays                     |

If you install only releases and betas, cleanup does not affect you.

Cleanup works on one package at a time: the one that was released. It changes only the app's own packages on Polaris Key (`pkg.plrs.im`), and it works the same for packages open to everyone and packages that need a license. It covers container images. A build that something else still refers to stays. A copy on a public registry, such as npmjs or PyPI.org, is never changed.

## When cleanup runs

Cleanup runs automatically right after the developer publishes a release. A beta version removes nothing.

Cleanup is on by default. Before it first runs for an app, Polaris Key records a one-time notice in the app's activity log. The notice comes from a dry run: Polaris Key counts the development builds cleanup would remove and deletes nothing. It also gives a start day, 7 days after the notice. Until that day nothing is removed, unless the developer turns cleanup on or runs it by hand. The first release after that day starts cleanup.

A developer can turn cleanup on or off for an app, and the choice applies at once. Turning it on starts cleanup at the next release. Turning it off stops automatic cleanup.

## If a version you use is gone

When you ask for a development build that was removed, your package manager reports a missing version.

:::caution[Important]
A removed development build is gone, and its version number can't be published again. Only the app's developer can publish a new version.
:::

1. Open your lockfile or dependency list and find the development build.
2. Change it to a release or a beta version.
3. Install again.

**Check it worked.** The install finishes with no error about a missing version.

If you install an npm package by the `main` tag, the tag points to the newest development build that is left. When none is left, the tag is gone.

To ask about an app's packages, contact the app's developer. See [Get help with an app](/docs/help/contact/).
