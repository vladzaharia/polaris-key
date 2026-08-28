---
title: "The customer portal"
description: "Sign in on the web to see your licenses, claim a key, manage devices, and download releases across every product you use."
sidebar:
  order: 3
---

For products that turn it on, the customer portal is a web page — separate from any one app —
where you can manage your account across every Polaris Key product you use. Not every product
offers it; if yours doesn't, everything described here happens inside the app instead. See
[Identity](/docs/services/identity/) for how the portal fits into the rest of the platform.

## Signing in

The portal offers up to two ways in, and a product may offer either or both:

- **Sign in with your identity provider** — the same account you might already use to sign into
  the product itself.
- **Email magic link** — enter your email and you're sent a one-time sign-in link. It's good for
  **10 minutes** and works only once; if it's expired by the time you click it, request a new one
  rather than reusing an old email.

If neither option appears, the product hasn't turned on portal sign-in.

## Your licenses

Once you're in, the portal groups every license it can find for your account by product, and for
each one shows its tier, expiry, how many devices are using it, and what it includes. A license
tied to your email or your sign-in identity generally appears on its own; one you only ever
redeemed as a key inside an app does not, until you claim it.

## Claim a license key to your account

If you have a license key that isn't showing up on its own, add it: enter the key on the
portal's dashboard, and it links that license to your account. The key itself is only ever used
for that one lookup — the portal doesn't keep a copy of it afterward.

## Downloading releases

For products that distribute software through Polaris Key, a Downloads section lists released
versions and their files. Choosing one gets you a **one-time download link** — it works once, so
if you need the file again later, come back to the portal for a fresh link rather than reusing
an old one. Some files are open to anyone signed in; others need a currently usable license, and
are marked as such if you don't have one.

## Managing your devices

Every license's page lists the devices using it and lets you disconnect any of them — handy for
a machine that's gone, sold, or otherwise out of reach. See [Devices](/docs/users/devices/) for
what disconnecting actually does, and how it compares to disconnecting from inside the app
itself.

## Deleting your account

Your portal account can be deleted on request. Doing so removes your portal profile, every email
address linked to it, and the links connecting your account to your licenses. It does **not**
delete the licenses themselves — those remain the product's own records, so if you sign back in
the same way later, the portal can reconnect them on its own. If you want a license itself
erased, that's a request for the product's own support, not the portal. Because deleting the
account removes your email address, you're sent one last confirmation to it as it happens.
