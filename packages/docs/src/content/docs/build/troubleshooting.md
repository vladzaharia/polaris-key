---
title: "Troubleshoot your integration"
description: "Find the cause of an integration problem from the status or error code your app reports."
type: "troubleshooting"
lastReviewed: "2026-10-16"
sidebar:
  order: 8
---

Each entry starts from a license status or an error code your app reports. For the full list of codes, see [Wire error codes](/docs/reference/error-codes/).

## `needs-activation`

**Cause:** The device has no token and no imported bundle, so no license has been granted. A freshly installed app starts here.

**Fix:** Activate with a license key or through sign-in. For a test, create a license in **License → Licenses** or run `pkey dev` and use its `ok` key. A product with License off reports `not-applicable` instead and runs.

**Check it works:** The status changes to `ok`, and the device appears under **Core → Devices**.

## `unauthorized`

**Cause:** The device token or license key is missing, invalid, or belongs to a license that can no longer be used. A revoked, disabled or expired license answers this way at activation, and a revoked device sees the status `revoked`.

**Fix:** Open the license in the console and check that it is enabled and unexpired. Re-enter the key, or sign in again to get a new device token.

**Check it works:** Activation returns a document and the status is `ok`.

## `device_limit`

**Cause:** The license has no free device seat. The body may carry `limit`, `deviceCount` and a customer-portal link that frees a seat.

**Fix:** Deauthorize a device the customer no longer uses, or raise the license's device limit. [Device-limit recovery](/docs/features/licensing/device-limit/) shows what to put on screen.

**Check it works:** Activating again succeeds.

## `key_entry_limit`

**Cause:** A license that belongs to no account has used every key entry its product allows. `identity.keyEntry.limit` sets the count, 10 by default.

**Fix:** Have the customer sign in so the license joins their account, or raise the limit in `.pkey/product`. See [Identity settings](/docs/build/manifest/product/#identity-settings-identity).

**Check it works:** The next activation on a new device succeeds.

## `license_expired` and `license_disabled`

**Cause:** The license ended, or an operator turned it off. Offline, an expired document keeps working until its `graceUntil`; after that the status is `expired`.

**Fix:** Extend or enable the license in **License → Licenses**. The app picks the change up on its next sync.

**Check it works:** The status returns to `ok`.

## `version_blocked`

**Cause:** The license allows a range of app versions, and this build is outside it. The status is `version-too-old` or `version-too-new`, and the body carries the allowed range.

**Fix:** Ship a build inside the range, or widen the range on the license or its tier. See [Test your integration](/docs/build/test-your-integration/) to check both ends.

**Check it works:** The status is `ok` for the new build.

## `channel_not_allowed`

**Cause:** The license isn't entitled to the release track the app asked for, such as `beta`. The status is `channel-not-entitled`.

**Fix:** Add the track to the license or its tier, or point the app at a track it has.

**Check it works:** The status is `ok` on that track.

## `hardware_mismatch`

**Cause:** The device's fingerprint no longer matches the one its seat was bound to. A strict fingerprint mode also answers `fingerprint_required` when a request carries none.

**Fix:** Reset the hardware binding on the device, or deauthorize it so the customer can activate again. [Fingerprints](/docs/features/licensing/fingerprints/) explains the modes.

**Check it works:** The device activates and keeps its seat.

## `not_found` on every request

**Cause:** One answer covers an unknown product, a service the product has turned off and an unknown route, so a probe learns nothing. The usual causes are a wrong slug, a wrong base URL, or the service being off.

**Fix:** Compare the slug and base URL in the generated config file with the product. Run `pkey doctor --product <slug>` and read the services it lists. Turn the service on in **Core → Services**.

**Check it works:** `pkey doctor` lists the service, and the request answers.

## `service-unavailable`

**Cause:** The app called a sub-client whose service the product doesn't run.

**Fix:** Enable the service in **Core → Services**, or remove the call. [How it works](/docs/start/how-it-works/#coherence-rules) lists what each service requires.

**Check it works:** The sub-client answers instead of reporting the service as unavailable.

## `invalid-options`

**Cause:** The client's options failed validation when it was built: a bad product slug, version or base URL, or a malformed pin. A pinned release key that is also a trust pin is refused too.

**Fix:** Regenerate the config file with `pkey sdk --lang <lang> --product <slug> --write --force` and use it unedited.

**Check it works:** The client builds.

## `rate_limited`

**Cause:** The caller sent too many requests.

**Fix:** Back off and try again. Don't call `sync()` in a loop; the client refreshes before its documents expire.

**Check it works:** The next request answers.

## `signing_unavailable`

**Cause:** The platform couldn't open the product's signing key, so it served no document. This is an operator-side failure, and it is retryable.

**Fix:** Try again. If it persists, ask the platform's operator to check the KEK keyring.

**Check it works:** A document request returns a signed document.

## The app stays in grace after going back online

**Cause:** The last sync failed, so the cached document is still the one in use. Grace runs from the document's `graceUntil`, not from the clock.

**Fix:** Check that the app can reach the base URL, then sync. With `pkey dev`, run `pkey dev online` if you ran `pkey dev offline`.

**Check it works:** The status is `ok`.

## If it isn't working

- [Wire error codes](/docs/reference/error-codes/): every code the platform and the SDKs raise.
- [Run Polaris Key locally](/docs/build/local/): reproduce a state with a test key.
- [pkey CLI](/docs/reference/cli/): `pkey doctor` and `pkey validate`.
