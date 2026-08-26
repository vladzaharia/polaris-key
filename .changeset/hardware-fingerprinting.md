---
"@plrs/protocol": minor
"@plrs/node": minor
---

Add hardware and software fingerprinting.

Native SDKs now collect a seven-component hardware fingerprint at activation. Each component
is hashed on the device (`pkey-hw:<product>:<component>:<raw>`), so raw serials, MAC addresses,
and platform UUIDs never leave the machine — the server compares opaque digests only. A device
that cannot read a component omits it rather than substituting a placeholder.

The server soft-binds a device to its fingerprint with per-tier drift tolerance (`off` /
`lenient` / `normal` / `strict`), so a RAM or disk upgrade does not break activation but a
whole-machine swap does. Drift is counted asymmetrically: a component that disappears counts
against you, a newly reported one does not, so an SDK upgrade that learns to read more
components never looks like a hardware change.

Clients that send no fingerprint — including every already-shipped version — keep activating
and are recorded as `unverified`. Only a `strict` tier makes a fingerprint mandatory.

Software facts (OS, runtime, hardware summary, locale, timezone) and product-declared
companion-app probes ride along on the existing `POST /<product>/config/report` call. There is
no installed-application enumeration.

Also in this release:

- `deviceIdFromRaw()` is exported, splitting the device-id formula from the hardware read so
  the cross-language corpus can pin it. Device-id derivation previously had no golden vector in
  any language.
- The Swift SDK now sends an OS _family_ in `X-PKey-Platform` (`darwin`/`ios`) to match Node and
  Python, instead of a full `"Version 15.1 (Build 24B83)"` string. The detailed version moved to
  the software-facts record, where it belongs.
- New `ActivationResult` variants `fingerprint-required` and `hardware-mismatch`.

The signed `ManagedConfigDoc` is unchanged and `PROTOCOL_VERSION` stays at 2.

See `docs/PRIVACY.md` for exactly what is collected, why, and how long it is kept.
