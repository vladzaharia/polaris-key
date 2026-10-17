---
title: "Fingerprints"
description: "The hashed hardware components a device reports, the anchor, how drift is counted and the four enforcement modes."
type: "concept"
lastReviewed: "2026-10-16"
sidebar:
  order: 8
---

A fingerprint is the set of per-component hashes a device reports about its hardware. The SDK hashes raw values on the device and never sends them. The Worker compares opaque digests, so a database dump holds no serial numbers.

The fingerprint sits on top of the device id, which stays the primary key every row and signed document binds to. Turning fingerprinting on never orphans an existing device.

## The components

| Component        | What it covers                                   |
| ---------------- | ------------------------------------------------ |
| `machineUuid`    | The platform machine identifier: the anchor      |
| `boardSerial`    | Mainboard or chassis serial                      |
| `cpuModel`       | CPU brand plus core count                        |
| `primaryMac`     | The lowest non-internal, non-zero MAC address    |
| `bootVolumeUuid` | The boot volume identifier                       |
| `ramBucket`      | Total RAM in GiB, rounded down to a power of two |
| `machineModel`   | The model identifier                             |

A component that can't be read is omitted, never replaced by a placeholder. A placeholder would make every partial reader collide with every other. An omission only lowers match precision.

`primaryMac` is chosen by address, not interface name, because names change across reboots and OS upgrades. `ramBucket` stays stable while the reported total sits between two powers of two. On Linux the anchor comes from `/etc/machine-id`, else `/var/lib/dbus/machine-id`, never from root-only DMI values, so root and non-root processes present the same fingerprint. A host with no usable machine id, such as most container images, has no anchor.

## The hashes

Each component hash is `base64url(sha256("pkey-hw:<product>:<component>:<raw>"))`, cut to 22 characters. The product slug is inside the digest, so one device presents different hashes to different products. The `pkey-hw` hash domain is frozen: renaming it would orphan every stored digest.

The `hwid` is the hash of the present components in canonical order, so losing one component changes it. It is the coarse dedupe key; component-wise matching is the authority. The Worker discards the client's `hwid` and recomputes it, so a forged value can't collide with another device's key.

SDKs must iterate the canonical order, never a language's map order. The constants are in [Fingerprint constants](/docs/reference/protocol/fingerprint-constants/).

The Worker drops unknown component names, so a newer SDK still activates. A known component that isn't a 22-character base64url string rejects the whole fingerprint.

## The anchor

`machineUuid` widens tolerance by one when it still matches, because a computer whose platform UUID is intact is very likely the same computer after a disk or network card swap. The bonus only widens an existing tolerance, so `strict` stays at zero. The anchor is also the whole [enrollment](/docs/features/licensing/access/) dedupe key.

## Drift

Drift is the number of components that differ between the stored and the presented fingerprint. The count is asymmetric:

- A component that was stored and is now missing or different counts. Otherwise a caller could omit every component that doesn't match.
- A newly present component doesn't count. An SDK update that reads two more components must not look like a hardware change.

## Modes

| Mode      | Tolerated drift | Notes                      |
| --------- | --------------- | -------------------------- |
| `off`     | Unlimited       | Collect, never enforce     |
| `lenient` | 4               |                            |
| `normal`  | 2               | The default                |
| `strict`  | 0               | A fingerprint is mandatory |

The anchor adds 1 when the base tolerance isn't zero. The effective mode is the tier's, else the product's `defaultMode`, else `normal`. A product with `enabled: false` forces `off`, which suits customers who run several instances on one host, such as containers that share a device UUID.

Reconciliation runs before the seat check, so a swapped device gets `hardware_mismatch`, not `device_limit`.

- **Exact.** Nothing extra is recorded.
- **Drift within tolerance.** The binding stands, `last_drift_at` and `last_drift_count` are stamped and a `device.fingerprint.drift` audit entry is written.
- **Mismatch.** The binding is retired: the device is deauthorized, its token evicted and a `device.fingerprint.mismatch` entry records the changed components. The answer is `409 hardware_mismatch`. The retry binds the new hardware as a new authorization, and the old device doesn't keep its seat.

A new authorization that presents hardware an authorized sibling on the same license already holds retires that sibling (`device.seat.coalesced`). The newest device id wins, because a reinstall legitimately produces a fresh one. One device may hold a free enrolled license and a purchased one, which are separate seat pools.

## Unverified

`unverified` marks a device that sent no fingerprint, so a member can tell "predates fingerprinting" from "declined to identify". Activation writes it when no fingerprint was presented, the mode isn't `off` and no row exists. The row is empty, so the device rebinds on its next attempt with real components. Registration writes no such row.

## Next steps

- [Activation](/docs/features/licensing/activation/): where the mode is resolved.
- [Enrollment and policy](/docs/features/licensing/access/): setting the policy, and the reset that clears a false lockout.
- [Device trust levels](/docs/features/licensing/device-trust/): attestation, a stronger signal than a fingerprint.
