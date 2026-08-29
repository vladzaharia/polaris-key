---
title: "The license model"
description: "License, key, device, tier, profile, entitlement — the nouns, the origins, the status lifecycle, and how seats are counted."
sidebar:
  order: 2
---

Six nouns carry the whole service. They are the vocabulary of [Concepts &
terminology](/docs/start/concepts/), which is the source of truth when code and glossary
disagree.

## The nouns

### license

An **account that holds entitlements**. It is the thing a seat hangs off, and the thing an
operator disables when a customer stops paying.

A license row carries an identity (`sub`, `name`, `email`, `groups_json` — all nullable), an
optional `tier_id`, an `activated_at`, an optional `expires_at`, an optional
`max_offline_days`, its own `overrides_json` payload, and its own channel and version window
(`channels_json`, `min_version`, `max_version`). Two further columns record how it came to
exist: `origin` and `enroll_hwid`.

Nothing about a license is per-machine. Machines are devices, and a license may have many.

### key

A `pkey_<product>_…` activation secret, redeemed once per device at
`POST /<product>/license/activate`.

Keys live in `keys_index`, one row per key, many rows per license. The raw key is **shown to
the operator exactly once** — at license creation, or when minting an additional key — and
stored only as a peppered hash. Nothing can recover it afterwards; the admin surface lists
hashes, labels, and `last_used_at`, never key material.

A key's `status` is `active` or `revoked`. Revocation is per key, not per license: revoking one
key leaves every other key and every already-activated device untouched, because a device
authenticates with its own `pkeyt_` token from the moment activation succeeds.

### device

An authorized install, bound to a per-device bearer token (`pkeyt_…`). A device is a **Core**
principal, not a licensing one — see [Core](/docs/services/core/). Under an `open` or
`requires-identity` registration policy a device holds a token with no license behind it at all
and still fetches config documents.

What License contributes is the binding: `devices.license_id` names the license that granted
this machine a place, and `devices.seat_no` is the ordinal it occupies in that license's seat
pool.

### tier

A named plan. A tier row is a profile reference plus policy:

| Column                        | Meaning                                                                       |
| ----------------------------- | ----------------------------------------------------------------------------- |
| `profile_id`                  | The managed-payload baseline every license on the tier inherits.              |
| `policy_expiry_days`          | Time-boxes the tier. Re-derived onto a license whenever the tier is assigned. |
| `policy_device_limit`         | Seats per license. `NULL` inherits the product default.                       |
| `policy_fingerprint`          | Per-tier fingerprint enforcement mode, overriding the product default.        |
| `channels_json`               | Release channels this tier's licenses are entitled to.                        |
| `min_version` / `max_version` | The tier's half of the version window.                                        |

`policy_device_limit` must be a **positive integer**. A `0` or a `-1` used to mean "unlimited"
because the seat check was gated on `limit > 0`, which is the core commercial control removed by
one mistyped admin field; the admin API now answers `422` and the database enforces the same
rule. `NULL` — not zero — is how a tier says "use the product default".

A tier cannot be deleted while any license references it (`409`, with the reference count).

### profile

A reusable managed-payload baseline that a tier or a license can attach. Profiles are
[Config's](/docs/services/config/) rows; License consumes them as merge layers.

:::caution[Two different profiles]
"Profile" is already taken twice in this system: the reusable payload baseline described here,
and `DocProfile` — the signed greeting block (name, first name, email, activation time) carried
on the [license document](/docs/services/license/document/). They are unrelated. Do not overload
the word a third time.
:::

### entitlement

A capability flag or value delivered to the client — the `flag` kind of a catalog entry, plus
the policy entries the server injects. Entitlements ride the **license document and only it**;
the config document carries no grant data whatsoever.

## Where an entitlement comes from

Effective managed config is merged server-side, later layers winning:

```text
catalog defaults
  → the tier's profile
    → the license's profiles, in their stored order
      → license overrides
        → device overrides
```

The merge is Core's (`core/payload.ts`) because both signed documents are assembled from it.
License then takes the `entitlements` slice and stamps admin/tier policy on top as **enforced**
entries:

| Injected entitlement | Source                                                         |
| -------------------- | -------------------------------------------------------------- |
| `license.tier`       | `licenses.tier_id`, when set                                   |
| `license.tierLabel`  | `tiers.label`, when the tier has one                           |
| `channels`           | The union of the tier's and the license's `channels_json`      |
| `deviceLimit`        | `tiers.policy_device_limit`, when numeric                      |
| `app.minVersion`     | The tighter (higher) of the tier's and license's `min_version` |
| `app.maxVersion`     | The tighter (lower) of the tier's and license's `max_version`  |

Every injected entry carries `updatedAt = licenses.modified_at`. That is what makes
[re-licensing](/docs/services/license/relicensing/) visible without changing the document's
shape.

Entitlements are **never sealed**. Managed secrets are AES-GCM envelopes at rest and have to be
opened before delivery; entitlements are authored in plaintext, which is the wire-level reason a
license document can be handed to a build gate without decrypting anything.

## Origins

`licenses.origin` records how a license came into existence. It is not decorative — the
enrollment path reads it to decide whether a machine's free license is still claimable.

| Origin   | Created by                                        | Identity                                      | Key minted                         |
| -------- | ------------------------------------------------- | --------------------------------------------- | ---------------------------------- |
| `admin`  | An operator, through the console or the admin API | Optional `name`/`email`, no `sub`             | Yes — the first key, returned once |
| `oidc`   | Product sign-in, via Identity                     | `sub` from the IdP                            | No                                 |
| `enroll` | Keyless auto-issue at `/license/enroll`           | None — `sub`, `name` and `email` are all null | No                                 |

Existing rows predating the column are `admin` by definition.

An `enroll` license also carries `enroll_hwid`, the anchor-derived dedupe key that makes
one-license-per-machine enforceable by a unique index. A claim or a migrate changes `origin` to
`oidc` but **never clears `enroll_hwid`** — see
[Enrollment](/docs/services/license/enrollment/) for why that matters.

## The status lifecycle

A license's own `status` column has exactly two values: `active` and `disabled`. Expiry is a
separate axis, carried by `expires_at`.

**Usable** is the conjunction, and it is one predicate applied everywhere:

```text
usable(license, now) :=
    license exists
  ∧ license.status = 'active'
  ∧ (license.expires_at is null ∨ now ≤ license.expires_at)
```

Every surface that hands out a grant requires it: activation, enrollment, token rotation, the
license document, and identity's session routes. Core's own `/devices` and `/devices/report`
require it **only when the product runs the License service** — a config-only product's devices
have no license at all, and refusing them would make "Core is always on" false for exactly the
products the suite exists to enable.

A few consequences worth stating plainly:

- **A dead license and a bad token return the same `401`.** Telling them apart would let a
  caller with a stolen token probe license state.
- **Disabling is immediate.** `POST …/licenses/<id>/disable` purges the KV token record of every
  device on the license, so the next request falls through to a database read that fails the
  usability check, rather than riding a warm cache entry.
- **Revocation is not instant on the client.** A client already holding a verified document runs
  until its `expiresAt`, then on `graceUntil`. Wire contract v3 §4.3 is explicit that for an
  offline install the grace bound _is_ the revocation lever.

Devices have their own two-value status — `authorized` and `deauthorized`. Deauthorizing purges
the device's fingerprint and facts rows and frees its seat.

## Seat pools and `deviceLimit`

A **seat pool** is the set of authorized devices sharing one license. `GET /<product>/devices`
lists exactly that pool for an activated device — and, for a registered device with no license,
lists only itself, because every unlicensed device of a product shares one sentinel
`license_id` and grouping by it would hand each device the whole product's device list.

### Where the limit comes from

The limit is resolved as an **entitlement**, through the same pipeline the license document is
built from:

1. `resolveEntitlements` for the license, merged and with admin policy injected.
2. Read `deviceLimit` if it is a number.
3. Otherwise fall back to `products.default_device_limit`.

That indirection is deliberate: the number enforced at activation and the `deviceLimit` the
client reads out of its document are computed by the same call, so they cannot disagree.

A non-positive limit **denies**. It does not mean unlimited.

### How a seat is claimed

The database is the arbiter, not a read-then-write. `devices.seat_no` is an ordinal governed by
a partial unique index over `(product, license_id, seat_no)` restricted to authorized devices
holding an ordinal. Two isolates that compute the same free ordinal cannot both commit: the
loser takes a uniqueness violation and retries against the ordinal set as it now stands. N
concurrent activations against a limit of L therefore admit exactly L.

A pre-count still runs ahead of the claim, for two reasons: it reports the true `deviceCount` in
the `device_limit` error body, and it catches authorized rows written before `seat_no` existed,
which hold no ordinal and would otherwise be invisible to the seat map.

A device that already holds an authorized seat on this license re-activates **for free** — that
is a refresh, not a new install.

### Dormancy

Seats are not held forever by machines that stopped checking in. A device whose `last_seen` is
older than the dormancy window (90 days) has its ordinal released and is excluded from the seat
count. Both the count and the ordinal search apply the same floor, because if they disagreed the
pre-count would refuse an activation the seat map would happily have granted.

The row itself is untouched — same status, same token hash — so a device that comes back simply
re-claims a seat on its next activation. Only the capacity returns to the customer.

### One machine, one seat

`X-PKey-Device` is a client-chosen string with no uniqueness requirement, so the cheapest way to
hold N seats used to be to activate N times with N device ids from one machine. Hardware
reconciliation now coalesces on the **server-computed** hwid: when a new authorization presents
hardware that already has an authorized sibling device id on the same license, the stale id is
retired and the newest wins.

Coalescing rather than refusing is deliberate — a reinstall or a cleared config directory
legitimately produces a fresh device id, and refusing would strand the customer on a seat they
can no longer reach.

Two scopes matter:

- It is scoped to the **same license**, because one machine may legitimately hold a product's
  free enrolled license _and_ a purchased one, and those are different seat pools.
- It is gated on fingerprint enforcement being on. A product whose customers genuinely run
  several instances on one host — containers sharing a machine UUID — turns enforcement off for
  the product or the tier and gets independent device ids back.

`test/enroll.test.ts` pins both halves: four enrollments from one machine with four device ids
leave exactly one authorized device, and two genuinely distinct machines pointed at one
two-seat license admit a third machine no further (`403 device_limit`).

## Reference

- [D1 data model](/docs/reference/data-model/) — every column of `licenses`, `keys_index`,
  `tiers`, `license_profiles`, and Core's `devices`.
- [Wire error codes](/docs/reference/error-codes/) — the taxonomy behind `device_limit`,
  `fingerprint_required`, `hardware_mismatch`, `enroll_disabled`.
- [Fingerprint constants](/docs/reference/fingerprint-constants/) — component order, hash
  domains, digest lengths, drift tolerances.
