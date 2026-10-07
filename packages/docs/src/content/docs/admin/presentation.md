---
title: "Presentation"
description: "The images Polaris Key hosts for a product: the product icon, the listing's icon, header and screenshots, and store slots. Upload, Revert to manifest, Delete copy."
sidebar:
  order: 6
---

**Core → Presentation** lists every image Polaris Key hosts for the product. Polaris Key keeps its
own copy of each file and serves it from its image host (`img.plrs.im`); the developer's original,
wherever it lives, is never changed.

## The slots

| Section         | Slots                                                                                                                    |
| --------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **Product**     | The product icon (`presentation.icon`), which the console's product card and the UI kits show.                           |
| **Listing**     | The listing icon (`listing.icon`, which falls back to the product icon), the header and screenshots 1 to 16.             |
| **Other slots** | Anything else hosted for the product: a store slot of the shared listing such as `play:feature-graphic`, a release file. |

Each slot shows:

- **Source.** The manifest's URL or repository path (`.pkey/product` `presentation.icon`, the
  `.pkey/distribution` listing), "Uploaded in the console" or "Pushed from CI".
- **Status.** Ready; Pulling (a first pull is on its way); Updating (the manifest names a new file,
  which is being pulled while the old copy keeps serving); Failed, with the reason; Source gone
  (the source answered 404 or 410, and the last good copy keeps serving).
- **Size, dimensions and type**, and a preview from the image host.
- **Sizes pending**, while the copy still owes its WebP sizes. Sizes are made once, when the file
  arrives; Polaris Key retries them from its stored copy and never pulls the source again for
  them. The original serves in the meantime.

## Upload or Replace

Choose a file for the slot. It must be a PNG, JPEG, WebP, GIF or AVIF image (Polaris Key reads the
file's first bytes to decide, so a renamed file is refused, and SVG is never accepted). Icon slots
take files up to 10 MiB; the header, screenshots and other art up to 20 MiB.

An upload **claims the slot**. A resync records what the manifest names but leaves the slot alone,
and a CI push to the slot is kept out. The order is always: an upload in the console, then the
manifest, then CI.

## Revert to manifest

Shown for a slot you uploaded whose source the manifest still names. The console's copy is
deleted at once and Polaris Key pulls the manifest's file again; nothing is shown for the slot
until it arrives.

## Delete copy

Drops this slot's copy at once: the image host stops serving it for this slot on the next
request. Delete copy is per slot: the same file held by another slot (the listing icon falls back
to the product icon, for example) keeps serving at the same content-addressed URL until that slot
is deleted or replaced too. If the manifest still names the file, the next resync pulls it again;
remove it from the manifest, or upload a replacement, to keep it gone. A slot you uploaded whose
source the manifest still names offers Revert to manifest instead. A store slot of the shared listing also loses its listing
row when that row holds the same file.

## From CI

`pkey assets push <file> --slot <slot>` and the publish Action's `assets` input send files from a
CI job; see [Hosted assets](/docs/build/ci/#hosted-assets). The CI token needs the opt-in
`assets:write` scope, which you grant on **Keys & secrets → CI publishing**.

## Hosting and quotas

The last section shows what Polaris Key holds for the product against its two quotas. Each file
counts once, however many slots use it.

| Row                      | What it shows or sets                                                                                                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Images**               | The bytes of hosted images (originals and their sizes) against the media quota.                                                                                                            |
| **Media quota**          | `assets.quota.mediaBytes`: 512 MiB unless the platform default or this product sets another. Past it, a new or replaced image is refused, and the copy the slot already has keeps serving. |
| **Release files**        | The bytes of mirrored release files against the release-file quota.                                                                                                                        |
| **Release-file quota**   | `assets.quota.releaseBytes`: 100 GiB unless the platform default or this product sets another. Past it, mirroring stops and GitHub keeps serving the files that have no copy.              |
| **Mirror release files** | `assets.releases.mirror`: on by default. Off copies no new release file for this product, so GitHub serves the files without a copy; the copies already made keep serving.                 |

A quota is entered in MiB and saved after a confirmation; **Reset** returns it to the platform
default. Turning mirroring off asks first. When a quota is full, its row says so. When hosted
assets are off for the whole deployment (Platform → Settings → Delivery), the section says that
first: every image surface then shows the developer's own URLs and no new release file is copied,
while the copies listed here stay (release files already copied keep serving from them).
