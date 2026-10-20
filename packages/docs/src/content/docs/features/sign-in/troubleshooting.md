---
title: "Troubleshoot sign-in"
description: "Find the cause of a sign-in error from the code or message you see."
type: "troubleshooting"
lastReviewed: "2026-10-16"
sidebar:
  order: 7
---

Entries are ordered by how often they happen. Every code is in the [error codes](/docs/reference/error-codes/) reference.

## timeout

**Cause** The device code lived its 600 seconds and nobody finished sign-in, or the flow was already redeemed. The Worker deletes the flow when a poll returns `ready` or `timeout`.

**Fix** Start the sign-in again and show the new code. Poll no faster than the advertised `interval`.

**Check it works** The poll returns `pending`, then `ready` after the person confirms.

## slow_down

**Cause** A second poll arrived inside the 2-second `interval`. The answer is `429` with `interval`.

**Fix** Wait the `interval` between polls. The SDKs' `waitForSignIn()` and `wait_for_sign_in` do this and honor `slow_down`.

**Check it works** The next poll returns `pending` or `ready`.

## That code isn't valid or has expired

**Cause** The user-code page found no unconfirmed flow for the code: it was mistyped, expired, or already confirmed. The page never says which.

**Fix** Check the code on the device. Codes are eight consonants and ignore case, spaces and hyphens. If it still fails, start a new sign-in.

**Check it works** The page shows the confirmation step with the product and device name.

## forbidden

**Cause** The identity matched no group in `groupRoleMap` and the product has no `oidcDefault` policy. Or a logout arrived without a matching `X-CSRF-Token`.

**Fix** Add the group to the map, or set an `autoIssue` policy with mode `oidcDefault` or `both` and a tier. See [Product sign-in provider](/docs/features/sign-in/oidc/).

**Check it works** A person in that group signs in and gets a license on the mapped tier.

## unauthorized

**Cause** The ID token failed verification: a wrong audience, issuer or algorithm, a token older than 5 minutes, a missing `nonce`, or an empty `sub`. On the poll it also means the `deviceId` differs from the one given at start.

**Fix** Check the provider's client id and issuer against the product's `oidc:` block, and that the provider's clock is right. Send the same device id to start and poll.

**Check it works** The sign-in completes with no `401`.

## misconfigured

**Cause** A custom issuer isn't on the Worker's `OIDC_ISSUER_ALLOWLIST`, or the product has no usable provider configuration. The Worker fails closed before it opens the client secret.

**Fix** Ask the platform operator to add the issuer's host to the allowlist, or fix the `oidc:` block and select **Resync from repo** on **Identity → Sign-in**.

**Check it works** The sign-in redirects to the provider.

## license-unusable

**Cause** The identity already has a license and it is disabled, expired or revoked. Sign-in never revives it.

**Fix** Enable or extend the license on **License → Licenses**. See [Manage licenses](/docs/features/licensing/manage-licenses/).

**Check it works** The person signs in and the status is `ok`.

## device_limit

**Cause** Sign-in tried to seat a device on a license with no free seat.

**Fix** Free a seat. See [Handle the device limit](/docs/features/licensing/device-limit/).

**Check it works** The sign-in returns a token.

## registration_closed

**Cause** The product requires sign-in for keyless registration and the request had no valid product session, or Identity is off for the product.

**Fix** Sign in first, then register. Turn Identity on under **Core → Services** if the product should offer sign-in.

**Check it works** Registration returns a device token.

## step_up_required

**Cause** A Polaris Locker action, such as a new key, a method change or an export, needs a sign-in within 5 minutes.

**Fix** Sign in again, then retry.

**Check it works** The action succeeds.

## email_unavailable

**Cause** The platform can't send mail: no sender is configured, or the sender is throttled or failing.

**Fix** A platform operator checks the email binding. Customers can use another sign-in method meanwhile.

**Check it works** The email start answers `ok` and a code arrives.

## signin_expired

**Cause** This browser's email sign-in, gate or passkey request is gone: used, expired, canceled or started in another browser.

**Fix** Start again in the same browser. Open a magic link in the browser that asked, or confirm it there.

**Check it works** The code or link signs in.

## email_in_use

**Cause** The proven address belongs to another Polaris Locker account. Nothing was created or joined.

**Fix** Choose the join offer and prove the other account in the same browser, or use a different email.

**Check it works** The sign-in lands in one account.

## auth_method_disabled

**Cause** The requested method is off: Polaris Locker's sign-in method for the product, or email codes for an enforced single sign-on domain.

**Fix** Turn the method on under **Identity → Portal**, or sign in through the organization's connection.

**Check it works** The method works on the login card.
