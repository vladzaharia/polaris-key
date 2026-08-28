---
title: "Troubleshooting"
description: "Common activation, device, and sign-in problems — what they mean and what to do about them."
sidebar:
  order: 6
---

## Activation says the key is invalid

The app treats several different problems as the same message on purpose, so a wrong guess can't
be used to fish for real keys: a mistyped key, one that's already been used up, and one that's
been turned off all look identical from the outside. Double-check you copied the whole key with
nothing missing from either end, and that it's for the right product — a key only ever works for
the product it was issued for. If it still doesn't work, that's a question for whoever issued it
rather than something you can fix by retrying.

## Device limit reached

Your license allows a fixed number of active devices, and you're already using all of them. See
[Seat limits](/docs/users/devices/#seat-limits) for what counts toward that number — the fix is
usually to disconnect a device you're no longer using, either from the app on that machine or
from the [customer portal](/docs/users/portal/), which frees the seat right away.

## Your version is blocked

Some licenses only cover a range of app versions — a minimum, a maximum, or both, reported to the
app as an `allowedRange`. If your installed build falls outside that range, the app refuses to
treat its license as valid until you update (too old) or, less commonly, until a rolled-back
version becomes available again (too new). A stuck update is usually as simple as visiting the
[download page](/docs/users/updates/#the-download-page) and installing what the app says it
needs.

## Offline grace has expired

After it last successfully checked in, the app can keep running for a while with no network at
all — that window is your **offline grace**, and the moment it runs out is what the app
internally calls `graceUntil`. Past that point without a successful check-in, the app stops
trusting what it has cached and asks you to reconnect, even briefly, so it can verify your
license again. Connecting to the internet — even for a few seconds — is all it takes to reset
the clock; there's nothing to reset by hand. See
[The status lifecycle](/docs/services/license/model/#the-status-lifecycle) for how grace fits
into the rest of a license's life.

## Can't sign in

A few common causes, roughly in order of likelihood:

- **The link expired.** A magic link is only good for 10 minutes and works only once — request a
  fresh one rather than reusing an old email.
- **Wrong account.** Sign-in has to match the identity the product, or your license, expects; if
  you have more than one account you sometimes use, try another.
- **Too many attempts.** Sign-in is rate-limited to stop guessing; wait a few minutes and try
  again.
- **The account isn't entitled.** Some products only let specific groups of people sign in, and
  outside that group sign-in is refused even with otherwise-valid credentials — that's a
  question for whoever administers the product.

If none of these fit, see [Signing in](/docs/users/portal/#signing-in) or check with whoever
administers the product for anything happening on their end.
