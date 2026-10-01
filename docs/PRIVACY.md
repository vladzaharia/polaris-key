# Polaris Key — what clients collect, and why

Polaris Key had no written privacy policy before hardware fingerprinting landed, but it did
have a consistent unwritten one: collect the minimum needed to license and configure software,
bound it hard, and never keep it longer than the thing it describes. This document makes that
explicit, because fingerprinting is the first feature where the policy became load-bearing.

The rules below are enforced in code, not just documented. Where that is true, the enforcing
call site is named.

## Principles

1. **Raw hardware identifiers never leave the device.** Every fingerprint component is hashed
   on the client as `SHA-256("pkey-hw:<product>:<component>:<raw>")`, truncated to 22
   base64url characters. The Worker only ever sees opaque digests and can compare them; it
   cannot recover a serial number, MAC address, or platform UUID from what it stores. This
   mirrors how the device id has always worked (`pkey-device:<product>:<raw>`).
2. **Domain separation per product.** The product slug is inside every hash, so the same
   machine produces unrelated digests for two different products. A leak of one product's
   table cannot be joined against another's.
3. **Collect declared things only.** There is no installed-application enumeration. A product
   declares the companion apps it cares about as **probes**; the client answers only those.
4. **Everything is bounded.** The report body is capped at 16 KiB, the probe map at 32
   entries, and the signed config document at 64 KiB. Unknown keys are dropped, not stored.
5. **Retention is device lifetime.** Fingerprints and software facts are deleted when the
   device they describe is deauthorized. There is no separate retention job, because there is
   nothing that outlives its device.

## What is collected

### Hardware fingerprint — native SDKs only (Node/Electron, Python, Swift, Godot)

Seven components, each hashed independently on-device. Any component that cannot be read is
omitted rather than substituted.

| Component        | Source                                                                                                                                             | Purpose                                                                            |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `machineUuid`    | macOS `IOPlatformUUID` · Windows registry `MachineGuid` · Linux `/etc/machine-id`, else `/var/lib/dbus/machine-id` · iOS `identifierForVendor`     | The anchor: identifies the machine (on Linux, the OS install) across upgrades      |
| `boardSerial`    | macOS `IOPlatformSerialNumber` · Windows `Win32_BaseBoard.SerialNumber` (PowerShell `Get-CimInstance`) · not read on Linux or iOS                  | Distinguishes otherwise-identical machines                                         |
| `cpuModel`       | CPU brand string + logical core count                                                                                                              | Detects a mainboard/CPU swap                                                       |
| `primaryMac`     | Lowest non-loopback MAC                                                                                                                            | Detects a NIC change                                                               |
| `bootVolumeUuid` | macOS boot volume UUID · Windows `vol C:` serial · Linux `findmnt -no UUID /`                                                                      | Detects a disk replacement or reimage                                              |
| `ramBucket`      | Total RAM in whole GiB, rounded down to a power of two; omitted below 1 GiB                                                                        | Coarse on purpose: stable while the reported total stays between two powers of two |
| `machineModel`   | macOS `hw.model` · Windows `Win32_ComputerSystem.Model` (PowerShell `Get-CimInstance`) · Linux `/sys/class/dmi/id/product_name` · iOS `hw.machine` | Distinguishes machine classes                                                      |

The exact derivation rules are normative in WIRE-CONTRACT-V3 §6.1 and pinned by the conformance
corpus. **No DMI serial or product UUID is read on Linux** (`product_uuid` and `board_serial` are
root-only, so reading them made the fingerprint depend on the process's privilege). A Linux host
with no usable machine-id — which includes most container images — therefore has no anchor
component, and cannot obtain a keyless (free-tier) licence; activating with a licence key still
works. In a container, mount the host's `/etc/machine-id` read-only, or create one and keep it in a
volume.

**Godot** reads the same desktop sources through `OS.execute` and the file system (on Windows,
`getmac` for the MAC; on macOS, `ifconfig`; on Linux, `/sys/class/net/*/address`), once per
session and off the main thread. On iOS and Android it sends only the anchor (Godot's
`OS.get_unique_id()`: `identifierForVendor` on iOS, `ANDROID_ID` on Android), the machine model,
RAM and, on iOS, the CPU. A Godot web export collects no fingerprint.

**The browser SDK collects no hardware fingerprint at all.** Canvas/WebGL-style browser
fingerprinting is unreliable, actively degraded by browsers, and privacy-hostile; the browser
keeps its existing server-minted session identity.

Used for: enforcing per-tier device limits honestly, deduplicating auto-issued free licenses
to one per machine, and detecting when a device's hardware has been replaced.

### Software facts — all SDKs

OS name, version, build, and kernel; CPU model, core count, total RAM, and machine model;
runtime name and version; locale and timezone; and the results of product-declared probes.

A Godot game also reports `engine` (the engine version, the renderer, the graphics adapter's
name, vendor and API version, the display server, and whether it is a debug build) and `outlet`
(the store the build was published through, such as `steam` or `itch`, when the build declares
one).

Used for: admin visibility, compatibility gating, and targeting configuration at the machines
that need it.

### Not collected

Hostname, OS username, IP-derived geolocation, browsing or file activity, a list of installed
applications, and any raw hardware serial. None of these are read by any SDK.

## Where it lives, and for how long

| Data                           | Table                 | Lifetime                              |
| ------------------------------ | --------------------- | ------------------------------------- |
| Fingerprint components + hwid  | `device_fingerprints` | Deleted with the device               |
| Software facts + probe results | `device_facts`        | Deleted with the device               |
| Drift and mismatch events      | `audit`               | Retained with the product's audit log |

Deauthorizing a device — from the app, the admin panel, or the customer portal — routes
through `setDeviceStatus()` in `packages/worker/src/repo.ts`, which purges both tables in the
same operation. Disabling a license purges every one of its devices. This is why no scheduled
cleanup job exists: there is no orphaned data for one to collect.

## Per-product opt-out

Fingerprinting is on by default at `normal` strength. A product turns it off entirely in its
`.pkey/product` manifest:

```jsonc
{
  "fingerprint": {
    "enabled": false,
  },
}
```

With `enabled: false`, clients collect no hardware components and the Worker enforces nothing.
An operator can also change this live from the admin panel; a live edit takes ownership of the
setting so a subsequent manifest resync cannot silently revert it (`fingerprint_policy_source`).

Products keep hardware fingerprinting on but restrict what is probed by declaring only the
probes they need:

```jsonc
{
  "fingerprint": {
    "enabled": true,
    "defaultMode": "normal",
    "probes": [
      {
        "id": "rekordbox",
        "label": "rekordbox",
        "macos": "/Applications/rekordbox 7.app",
      },
    ],
  },
}
```

## What an admin can see

The device panel shows a device's fingerprint status (`verified` / `unverified`), a truncated
hwid, truncated per-component digests, the component count, and the last drift event — never a
full digest, so a screenshot of the panel cannot be used to correlate a device elsewhere. An
admin can clear a device's binding, which is audited and lets the device re-bind on its next
check-in without losing its seat.

## What an end user can see

The customer portal already lists a user's own devices with their platform, versions, and
first/last-seen times, and lets them disconnect any of them — which purges that device's
fingerprint and facts.
