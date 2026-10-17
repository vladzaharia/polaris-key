---
title: "Verify licenses on your server"
description: "Check a device's signed license document on your own backend, with the verifier the SDKs use."
type: "how-to"
lastReviewed: "2026-10-16"
sidebar:
  order: 12
---

A backend that grants something to a device, such as a cloud save, a multiplayer seat or a download, shouldn't trust a "licensed" flag the client sends. It verifies the device's signed license document, a `pkey-license+jws`, as the SDKs do.

Requires the License feature, your product's trust pins and a backend on Node, Python or Kotlin.

## Steps

1. **App** Send the device's cached license document (the JWS) in an `X-PKey-License` header, and its device id in `X-PKey-Device`. The device's own copy comes from the license document route with its device token.
2. **Server** Load the product's pinned keys, the same ones `pkey sdk` writes into the config file, and the product slug, which is the document's audience.
3. **Server** Verify the document. A document that verifies has a valid signature from a pinned key, names this product and this device, and its issue time isn't ahead of the clock. A backend keeps no per-device history, so it doesn't apply the replay floor.
4. **Server** Read entitlements from the verified document, and deny when verification fails.

| SDK    | Verifier                                           | Arguments you pass                                                                                    |
| ------ | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Node   | `verifyLicenseDocument` from `@polaris-key/server` | `trust`, `product`, `deviceId`, and optionally `now`                                                  |
| Python | `verify_license_doc` from `polaris_key`            | The pinned keys, `expected_aud`, `device_id`, `last_accepted_issued_at=None`, `check_freshness=False` |

The Node helper returns `ok: false` for any invalid document. For a valid one it returns the document, the gate `state`, `usable`, `ageSeconds`, `isEntitled(name)` and `entitlementValue(name)`. Both entitlement getters answer as unentitled when the gate isn't usable. The Python function returns the document or `None`, and you read `doc.entitlements`.

Offline, a document is expected to be past its short `expiresAt`, so the helper applies the gate: `ok` and `grace` are usable and `expired` isn't. Revocation shows up as the server no longer issuing fresh documents. A backend that needs revocation bounds the document's age with `ageSeconds` and asks the app to sync first.

A web backend can let a drop-in do steps 2 to 4 instead: it reads the two headers, verifies offline against the trust manifest and answers `401` or `403` with a problem body when it refuses. `@polaris-key/server` has drop-ins for Express, Hono and Next.js; `polaris_key.server` for FastAPI, Starlette, Django, DRF and Flask; `polaris-key-server-ktor` for Ktor.

The SDK pages carry the compiled code for each runtime. See [Node](/docs/build/sdks/node/) and [Python](/docs/build/sdks/python/).

## Check it works

Verify a document from `pkey dev` ([Run Polaris Key locally](/docs/build/local/)) with the dev run's pins, then change the device id and see the verification fail.

## If it isn't working

- A document for another device or product fails: check the device id and the slug.
- A pin mismatch fails: use the keys from the product's config file, not another environment's.
- [License document](/docs/reference/protocol/license-document/): the envelope you are verifying.
- [Troubleshoot licensing](/docs/features/licensing/troubleshooting/).
