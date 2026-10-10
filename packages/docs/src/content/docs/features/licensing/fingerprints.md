---
title: "Fingerprints"
description: "The seven hashed hardware components, the machineUuid anchor, asymmetric drift counting, the four enforcement modes, and what unverified means."
sidebar:
  order: 3
---

A **fingerprint** is the set of per-component hashes a device reports about its hardware. Raw
hardware values are hashed on-device and never transmitted — the server only ever compares
opaque digests, and a database dump yields no serial numbers.

The fingerprint is layered _on top of_ the device id, which stays the stable primary key every
row and signed document is bound to. Turning fingerprinting on can therefore never orphan an
existing device.

## The seven components

| Component        | What it covers                                   |
| ---------------- | ------------------------------------------------ |
| `machineUuid`    | The platform machine identifier — **the anchor** |
| `boardSerial`    | Mainboard / chassis serial                       |
| `cpuModel`       | CPU brand plus core count (they change together) |
| `primaryMac`     | The lowest non-internal, non-zero MAC address    |
| `bootVolumeUuid` | The boot volume identifier                       |
| `ramBucket`      | Total RAM rounded down to a power of two in GiB  |
| `machineModel`   | The model identifier                             |

Two of those deserve their reasoning. `ramBucket` is whole GiB rounded down to a power of two
(omitted below 1 GiB), so what it buys is stability while the reported total stays between two
powers of two: a 16 GB machine whose OS reports 15.4 GiB buckets to `8`, and keeps doing so.
`primaryMac` is selected by **address**
rather than by interface name, because interface naming is unstable across reboots and OS
upgrades — sorting by name would make `en0` becoming `enp3s0` look like a NIC swap.

### Where components come from

The per-OS sources, and the three rules the conformance corpus pins (the Windows CIM parser, the
Linux anchor and the RAM bucket), are normative in WIRE-CONTRACT-V3 §6.1
(`docs/security/WIRE-CONTRACT-V3.md`). In short:

- **Windows** reads `boardSerial` and `machineModel` with one PowerShell `Get-CimInstance` call
  (`Win32_BaseBoard.SerialNumber`, `Win32_ComputerSystem.Model`), the same WMI properties the
  retired `wmic` tool read, so Windows 10 values are unchanged.
- **Linux** reads the anchor from `/etc/machine-id`, else `/var/lib/dbus/machine-id`, skipping a
  blank file and systemd's `uninitialized`. It never reads the root-only DMI `product_uuid` or
  `board_serial`, so root and non-root processes present the same fingerprint. A host with no
  usable machine-id (most container images) has no anchor.

A component that cannot be read is **omitted, never substituted**. A placeholder would make
every partial reader collide with every other partial reader; an omission merely degrades match
precision.

## The hashes

Each component is hashed on the device:

```
component hash = base64url(sha256("pkey-hw:<product>:<component>:<raw>"))[0..22]
```

The product slug is inside the digest, so the same machine presents different component hashes
to different products. `pkey-hw` is a **hash domain**, frozen at `fingerprintVersion 1` — a
rename would orphan every stored digest, so the wire contract's identifier rebrand explicitly
does not touch it.

The composite key, the **hwid**, is built over the present components in canonical order:

```
hwid = base64url(sha256(join("\n", ["<component>=<hash>", …])))[0..32]
```

Only components that are present contribute, so losing one changes the hwid. That is why the
hwid is the _coarse_ dedupe key and component-wise matching is the authority.

Every SDK must iterate the canonical order rather than a language-native map ordering; a
different order is a conformance failure. The exact constants and the canonical order live at
[Fingerprint constants](/docs/reference/fingerprint-constants/).

:::caution
The client's own `hwid` is **discarded** on arrival and recomputed by the server from the
components. A forged hwid would otherwise let a caller collide with another device's dedupe key;
recomputing removes the surface entirely and leaves the client's value as a purely local
convenience that the conformance vectors, not production, are responsible for pinning.
:::

### What a presented fingerprint must look like

Server-side parsing is strict, with one deliberate tolerance:

- Unknown component names are **dropped**, not rejected, so a newer SDK reporting a component
  this worker does not know about still activates.
- A known component whose value is not a string, is not exactly 22 characters, or is not
  base64url rejects the **whole** fingerprint.
- An empty component set is no fingerprint at all.

"No usable fingerprint" is one case regardless of why, so callers never have to branch on the
reason.

## The anchor

`machineUuid` is the **anchor**: the platform's own stable machine identifier, and the one
component the matcher treats as privileged. It does two jobs.

**It widens tolerance by one when it still matches.** A machine whose platform UUID is intact is
very likely the same machine that had a disk and a NIC replaced. The bonus only ever widens an
_existing_ tolerance — it never creates one — so `strict` really does mean zero drift rather
than quietly becoming one.

**It is the entire enroll-dedupe key.** See below.

## Drift, counted asymmetrically

**Drift** is how many components differ between a device's stored and presented fingerprint. The
counting is asymmetric, and the asymmetry is the security-relevant part:

- A component that was **stored and is now missing or different** counts as drift. Without this,
  a caller could simply omit every component that does not match and pass at tolerance 0.
- A component that is **newly present** does not count. An SDK upgrade that learns to read two
  more components must not look like a two-component hardware change to every device that
  updates.

Zero changed components is an exact match. Otherwise the changed count is compared against the
tolerance for the effective mode, plus the anchor bonus.

## Modes and tolerances

| Mode      | Tolerated drift | Notes                                            |
| --------- | --------------- | ------------------------------------------------ |
| `off`     | ∞               | Collect, never enforce                           |
| `lenient` | 4               |                                                  |
| `normal`  | 2               | The default                                      |
| `strict`  | 0               | A fingerprint additionally becomes **mandatory** |

Plus **+1 when the anchor still matches**, and only when the base tolerance is non-zero.

The effective mode resolves as: the tier's `policy_fingerprint`, else the product's
`defaultMode`, else `normal`. A product-level `enabled: false` overrides all of it with `off`,
which is the documented escape hatch for products whose customers legitimately run several
instances on one host — containers sharing a machine UUID, for example.

A malformed `fingerprint_policy_json` falls back to the default policy rather than throwing: a
bad policy blob must never take a product's licensing offline.

Under `strict`, a device that presents no fingerprint is refused with `fingerprint_required`.
Every other mode keeps clients that predate fingerprinting working.

## What happens on a match, a drift, and a mismatch

Reconciliation runs **before** the seat check, so a swapped machine gets a precise
`hardware_mismatch` instead of a confusing `device_limit`, and a coalesced sibling has already
released its seat by the time capacity is counted.

- **Exact** — nothing to record beyond the usual row update.
- **Drift within tolerance** — the binding stands. `last_drift_at` and `last_drift_count` are
  stamped on the fingerprint row and a `device.fingerprint.drift` audit entry is written.
- **Mismatch** — the binding is **retired**, not rebound in place: the device row is
  deauthorized (which purges its fingerprint and facts) and its token record evicted, and a
  `device.fingerprint.mismatch` audit entry records the drift count and the changed components.
  The client's retry then re-authorizes the same device id through the normal path, where it now
  counts as a new authorization, the seat check runs again, and the new hardware binds cleanly.
  The old machine does not keep holding a seat.

### Seat coalescing

`X-PKey-Device` is a client-chosen string with no uniqueness requirement, so the cheapest way to
hold N seats was once to activate N times with N device ids from one machine — the server
computed N identical hwids and never compared them.

On a new authorization with a fingerprint and a mode other than `off`, Core looks up any sibling
row with the same server-computed hwid. If that sibling is authorized **and on the same
license**, it is retired and a `device.seat.coalesced` audit entry is written.

Two scoping decisions:

- **The newest device id wins**, rather than the request being refused. A reinstall or a cleared
  config legitimately produces a fresh device id, and refusing would strand the customer on a
  seat they can no longer reach.
- **Same license only.** One machine may legitimately hold this product's free enrolled license
  and a purchased one; those are different seat pools.

## `unverified`

`unverified` is a status on the fingerprint row, and it exists so an operator can tell
"predates fingerprinting" from "declined to identify".

It is written on the **activation** path only, and only when all of these hold: no fingerprint
was presented, the effective mode is not `off`, and no fingerprint row exists yet. The row it
writes has an empty hwid, an empty component map, and a null anchor — so it matches nothing that
was stored, and the device rebinds on its next attempt with real components.

The **registration** path deliberately writes no such row. Under an `open` policy, declining to
identify is the documented normal rather than a signal, and there is no tier there to demand a
fingerprint. A presented fingerprint is stored (with the hwid recomputed server-side); an absent
one is simply absent.

A corrupt `components_json` is read as an empty component map rather than throwing, for the same
reason: a bad row must not wedge activation.

## The enroll-dedupe key hashes the anchor alone

Keyless enrollment needs a one-license-per-machine key, and it must **not** be the ordinary
hwid.

`computeHwid` digests exactly the components that were submitted. That is right for a device
binding — a partial read should degrade match precision rather than collide with every other
partial reader — and catastrophic for a dedupe key. With seven components there are
`2^7 - 1 = 127` non-empty subsets, and the parser accepts any of them, so one machine could
present 127 distinct "identities" and collect 127 free licenses, each with its own seat pool.

The enroll key is therefore computed over a **fixed projection — the anchor alone**:

```
enrollHwid = base64url(sha256("pkey-hw:enroll:machineUuid=<anchor hash>"))[0..32]
```

Every subset of one machine's components that contains the anchor now yields the same key, so
omitting components gains nothing. A submission **without** the anchor cannot be deduped at all,
and is refused with `403 fingerprint_required` rather than being minted a license. The distinct
`:enroll:` segment keeps the value in a different space from a device hwid, so one can never be
replayed as the other.

Uniqueness is ultimately enforced by the `idx_licenses_enroll_hwid` index, not by the
read-then-write: if two enrollments race, the loser's insert violates the index and the winner's
row is re-read, so a burst of concurrent first-runs converges on a single license.

## See also

- [Fingerprint constants](/docs/reference/fingerprint-constants/) — the frozen values, pinned by
  the conformance corpus.
- [The device principal](/docs/services/core/device-principal/) — where a fingerprint is read
  from and what it binds.
- [License](/docs/services/license/) — activation, enrollment, and tier fingerprint policy.
