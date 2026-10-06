---
title: "Licenses & devices"
description: "The license list and record, tier changes, keys, the device table, the fingerprint policy, tiers, and the reset escape hatch."
sidebar:
  order: 5
---

The License section has three pages: **Licenses** (each license opens as a record),
**Tiers** (each tier opens as a record) and **Enrollment**. This page walks the parts with real
operational weight: what a tier change does to a running client, the device table and its two
actions, and the difference between deauthorizing a device and resetting its hardware binding.

## The license list

Each row shows the holder (name and email), the license's **state**, its tier, its expiry, its
seats and its active keys. The state is worked out from the license's status and its expiry:

| State                   | Meaning                                                 |
| ----------------------- | ------------------------------------------------------- |
| **Active**              | Enabled, and not expiring within 14 days.               |
| **Expires in _N_ days** | Enabled, and the expiry is 14 days away or less.        |
| **Expired**             | The expiry has passed. Devices are refused at check-in. |
| **Disabled**            | An operator disabled it.                                |

The four tiles above the table count each state; a tile filters the table to that state. Search
matches the name, the email and the license id. The **Status**, **Tier**, **Channel** and
**Sign-in** filters, the search and the sort are all in the URL, so a filtered list can be
bookmarked or shared. **Seats** is the device count against the effective limit, with its source
under the meter ("set on this license", "from Pro", "product default"): see
[The device limit](#the-device-limit). The **Channels**, **Sign-in**,
**Email** and **Id** columns are hidden at first; **Columns** shows them, and **Export CSV**
downloads what the filters show.

Select rows to **Disable**, **Enable** or **Export** them together. Disable and Enable ask first
and list the effect.

## Creating a license

**Create license** is a dialog in three steps:

1. **Holder**: name and email, both required.
2. **Terms**: every policy field in one place.
   - **Tier**, which applies that tier's profile, device limit and term in one step. The picker
     shows each tier's policy beside its name.
   - **Expiry**: the tier's term (the license expires that many days from now; the server
     derives it, so leave this when the tier should decide), **No expiry**, or **On a date**.
     A date means the end of that day in your time zone, and the exact instant is shown under
     the field.
   - **Max offline days**: 1 to 365, or blank for the product default.
   - **Release channels**: added to the tier's channels.
   - A **version window**: a minimum and a maximum version.
   - **Profiles**, as a numbered list. They apply after the tier's profile, in the order shown:
     a later profile overrides an earlier one. Reorder them with the arrows.

   The **Effective policy** panel beside the form says what a device on these terms receives and
   where each value comes from: this license, the tier, or the product default. A new license
   inherits its device limit; set one of its own afterwards with **Device limit…** on the
   record. If the tiers or profiles can't be loaded, the dialog says so where the field would
   be, with a retry.

3. **Key**: the license is created **and its first key is minted in the same request**. The raw
   key is shown exactly once; the server keeps only its hash and can never show it again. The
   dialog won't close until you copy the key or confirm you've stored it. From there,
   **Open license** goes to the new record and **Create another** starts again.

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

Unticking a held value leaves it on screen until the form is saved or discarded, and a held value
the picker does not offer survives a save untouched.

## The license record

The header shows the holder, the state, the expiry ("Expires 30 Sep 2027 (in 361 days)"), the
email, the license id (with a copy button), how the holder signs in, and who changed the license
last and when. The primary action is **Mint key** (or **Enable license** while it is disabled);
**More actions** holds **Edit holder…**, **Mint offline bundle…**, **View in activity** and, last,
**Disable license…**.

The record has four tabs, and each is part of the URL (`…/licenses/<id>/keys`):
**Overview**, **Keys**, **Devices** and **Config overrides**.

### Terms, and what a tier change does

The **Overview** tab holds one **Terms** form with every policy field: tier, expiry, max offline
days, the version window, release channels and profiles (ordered, as on create). A save bar
appears once something changes and saves only the fields you changed. Clearing **Max offline
days** sends `null`, so the product default applies again. Below the form, **Effective policy**
shows what devices receive with your unsaved changes. A draft survives switching tabs (the
Overview tab shows a dot), and leaving the record with unsaved changes asks first. The holder's
name and email are edited from **Edit holder…**.

Changing the tier is the edit worth calling out: it's the "remote re-licensing" action described
in [License](/docs/services/license/). There's no push channel, so a running client picks up the
new entitlements the next time it fetches its license document, not instantly. Unless you also
set an expiry, the server re-derives it from the new tier's term (R3-06); the form says so
before you save.

### The over-limit warning

A tier carries its own `policyDeviceLimit`. Moving a license to a tier with a **lower** limit
than its current device count doesn't evict anyone (the seat check only runs on a _new_
authorization), but no new device can activate until the count drops back under the limit. The
Terms form warns about this before you save, from the server's device count for the license; the
`PATCH` response carries the authoritative version as `overLimit: { deviceCount, deviceLimit }`,
and the confirmation says so. Existing devices are **grandfathered**, not force-deauthorized.

### The device limit

A license's device limit is resolved most specific first: the limit **set on this license**,
else its **tier's** device limit, else a `deviceLimit` **entitlement** (from a profile, a store
grant or a config override), else the **product default** (LX-14a). The same number is enforced
at activation and signed into the license document's `deviceLimit` entitlement. The record's
header, the **Effective policy** panel, the Devices tab's **Seats** meter and the licenses list
all show the effective limit and where it comes from: "3 · set on this license", "5 · from
Pro", "5 · product default".

**Device limit…** (in **More actions**) opens a sheet to raise or lower it for this one license,
seat or account-wide alike. The field's placeholder is the inherited value ("Inherits 5 from
Pro"). **Save** sets the number; **Use inherited limit** clears it, so the tier or product value
applies again. A limit set here beats any tier, so changing the tier later doesn't move it.
Lowering it below the devices signed in warns first — "4 devices are signed in. None is signed
out; new devices are refused until the count is under 3." — and, like a tier downgrade, signs
nobody out: the `PATCH` answers `overLimit` and the next new device is refused. Each change is
audited as `license.device_limit.set` with the old and new values.

The API is the same `PATCH /manage/api/products/<slug>/license/licenses/<id>` with
`deviceLimit`: a positive integer, or `null` to inherit; anything else is a `422`. Every license
read answers `deviceLimit` (the stored value), `effectiveDeviceLimit` (`0`: no limit),
`deviceLimitSource` (`license`, `tier`, `entitlement` or `product`) and the inherited pair
`inheritedDeviceLimit` / `inheritedDeviceLimitSource`.

### Enable and disable

**Disable license…** (in **More actions**) asks first and lists the effect. Disabling purges
every one of its devices' cached bearer tokens from the hot KV store immediately, rather than
waiting for the next request to notice the license is unusable: a disabled license stops
authenticating right away, not at the next check-in. Keys, devices and terms are kept;
**Enable license** restores access.

## Keys

The Keys tab lists the license's active keys: label, hash (the first 6 and last 4 characters,
with the full value a click away and a copy button), status, created, who created it and when it
was last used. Revoked keys are collapsed under **Show _N_ revoked**. The raw value is never
stored, so it's never shown again after mint. **Mint key** takes an optional label and shows the
new raw key once, in the same guarded panel as creation. **Revoke** asks first, takes effect
immediately, and cannot be undone: devices using that key must activate again with another key.

## The device table

Each license's **Devices** tab shows a **Seats** meter and the same device table as
[Devices, product-wide](#devices-product-wide), limited to this license: label or id, status,
platform and architecture, app and SDK version, when it was added and when it was last seen. The
table filters by status and platform, and its filters are in the URL.

A row's actions appear only when they apply: **Deauthorize** for a device that is still
authorized, and **Reset binding** for a device that has a hardware binding. Opening a device
shows its detail drawer, where the fingerprint and its components, the hardware and software
facts and the probe answers are written out. See [Fingerprints](/docs/services/core/fingerprints/)
for the matching algorithm behind all of this.

- Hardware ids and component hashes are truncated for display (the hardware id to 12 characters,
  each component hash to 8) on top of the truncation the wire format itself already applies (a
  component hash is 22 base64url characters; the hardware id is 32). Even an already-opaque
  digest is still hardware-derived, so a screenshot can't be used to correlate one device across
  products.
- **Unverified** means the device activated without sending a fingerprint at all, either
  because it predates fingerprinting or the product has it disabled.
- **Drifted** means the device's last check-in changed some components but stayed within
  tolerance. This is the _last_ drift only; the full history is in
  [Activity](/docs/admin/activity/) as `device.fingerprint.drift` entries, one per tolerated
  drift event.

### Deauthorize vs. reset the hardware binding

Two different actions, for two different problems:

| Action            | Effect                                                                                                                                                           | Use it when                                                                                                                           |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **Deauthorize**   | The device is marked deauthorized, its token evicted. It must re-activate — with a key — to use the license again. **Frees the seat.**                           | The device shouldn't have access at all: lost, decommissioned, offboarded.                                                            |
| **Reset binding** | Clears the stored hardware fingerprint only. The device **stays authorized and keeps its seat**; its next check-in re-binds to whatever hardware it now reports. | A legitimate hardware change tripped `hardware_mismatch` and locked the user out, and you don't want to burn a seat re-issuing a key. |

Deauthorize asks first, as an irreversible action; reset binding asks first too. Reset binding is
`POST .../devices/<id>/fingerprint/reset`, audited as `device.fingerprint.reset`. It exists
specifically as the support escape hatch for a false-positive drift lockout: a mismatch normally
retires the binding and forces a fresh authorization on its own, but reset does the same clearing
_proactively_, before the user hits the wall, without spending a re-activation.

## Config overrides

The **Config overrides** tab edits the license's own configuration values over everything it
inherits. Each inherited value names its source: the catalog default, the tier's profile, or one
of the license's profiles, merged in the server's order. When the product doesn't run Config the
tab says so; when the catalog can't be loaded the tab shows the error with a retry; when a
profile the license inherits from can't be loaded, a warning says the inherited values may be
incomplete.

## Devices, product-wide

A license's Devices tab reaches a device through the license it holds a seat on, so a device that
holds **no license** never appears there: a device registered under open or
requires-identity registration (a free game, say) has none. **Platform → Devices** lists every
device of the product, licensed or not, and it is never hidden by service enablement.

The table shows one summary row per device: label or id, status, license and seat (or a
**License-free** badge), platform and architecture, app and SDK version, and **last seen**.
"Last seen" is the time of the device's most recent check-in; it is not an "online" indicator.
Fingerprint and software facts are not loaded per row; open a device to see them in the detail
drawer, the same drawer a license's Devices tab opens, and nothing more (raw hardware values never
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
- **Actions** in the drawer are the same two as on a license's Devices tab, with the same effects and
  the same audit events (`device.deauthorize`, `device.fingerprint.reset`):
  **Deauthorize** and **Reset binding**. Deauthorizing a license-free device marks it
  deauthorized and revokes its token, and frees nothing because it holds no seat. Under open
  registration it can register again on its next start, and the console says so before you
  confirm. Deauthorizing a licensed device here frees its seat exactly as the license's tab does.

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

## Refused activations

Every time a device is turned away at activation, the Worker records it: the license, when, why,
a short label for the device and a hash of its device id. The reasons are `device_limit` (every
seat is taken), `hardware_mismatch` (the machine no longer matches its binding),
`fingerprint_required` (a `strict` tier and no fingerprint) and `license_unusable` (disabled,
expired or ended). The label is the device's own name when it has one, else its reported platform
and architecture, else its User-Agent, held to 64 plain-text characters.

The record is written after the device has its answer, so it never slows a refusal down and a
failed write never changes one. Repeats from one device for one reason within a minute count once.
Records are kept for 30 days; the nightly maintenance run deletes older ones.

| Route                                      | Purpose                                                                                                                                  |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /manage/api/products/<slug>/refusals` | Recent refusals and the licenses refusing devices: `refusedSince` (epoch seconds, default 7 days ago), `licenseId`, `limit` (1-200, 50). |

It returns `{ since, refusals, licenses }`. `refusals` is newest first, each
`{ id, licenseId, at, reason, deviceLabel, deviceHash }`. `licenses` lists every license refused at
least once since `since`, latest first, each `{ licenseId, count, devices, lastAt }`, where
`devices` counts distinct devices. A `refusedSince` older than 30 days reads from 30 days ago.

## Fingerprint policy

The **Enrollment** page has three sections.

**Registration** is shown read-only: what is enforced now and what is declared, with **Change in
Services**. It's a Core policy derived from the enabled service set (or explicitly declared), and
editing it here would be a second control over a value that already has one; see
[Services & enablement](/docs/admin/services-enablement/). It's shown here because you can't
reason about fingerprinting without first knowing whether a device can reach the point where a
fingerprint matters.

**Fingerprint policy** is one choice of mode, each with its own tolerated-drift count (see
[Fingerprints](/docs/services/core/fingerprints/#modes-and-tolerances) for the exact numbers and
the anchor bonus):

| Mode        | Effect                                                                                 |
| ----------- | -------------------------------------------------------------------------------------- |
| **Off**     | Fingerprints are recorded but never enforced, whatever a tier sets (`enabled: false`). |
| **Lenient** | Up to 4 changed components still count as the same machine.                            |
| **Normal**  | Up to 2 changed components still count as the same machine.                            |
| **Strict**  | Every component must match, and a device with no fingerprint is refused.               |

A tier may set its own mode, which applies whenever enforcement is on. Like Services, this policy
carries an owner, shown beside the section title (**From manifest** or **Set in console**).
**Revert…** in that badge hands the policy back to `manifest` ownership and, in the same action,
**also returns the auto-issue policy to manifest control**. The confirm dialog lists both,
because the second effect isn't visible anywhere else in the console.

**Probes** lists the presence checks the product declares in `.pkey/product`: the probe, its id
and the per-platform hint for macOS, Windows and Linux, sortable by any column. The list is
**not** editable here: a `PATCH` replaces the whole array, and the per-platform hints aren't
something a partial editor could safely round-trip. Change it in `.pkey/product` and use
**Resync from repo** (for a product linked to a repository) to apply it.

## Tiers

A tier is a named template that a license can be assigned: a profile, a term (how long a license
issued on the tier lasts), a device limit, release channels and a version window. The Tiers list
shows each of those and **Used by**, the number of licenses on the tier (a link to the license list
filtered to it). A row opens the tier record.

- **New tier** opens a drawer with every field on one pane. The id is permanent: lowercase
  letters, digits, `-` and `_`.
- The tier record's **Overview** edits the same fields and saves only what changed. A blank term
  means no expiry; a blank device limit means the product default. Clearing a number, or choosing
  **No profile**, sends `null`. The form checks that the minimum version is not above the
  maximum before saving.
- **Used by** lists the licenses on the tier.
- A tier has one profile; a license can add more of its own on top of it, in order.

The server validates `policyDeviceLimit` as a real seat count: `0` or a negative number is
refused (`422`), because the runtime treats a non-positive limit as **unlimited**, not zero. Delete
is unavailable, with the reason, while any license uses the tier (the server refuses it with `409`
too); for an unused tier it asks first.

## Minting an offline bundle

**Mint offline bundle…** (in a license record's **More actions**) is for devices that can't reach
the network at all. It opens a dialog with:

- **Device ID**: the 32-character request code the air-gapped app's own offline screen shows;
  pasted, not chosen. A code of the wrong length is refused in the dialog.
- **Grace days**: the offline window the minted documents grant, 1 to 365 (365 by default, the
  ceiling, since this is for the machine least able to come back for another bundle).
- **Include configuration**: shown only when the product runs Config; ships the signed config
  document alongside the license document.
- The license itself supplies `licenseId`: there's no authenticated device on this path to infer
  one from, so the console always sends the license you opened the dialog from.

The result shows the bundle id (with a copy button: quote it on a support ticket), a
**Download** button for the `.pkeybundle` file, and the bundle itself to copy if the browser
won't save the file. The full operator workflow (when to reach for this instead of normal
offline tolerance, the `pkey bundle` CLI, and why the mint has two independent time bounds) is on
[Offline bundles](/docs/admin/bundles/). The wire-level detail is at
[Offline bundles](/docs/build/wire/bundles/) in the wire contract section.

## Admin API: clearing a value

The license and tier `PATCH` routes (`/manage/api/products/<slug>/license/licenses/<id>` and
`…/license/tiers/<id>`) treat a field three ways: absent keeps the stored value, a value replaces
it, and `null` clears it. `null` clears a license's `maxOfflineDays` (the product default
applies), and a tier's `profile`, `policyExpiryDays` (no term) and `policyDeviceLimit` (the
product default). Each change is audited as `license.update` or `tier.update`.

## Reference

- [D1 data model](/docs/reference/data-model/) — `licenses`, `keys_index`, `tiers`,
  `license_profiles`, `device_fingerprints`, `device_facts`.
- [Fingerprints](/docs/services/core/fingerprints/) — the matching algorithm, drift counting, and
  what `unverified` means.
- [The device principal](/docs/services/core/device-principal/) — the device roster, registration
  and `pkeyt_` tokens.
- [Fingerprint constants](/docs/reference/fingerprint-constants/) — the frozen hash formulas.
