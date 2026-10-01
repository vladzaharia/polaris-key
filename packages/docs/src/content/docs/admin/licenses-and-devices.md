---
title: "Licenses & devices"
description: "Creating and editing licenses, tier changes, keys, the device panel, fingerprint status, and the reset escape hatch."
sidebar:
  order: 5
---

The License section's three tabs — Licenses, Tiers, Enrollment & fingerprints — cover licenses
end to end. This page walks the parts with real operational weight: what a tier change does to
a running client, the device panel's fingerprint columns, and the difference between
deauthorizing a device and resetting its hardware binding.

## Creating a license

**Create license** collects a holder (name and email, both required), an optional tier (applies
that tier's profile and policy in one step), any number of profiles in the order they should
apply, and policy overrides: expiry (blank means no expiry), a max-offline-days override, release
channels, and a version window. On submit the license is created **and its first key is minted in
the same request** — the raw key is shown exactly once, in a copy panel; the server keeps only
its hash and can never show it again.

### The channel picker

The licence and tier editors share one channel picker, built from the channel vocabulary
(WIRE-CONTRACT-V3 §5.1). It offers, in order:

1. `stable`, `beta` and `pr` (labelled "every PR build": a `pr` grant covers every `pr-<n>`);
2. the product's declared manual channels, read from its Release channels. A name the feed
   routes cannot reach (uppercase, `.` or `_`) or that a built-in takes over (`dev`, `pr`,
   `latest`, `pr42`, …) is not offered. A manual `staging` is listed and labelled, because its
   grant also covers `beta`;
3. `staging`, only when the licence or tier already holds it, labelled as the legacy alias of
   `beta`;
4. `dev`, only when already held, labelled: a `dev` grant lets every `0.0.0-dev*` build skip the
   version window and the channel checks (R3-01). The console never offers `dev` as a new
   grant; a deliberate one goes through the admin API or a manifest tier;
5. any other value already held, marked "not offered".

Unticking a held value leaves it on screen until the dialog closes, and a held value the picker
does not offer survives a save untouched.

## Editing a license, and what a tier change does

**Edit** reopens the same holder/policy fields. Changing the tier is the one edit worth calling
out: it's the "remote re-licensing" action described in
[License](/docs/services/license/) — there's no push channel, so a running client picks up the
new entitlements the next time it fetches its license document, not instantly.

### The over-limit warning

A tier carries its own `policyDeviceLimit`. Moving a license to a tier with a **lower** limit
than its current active device count doesn't evict anyone — the seat check only runs on a _new_
authorization — but it does mean no new device can activate until the count drops back under the
limit. The edit dialog warns about this before you save, computed from the tiers already loaded;
the `PATCH` response carries the authoritative version as `overLimit: { deviceCount,
deviceLimit }`, and the console's success toast uses whichever fired. Existing devices are
**grandfathered**, not force-deauthorized.

### Enable and disable

The status switch on the license detail header disables or re-enables it. Disabling purges every
one of its devices' cached bearer tokens from the hot KV store immediately, rather than waiting
for the next request to notice the license is unusable — a disabled license stops authenticating
right away, not at the next check-in.

## Keys

The Keys tab lists every key ever issued for the license by its hash (the raw value is never
stored, so it's never shown again after mint). **Mint key** takes an optional label and shows the
new raw key once, the same one-time panel as creation. **Revoke** takes effect immediately;
devices using that key must re-activate with a new one, and it cannot be undone.

## The device panel

Each license's Devices tab lists every device that has activated against it: identity, status,
a hardware column, a software column, and first/last seen. Two columns carry the fingerprinting
detail — see [Fingerprints](/docs/services/core/fingerprints/) for the matching algorithm behind
all of this; this section is only what the panel shows and what its two actions do.

**Hardware column.** A device with no fingerprint row shows a dash. Otherwise:

- **Verified** devices show a hardware id and a tooltip listing every present component. Both
  are truncated for display — the hardware id to 12 characters and each component hash to 8 —
  on top of the truncation the wire format itself already applies (a component hash is 22
  base64url characters; the hardware id is 32). The extra cut is deliberate: even an already-
  opaque digest is still hardware-derived, so a screenshot of this panel can't be used to
  correlate one device across products.
- **Unverified** carries a tooltip explaining why: the device activated without sending a
  fingerprint at all, either because it predates fingerprinting or the product has it disabled.
- A **Drifted** badge appears when the device's last check-in changed some components but stayed
  within tolerance. Its tooltip gives the count and the date. This is the _last_ drift only — the
  full history is in [Activity](/docs/admin/activity/) as `device.fingerprint.drift` entries, one
  per tolerated drift event.

**Software column.** OS name/version/architecture, the reported app version, and — when the
product declares probes in its manifest — a badge counting how many of the declared probes this
device reported present, with versions in the tooltip.

### Deauthorize vs. reset the hardware binding

Two different actions, for two different problems:

| Action            | Effect                                                                                                                                                           | Use it when                                                                                                                           |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **Deauthorize**   | The device is marked deauthorized, its token evicted. It must re-activate — with a key — to use the license again. **Frees the seat.**                           | The device shouldn't have access at all: lost, decommissioned, offboarded.                                                            |
| **Reset binding** | Clears the stored hardware fingerprint only. The device **stays authorized and keeps its seat**; its next check-in re-binds to whatever hardware it now reports. | A legitimate hardware change tripped `hardware_mismatch` and locked the user out, and you don't want to burn a seat re-issuing a key. |

Reset binding is `POST .../devices/<id>/fingerprint/reset`, audited as
`device.fingerprint.reset`. It exists specifically as the support escape hatch for a
false-positive drift lockout — a mismatch normally retires the binding and forces a fresh
authorization on its own, but reset does the same clearing _proactively_, before the user hits
the wall, without spending a re-activation.

## Devices, product-wide

The device panel above reaches a device through the license it holds a seat on, so a device that
holds **no license** never appears there: a device registered under open or
requires-identity registration (a free game, say) has none. **Platform → Devices** lists every
device of the product, licensed or not, and it is never hidden by service enablement.

The table shows one summary row per device: label or id, status, license and seat (or a
**License-free** badge), platform and architecture, app and SDK version, and **last seen**.
"Last seen" is the time of the device's most recent check-in; it is not an "online" indicator.
Fingerprint and software facts are not loaded per row; open a device to see them in the detail
drawer, which is the same data the license view shows and nothing more (raw hardware values never
exist server-side).

- **Filters**: status (authorized by default, deauthorized, or all), platform, licensed or
  license-free, and a case-insensitive prefix of the device id or label. Results are paged, newest
  last-seen first, 50 at a time. `status=all` scans the product's devices rather than walking the
  status index, so leave it on **authorized** for a very large product unless you need the rest.
- **Summary chips** count devices by status and by licensed versus license-free. The platform
  chips (click one to filter by it) count **authorized** devices only, as does every other
  breakdown the summary endpoint returns: architecture, SDK name, and the top 20 app versions.
  Platform, architecture and SDK are stored canonically (WIRE-CONTRACT-V3 §5.2), so one kind of
  machine is one chip: an older SDK's `darwin`, `win32`, `x64` or package name is mapped to
  `macos`, `windows`, `x86_64` or the SDK id when it is written, and rows stored before that were
  converged by a migration.
- **Actions** in the drawer are the same two as on the license panel, with the same effects and
  the same audit events (`device.deauthorize`, `device.fingerprint.reset`):
  **Deauthorize** and **Reset binding**. Deauthorizing a license-free device marks it
  deauthorized and revokes its token, and frees nothing because it holds no seat. Under open
  registration it can register again on its next start, and the console says so before you
  confirm. Deauthorizing a licensed device here frees its seat exactly as the license panel does.

Endpoints (admin API, session cookie plus CSRF on mutations; documented here rather than in the
public OpenAPI spec, which covers only the client wire):

| Route                                                                   | Purpose                                                                         |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `GET /manage/api/products/<slug>/devices`                               | Paged list: `status`, `platform`, `licensed`, `q`, `limit` (1-200), `cursor`.   |
| `GET /manage/api/products/<slug>/devices/summary`                       | Counts by status, platform, arch, licensed/license-free, SDK, top app versions. |
| `GET /manage/api/products/<slug>/devices/<deviceId>`                    | One device with fingerprint and facts.                                          |
| `POST /manage/api/products/<slug>/devices/<deviceId>/deauthorize`       | Deauthorize.                                                                    |
| `POST /manage/api/products/<slug>/devices/<deviceId>/fingerprint/reset` | Clear the hardware binding without deauthorizing.                               |

The list returns `{ devices, nextCursor }`; pass `nextCursor` back as `cursor` until it is
`null`. A license-free device has `licenseId: null`.

## Fingerprint policy

The **Enrollment & fingerprints** tab has two halves of different kinds.

**Device registration** is shown read-only. It's a Core policy derived from the enabled service
set (or explicitly declared), and editing it here would be a second control over a value that
already has one — see [Services & enablement](/docs/admin/services-enablement/). It's shown on
this tab because you can't reason about fingerprinting without first knowing whether a device
can reach the point where a fingerprint matters.

**The fingerprint policy itself** is editable: whether it's enforced at all, and the default
mode — `off`, `lenient`, `normal` or `strict` — each with its own tolerated-drift count (see
[Fingerprints](/docs/services/core/fingerprints/#modes-and-tolerances) for the exact numbers and
the anchor bonus). The probe list is **not** editable here: a `PATCH` replaces the whole array,
and the manifest-declared per-platform hints (`macos`/`windows`/`linux` targets) aren't
something a partial editor could safely round-trip, so the table is shown as read-only and the
list is authored in `.pkey/product`.

Like Services, this policy carries an owner. **Revert to manifest** hands `services_json`'s
sibling columns back to `manifest` ownership — and, in the same action, **also returns the
auto-issue policy to manifest control**, even though auto-issue itself has no live-edit form in
this console view yet. The confirm dialog says so explicitly, precisely because that side effect
isn't visible anywhere else in the UI.

## Tiers

A tier is a named template — a profile plus policy, channel and version-window defaults — that a
license can be assigned. Creating or editing one validates `policyDeviceLimit` as a real seat
count: `0` or a negative number is refused (`422`), because the runtime treats a non-positive
limit as **unlimited**, not zero — the opposite of what a fuzzed or mistyped admin field would
suggest. Deleting a tier is refused (`409`) while any license still references it.

## Minting an offline bundle

Each license detail page has an **Offline bundle** action for devices that can't reach the
network at all. It opens a dialog with:

- **Device ID** — the 32-character request code the air-gapped app's own offline screen shows;
  pasted, not chosen.
- **Grace days** — the offline window the minted documents grant, 1 to 365 (365 by default — the
  ceiling, since this is for the machine least able to come back for another bundle).
- **Include configuration** — shown only when the product runs Config; ships the signed config
  document alongside the license document.
- The license itself supplies `licenseId` — there's no authenticated device on this path to
  infer one from, so the console always sends the license you opened the dialog from.

The full operator workflow — when to reach for this instead of normal offline tolerance, the
`pkey bundle` CLI, and why the mint has two independent time bounds — is on
[Offline bundles](/docs/admin/bundles/). The wire-level detail is at
[Offline bundles](/docs/build/wire/bundles/) in the wire contract section.

## Reference

- [D1 data model](/docs/reference/data-model/) — `licenses`, `keys_index`, `tiers`,
  `license_profiles`, `device_fingerprints`, `device_facts`.
- [Fingerprints](/docs/services/core/fingerprints/) — the matching algorithm, drift counting, and
  what `unverified` means.
- [The device principal](/docs/services/core/device-principal/) — the device roster, registration
  and `pkeyt_` tokens.
- [Fingerprint constants](/docs/reference/fingerprint-constants/) — the frozen hash formulas.
