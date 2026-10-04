---
title: "Device trust levels"
description: "basic and attested devices, App Attest and Play Integrity verification, the operator's trust policy, log-only enforcement, and the owner setup each attestation needs."
sidebar:
  order: 4
---

Under open registration anyone can hold a device token, and edge-mint and gated delivery trust
that token. A **trust level** adds the one signal a script cannot fake cheaply: proof that the
device runs a genuine store install of the product.

| Level      | Who has it                                                                                |
| ---------- | ----------------------------------------------------------------------------------------- |
| `basic`    | Every device. The expected level for web, desktop and sideloaded builds — not a red flag. |
| `attested` | A device that passed Apple App Attest or Google Play Integrity against a fresh challenge. |

The level lives on the device row. It is **not** carried in a signed document or in the device
token, so nothing on the wire changes and every existing SDK keeps working. It protects delivery
and server-side features; it does not protect the client binary.

## How a device attests

Both routes are Core routes, authenticated with the device bearer token:

1. `POST /<product>/devices/attest/challenge` returns a single-use `challenge` (five minutes,
   bound to this device) and `requestHash`, the one value the client hands the platform API.
2. The client runs the platform attestation:
   - **iOS:** `DCAppAttestService.attestKey(keyId, clientDataHash: SHA-256(requestHash))`;
   - **Android (Play build):** a standard Integrity API request with `requestHash`.
3. `POST /<product>/devices/attest` with `{kind: "app-attest", keyId, attestation, challenge}` or
   `{kind: "play-integrity", token, challenge}`. On success the device is `attested`.

The Godot SDK wraps all three as `PolarisKey.devices.attest()`. It answers Unsupported with reason
`runtime` on desktop and web, and `outlet` on a sideloaded or non-Play install.

Challenges are stored in KV. On rare occasions a challenge issued at one Cloudflare location has
not yet propagated to the location that receives the attest request a moment later; the attempt
answers `422 attestation_rejected`. Fetch a new challenge and retry.

Each device may ask for 10 challenges and make 4 attempts an hour. A failed attempt is recorded on
the device (the console's **Last verdict**) and never changes its level; an attested device stays
attested through a failed retry.

### What the Worker checks

**App Attest:** the attestation's certificate chain up to the pinned Apple App Attestation Root
CA; the nonce `SHA-256(authData ‖ clientDataHash)` against the certificate's extension
`1.2.840.113635.100.8.2`; the key id against the certificate key's hash; the RP ID hash against
`<TeamID>.<bundleId>` for the bundle id of a live App Store or TestFlight outlet; a counter of 0;
and the aaguid of the environment the policy names. The credential public key is kept for future
assertions.

**Play Integrity:** Google decodes the token with the product's pinned
`google-service-account` credential, then the package name, the request hash, a timestamp within
five minutes, `PLAY_RECOGNIZED` and `MEETS_DEVICE_INTEGRITY` must all hold. The licensing verdict
is recorded but not required.

### Keys die on reinstall

An App Attest key does not survive a reinstall, a restore or a device migration. The SDK makes a
new key and attests again; that is expected, not fraud. A keyless re-registration of a device id,
or a licence (re)bind, drops the device back to `basic` until it attests again, because a new
token minted without the old one is not proof of the same install.

**Attest after licence activation.** Because activating a licence key (or re-activating it) on a
device id mints a new token, it resets the device to `basic`. Call `attest()` after the device
holds its final token: after activation or enrollment, not before. A token refresh
(`/license/token`) keeps the level.

## The trust policy

The policy is operator-owned: only a platform admin sets it, never a manifest or a resync.

```http
PUT /manage/api/products/<slug>/trust-policy
{
  "mint": "attested",
  "gatedDelivery": "basic",
  "commerceClaim": "basic",
  "enforce": false,
  "appAttest": { "teamId": "ABCDE12345", "environment": "production" },
  "playIntegrity": { "cloudProjectNumber": "123456789012" }
}
```

`GET` reads it (the default when unset) and `DELETE` restores the default: every operation
`basic`, `enforce: false`, nothing configured.

- `mint`, `gatedDelivery` and `commerceClaim` say which operations need an `attested` device.
  `gatedDelivery` covers every surface that answers through a licence: Release's release records
  and artifacts (changelog, record and artifact routes) and Distribution's byte routes, appcasts
  and feeds when their access mode is `licensed` or `entitled`, and pack delivery gates.
  `commerceClaim` is consulted once the commerce bridge lands.
- `enforce: false` (the default) is **log-only**: a basic device that the policy would refuse
  proceeds, and one `device.trust.would_refuse` audit row per device and operation per hour
  records it. Watch the activity log, then set `enforce: true` to answer
  `403 attestation_required` instead (`device.trust.refused`).
- `appAttest.environment` is `production` for App Store and TestFlight builds and `development`
  for builds signed with a development profile. Only the named environment's aaguid is accepted.
- `playIntegrity.cloudProjectNumber` is handed to the client with each challenge, so the app needs
  no build-time setting.

## Owner setup

Nothing here can be done from the repository. Each item is a one-time step by the account owner.

**App Attest**

1. In the Apple Developer portal, enable the **App Attest** capability on the App ID, and add the
   `com.apple.developer.devicecheck.appattest-environment` entitlement (`production`) to the
   release build.
2. Note the 10-character **Team ID** and set it in the trust policy (`appAttest.teamId`).
3. Declare the app's `app-store` (and `testflight`) outlet with its `bundleId` in
   `.pkey/distribution`.

**Play Integrity**

1. In Google Cloud, create or pick a project, enable the **Play Integrity API**, and link the
   project in Play Console (**Release → App integrity → Play Integrity API**).
2. Note the **project number** and set it in the trust policy
   (`playIntegrity.cloudProjectNumber`).
3. Grant the service account the project's Play Integrity access, and store its key as the
   product's `google-service-account` outlet credential **pinned to the app's package name** (the
   same credential the Play connector uses). An unpinned or mispinned credential is never used to
   decode a token.
4. Declare the `play` outlet with its `packageName` in `.pkey/distribution`.

**Device checklist**

- A TestFlight build on an iPhone reaches `attested` (console → Devices → Trust).
- An internal-track Play build on a Play-certified Android device reaches `attested`.
- A sideloaded build (an AltStore IPA, a direct APK) stays `basic`, and the SDK reports
  Unsupported with reason `outlet`.
- With `mint: "attested"` and `enforce: false`, the sideloaded build still mints and a
  `device.trust.would_refuse` row appears; with `enforce: true` it gets `attestation_required`.
