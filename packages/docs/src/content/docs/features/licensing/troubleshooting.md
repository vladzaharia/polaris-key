---
title: "Troubleshoot licensing"
description: "Find the cause of a licensing error from the code or message you see."
type: "troubleshooting"
lastReviewed: "2026-10-16"
sidebar:
  order: 14
---

Entries are ordered by how often they happen. Every code is in the [error codes](/docs/reference/error-codes/) reference.

## device_limit

**Cause** The license is at its device limit. Devices not seen for 90 days no longer count. A tier downgrade also leaves existing devices in place and refuses new ones.

**Fix** Make room for another device. The user deauthorizes a device from another activated device, or from Polaris Locker through the response's `manageUrl`. A member can **Deauthorize** a device or raise the limit with **Device limit…** on the license. See [Handle the device limit](/docs/features/licensing/device-limit/).

**Check it works** Activation succeeds, and the license's **Devices** meter shows room for another device.

## unauthorized

**Cause** One answer covers an unknown key, a revoked key, a missing license and a disabled or expired license. It is the same on purpose, so a caller can't probe which keys exist. On a document fetch it also means the device token was rotated or the device was deauthorized.

**Fix** Check the license in the console: its state, its expiry and whether the key is revoked. For a device token, the SDK makes one rotate attempt and one retry. If that fails, activate again.

**Check it works** The license shows **Active** and activation returns a token.

## hardware_mismatch

**Cause** The presented hardware differs from the stored hardware by more than the fingerprint mode tolerates. The Worker retired the old binding.

**Fix** Retry activation: it binds the new hardware as a new authorization. To avoid spending a re-activation, a member selects **Reset binding** on the device before the user hits it. If customers legitimately run several instances on one host, switch the mode to **Off** on **License → Enrollment**. See [Fingerprints](/docs/features/licensing/fingerprints/).

**Check it works** The device appears authorized, with a fresh binding.

## fingerprint_required

**Cause** The tier's mode is `strict` and the request carried no fingerprint. Enrollment also requires one, with the anchor component, whatever the mode.

**Fix** Update the SDK to one that collects a fingerprint, or lower the tier's mode. On a host with no machine id, such as a container image, there is no anchor: enrollment can't work there.

**Check it works** Activation or enrollment returns a token.

## key_entry_limit

**Cause** The license, in no account, has used every key entry, and the platform switch `identity.keyEntryRefusals` is on.

**Fix** Send the user to the `manageUrl` in the response, where the key joins an account. Don't treat it as an auth failure: keep the app's state. See [Activation](/docs/features/licensing/activation/).

**Check it works** After the key joins an account, the app signs in and the license activates.

## license_owned

**Cause** The license is in a Locker account, and an owned license never moves by presenting its key.

**Fix** Sign in to the account that holds the license. The response carries `signInUrl`.

**Check it works** The sign-in activates the device on the license.

## enroll_disabled

**Cause** Keyless enrollment is closed: the product never opted in, or its policy names a missing tier. The answer is `404` on purpose.

**Fix** In the app, fall back to key activation. To open the path, set the `autoIssue` block with a valid tier. See [Enrollment and policy](/docs/features/licensing/access/).

**Check it works** Enrollment returns a token.

## enroll_claimed

**Cause** This device's free license now belongs to an identity.

**Fix** Sign in with that identity. An anonymous enrollment from the device is refused from now on.

**Check it works** Signing in activates the claimed license.

## license_disabled

**Cause** A member disabled the license, or an anonymous enrolled license was disabled.

**Fix** Re-enable it with **Enable license**, or issue a new license. A license that ended by refund or chargeback can be restored only by the store's reversal. See [The license model](/docs/features/licensing/model/).

**Check it works** The license shows **Active**.

## attestation_required

**Cause** The trust policy needs an attested device and enforces it. This device is `basic`.

**Fix** Swift and Kotlin attest and retry once by themselves. Godot calls `attest()` and retries once. A sideloaded or desktop build can't attest. See [Require attested devices](/docs/features/licensing/attestation/).

**Check it works** The device attests and the call succeeds.

## attestation_rejected

**Cause** The challenge was unknown, used, expired or another device's, or the App Attest object or Play Integrity verdict failed a check. The trust level is unchanged.

**Fix** Fetch a new challenge and retry. A challenge from another Cloudflare location can lag briefly. Check the Team ID, bundle id and package name in the trust policy.

**Check it works** The retry returns `attested`.

## rate_limited

**Cause** Too many attempts. Activation and token rotation allow 30 per 60 seconds per client network. Enrollment allows `rateLimitPerHour` (10 by default).

**Fix** Wait, and don't loop. In an automated test, use `pkey dev` instead of a deployed product.

**Check it works** The next attempt after the window succeeds.

## version_blocked

**Cause** The build gate refuses this app version. The body carries the allowed range.

**Fix** Update the app, or widen the version window on the tier or license.

**Check it works** The SDK status is no longer `version-too-old` or `version-too-new`.

## channel_not_allowed

**Cause** The license isn't entitled to the release track the build asked for.

**Fix** Add the track to the tier's or the license's **Release channels**.

**Check it works** The SDK status is no longer `channel-not-entitled`.
