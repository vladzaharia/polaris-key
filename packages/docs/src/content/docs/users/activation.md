---
title: "Activating your product"
description: "The four ways to get a Polaris Key product running: a license key, signing in, free enrollment, or an offline bundle."
sidebar:
  order: 2
---

Activation is what turns an installed copy of the app into one that's allowed to run — it tells
the app who you are, or that you're allowed in at all, and leaves it holding a credential it uses
from then on so you don't have to repeat the process. Every product supports at least one of the
four ways in below; most support only one or two.

## Redeem a license key

The most common way in. You'll have a key that looks something like `pkey_product_xxxxxxxxxxxx`
— from a purchase receipt, an email, or whoever administers the product for you. Paste it into
the app's activation screen once.

The key is shown to whoever issued it exactly one time, so if you've lost it, ask them for a new
one rather than searching for it — the app, and Polaris Key itself, never display it back to you
afterward. Once redeemed, the app holds its own credential for this machine, and you won't need
the key again unless you reinstall or move to a new machine.

Every key is good for a limited number of devices at once — see [Devices](/docs/users/devices/)
for what happens if you're already at that limit.

## Sign in with the product's identity provider

Some products let you sign in the way you already do elsewhere — through whatever account system
they've connected — instead of typing a key. Depending on the app, this either opens a browser
window to sign in, or shows you a short code to enter on a second device or browser tab. Either
way, once you approve it, the app finishes activating on its own — no key ever changes hands.

If this exact machine already had a free license from enrollment (below), signing in attaches
that license to your account rather than creating a second one — you keep the devices and
settings you already had.

See [Identity](/docs/services/identity/) for how sign-in works underneath.

## Enroll for free

Where a product allows it, the app can activate itself with no key and no sign-in at all — you
simply never see an activation screen. This is limited to **one free license per machine**,
decided by the machine's own hardware rather than by how many times you reinstall, so
reinstalling the app — or clearing its settings — doesn't get you a second one.

Because it depends on reading something about the machine's hardware, free enrollment is only
available from the installed app, never from a browser-only sign-in. If a product doesn't offer
this path, it simply hasn't turned it on.

## Import an offline bundle

For a machine with no network access at all — air-gapped by design. The app's activation screen
shows a short **request code** instead of asking for a key. Give that code to whoever
administers the product for you; they mint a file addressed to exactly that code and get it back
to you however makes sense on their end — a USB stick, an email, a support ticket attachment.

Importing that file in the app activates it with **no network call made at all**: everything in
it — including the keys used to sign it — is checked entirely offline before any of it is
trusted. A bundle typically covers your machine for a long stretch before a fresh one is needed,
and getting a new one costs nothing if the first is lost or the machine needs re-importing.

:::tip[No request code, no offline path]
If your app has never shown you a request code, it doesn't support offline activation — this
path only exists for products built to offer it.
:::

## Which one will I see?

Only the ways in that actually work for your product — the app shows nothing else. If activation
isn't going the way you expect, see [Troubleshooting](/docs/users/troubleshooting/); once you're
in, [Devices](/docs/users/devices/) covers what you can do with the machine you just activated.
