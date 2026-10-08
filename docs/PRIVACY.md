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

### Hardware fingerprint — native SDKs only (Node/Electron, Python, Swift, Godot, Kotlin)

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

**Kotlin** on a JVM desktop reads a subset of the desktop sources: the Linux machine-id, macOS's
`IOPlatformUUID`, the Windows board serial and model (`Get-CimInstance`) and the RAM bucket. On
Android it reads no hardware serial: it sends the anchor (`ANDROID_ID`, which is app-scoped, or
else a random value kept in the Android Keystore), `Build.MODEL` and the RAM bucket.

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
(where the install came from: the build's stamped outlet, refined on the device by outlet
detection, such as `steam`, `itch` or `app-store`; only the outlet id or kind, never a raw
signal, and nothing when it is unknown).

Every SDK that reports also sends `caps`: the parity feature ids its `supports()` answers
Supported for right now, such as `core.verify` or `update.decide`. The list follows from the
SDK, its version, the runtime, the product's enabled services and the build's outlet, which are
reported or known already. It adds one bit about the device: whether an optional dependency is
present. For example, `core.store` is missing from a Node or Python install without a usable OS
keyring. It names features only. It never names a library, a path or a version.

Used for: admin visibility, compatibility gating, and targeting configuration at the machines
that need it.

### Update outcome events — SDKs with an updater (Godot today)

What happened after an update reached the device: one of `update_offered`, `update_downloaded`,
`update_applied`, `update_confirmed`, `update_reverted`, `pack_failed` or `boot_rolled_back`,
each with a client-chosen event id, the deliverable and release ids (and the release it came
from), the outlet and channel, the pack set id for a pack, a timestamp, and an optional short
machine-readable code such as `boot_failed`. At most 16 per report, sent in the report's
`updates` key. No hardware value, no user identifier, no free-text message.

Used for: the operator's update funnel per release, outlet and channel, the operator-enabled
automatic halt of a rollout that reverts or rolls back too often, and nothing else. A Sentry
alert the operator connects is mapped to a rollout from the release, environment and outlet tags
only; no crash payload is stored. Of each Sentry delivery the Worker keeps only `{resource, action,
rule, issueId, release, environment, outlet}` (30 days, with the connector event log), never the
crash message, exception, user or other tags.

### Pack install reports — SDKs with packs (Node today)

How the device's recent content-pack installs went: the pack id, the content hashes of the
payload it moved from and to, the strategy that installed it (`delta`, `chunk`, `file`, `full`),
the planned bytes, whether a fallback ran and, if so, the first failure's code. At most 8 per
report, in the report's `packInstalls` key. No file name, path, hardware value or user identifier.

Used for: finding the pairs of pack releases many devices move between, so the server can
prepare a smaller download for them (lazy deltas), and nothing else. Counted only for products
whose operator opted in.

### Store purchases — the commerce bridge (P6-01, products that sell through a store)

When a player claims a store purchase, the Worker keeps what it needs to keep the licence flag
honest: the SHA-256 of the store's purchase key (never the key itself), the store product id, the
licence it was bound to, its state and environment, and the store ids a later re-check needs — an
App Store transaction id, a Play purchase token and order id, or a **Steam ID** (a Steam account
number) with the DLC's app id. The licence's purchase **binding** is a random UUID handed to the
store; it is not the licence id and identifies no one by itself. Store notifications are kept as
received (Apple's signed payload, Play's notification body: product and purchase ids, no name,
email or payment data) for 30 days, with the connector event log.

Used for: granting and revoking the purchased licence flag, and nothing else.

### The Polaris Key account's sign-in (I-07, the login card on key.plrs.im)

When a person signs in to their Polaris Key account, the Worker keeps, per browser session: when it
started and was last seen (refreshed at most every five minutes), when it expires, how the person
signed in (`email`, `google`, …) and a coarse label of the browser family and operating system
("Firefox on Windows"; no versions, builds or device models). The person
sees and ends these sessions themselves. A pending sign-in or email confirmation keeps the address
being confirmed, the provider's identity and what the provider sent about the person, plus the
city and country Cloudflare attaches to the request that started it (shown back as "requested at
<time> from <place>" when the link is opened on another device). From an identity provider
(Google, Apple, Steam) it keeps, per sign-in method: the name and locale the provider sent, and a
copy of the provider's picture in R2 under an opaque random key (never the provider's URL; a
peppered hash of it decides when to fetch again). The provider learns nothing about who views the
copy.

Used for: signing the person in, showing and ending their sessions, and filling their profile.

While the owner has the move off single sign-on turned on (I-17), a sign-in through the platform
identity provider (single sign-on at id.plrs.im, in an app of a `provider: platform` product or on
the portal) is kept on a Polaris Key account: the provider's subject as a sign-in method, the
address it verified as the account's primary email and an email sign-in method (when no other
account uses it), the name it sent, the groups it reported (`groups`, which Discover reads to
offer a product's group tiers; replaced at each sign-in), and the time of the sign-in. The licences
that provider's
sign-ins created join the account. Nothing new is collected from the device. The operator's count
of who would lose single sign-on at the sunset holds numbers only.

Whatever that switch says, a product browser session opened through single sign-on (the web page
of an app of a `provider: platform` product) keeps on its record the id of the Polaris Key
account that holds the person's single sign-on, if one does, and nothing else about them. It is
there so the session ends when that account is disabled or erased; the record expires with the
session, after 30 days at most.

For each passkey a person adds (I-16), the Worker keeps the credential's public key and id, its
signature counter, the transports the browser reported, the relying party (`key.plrs.im`), the
account's random WebAuthn user handle (never the account id), when it was added and last used, and
for the settings list the authenticator model's AAGUID (when the browser discloses it), whether it
is synced, and the coarse browser label it was added from. No biometric or private key ever leaves
the person's device. A pending passkey ceremony is held for 5 minutes: its random challenge and
the relying party, plus the same-origin return path for a sign-in, or the account id and its user
handle for adding a passkey.

### Not collected

Hostname, OS username, IP-derived geolocation, browsing or file activity, a list of installed
applications, and any raw hardware serial. None of these are read by any SDK.

## Where it lives, and for how long

| Data                                                                                                                                                                                                                                                                                                                                                                                                                             | Table                                                                           | Lifetime                                                                                                                                                                                                                                                         |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fingerprint components + hwid                                                                                                                                                                                                                                                                                                                                                                                                    | `device_fingerprints`                                                           | Deleted with the device                                                                                                                                                                                                                                          |
| Software facts + probe results                                                                                                                                                                                                                                                                                                                                                                                                   | `device_facts`                                                                  | Deleted with the device                                                                                                                                                                                                                                          |
| Drift and mismatch events                                                                                                                                                                                                                                                                                                                                                                                                        | `audit`                                                                         | Retained with the product's audit log                                                                                                                                                                                                                            |
| Update outcome events (latest report's `updates`)                                                                                                                                                                                                                                                                                                                                                                                | `devices.reported_json`                                                         | Replaced by the next report; deleted with the device                                                                                                                                                                                                             |
| Update outcome counters (per release, outlet, channel, event) and one record per device (its counted event ids, to count distinct devices)                                                                                                                                                                                                                                                                                       | `UpdateHealthDO` (a Durable Object per release)                                 | 30 days (a device record: 30 days after its last event), then deleted by the object's own sweep                                                                                                                                                                  |
| Sign-in artefacts: OIDC flow records, device codes, portal magic links (which name the recipient's email), email codes (stored hashed) and wrong-code strikes (keyed by a hashed recipient)                                                                                                                                                                                                                                      | `SingleUseDO` (the sharded single-use store)                                    | Until used or expired: 10 minutes for a flow, link or code; a strike record at most an hour (a lockout 15 minutes); expired records are deleted by the object's own sweep                                                                                        |
| Pack install reports (latest report's `packInstalls`)                                                                                                                                                                                                                                                                                                                                                                            | `devices.reported_json`                                                         | Replaced by the next report; deleted with the device                                                                                                                                                                                                             |
| Lazy-delta demand: one row per device and pack-payload pair (strategy, last time), for products that opted in                                                                                                                                                                                                                                                                                                                    | `delta_demand_devices`                                                          | 30 days after the device last reported the pair, then deleted by the nightly sweep                                                                                                                                                                               |
| Store purchases (hashed key, product, licence, state, re-check ids incl. a Steam ID) and the licence's store grants                                                                                                                                                                                                                                                                                                              | `dist_purchases`, `license_store_grants`                                        | Kept while the licence exists; a refund marks them revoked                                                                                                                                                                                                       |
| Grants (LX-08): why a licence, an account or a Steam identity holds an entitlement: the source, the hashed purchase key, the store product, the state and times, and each key it carries (a licence's OIDC-provisioned keys included); the Steam identities verified on a device (hashed); entitlement-change events (the product's pairwise subject, the keys)                                                                  | `grants`, `grant_entitlements`, `device_store_identities`, `entitlement_events` | A licence's grants are kept while the licence exists and deleted with it; account- and Steam-held grants, Steam identities and events (none written before LX-11 and LX-13) are deleted with the product, and events also with the person's data for the product |
| Purchase binding (random UUID per licence)                                                                                                                                                                                                                                                                                                                                                                                       | `dist_purchase_bindings`                                                        | Kept while the licence exists                                                                                                                                                                                                                                    |
| Store notifications (as received)                                                                                                                                                                                                                                                                                                                                                                                                | `dist_connector_events`                                                         | 30 days                                                                                                                                                                                                                                                          |
| Account sessions (times, sign-in method, browser label)                                                                                                                                                                                                                                                                                                                                                                          | `account_sessions`                                                              | 14 days while live; an ended session is pruned 30 days after it ended; deleted with the account                                                                                                                                                                  |
| Pending email sign-ins, email gates and passkey ceremonies (the address, the provider identity and profile, the requesting city and country; a passkey ceremony's challenge, relying party, return path or account id and user handle)                                                                                                                                                                                           | `SingleUseDO` (the sharded single-use store)                                    | Until used or expired: 10 minutes for a sign-in, 15 for an email gate, 5 for a passkey ceremony                                                                                                                                                                  |
| Provider profile per sign-in method (name, locale, picture reference) and the account's pictures (provider copies and uploads, re-encoded; metadata discarded, originals never kept)                                                                                                                                                                                                                                             | `account_links.profile_json`, `account_avatars`, R2 `avatars/`                  | A picture nothing uses is deleted when replaced, or by the nightly sweep after a day (an upload never saved included); everything is deleted with the account                                                                                                    |
| Passkeys (public key, credential id, counter, transports, user handle, times, AAGUID, synced flag, browser label)                                                                                                                                                                                                                                                                                                                | `account_passkeys`, `accounts`                                                  | Until the person removes the passkey or the account is deleted                                                                                                                                                                                                   |
| Account overrides: managed config an operator sets for one person on one product (U-03), secrets sealed                                                                                                                                                                                                                                                                                                                          | `account_overrides` (by the product's pairwise subject)                         | Until an operator removes them; deleted with the person's data for the product, with the account and with the product                                                                                                                                            |
| The licence-override migration report: licence id, the licence's own email, key names, non-secret config values, the owner's pairwise subject (never a secret value)                                                                                                                                                                                                                                                             | `override_migration_report`                                                     | 90 days after the run, then deleted by the nightly sweep; a person's rows go with their data for the product and with the account, and every row with the product                                                                                                |
| The relink tool's history (I-12, LX-30): which pairwise subject a licence moved from and to, the reason, the operator, the undo window; for Make floating and Reassign also the licence's own name and email before and after                                                                                                                                                                                                    | `license_relinks`                                                               | Kept as the licence's history; deleted with the licence and with the product; an account deletion clears its account ids                                                                                                                                         |
| Accepted product terms (product, terms version, the terms URL the gate showed, time accepted)                                                                                                                                                                                                                                                                                                                                    | `account_terms_acceptances`                                                     | For the account's life, one row per terms version (a merge moves them to the survivor); deleted with the account, and a product's rows with the product                                                                                                          |
| Storefront library entries (account, product, time added): an open product added from the Polaris Key storefront, with no licence                                                                                                                                                                                                                                                                                                | `library_entries`                                                               | Until the person removes it; deleted with the account, moved to the survivor on an account merge and back to the joined account on the join's undo, if the survivor still holds it; cleared when the product is deleted                                          |
| Storefront impression dedupe: a daily keyed HMAC of the account id (the salt derived from `KEY_HASH_PEPPER` and the day, never stored), with the product and day; no account id. Not written at all without `KEY_HASH_PEPPER`                                                                                                                                                                                                    | `storefront_seen`                                                               | At most two days (today and yesterday), then deleted by the nightly sweep                                                                                                                                                                                        |
| Storefront daily counters per product, day and path kind (impressions, adds, first activations); nothing about a person                                                                                                                                                                                                                                                                                                          | `storefront_daily`                                                              | Kept until the product is deleted                                                                                                                                                                                                                                |
| An account join's undo snapshot (`snapshot_json`): the absorbed account's row (primary email, display name, locale, profile sources, passkey user handle), its consents (claims shared with each app), terms acceptances, auto-attach blocks and library entries, and the ids of what moved (sign-in methods, passkeys, licences, sessions, pictures, registry tokens, relinks, pairwise subjects and the devices bound to them) | `account_merges`                                                                | Up to 72 hours: cleared by an undo, deleted by the nightly job once the window ends, and deleted with either account                                                                                                                                             |

Deauthorizing a device — from the app, the admin panel, or the customer portal — routes
through `setDeviceStatus()` in `packages/worker/src/repo.ts`, which purges both tables in the
same operation. Disabling a license purges every one of its devices. This is why no scheduled
cleanup job exists for these tables: there is no orphaned data for one to collect. The update
outcome counters are the exception: they are aggregates per release, not per device, so they are
not purged with a device; each counter object deletes buckets older than 30 days and every device
record (a device id with the event ids it had counted) idle for 30 days, on its own alarm — it
resumes within minutes until the whole object has been swept — and deletes itself entirely once
nothing is left. Lazy-delta demand rows are the other exception: they count distinct devices per
pair of pack payloads, so they are kept 30 days after the device last reported that pair and then
pruned by the nightly maintenance sweep, whether or not the device still exists.

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

A product's **Users** page (Core → Users) shows each person by a random id that exists for that
product only (`ps_…`); another product's console sees a different id for the same person. It
shows that product's licences, devices, data size and console audit, and, with Identity on, the
person's sign-ins to that product by method kind ("Steam") only. It never shows the Polaris Key
account id, the account's sign-in methods, or anything from another product. The contact email
is the licence's buyer email; the account's own email appears only when the person agreed to
share it with that product. An admin can export that product's data for the person as JSON,
delete it, detach a licence, or move a licence to another person of the same product (a fresh
admin sign-in, a recorded reason, an email to both people first, and 72 hours to undo). An admin
can also set the person's **account overrides** for that product (managed config; a secret is
never shown again once saved). No admin can delete, disable, sign out or merge an account, or
change its sign-in methods.

## What an end user can see

The customer portal already lists a user's own devices with their platform, versions, and
first/last-seen times, and lets them disconnect any of them — which purges that device's
fingerprint and facts.
