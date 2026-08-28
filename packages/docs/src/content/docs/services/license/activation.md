---
title: "Activation"
description: "Redeeming a key for a device token: the request, the authorization pipeline in order, token rotation, and self-deauthorize."
sidebar:
  order: 3
---

Activation is the hot path: a user pastes a `pkey_…` key, and one machine walks away with a
`pkeyt_` device token it will use for everything afterwards. Three routes make up the lifecycle
— redeem, rotate, release.

## `POST /<product>/license/activate`

```http
POST /djdl/license/activate
Authorization: Bearer pkey_djdl_kf9Q2xR7bN4vL1mZ
X-PKey-Device: 7Yb2Qh8sK1nR4tV9wX3zA6cD0eF5gH7j
X-PKey-Version: 2.4.1
Content-Type: application/json

{ "fingerprint": { "components": { "machineUuid": "…", "cpuModel": "…" } } }
```

The key rides in `Authorization`, not the body. `X-PKey-Device` is **required**; the body is
**optional** and carries nothing but a hardware fingerprint.

A success is `200` with four fields:

| Field | Contents |
| --- | --- |
| `token` | The minted `pkeyt_` device token. Never shown again. |
| `schemaVersion` | The product's active catalog version — not the wire version. |
| `device` | The device as the server now sees it: id, status, labels, platform/arch, SDK name and version, first and last seen. |
| `license` | Id, status, name, email, tier id, activation time, expiry, `maxOfflineDays`, channels, and the version window. |

[Enrollment](/docs/services/license/enrollment/) returns this **exact** shape, which is why an
SDK reuses one activation result type for both paths with no new client plumbing.

### The request checks, in order

1. **Method.** Anything but `POST` is `405`. The method check lives in the handler, so a
   `GET /license/activate` is a `405` rather than falling through to the router's `404`.
2. **Rate limit.** Bucket `activate`, 30 attempts per 60 seconds, keyed by client IP and
   product. Over the limit is `429 rate_limited`. This bucket **fails closed**: if the limiter
   itself is unavailable the request is refused, because an unlimited credential endpoint is a
   brute-force oracle against license keys.
3. **Bearer key.** Absent is `401 unauthorized`.
4. **Device header.** Absent is `400 bad_request`, "missing device id".
5. **Key lookup.** The key is hashed with the deployment pepper and looked up by hash. A key
   that does not exist, or whose status is not `active`, is `401`.
6. **License lookup.** A key whose license row has vanished is `401`.

:::note[One 401 for several causes]
Unknown key, revoked key, missing license, and dead license all answer `401 unauthorized` with
no distinguishing detail. Telling them apart would let a caller enumerate which key strings are
real and probe license state from outside.
:::

On success the key's `last_used_at` is stamped — which is what the console's key list shows, and
the only trace redemption leaves on the key row.

## The authorization pipeline

Everything after the key check is `authorizeDevice`, which is Core's because Identity's sign-in
paths run the identical decision. The order of its side effects is load-bearing, not incidental:

```text
license usable
  → tier lookup
    → fingerprint mode resolution
      → strict-requires-fingerprint
        → reconcileDeviceHardware
          → seat claim
            → bindDevice
```

### 1. License usable

`status = 'active'` and either no `expires_at` or one still in the future. A failure here is
`401 unauthorized`, the same answer a bad key gets.

### 2. Tier lookup

The license's `tier_id`, if it has one, is read now — its `policy_fingerprint` decides the next
step, and its `policy_device_limit` reaches the seat check later as an entitlement.

### 3. Fingerprint mode resolution

```text
mode := product.fingerprintPolicy.enabled
          ? (tier.policy_fingerprint ?? product.defaultMode ?? "normal")
          : "off"
```

The product-level switch wins outright: turning fingerprinting off for a product forces `off`
regardless of what any tier says. Otherwise the tier's mode wins over the product default, and
`normal` is the floor when neither names a valid mode. Tolerances per mode are in
[Fingerprint constants](/docs/reference/fingerprint-constants/).

### 4. Strict requires a fingerprint

`strict` is the **only** mode that makes a fingerprint mandatory. Without one it is
`403 fingerprint_required`. Every other mode tolerates a client that sent nothing — including
clients that predate fingerprinting entirely, which `bindDevice` later records as `unverified`
so an operator can tell "old client" from "declined to identify".

### 5. `reconcileDeviceHardware`

Core reconciles the presented hardware against what this product already knows, **before** any
seat decision. Two things can happen:

- **Mismatch.** The presented components differ from the stored ones by more than the mode
  tolerates. The existing binding is *retired* — the device is deauthorized, its fingerprint and
  facts rows are purged, its cached token record is evicted — an audit entry
  (`device.fingerprint.mismatch`) is written, and the call answers
  `409 hardware_mismatch` with `drift` and `changed`.

  It is a `409` and not a `403` deliberately: the caller resolves it by simply retrying
  activation, which re-binds the new hardware cleanly. A flat `403` reads as "never going to
  work". Retiring rather than rebinding in place is also deliberate — the old machine is gone
  and must not keep holding a seat.

- **Coalescing.** For a *new* authorization presenting hardware that already has an authorized
  sibling device id on the same license, the stale id is retired (audit
  `device.seat.coalesced`) so one machine holds one seat. See
  [Seat pools](/docs/services/license/model/#seat-pools-and-devicelimit).

This runs before the seat check for two behavioural reasons: a swapped machine gets a precise
`hardware_mismatch` instead of a confusing `device_limit`, and a coalesced sibling has already
released its seat by the time capacity is counted.

### 6. Seat claim

Only when this is a **new authorization** — no device row, a non-authorized one, or one bound to
a different license. A device refreshing its own seat skips this step entirely.

The limit is read as the `deviceLimit` entitlement (falling back to the product default), the
active devices are pre-counted with the dormancy floor applied, and then the ordinal is claimed
atomically in the database. Either failure is:

```json
{
  "error": "device_limit",
  "message": "device limit reached",
  "limit": 5,
  "deviceCount": 5
}
```

with status `403`. A non-positive limit denies rather than meaning "unlimited".

### 7. `bindDevice`

The rows the binding consists of, written only once a seat is granted:

- The `devices` row — upserted, preserving `first_seen`, the user's label, per-device overrides
  and the reported snapshot, and folding in the request's `X-PKey-Platform`, `X-PKey-Arch`,
  `X-PKey-Version`, `X-PKey-SDK` and `X-PKey-SDK-Version`.
- The token: minted, hashed, stored on the device row. Any previous token record is deleted from
  KV, so a re-activation invalidates the old credential immediately.
- The fingerprint row — `verified`, with the **server-recomputed** hwid and the anchor hash. If
  the match was tolerated drift, a `device.fingerprint.drift` audit entry records what changed.
- Or, when no fingerprint was presented and the mode is not `off`, an `unverified` marker row —
  written only if no prior row exists.
- The KV token record: product, device id, license id.

## The fingerprint body

`/activate` carried no body before fingerprinting existed, so the reader is deliberately
forgiving. An absent, empty, oversized (over 4 KiB), or unparseable body means **"no
fingerprint"** and never an error — otherwise every already-shipped client would have started
failing the day fingerprinting deployed. Whether a missing fingerprint is *acceptable* is the
tier's decision, taken at step 4.

Validation of what is present is strict, though:

- Component names the worker does not know are **dropped**, so a newer SDK reporting an
  unfamiliar component still activates.
- A known component whose value is not a string of exactly the canonical digest length in the
  base64url alphabet rejects the **whole** fingerprint (it becomes "no fingerprint").
- An empty component map is "no fingerprint".
- The client's own `hwid` is **ignored and recomputed server-side**. A forged hwid would
  otherwise let a caller collide with another device's dedupe key; recomputing removes the
  surface entirely.

## `POST /<product>/license/token`

Rotate or re-acquire the token for a device that is already authorized.

```http
POST /djdl/license/token
Authorization: Bearer pkeyt_…
X-PKey-Device: 7Yb2Qh8sK1nR4tV9wX3zA6cD0eF5gH7j
```

Both the **current token** and the **matching device id** are required, and the two must agree —
a token presented with somebody else's device header is `401`. Rate limit: bucket `token`, 30
per 60 seconds per IP, fail-closed like activation.

Rotation deletes the old KV token record, writes the new hash onto the device row, and installs
the new record — so the previous token stops working at once rather than at KV expiry. The
response is `token` and `schemaVersion`; no device or license block.

The token itself is checked on **shape** first: `pkeyt_` followed by at least 43 base64url
characters. Anything else — a license key, a session cookie value, a browser-session token
pasted into the header — is refused before the pepper HMAC and the KV/D1 reads it would
otherwise cost.

:::tip[The client contract]
Wire contract v3 §5: on a `401` from a document fetch, an SDK makes **exactly one**
`POST /license/token` re-acquire attempt, then **one** retry of the failed fetch. Not a loop.
:::

## `POST /<product>/license/deauthorize`

Self-deauthorize the bearer token's own device.

```http
POST /djdl/license/deauthorize
Authorization: Bearer pkeyt_…
```

The device is marked `deauthorized` — which purges its fingerprint and facts rows and frees its
seat — and its token record is evicted from KV. The response is `{"ok": true}`.

Two asymmetries with `/token` are worth knowing:

- No `X-PKey-Device` header is required. The token identifies the device on its own; the header
  on `/token` exists to make rotation refuse a mismatched pairing.
- There is no rate limit bucket on this route. It destroys a credential rather than minting one.

A device token authenticates **one** device, not the license. Deauthorizing a *sibling* device is
refused on Core's `/devices/<id>` surface with `403`, because any device could otherwise evict
every other install on the same license — and the eviction purges the victim's fingerprint, so
it is not even recoverable by re-activating the same hardware. Cross-device management belongs on
the portal, which authenticates the license owner.

## Behaviour pinned by tests

- `test/enroll.test.ts` — "still enforces the tier's device limit when distinct machines share a
  license": two distinct machines fill a two-seat license through `/activate`, and a third gets
  `403 device_limit`.
- `test/enroll.test.ts` — the R3-11 case: four authorizations from one machine under four device
  ids leave exactly one authorized device, named by the newest id.
- `test/relicense.test.ts` — "refuses a NEW activation once over the downgraded limit": after a
  downgrade the existing devices keep working and the next activation is `403 device_limit`.
- `test/fingerprintPolicy.test.ts` — the admin fingerprint reset clears a device's binding
  **without** deauthorizing it, so a false-positive drift lockout does not cost the user a seat.

## Reference

- [Public route table](/docs/reference/routes/) — every route with its owning service.
- [Wire error codes](/docs/reference/error-codes/) — `unauthorized`, `device_limit`,
  `fingerprint_required`, `hardware_mismatch`, `rate_limited`, `bad_request`.
- [The license model](/docs/services/license/model/) — seat pools, dormancy, and where
  `deviceLimit` is resolved.
