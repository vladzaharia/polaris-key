---
title: "Updates"
description: "How new versions reach you: in-app updates on your channel, the download page, and why an old build might be told to update."
sidebar:
  order: 5
---

Once activated, most products keep themselves current without you doing anything — but it's
useful to know where an update actually comes from, and why the app occasionally insists on one.

## In-app updates

The app periodically checks for a newer build on its own and offers to install it — the same
kind of mechanism (Sparkle, on the platforms that use it) many desktop apps rely on. Checks
happen on a schedule rather than continuously, so there's normally a short delay between a
version going out and your app noticing it.

Which builds you're offered depends on your **channel**: almost everyone is on the standard,
stable channel, but a license can also be entitled to an early-access channel, which then
behaves like a second, faster-moving lane of updates layered on top of the stable one. See
[Update](/docs/services/update/) for how channels and eligibility work underneath.

## The download page

You can also fetch the current build directly at any time, rather than waiting for the in-app
updater — through the
[customer portal's downloads](/docs/users/portal/#downloading-releases), for products that offer
one. That's also the place to go if you ever need to reinstall from scratch.

## Version windows

A license can carry a minimum, and occasionally a maximum, supported app version. If the build
you have installed falls outside that window, the app is told so the next time it checks in, and
asks you to update rather than continuing to run silently on a version the product no longer
supports. This is the most common reason an otherwise-working install suddenly starts asking to
update — see
[Your version is blocked](/docs/users/troubleshooting/#your-version-is-blocked) for what that
screen means and what to do about it.

:::note[No in-app updater?]
If a product doesn't run one, reinstalling from the download page whenever a new version ships
is the update mechanism.
:::
