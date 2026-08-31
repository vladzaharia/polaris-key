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
5. **Retention is device lifetime, plus a bounded window for the audit log.** Fingerprints and
   software facts are deleted when the device they describe is deauthorized — they never
   outlive it, and no job has to notice. The audit log is the one thing that does outlive a
   device, because it records that something _happened_ rather than describing a machine, so it
   is not open-ended either: a nightly maintenance job deletes audit records after 180 days.
   See _Scheduled cleanup_ below.

## What is collected

### Hardware fingerprint — native SDKs only (Node/Electron, Python, Swift)

Seven components, each hashed independently on-device. Any component that cannot be read is
omitted rather than substituted.

| Component        | Source                                                                    | Purpose                                                                   |
| ---------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `machineUuid`    | macOS `IOPlatformUUID` · Windows `MachineGuid` · Linux DMI `product_uuid` | The anchor: identifies the machine across upgrades                        |
| `boardSerial`    | Platform serial / baseboard serial                                        | Distinguishes otherwise-identical machines                                |
| `cpuModel`       | CPU brand string + logical core count                                     | Detects a mainboard/CPU swap                                              |
| `primaryMac`     | Lowest non-loopback MAC                                                   | Detects a NIC change                                                      |
| `bootVolumeUuid` | Boot volume UUID / volume serial                                          | Detects a disk replacement or reimage                                     |
| `ramBucket`      | Total RAM, rounded down to a power of two in GiB                          | Coarse on purpose — a 15.9-vs-16.0 GiB report must not look like a change |
| `machineModel`   | Hardware model identifier                                                 | Distinguishes machine classes                                             |

**The browser SDK collects no hardware fingerprint at all.** Canvas/WebGL-style browser
fingerprinting is unreliable, actively degraded by browsers, and privacy-hostile; the browser
keeps its existing server-minted session identity.

Used for: enforcing per-tier device limits honestly, deduplicating auto-issued free licenses
to one per machine, and detecting when a device's hardware has been replaced.

### Software facts — all SDKs

OS name, version, build, and kernel; CPU model, core count, total RAM, and machine model;
runtime name and version; locale and timezone; and the results of product-declared probes.

Used for: admin visibility, compatibility gating, and targeting configuration at the machines
that need it.

### Not collected

Hostname, OS username, IP-derived geolocation, browsing or file activity, a list of installed
applications, and any raw hardware serial. None of these are read by any SDK.

## Where it lives, and for how long

| Data                           | Table                 | Lifetime                       |
| ------------------------------ | --------------------- | ------------------------------ |
| Fingerprint components + hwid  | `device_fingerprints` | Deleted with the device        |
| Software facts + probe results | `device_facts`        | Deleted with the device        |
| Drift and mismatch events      | `audit`               | 180 days, then deleted nightly |

Deauthorizing a device — from the app, the admin panel, or the customer portal — routes
through `setDeviceStatus()` in `packages/worker/src/repo.ts`, which purges both tables in the
same operation. Disabling a license purges every one of its devices. Device-owned data is
therefore gone the moment the device is, with nothing left over for a cleanup job to collect.

### Scheduled cleanup

What deletion-on-deauthorization cannot reach is the data that describes an **event** rather
than a device. That data is bounded by a nightly maintenance job — `scheduled()` in
`packages/worker/src/scheduled.ts`, triggered by `crons = ["17 3 * * *"]` in
`packages/worker/wrangler.toml`, so **03:17 UTC every day**. Every step it runs is a deletion
or a release; the job collects nothing and reads nothing from any device.

| Nightly step              | What it acts on                                                                                                                                    | Threshold                             |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `audit`                   | The product's admin-side audit log — the drift and mismatch events in the table above, plus the acting operator's name and email on each record    | Deleted at **180 days**               |
| `portal_audit`            | Customer-portal audit records — sign-ins, device disconnects, license claims — each keyed to a portal account                                      | Deleted at **180 days**               |
| `release_download_tokens` | Single-use download tokens issued for release artifacts, once past their own expiry                                                                | Deleted once **expired**              |
| Device seats              | Releases the _seat_ held by a device that has not checked in recently. The device row, its name and its history are left untouched — only the seat | Released after **90 days** of silence |

The 180-day figure is `AUDIT_RETENTION_SECONDS`, and it is a deliberate balance: an audit log
is the evidence for "who disabled that license", and incidents are often discovered a quarter
or two later, while indefinite retention of a personal record with no stated period is exactly
what a privacy policy is supposed to rule out.

**What this means for you.** Six months after an action on your account is recorded, the record
is deleted — it can no longer be produced, for you or for anyone else. And if you stop using a
machine for 90 days, it stops occupying one of your license's seats, so a new machine can
activate without you disconnecting the old one first; the old device still appears in the
portal and you can still disconnect it, which is what actually erases its data.

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
