---
title: "Activation"
description: "How a key becomes a device token: the request, the checks in order, token rotation and self-deauthorize."
type: "concept"
lastReviewed: "2026-10-16"
sidebar:
  order: 4
---

Activation redeems a `pkey_…` key for a `pkeyt_…` device token that the device uses for everything afterwards. Three routes make up the lifecycle: redeem, rotate and release.

## Redeem a key

```http title="Request"
POST /tidewater/license/activate
Authorization: Bearer <license key>
X-PKey-Device: <device id>
X-PKey-Version: 2.4.1
Content-Type: application/json

{ "fingerprint": { "components": { "machineUuid": "<hash>" } } }
```

The key travels in `Authorization`. `X-PKey-Device` is required. The body is optional and carries only a hardware fingerprint. A success is `200` with `token`, `schemaVersion` (the product's catalog version), `device` and `license`. [Enrollment](/docs/features/licensing/access/) returns the same shape, so an SDK reuses one result type for both paths.

The Worker checks, in order:

1. The method is `POST`, else `405`.
2. The rate limit: 30 attempts per 60 seconds per client network and product, else `429 rate_limited`. The limiter fails closed, because an open credential endpoint is a brute-force oracle against keys.
3. A bearer key is present, else `401 unauthorized`.
4. The device header is present, else `400 bad_request`.
5. The key hash exists and is `active`, else `401`.
6. The key's license exists, else `401`.
7. The key entry check, when Identity is on.

An unknown key, a revoked key, a missing license and a dead license all answer the same `401`. Telling them apart would let a caller enumerate real keys.

## The authorization pipeline

After the key checks, Core runs one shared decision. Sign-in activation runs the same one. The order of its side effects matters.

1. **License usable.** The license is `active` and not expired, else `401`.
2. **Fingerprint mode.** With the product's fingerprint policy on, the tier's mode wins, then the product's default, then `normal`. With it off the mode is `off`. See [Fingerprints](/docs/features/licensing/fingerprints/).
3. **Strict needs a fingerprint.** Only `strict` makes one mandatory: without it the answer is `403 fingerprint_required`. Other modes accept a client that sent none and record the device as `unverified`.
4. **Hardware reconcile**, before any seat decision. If the presented hardware differs from the stored hardware by more than the mode tolerates, the old binding is retired and the call answers `409 hardware_mismatch` with `drift` and `changed`. A retry binds the new hardware. If a new authorization presents hardware that an authorized sibling on the same license already holds, the stale id is retired so one device holds one seat.
5. **Seat claim**, only for a new authorization. A device refreshing its own seat skips it. A full license answers `403 device_limit`.
6. **Bind.** The device row is written with the request's platform, architecture, version and SDK headers. The Worker mints and stores a token hash, so a re-activation invalidates the old token at once. It also writes the server-recomputed fingerprint row, or an `unverified` marker.

```json title="Output"
{
  "error": "device_limit",
  "message": "device limit reached",
  "limit": 5,
  "deviceCount": 5,
  "manageUrl": "https://key.plrs.im/activate?product=tidewater&next=free-device"
}
```

`manageUrl` opens the Polaris Locker flow that frees a seat. It is present only while the product's Polaris Locker is on, never carries a key, account id or device id, and isn't an auth failure: offer it behind a user action such as **Replace a device**.

## Fingerprint body rules

An absent, empty, oversized (over 4 KiB) or unparseable body means no fingerprint, never an error, so shipped clients kept working when fingerprinting arrived. Unknown component names are dropped. A known component whose value isn't a base64url string of the canonical digest length rejects the whole fingerprint. The client's own `hwid` is ignored and recomputed on the server.

## Key entries

While Identity is on, the Worker counts how many times a license key was typed on a new device, so a key passed around in public stops working on new devices and points people at an account.

- **What counts.** A new device taking a seat through `/license/activate`, a browser key session, and a Polaris Locker claim. Rotation, document fetches and a device that is already enrolled don't count.
- **The member.** Every success carries `"keyEntries": { "used": 3, "limit": 10 }`. Show `max(0, limit − used)` entries left.
- **The limit.** The product setting `identity.keyEntry.limit`, from 1 to 100, capped by the platform setting of the same name.
- **The refusal.** With the platform switch `identity.keyEntryRefusals` on, a new device whose key belongs to a usable license in no account, at or past its limit, gets `403 key_entry_limit` with Polaris Locker's activate link as `manageUrl`. The switch is off until the SDKs that show the refusal ship. Counting runs either way.
- **Owned licenses.** With the same switch on, a usable license that is in an account refuses a device not enrolled on it: `403 license_owned` with `signInUrl`. The device reaches the license by signing in to that account.

With Identity off nothing is counted or refused.

## Rotate a token

```http title="Request"
POST /tidewater/license/token
Authorization: Bearer <device token>
X-PKey-Device: <device id>
```

The token and the device id must agree, else `401`. The token is checked for shape first: `pkeyt_` plus at least 43 base64url characters. The rate limit is 30 per 60 seconds per network and fails closed. Rotation deletes the old token record, so the previous token stops at once. The response is `token` and `schemaVersion`.

On a `401` from a document fetch, an SDK makes exactly one rotate attempt and then one retry of the fetch.

## Release a device

```http title="Request"
POST /tidewater/license/deauthorize
Authorization: Bearer <device token>
```

The device is marked `deauthorized`, its fingerprint and facts rows are purged, its seat frees and its token record is evicted. The response is `{"ok": true}`. No device header is needed, and the bucket (30 per 60 seconds) fails open.

A device token authenticates one device. Deauthorizing a sibling is refused with `403`, because any device could otherwise evict every other install. Cross-device management belongs on Polaris Locker.

## Next steps

- [The license model](/docs/features/licensing/model/): seat pools and dormancy.
- [Handle the device limit](/docs/features/licensing/device-limit/): what to show on `device_limit`.
- [Public routes](/docs/reference/routes/) and [error codes](/docs/reference/error-codes/).
