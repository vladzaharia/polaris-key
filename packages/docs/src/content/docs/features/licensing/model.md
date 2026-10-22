---
title: "The license model"
description: "License, key, device, tier and entitlement: how they relate, how the device limit works and how a license ends."
type: "concept"
lastReviewed: "2026-10-16"
sidebar:
  order: 3
---

A license is the account a device's place hangs off. A key activates one device, a tier shapes the license, and the signed license document tells the device what it may do.

## The nouns

| Noun        | What it is                                                                                                         |
| ----------- | ------------------------------------------------------------------------------------------------------------------ |
| License     | The record that holds entitlements and the device limit. A member disables it when a customer stops paying.        |
| Key         | A `pkey_…` secret that activates one device each. A license can have many keys.                                    |
| Device      | One install with its own `pkeyt_…` token. Devices belong to Core, so products without licensing have them too.     |
| Tier        | A named license template: a profile, a device limit, an expiry, release tracks and a version window.               |
| Entitlement | A named right the device gets. Entitlements travel in the license document only; the config document carries none. |

Nothing about a license is per device. A device authenticates with its own token from the moment activation succeeds, so revoking one key leaves every other key and every activated device untouched.

The console shows a key once. The Worker stores only a peppered hash, so nothing can recover it.

## Where an entitlement comes from

The Worker merges layers on every document request, later layers winning: catalog defaults, the tier's profile, the license's profiles, store grants, license overrides, account overrides, device overrides. Licensing then stamps its own entries on top:

| Entitlement         | Source                                           |
| ------------------- | ------------------------------------------------ |
| `license.tier`      | The license's tier                               |
| `license.tierLabel` | The tier's label                                 |
| `channels`          | The union of the tier's and the license's tracks |
| `deviceLimit`       | The tier's device limit, when it sets one        |
| `app.minVersion`    | The higher of the tier's and the license's       |
| `app.maxVersion`    | The lower of the tier's and the license's        |

Every injected entry carries the license's last-modified time, which is how a tier change reaches running apps ([Re-licensing](/docs/features/licensing/relicensing/)).

## Origins

`origin` records how a license came to exist.

| Origin   | Created by                                                        | Key minted      |
| -------- | ----------------------------------------------------------------- | --------------- |
| `admin`  | A member, in the console or through the admin API                 | Yes, shown once |
| `oidc`   | Sign-in, through Identity                                         | No              |
| `enroll` | The keyless path ([Enrollment](/docs/features/licensing/access/)) | No              |

## How a license ends

A license is usable when its status is `active` and it hasn't passed its expiry. Every surface that hands out a grant checks that one rule.

- A dead license and a bad token both answer `401 unauthorized`, so a caller can't probe license state.
- **Disable** takes effect on the next request: it purges the cached token of every device on the license.
- A client holding a verified document keeps running until the document's `expiresAt`, then until `graceUntil`. For an offline install the grace bound is the revocation lever.

A disabled license records why in `ended_reason`.

| Reason       | Written when                                                                  |
| ------------ | ----------------------------------------------------------------------------- |
| `revoked`    | A member disables it or deletes the product                                   |
| `superseded` | An enrolled license merged into the license of the person who signed in on it |
| `refunded`   | Its sale was fully refunded                                                   |
| `chargeback` | Its sale was charged back                                                     |

Refunds have no grace period. Only the store's reversal of a refund or chargeback restores such a license: **Enable** answers `409` for it, so issue a new license to give the person access anyway. Enable restores a license that ended for any other reason.

An add-on is `active`, `past_due` (a renewal failed and the store is retrying), `suppressed`, `revoked` or `refunded`. Only `active` and `past_due` count toward entitlements.

## Device limit

A device pool is the set of authorized devices that share one license. The limit is the `deviceLimit` entitlement, falling back to the product's default device limit. A tier's limit must be a whole number from 1 to 1000, and an empty value inherits the product default. A limit of zero or less denies; it never means unlimited.

- **The database arbitrates.** Each device takes an ordinal under a unique index, so N concurrent activations against a limit of L admit exactly L.
- **A device that already counts re-activates for free.**
- **Dormant devices stop counting.** A device not seen for 90 days no longer counts. The row stays, and the device counts again on its next activation.
- **One device counts once.** When fingerprint enforcement is on and a new authorization presents hardware that already has an authorized sibling on the same license, the stale device id is retired and the newest wins. Switch enforcement off for the product or tier if customers run several instances on one host.

## Licensing settings

Settings under `licensing:` in `.pkey/product` decide how these nouns combine. They are also on **License → Settings**, where a change claims the setting from the manifest until you revert it. See [Product manifest](/docs/build/manifest/product/).

- `entitlementModel` and `entitlementHolder`: whether a device sees only its own license's entitlements or everything its holder has, and whose they are.
- `anchorPolicy` and `reanchor`: which license a device runs on.
- `clampGraceToExpiry`: on by default. A license that expires inside its offline window gets documents whose `graceUntil` stops at the expiry.

## Next steps

- [Activation](/docs/features/licensing/activation/): how a key becomes a device token.
- [Fingerprints](/docs/features/licensing/fingerprints/): what a device hashes.
- [Error codes](/docs/reference/error-codes/): `device_limit`, `fingerprint_required` and `hardware_mismatch`.
