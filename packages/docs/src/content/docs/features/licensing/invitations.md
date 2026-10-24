---
title: "Invite people"
description: "Email a license holder a sign-in link instead of a key, resend it, and when invitations are not offered."
type: "concept"
lastReviewed: "2026-10-23"
sidebar:
  order: 12
---

Invitations are in the **New license** wizard and on a waiting license's record. See [Manage licenses](/docs/features/licensing/manage-licenses/) for the rest of the console.

## How the person gets it

For **Someone specific**, the wizard's **Delivery** step offers:

- **Email an invitation**: a "Your _App_ license is ready" email with a sign-in link and no key. It is the default where Sign-in is on and signing in adds licenses by email. **Also create a key** nests under it: the key is shown once in the console and never emailed. Without it no key is made.
- **Email the key and show it once**, and **Show it once**: the key itself.

The invitation is sent as "_App_ via Polaris Locker". The person signs in at Polaris Locker with that address and the license joins their account. It names the address in the body, never in a link, and carries no key. If the send fails the license still exists and waits for that address; **Try again** resends it, and **Create a key** makes a key to pass on yourself.

Invitations are not offered, and Delivery says why, when Sign-in is off for the product, when its sign-in doesn't add licenses by email (a custom identity provider), or when email isn't set up on this Polaris Key server. A license that is disabled or expired gets no library notice when it joins an account.

## Resend an invitation

On a license that is waiting for its holder, **Resend invitation** is the primary action; **Send a new key…** stays in **More actions**. The **Invitation** card shows when the last one was sent, or **Not sent** with **Send invitation**. One email per license per 10 minutes, shared with **Send a new key…**. **Assign…** has the same choice, **Email them an invitation**. The list's **Waiting** pill reads "Invited" with the date only after an invitation went out, else "Added".
