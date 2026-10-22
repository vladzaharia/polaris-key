---
title: "Device trust levels"
description: "Basic and attested devices, how App Attest and Play Integrity raise a level, and the trust policy that decides which operations need one."
type: "concept"
lastReviewed: "2026-10-16"
sidebar:
  order: 9
---

Under open registration anyone can hold a device token. A trust level adds the one signal a script can't cheaply fake: proof that the device runs a genuine store install of the app.

| Level      | Who has it                                                                           |
| ---------- | ------------------------------------------------------------------------------------ |
| `basic`    | Every device. The expected level for web, desktop and sideloaded builds.             |
| `attested` | A device that passed Apple App Attest or Google Play Integrity on a fresh challenge. |

The level lives on the device row. It isn't in a signed document or the device token, so nothing on the wire changed. It protects delivery and server-side features, not the client binary.

## How a device attests

Both routes are Core routes, authenticated with the device token.

1. `POST /<product>/devices/attest/challenge` returns a single-use `challenge` (valid 5 minutes, bound to the device) and a `requestHash`.
2. The SDK runs the platform check: App Attest on iOS, or a standard Integrity API request on a Play build.
3. `POST /<product>/devices/attest` sends the result. On success the device is `attested`.

Swift, Kotlin and Godot call these routes through `client.devices.attest()` (Godot: `PolarisKey.devices.attest()`). They answer unsupported with reason `runtime` on desktop and web, and `outlet` for a sideloaded or non-Play install. Node and Python have no platform attestation service.

A device may ask for 10 challenges and make 4 attempts an hour. A failed attempt is recorded on the device and never lowers the level. A challenge issued in one Cloudflare location can briefly be missing in another: the attempt answers `422 attestation_rejected`, so fetch a new challenge and retry.

The Worker verifies App Attest against the pinned Apple root, the nonce, the key id, the RP ID hash for `<TeamID>.<bundleId>` of a live App Store or TestFlight outlet, a zero counter and the environment's aaguid. For Play Integrity, Google decodes the token with the product's pinned `google-service-account` credential, then the package name, request hash, a timestamp within 5 minutes, `PLAY_RECOGNIZED` and `MEETS_DEVICE_INTEGRITY` must hold.

An App Attest key doesn't survive a reinstall, restore or migration, so the SDK attests again with a new key. A keyless re-registration, or activating a license on a device id, mints a new token and drops the device back to `basic`. Attest after the device holds its final token. A token refresh keeps the level.

## The trust policy

Only a member who holds the Keys & secrets area (`keys`) for the product sets the policy; a manifest or resync never does. It is the setting `core.trustPolicy`, at `/manage/api/products/<slug>/settings/core.trustPolicy` (`GET`, `PATCH` with the policy as `value`, and `DELETE`). `DELETE` restores the default: every operation `basic`, `enforce: false`, nothing configured.

```json title="Trust policy"
{
  "mint": "attested",
  "gatedDelivery": "basic",
  "commerceClaim": "basic",
  "enforce": false,
  "appAttest": { "teamId": "<Team ID>", "environment": "production" },
  "playIntegrity": { "cloudProjectNumber": "<project number>" }
}
```

- `mint`, `gatedDelivery` and `commerceClaim` name the operations that need an attested device. `gatedDelivery` covers release records and artifacts, and Distribution's byte routes, appcasts and feeds when their access mode is `licensed` or `entitled`, and pack delivery gates.
- `enforce: false` is log-only. A basic device that the policy would refuse proceeds, and one `device.trust.would_refuse` audit row per device and operation per hour records it. Set `enforce: true` to answer `403 attestation_required` instead.
- `appAttest.environment` is `production` for App Store and TestFlight, `development` for development-profile builds. Only that environment's aaguid is accepted.
- `playIntegrity.cloudProjectNumber` goes to the client with each challenge, so the app needs no build-time setting.

## Owner setup

Each step is done once by the account owner, outside the repository.

**App Attest**

1. In the Apple Developer portal, enable **App Attest** on the App ID and add the `com.apple.developer.devicecheck.appattest-environment` entitlement (`production`) to the release build.
2. Put the 10-character Team ID in `appAttest.teamId`.
3. Declare the `app-store` and `testflight` outlets with their `bundleId` in `.pkey/distribution`.

**Play Integrity**

1. In Google Cloud, enable the **Play Integrity API** and link the project in Play Console under **Release → App integrity → Play Integrity API**.
2. Put the project number in `playIntegrity.cloudProjectNumber`.
3. Store the service account's key as the product's `google-service-account` outlet credential, pinned to the app's package name. An unpinned or mispinned credential is never used to decode a token.
4. Declare the `play` outlet with its `packageName` in `.pkey/distribution`.

## Next steps

- [Require attested devices](/docs/features/licensing/attestation/): what the app does when refused.
- [Fingerprints](/docs/features/licensing/fingerprints/): the weaker, hardware-based signal.
- [Error codes](/docs/reference/error-codes/): `attestation_required` and `attestation_rejected`.
