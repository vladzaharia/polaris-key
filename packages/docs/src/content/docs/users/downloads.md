---
title: "Downloads and app stores"
description: "Where you can get a product besides its own download page: adding an AltStore, SideStore or F-Droid source, tracking it in Obtainium, and installing it with Scoop."
sidebar:
  order: 6
---

A product can reach you through more than its own download page. Besides the big app stores,
many products publish to storefronts you add yourself: a **source** in a sideloading app on
iPhone and iPad, a **repository** in an Android store, or a **manifest** for a Windows package
manager. Once a source is added, the store notices new versions by itself.

Each source belongs to a **channel**. Stable is the one almost everyone wants. Beta includes
everything stable gets, plus the early builds. Add the source for the channel you want; to
switch channels later, remove one source and add the other.

The product's download page has buttons and QR codes for all of these. The rest of this page
explains what each one does.

## The download page

Every product that publishes downloads to everyone has a public download page at its short link
on the download host, `https://dl.plrs.im/<product>`. You do not need an account to open it, and
it sets no cookies.

The page works out which device you are on and leads with one button for it: the App Store or
Google Play listing when the product is there, otherwise a direct download of the right build for
your system. On an iPad, which reports itself as a Mac to websites, the page shows the iPhone and
iPad option on touch screens. If the page cannot tell, it offers every platform.

Below the button, **Other ways to get it** lists everything else: the other stores, the
AltStore, SideStore and F-Droid sources described below with a QR code to scan from your phone,
the Obtainium link, and the Scoop and Homebrew commands. **All downloads** lists every build with
its version, size, minimum system version and SHA-256 checksum, and **Signing keys** lists the
fingerprints of the keys the product signs with.

### Checking a download

Before you install something you downloaded directly, you can check it is the file the product
published:

- **Checksum.** Compare the file's SHA-256 with the one on the page. On macOS and Linux run
  `shasum -a 256 <file>`; on Windows run `Get-FileHash <file>` in PowerShell.
- **Signing key (Android).** Apps such as AppVerifier compare an installed app's signing
  certificate with a published fingerprint. Use the Android app signing certificate under
  **Signing keys**.

The page only lists versions that are released to everyone. While a product is rolling an update
out gradually, or has paused it, the page keeps offering the previous version.

## Adding a source

### AltStore and SideStore (iPhone and iPad)

Tap the product's **Add to AltStore** or **Add to SideStore** link, or open AltStore or SideStore
and go to **Sources → Add**, then paste the source URL:

```
https://key.plrs.im/<product>/distribution/altstore/stable/source.json
```

The links are `altstore://source?url=…` and `sidestore://source?url=…`. A `sidestore://` link
does nothing useful unless SideStore is already installed, so install the store app first.

Apps installed this way with a free Apple ID have to be refreshed every seven days, and a free
account can have only three such apps at once. That is Apple's limit, not the product's.

**AltStore PAL** (in the EU, Japan and Brazil) uses its own source, ending in
`altstore-pal/<channel>/source.json`. AltStore PAL installs only apps that Apple has notarized,
so a version appears there a little later than in the regular source.

### F-Droid and other Android stores

In F-Droid (or Droid-ify or Neo Store), go to **Settings → Repositories → Add**, or tap the
product's **Add to F-Droid** link (`fdroidrepos://…`). The repository URL ends in
`fdroid/<channel>/repo` and carries a `?fingerprint=` value. Keep that value: the store uses it to
check that the repository really is the product's, and it refuses a repository signed with a
different key.

### Obtainium

Tap the product's **Add to Obtainium** link (`obtainium://app/…`). It opens Obtainium with the
app's settings filled in. When the product has an F-Droid repository, Obtainium tracks that
repository, which gives it real version numbers and the right build for your phone.

### Scoop (Windows)

Install straight from the manifest URL:

```
scoop install https://key.plrs.im/<product>/distribution/scoop/stable.json
```

Run `scoop update` to update the app, the same way you update anything else installed with Scoop.

## When a new version shows up

A source lists a version only once it is ready for everyone on that storefront. While a product
is rolling an update out gradually, or has paused or stopped a rollout, the source keeps showing
the previous version: these stores have no way to offer an update to only some people. A version
the developer has withdrawn disappears from every source.

Sources are refreshed every few minutes, but your store app may check less often.

## Private products

These storefronts cannot sign in. A product that requires a license or an account to download
does not publish any of these sources. Download it from the
[customer portal](/docs/users/portal/) instead.
