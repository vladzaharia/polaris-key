---
title: "Enrollment and policy"
description: "Keyless licenses for products that opt in, one license per device, the claim and migrate merge, and who owns the fingerprint and access policy."
type: "concept"
lastReviewed: "2026-10-16"
sidebar:
  order: 5
---

Enrollment is the keyless path: the Worker issues a license bound to the device, authorizes the device and returns the same body as [activation](/docs/features/licensing/activation/). Activation redeems a key. Enrollment creates the license it then authorizes against.

## Enroll a device

```http title="Request"
POST /tidewater/license/enroll
X-PKey-Device: <device id>
Content-Type: application/json

{ "fingerprint": { "components": { "machineUuid": "<hash>" } } }
```

There is no `Authorization` header. The response has `token`, `schemaVersion`, `device` and `license`.

Enrollment exists only for products that opt in through the access policy:

| Field              | Meaning                                               |
| ------------------ | ----------------------------------------------------- |
| `enabled`          | The opt-in. Off by default.                           |
| `tierId`           | The tier the license lands on. Required.              |
| `mode`             | `anonymous`, `oidcDefault` or `both`.                 |
| `rateLimitPerHour` | Per-network ceiling. `0` disables it. Defaults to 10. |

`anonymous` opens `/license/enroll`. `oidcDefault` opens nothing: a signed-in user who matches no group lands on the policy's tier instead of being refused. `both` does both. The policy has no console control. Set the `autoIssue` block in `.pkey/product`, or `PATCH` it through the admin endpoint below.

An `enabled: true` policy with no `tierId` reads as disabled, and unparseable JSON reads as off. The policy never fails open into minting free licenses.

The Worker checks, in order: method `POST`; the policy; the rate limit (`429 rate_limited`); the device header (`400`); that the tier exists; a fingerprint; then it finds or mints the license and runs the activation pipeline.

:::caution[A 404 here means enrollment is closed]
Every closure answers `404 enroll_disabled`: the product never opted in, or the policy names a missing tier or none. SDKs treat it as "this product has no keyless path" and fall back to activation. It isn't a transport error to retry.
:::

## One license per device

Enrollment requires a fingerprint whatever the tier's mode, and the fingerprint must include the anchor component (`machineUuid`). Otherwise the answer is `403 fingerprint_required`.

The dedupe key hashes the anchor alone, under its own domain prefix. A device hash digests whatever components were sent, so a computer could present 127 different subsets and collect 127 free licenses. Any subset that contains the anchor gives one key.

A unique index on `(product, enroll_hwid)` enforces it. Concurrent first runs converge on one license. A second enrollment from the same device, even under a different device id, returns the same license.

The minted license is `active`, anonymous (no name, email or subject), on the policy's tier, with the tier's expiry policy applied and `origin = enroll`.

A claimed device can't enroll again. After an identity claims or merges the license, the key stays and an anonymous caller from that device gets `403 enroll_claimed`: sign in to use it. An anonymous enrolled license that a member disabled answers `403 license_disabled`.

## Claim and migrate

A sign-in can merge an anonymously enrolled license into an identity. The only caller that does is the device-code poll, and only when the person accepts it on the device after seeing the identity. A device-code callback alone activates nothing. See [Device flow](/docs/features/sign-in/device-flow/).

Only a license with `origin = enroll` and no subject is claimable. Any other license the device holds is left alone.

- **Claim.** The identity is new, so it attaches to the same row: subject, name and email are written, the tier and expiry follow the group mapping, `origin` becomes `oidc` and the key is kept. Devices and local state survive. The result carries `merged: "claimed"`.
- **Migrate.** The identity already has a license. The enrolled row's devices move onto it, each taking a free seat, and the migrate is refused when they don't fit. Store purchases follow. The enrolled row is disabled and keeps its key. It is one batch: everything moves or nothing does. The result carries `merged: "migrated"`.

The retired row keeps its key because the unique index is the only guard on one free license per device.

An enrolled license is an ordinary license. Seat limits, fingerprint drift, re-licensing and the build gate apply to it unchanged.

## The policy and who owns it

The fingerprint policy decides how tightly a device binds to its hardware. The access policy decides whether an unrecognized install mints a license. Both are declared in `.pkey/product` and editable live, so each carries an owner: `manifest` or `admin`.

| Policy        | Fields                                          | Absent or malformed            |
| ------------- | ----------------------------------------------- | ------------------------------ |
| Fingerprint   | `enabled`, `defaultMode`, `probes`              | The default: enabled, `normal` |
| Access policy | `enabled`, `tierId`, `mode`, `rateLimitPerHour` | Off                            |

The fallbacks differ on purpose: a malformed fingerprint policy must never take licensing offline, and a malformed access policy must never mint free licenses.

- **Console** The fingerprint policy is on **License → Enrollment**: choose a **Mode** (Off, Lenient, Normal or Strict). The page also lists the declared probes and returns the device policy to the manifest. Access policy has no console control.
- A manifest write (a resync after a push) applies only where the owner is still `manifest`. An admin write always wins and sets the owner to `admin`.
- Any `PATCH` claims the fingerprint policy. The access policy is claimed only when the body includes `autoIssue`.
- Revert sets the owner back to `manifest` for both policies and restores no values. The next resync reapplies the manifest.

The admin endpoint is `/manage/api/products/<slug>/license/policy`, with `GET`, `PATCH` and a `revert` sub-path. A rejected `PATCH` is `422` with every failing field path in `fields`, and it writes nothing. Probes are validated by running the runtime parser: a probe it would drop, such as one with no `id`, is refused. Enabling access policy against a tier that doesn't exist is refused. `pkey validate` reports the same rules as manifest codes; see [Validation codes](/docs/reference/validation-codes/).

To clear a false-positive drift lockout without costing the user a seat, reset the device's fingerprint with the endpoint below (a `POST`). It clears the binding and leaves the device authorized.

```text title="Admin endpoint"
/manage/api/products/<slug>/license/licenses/<id>/devices/<deviceId>/fingerprint/reset
```

## Next steps

- [The license model](/docs/features/licensing/model/): origins and seat pools.
- [Fingerprints](/docs/features/licensing/fingerprints/): modes and tolerances.
- [Manage licenses](/docs/features/licensing/manage-licenses/): the console side.
