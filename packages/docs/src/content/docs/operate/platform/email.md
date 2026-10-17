---
title: "Email delivery"
description: "Sending domain, Apple private relay, limits and what to do when email is down."
type: "runbook"
lastReviewed: "2026-10-16"
sidebar:
  order: 9
---

**Role required:** Platform admin with Cloudflare access.

**Impact:** Every sign-in and account email leaves one shared sender, `noreply@auth.plrs.im`, so every product shares its reputation. Platform mail is sent as `Polaris Key`. Sign-in mail started through a product is sent as `<App> via Polaris Key`.

Use this when people report "We can't send email right now", a code does not arrive, or you change the sending setup. The setup steps are in [Set up sign-in email](/docs/operate/platform/runbook/set-up-sign-in-email/).

## What stops a send

Every send goes through one function that applies these checks in order. The first one that fails decides what the person sees.

| Check                | What it does                                                                                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The `EMAIL` binding  | Without it, the send answers `email_unavailable`.                                                                                                            |
| The sender name      | A product whose display name and slug are both refused answers `email_unavailable`.                                                                          |
| Apple private relay  | A `@privaterelay.appleid.com` recipient gets `email_unavailable` until the sender domains are registered with Apple and `EMAIL_APPLE_RELAY` is `registered`. |
| The suppression list | A suppressed recipient is never sent to. The caller answers as if it had sent.                                                                               |
| The product cap      | Sign-in mail started through a product is capped at 500 a day by default. Platform mail is never capped.                                                     |
| The provider         | Quota, rate, an unverified sender or an outage answers `email_unavailable`.                                                                                  |

When a send answers `email_unavailable`, the login card offers another sign-in method.

## Limits per person

These limits protect one person and one product. They answer exactly as a sent message does, so nobody can learn which address exists.

| Limit                      | Value                                     |
| -------------------------- | ----------------------------------------- |
| Code lifetime              | 10 minutes, 6 digits                      |
| Wrong guesses per code     | 5                                         |
| Wrong guesses across codes | 10 an hour locks new codes for 15 minutes |
| Sends per recipient        | 5 an hour and 20 a day, per product       |
| Send requests per address  | 10 an hour, per product                   |
| Send requests per network  | 30 an hour, per product                   |
| Email starts per device    | 3 an hour                                 |

A person locked out by the wrong-guess limit sees nothing different and gets no new code for 15 minutes. Waiting is the fix.

## Raise a product's cap

A capped product shows its users "We can't send email right now." Set its own cap with a row in `email_product_caps`, or change the deployment value with `EMAIL_PRODUCT_DAILY_CAP`. The day is a sliding 24 hours. The statement is in _Sign-in email_ in the [runbook](/docs/operate/platform/runbook/set-up-sign-in-email/).

## Verify

- Send a sign-in to an address at a test Apple account's private relay and confirm it arrives.
- In Cloudflare, check the delivery rate (over 95 %), hard bounces (under 2 %) and complaints (under 0.1 %).
- Request a magic link to a mailbox you control and read the original message: SPF, DKIM and DMARC pass for `auth.plrs.im`.

## Roll back

- Delete a product's row in `email_product_caps` to return it to the deployment value.
- The Worker sends from `noreply@plrs.im` while `EMAIL_SENDER_ADDRESS` is unset.
- Clear a suppressed address in Cloudflare's list as well as ours. Otherwise the next send adds it back.

## Escalate

If the provider is down or the account quota is spent, no setting here helps. Keep the time of the first failure and escalate to the owner.
