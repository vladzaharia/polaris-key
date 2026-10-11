---
title: "Check a download is genuine"
description: "Check that a file you downloaded matches the one the app's developer published."
type: "help"
status: "shipped"
lastReviewed: "2026-10-11"
sidebar:
  order: 7
---

Compare your file's SHA-256 with the value listed for it. A SHA-256 is a code worked out from a file's contents, so a changed or damaged file gets a different one. This check is optional.

:::caution[Important]
A matching value can't show that the page itself is genuine. Take the value from the app's own download page, or from your library at [key.plrs.im](https://key.plrs.im).
:::

## Before you start

Have the file you downloaded, and the app's download page or your library, open.

## Find the listed value

- On the app's public download page, find **All downloads**. The **SHA-256** column shows the full value for each file.
- In your library, each file shows a short SHA-256. Select it to see the full value. A phone may not show it, so use the download page there.

## Get your file's value

Run the command for your system, with `<file>` replaced by the file's name. The file needs to be in the folder you run it from.

| System  | Program    | Command                |
| ------- | ---------- | ---------------------- |
| macOS   | Terminal   | `shasum -a 256 <file>` |
| Windows | PowerShell | `Get-FileHash <file>`  |
| Linux   | A terminal | `sha256sum <file>`     |

The two values must match exactly. Capital and small letters count as the same.

## Check several files at once

The download page links **SHA256SUMS**, a list of the SHA-256 for each file of that version. Put your downloads and **SHA256SUMS** in one folder. If your system has `sha256sum`, run `sha256sum --check SHA256SUMS` there. It reports **OK** for each file that matches.

## Check an Android app's signing key

For an Android app, **Signing keys** on the download page lists the keys the developer signs with, each with a SHA-256 value. You check an Android app after you install it, with an app such as AppVerifier that shows an installed app's signing certificate.

1. Install the app.
2. In AppVerifier, find the installed app's signing certificate SHA-256.
3. Compare it with the matching entry under **Signing keys**. Use **Android sideload signing certificate** for a file you downloaded from the page or installed with a tool such as Obtainium. Use **Android app signing certificate** for an app from Google Play.

## If the values don't match

Don't install the file. Delete it and download it again. If an Android app's signing certificate doesn't match its entry, uninstall the app.

## Check it worked

The value for your file is the same as the listed value. For an Android app, the signing certificate matches its entry.

## Still need help?

If the values still differ, read [Get help with an app](/docs/help/contact/).
