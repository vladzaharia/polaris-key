---
title: "Check a download is genuine"
description: "Check that a file you downloaded matches the one the app's developer published."
type: "help"
status: "shipped"
lastReviewed: "2026-10-11"
sidebar:
  order: 7
---

Compare your file's SHA-256 with the value listed for it. A SHA-256 is a code worked out from a file's contents, so a changed or damaged file gets a different one. Do this before you install the file.

:::caution[Important]
A matching value can't show that the page itself is genuine. Take the value from the app's own download page, or from your library at [key.plrs.im](https://key.plrs.im). To check the page's address, see [Use the public download page](/docs/help/download/#use-the-public-download-page).
:::

## Before you start

Have the file you downloaded, and the app's download page or your library, open.

## Find the listed value

- On the app's public download page, find **All downloads**. The **SHA-256** column shows the full value for each file.
- In your library, each file shows a short SHA-256. Select it to see the full value. A phone may not show it, so use the download page there.

## Get your file's value

A terminal is a window where you type commands. Terminals usually open in your home folder and browsers usually save to Downloads, so first type `cd Downloads` and press Enter (macOS, Linux and PowerShell). If you saved the file somewhere else, use that folder instead. Replace `<file>` with the file's name, in quotes if it has spaces.

- **macOS:** in Terminal, run `shasum -a 256 <file>`
- **Linux:** in a terminal, run `sha256sum <file>`
- **Windows:** in PowerShell, run `Get-FileHash <file>`

The two values must match exactly. Capital and small letters count as the same.

## Check several files at once

The download page links **SHA256SUMS**, a list of the SHA-256 for every file of that version, for all systems. Put your downloads and **SHA256SUMS** in one folder. If your system has `sha256sum`, run `sha256sum --check SHA256SUMS` there. It prints `OK` for each file that matches. A listed file you didn't download can't be checked, which isn't a mismatch.

## Check an Android app's signing key

For an Android app, **Signing keys** on the download page lists the keys the developer signs with, each with a SHA-256 value. An app such as AppVerifier shows an installed app's signing certificate. Install AppVerifier (or a similar app) only from its own official site or a store you already use.

1. If you downloaded a file, check its SHA-256 first, then install the app you are checking. If a store or a tool such as Obtainium installed it for you, go to step 2.
2. In AppVerifier, find the installed app's signing certificate SHA-256.
3. Compare it with the matching entry under **Signing keys**:
   - **Android sideload signing certificate**: for a file you downloaded from the page or installed with a tool such as Obtainium.
   - **Android app signing certificate**: for an app from Google Play.

## If the values don't match

Don't open or install the file. Delete it and download it again from the app's own download page or your library. If an Android app's signing certificate doesn't match its entry, uninstall the app.

## Check it worked

The value for your file is the same as the listed value. For an Android app, the signing certificate matches its entry.

## Still need help?

If the values still differ, don't install the file. Read [Get help with an app](/docs/help/contact/).
