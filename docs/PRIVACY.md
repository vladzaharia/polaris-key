# Polaris Key — what clients collect, and why

What an SDK and the Worker collect from a device, why, and how long it is kept.

The rules below are enforced in code, not just documented. Where that is true, the enforcing
call site is named.

## Principles

1. **Raw hardware identifiers never leave the device.** Every fingerprint component is hashed
   on the client as `SHA-256("pkey-hw:<product>:<component>:<raw>")`, truncated to 22
   base64url characters. The Worker only ever sees opaque digests and can compare them; it
   cannot recover a serial number, MAC address, or platform UUID from what it stores. This
   mirrors how the device id has always worked (`pkey-device:<product>:<raw>`).
2. **Domain separation per product.** The product slug is inside every hash, so the same
   device produces unrelated digests for two different products. A leak of one product's
   table cannot be joined against another's.
3. **Collect declared things only.** There is no installed-application enumeration. A product
   declares the companion apps it cares about as **probes**; the client answers only those.
4. **Everything is bounded.** The report body is capped at 16 KiB, the probe map at 32
   entries, and the signed config document at 64 KiB. Unknown keys are dropped, not stored.
5. **Retention is device lifetime.** Fingerprints (including the first one bound, kept as the
   comparison baseline: the same hashed components) and software facts are deleted when the
   device they describe is deauthorized, so nothing about a device outlives it. What ages out on
   its own is the log and housekeeping data around it: a nightly maintenance job deletes audit rows
   after 180 days, stops counting devices unseen for 90 days, and removes the other expired
   records listed under "The nightly maintenance job".

## What is collected

### Hardware fingerprint — native SDKs only (Node/Electron, Python, Swift, Godot, Kotlin)

Seven components, each hashed independently on-device. Any component that cannot be read is
omitted rather than substituted.

| Component        | Source                                                                                                                                             | Purpose                                                                            |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `machineUuid`    | macOS `IOPlatformUUID` · Windows registry `MachineGuid` · Linux `/etc/machine-id`, else `/var/lib/dbus/machine-id` · iOS `identifierForVendor`     | The anchor: identifies the device (on Linux, the OS install) across upgrades       |
| `boardSerial`    | macOS `IOPlatformSerialNumber` · Windows `Win32_BaseBoard.SerialNumber` (PowerShell `Get-CimInstance`) · not read on Linux or iOS                  | Distinguishes otherwise-identical devices                                          |
| `cpuModel`       | CPU brand string + logical core count                                                                                                              | Detects a mainboard/CPU swap                                                       |
| `primaryMac`     | Lowest non-loopback MAC                                                                                                                            | Detects a NIC change                                                               |
| `bootVolumeUuid` | macOS boot volume UUID · Windows `vol C:` serial · Linux `findmnt -no UUID /`                                                                      | Detects a disk replacement or reimage                                              |
| `ramBucket`      | Total RAM in whole GiB, rounded down to a power of two; omitted below 1 GiB                                                                        | Coarse on purpose: stable while the reported total stays between two powers of two |
| `machineModel`   | macOS `hw.model` · Windows `Win32_ComputerSystem.Model` (PowerShell `Get-CimInstance`) · Linux `/sys/class/dmi/id/product_name` · iOS `hw.machine` | Distinguishes device classes                                                       |

The exact derivation rules are normative in the wire contract (v5) and pinned by the conformance
corpus. **No DMI serial or product UUID is read on Linux** (`product_uuid` and `board_serial` are
root-only, so reading them made the fingerprint depend on the process's privilege). A Linux host
with no usable machine-id — which includes most container images — therefore has no anchor
component, and cannot obtain a keyless (free-tier) license; activating with a license key still
works. In a container, mount the host's `/etc/machine-id` read-only, or create one and keep it in a
volume.

**Godot** reads the same desktop sources through `OS.execute` and the file system (on Windows,
`getmac` for the MAC; on macOS, `ifconfig`; on Linux, `/sys/class/net/*/address`), once per
session and off the main thread. On iOS and Android it sends only the anchor (Godot's
`OS.get_unique_id()`: `identifierForVendor` on iOS, `ANDROID_ID` on Android), the device model,
RAM and, on iOS, the CPU. A Godot web export collects no fingerprint.

**Kotlin** on a JVM desktop reads a subset of the desktop sources: the Linux machine-id, macOS's
`IOPlatformUUID`, the Windows board serial and model (`Get-CimInstance`) and the RAM bucket. On
Android it reads no hardware serial: it sends the anchor (`ANDROID_ID`, which is app-scoped, or
else a random value kept in the Android Keystore), `Build.MODEL` and the RAM bucket.

**The browser SDK collects no hardware fingerprint at all.** Canvas/WebGL-style browser
fingerprinting is unreliable, actively degraded by browsers, and privacy-hostile; the browser
keeps its existing server-minted session identity.

Used for: enforcing per-tier device limits honestly, deduplicating auto-issued free licenses
to one per device, and detecting when a device's hardware has been replaced.

### Software facts — all SDKs

OS name, version, build, and kernel; CPU model, core count, total RAM, and device model;
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

Used for: admin visibility, compatibility gating, and targeting configuration at the devices
that need it.

### Update outcome events — SDKs with an updater

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

### Pack install reports — SDKs with packs (Node)

How the device's recent content-pack installs went: the pack id, the content hashes of the
payload it moved from and to, the strategy that installed it (`delta`, `chunk`, `file`, `full`),
the planned bytes, whether a fallback ran and, if so, the first failure's code. At most 8 per
report, in the report's `packInstalls` key. No file name, path, hardware value or user identifier.

Used for: finding the pairs of pack releases many devices move between, so the server can
prepare a smaller download for them (lazy deltas), and nothing else. Counted only for products
whose operator opted in.

### Store purchases — the commerce bridge (products that sell through a store)

This is the Commerce service (`commerce`); it adds no new data.

When a player claims a store purchase, the Worker keeps what it needs to keep the license flag
honest: the SHA-256 of the store's purchase key (never the key itself), the store product id, the
license it was bound to, its state and environment, and the store ids a later re-check needs — an
App Store transaction id, a Play purchase token and order id, or a **Steam ID** (a Steam account
number) with the DLC's app id. The license's purchase **binding** is a random UUID handed to the
store; it is not the license id and identifies no one by itself. Store notifications are kept as
received (Apple's signed payload, Play's notification body: product and purchase ids, no name,
email or payment data) for 30 days, with the connector event log.

Used for: granting and revoking the purchased license flag, and nothing else.

### The Polaris Key account's sign-in (the login card on key.plrs.im)

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

The account's profile is a screen name, a picture and, only if the person adds or accepts
one, a **birth date** (`YYYY-MM-DD`) with where it came from (`user`: typed by the person;
`connection:<id>`: offered by a connection's sign-in and accepted unchanged). Minimised by
design:

- **Optional, stored only on acceptance.** A connection's birth date is kept only in the pending
  sign-in (15 minutes) as an offer; it reaches the account only when the person accepts it, and is
  never stored on a sign-in method. The person can add, change or remove it in Account → Profile.
- **Never shared.** It is shown only to the person (Account → Profile, and their own export). No
  app, developer, operator, Users page, export or signed document receives it, whatever the person
  consented to. It is not written to the audit (which names the field, never the value), to mail
  or to logs.
- **Nothing is decided from it.** There is no age check or age signal until a product gates
  content.
- **Deleted with the account**, at once.

Once the owner publishes Polaris Key's own terms (`identity.platformTerms`, unset), each new
account also records the terms version it accepted and the terms URL it was shown (a `_platform`
row beside the product terms acceptances). The privacy notice is linked beside them and is not
"accepted", so it gets no row.

While the owner has the move off single sign-on turned on, a sign-in through the platform
identity provider (single sign-on at id.plrs.im, in an app of a `provider: platform` product or on
the portal) is kept on a Polaris Key account: the provider's subject as a sign-in method, the
address it verified as the account's primary email and an email sign-in method (when no other
account uses it), the name it sent, the groups it reported (`groups`, which Discover reads to
offer a product's group tiers; replaced at each sign-in), and the time of the sign-in. The licenses
that provider's
sign-ins created join the account. Nothing new is collected from the device. The operator's count
of who would lose single sign-on at the sunset holds numbers only.

Whatever that switch says, a product browser session opened through single sign-on (the web page
of an app of a `provider: platform` product) keeps on its record the person's single sign-on
subject (the identity provider's address and its id for them) and the id of the Polaris Key
account that held that sign-on when the session opened, if one did, and nothing else about them.
They are there so the session ends when an account that holds that sign-on, then or since, is
disabled or erased: every use of the session checks them. If that check cannot run (the database
is unavailable), the page reads as signed out for that request. The record expires with the
session, after 30 days at most.

A connection is an identity provider the platform signs people in through, such as an
organization's single sign-on. A sign-in through one keeps, on that sign-in method, the groups the
connection's mapped claim reported (at most 100 names) and the values of the few claims its claim
map names for access rules (`claims_json`), both replaced at each sign-in through it and deleted
with the method. A connection's birth date is never kept there: it rides only in the pending
sign-in as an offer (above). To prove that a connection may sign in an email domain, the Worker
reads a public DNS TXT record for that domain over DNS-over-HTTPS (Cloudflare's resolver) when the
domain is added and once a day after; the query names the domain only, never a person.

For each passkey a person adds, the Worker keeps the credential's public key and id, its
signature counter, the transports the browser reported, the relying party (`key.plrs.im`), the
account's random WebAuthn user handle (never the account id), when it was added and last used, and
for the settings list the authenticator model's AAGUID (when the browser discloses it), whether it
is synced, and the coarse browser label it was added from. No biometric or private key ever leaves
the person's device. A pending passkey ceremony is held for 5 minutes: its random challenge and
the relying party, plus the same-origin return path for a sign-in, or the account id and its user
handle for adding a passkey.

### The console sign-in card's remembered address (key.plrs.im/manage/login)

The console's sign-in card remembers who signed in last, so an operator sees "email · Change"
instead of an empty field. It is one cookie, set on the operator's own browser:

| Cookie                     | Holds                                        | Lifetime | Flags                                   | Cleared by                            |
| -------------------------- | -------------------------------------------- | -------- | --------------------------------------- | ------------------------------------- |
| `__Host-pkey_console_hint` | The email of the last account sign-in (text) | 30 days  | `HttpOnly`, `Secure`, `SameSite=Strict` | **Change** on the card, or its expiry |

It is set only by an account sign-in, never by break-glass, and it survives sign-out on purpose.
The Worker never stores it. It is read only to fill the card and to offer the address to the
identity provider as `login_hint`; it grants nothing. On a shared computer the card shows the
last operator's address until someone presses **Change**.

### Product backends — the license document sent to the developer's own server

An app built with a client half (`client.backend`) sends its signed license document to its
developer's own backend in the `X-PKey-License` header, with its device id in `X-PKey-Device`
(WIRE-CONTRACT-V4 §14). The document is the one the device already holds: it carries the license
holder's name and email (its signed `profile`), the license id, the device id, the entitlements
and, when an account is signed in on the device, that account's pairwise subject. It goes to the developer's own
server, never to Polaris Key: the Worker never receives or reads the header, so nothing about these
requests is collected or stored by Polaris Key. What that server keeps is the developer's own
policy. The server drop-ins never log the header, the document or the holder's name and email, and
the docs list the header for APM scrubbing. The device token and the config document are never
sent.

### Cloud Sync — settings kept for a signed-in person

Cloud Sync (service `sync`) stores what a signed-in person chose in one product so their devices
agree: the product's synced settings, each key with its value, edit clock and the random `clientId`
of the install that wrote it. It is keyed by the product's pairwise subject, never an account id,
so two products cannot join their data. Nothing is stored for a device with no signed-in account.
The directory row also keeps the person's `tier_id` (from the device's license, for the operator's
usage page) and the last `platform` family that wrote; neither is a hardware value. An
operator sees totals and the per-product breakdown, not values; an operator delete needs a step-up.
Quota never deletes. The person can clear it, export it with their
account data, or delete it with the account; deleting a product erases its objects, and an object that finds its product gone erases itself.

### The key ring — wrapped keys for a person's devices

When a product keeps Cloud Sync data end to end encrypted (the default), the person's devices
share one root key that the Worker never holds in a form it can open. The Worker keeps, per product
and pairwise subject, one ring: its id, its epoch and the key's identifier (`kid`, a hash, not
key material); one wrap per device, which is the root encrypted to that device's public
key-agreement key, with the id of the device that deposited it; and one recovery blob, the root
encrypted under a code only the person holds. After a start over, the ring it replaced stays as
`previous` for 30 days, and a device may store the old root encrypted under the new one
(an adoption blob), so data written before the reset can be read again. No row holds a key, a code,
a name or a hardware value. Because the root is encrypted on the device, the Worker cannot read
synced content in this mode.

The Worker records who touched the ring, not what was in it. A recovery fetch, a change of the
recovery blob and a start over each write an audit row with the device id and no blob, and each
sends a notice to the account's verified addresses. When no address can be reached, only a row
with a count is left.

Rows are deleted as follows. A device's wrap goes when the device is removed or unbound, when it
joins another subject, and when it registers new keys. The ring, every wrap, every adoption blob and
the recovery blob go when the person deletes their account or their Cloud Sync data, and when the
product is deleted. The previous ring and its wraps go in the nightly job 30 days after a reset.
They are part of the person's data export as the opaque values they are.

### Device keys — kept for a device's own keys

A device may register two public keys with the product: a signing key and a key-agreement key,
each 32 bytes. They are generated on the device, and the private halves never leave it. The Worker
keeps, per device, the two public keys, a key counter and the times they were created and last
changed. A separate row keeps only the counter and the time of the last accepted proof, so a
registration after a removal continues the count and an old proof cannot be replayed. Neither row
holds a hardware value, a name or a subject: the keys are random and are not derived from the
hardware fingerprint.

The keys are deleted when the device is deauthorized, when its license is deleted and when its
product is deleted. The counter row is deleted with its license and its product. Services told that
a device was bound, unbound, removed or changed its keys (the device lifecycle event) receive the
product, the device id and, for a binding, the pairwise subject; they receive no key material.

Within one product no two devices may hold the same key-agreement key. A registration that
repeats another device's key is refused, so a device that can register can tell whether a given
public key is already in use in that product. This is accepted: the keys are public, and a change
is limited to four a day per device.

### Cloud Connect — a person's devices finding each other

Cloud Connect (an opt-in service, off in production until launch) lets a signed-in person's devices
find each other and talk over the local network or a relay.

- **Stored.** The device keys above; per person and product, a roster of device ids with their
  keys and an epoch, and a random discovery key for the current epoch (the previous one for 24
  hours after a change that only adds devices). The roster holds a device's label, platform and
  key dates for the person's own view and the console's Linked devices page.
- **Signed per read, not stored.** The device certificate and the signed roster are produced when a
  device asks and are not kept.
- **Relay.** A counter per product and day for bytes and sessions, with no subject, and a
  per-person day total with the person's live presence while a socket is open. A relay ticket is
  kept as a hash for 60 seconds.
- **Never seen.** Message contents. Channels are end-to-end encrypted with Noise, and the relay
  forwards ciphertext it cannot read. The server learns who is in a room and how many bytes moved,
  not what.
- **On the local network.** An advert carries the service type, a rotating name and a protocol
  version and mode, with no label, id or subject. The host name, the MAC address and the IP address
  are still visible to others on the same network, and anyone who knows a product's slug can tell
  that an app of that product is nearby.
- **Kept for.** Device keys until the device is removed; the roster and discovery key until the
  product is removed or the account is deleted; relay counters 90 days.
- **Admin view.** Rosters with labels and relay totals, never content.

### Not collected

OS username, browsing or file activity, a list of installed applications, and any raw
hardware serial. None of these are read by any SDK. The host name is read only as the default device label (see the device label row below), and an app can turn that off. The server stores no location for a device.
The one place a place appears is a sign-in: the city and country Cloudflare attaches to the
request are kept with the pending sign-in (above) so the link can say where it was requested.

## Where it lives, and for how long

| Data                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Table                                                                                                            | Lifetime                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fingerprint components + hwid                                                                                                                                                                                                                                                                                                                                                                                                                               | `device_fingerprints`                                                                                            | Deleted with the device                                                                                                                                                                                                                                                                                                                                                                                                |
| Software facts + probe results                                                                                                                                                                                                                                                                                                                                                                                                                              | `device_facts`                                                                                                   | Deleted with the device                                                                                                                                                                                                                                                                                                                                                                                                |
| Drift and mismatch events                                                                                                                                                                                                                                                                                                                                                                                                                                   | `audit`                                                                                                          | 180 days, then deleted by the nightly job                                                                                                                                                                                                                                                                                                                                                                              |
| The User-Agent header of the request that registered or last used the device (the raw string, capped in length)                                                                                                                                                                                                                                                                                                                                             | `devices.ua`                                                                                                     | The device record's lifetime: deauthorizing a device keeps the record, so keeps this value                                                                                                                                                                                                                                                                                                                             |
| The device label: what the sign-in page, the customer portal and the console call the device. The Node, Swift, Kotlin and Godot SDKs send the computer's host name by default (a trailing `.local`, `.lan` or `.home` removed); the app can set its own name or send none with `deviceName: ""`. Display data only: no decision reads it. A person can rename the device                                                                                    | `devices.label`                                                                                                  | The device record's lifetime                                                                                                                                                                                                                                                                                                                                                                                           |
| SDK sightings: which SDK id, platform, architecture and SDK version made a successful request to a product, which route namespaces answered it, and when it was first and last seen. No IP, device id, license or user                                                                                                                                                                                                                                      | `sdk_sightings`                                                                                                  | Pruned 90 days after last seen, on the nightly sweep; deleted with the product                                                                                                                                                                                                                                                                                                                                         |
| Update outcome events (latest report's `updates`)                                                                                                                                                                                                                                                                                                                                                                                                           | `devices.reported_json`                                                                                          | Replaced by the next report. A deauthorized device keeps its record, so keeps its last report                                                                                                                                                                                                                                                                                                                          |
| Update outcome counters (per release, outlet, channel, event) and one record per device (its counted event ids, to count distinct devices)                                                                                                                                                                                                                                                                                                                  | `UpdateHealthDO` (a Durable Object per release)                                                                  | 30 days (a device record: 30 days after its last event), then deleted by the object's own sweep                                                                                                                                                                                                                                                                                                                        |
| Sign-in artefacts: OIDC flow records, device codes, portal magic links (which name the recipient's email), email codes (stored hashed) and wrong-code strikes (keyed by a hashed recipient)                                                                                                                                                                                                                                                                 | `SingleUseDO` (the sharded single-use store)                                                                     | Until used or expired: 10 minutes for a flow, link or code; a strike record at most an hour (a lockout 15 minutes); expired records are deleted by the object's own sweep                                                                                                                                                                                                                                              |
| Native sign-in nonce: the product, the device id, the signing key's SHA-256 thumbprint and the agreement key, under a peppered hash of the nonce; the provider ID token is verified once and never stored                                                                                                                                                                                                                                                   | `SingleUseDO` (`exchange-nonce`)                                                                                 | Until used or expired: 300 seconds                                                                                                                                                                                                                                                                                                                                                                                     |
| Native sign-in link handle, held when a verified identity has no link yet: product, device id, key thumbprint, provider, issuer, subject, tenant scopes and the provider's email, under a peppered hash of the handle                                                                                                                                                                                                                                       | `SingleUseDO` (`exchange-link`)                                                                                  | Until used or expired: 600 seconds                                                                                                                                                                                                                                                                                                                                                                                     |
| Nearby approval request: the requesting device's id, both public keys, the label it sent, client metadata, a peppered hash of its network (never the address), the times, the approving device's id, the licence id, the subject and a hash of the credential minted for it; the token is never stored                                                                                                                                                      | `SingleUseDO` (`nearby-request`)                                                                                 | Until the token is collected or expired: 300 seconds                                                                                                                                                                                                                                                                                                                                                                   |
| Step-up mark of a same-device sign-in: the product and device id only                                                                                                                                                                                                                                                                                                                                                                                       | `SingleUseDO` (`signin-fresh`)                                                                                   | 300 seconds                                                                                                                                                                                                                                                                                                                                                                                                            |
| Sign-in method linked from an app (the link offer): the provider's subject, tenant scope and the address in the token, kept on the account as a sign-in method. One security email goes to the account's verified addresses and, when the provider vouches for it, to the token's address                                                                                                                                                                   | `account_links`                                                                                                  | Until the person removes the method or the account is erased                                                                                                                                                                                                                                                                                                                                                           |
| App consent: the claims the person granted an app and the hash of the scope they were shown                                                                                                                                                                                                                                                                                                                                                                 | `account_product_grants`                                                                                         | Until the person withdraws it; deleted with the account                                                                                                                                                                                                                                                                                                                                                                |
| Native sign-in audit rows (`signin.exchange`, `signin.consent.granted`, `identity.link.added`): the provider kind, the outcome, the device id, the granted claims and, for a link, its reach; never the token, nonce or email                                                                                                                                                                                                                               | `audit`                                                                                                          | 180 days, then deleted by the nightly job                                                                                                                                                                                                                                                                                                                                                                              |
| Nearby approval audit rows: the outcome, the device ids and the device label; never the network, the keys or the token. The person also gets an email at the account's primary address when a device is approved                                                                                                                                                                                                                                            | `audit`                                                                                                          | 180 days, then deleted by the nightly job                                                                                                                                                                                                                                                                                                                                                                              |
| Pack install reports (latest report's `packInstalls`)                                                                                                                                                                                                                                                                                                                                                                                                       | `devices.reported_json`                                                                                          | Replaced by the next report. A deauthorized device keeps its record, so keeps its last report                                                                                                                                                                                                                                                                                                                          |
| Lazy-delta demand: one row per device and pack-payload pair (strategy, last time), for products that opted in                                                                                                                                                                                                                                                                                                                                               | `delta_demand_devices`                                                                                           | 30 days after the device last reported the pair, then deleted by the nightly sweep                                                                                                                                                                                                                                                                                                                                     |
| Store purchases (hashed key, product, license, state, re-check ids incl. a Steam ID) and the license's store grants                                                                                                                                                                                                                                                                                                                                         | `dist_purchases`, `license_store_grants`                                                                         | Kept while the license exists; a refund marks them revoked                                                                                                                                                                                                                                                                                                                                                             |
| Grants: why a license, an account or a Steam identity holds an entitlement: the source, the hashed purchase key, the store product, the state and times, and each key it carries (a license's OIDC-provisioned keys included); the Steam identities verified on a device (hashed); entitlement-change events (the product's pairwise subject, the keys)                                                                                                     | `grants`, `grant_entitlements`, `device_store_identities`, `entitlement_events`                                  | A license's grants are kept while the license exists and deleted with it; account- and Steam-held grants, Steam identities and events (none are written before the store-purchase and Steam-identity grants shipped) are deleted with the product, and events also with the person's data for the product                                                                                                              |
| Purchase binding (random UUID per license)                                                                                                                                                                                                                                                                                                                                                                                                                  | `dist_purchase_bindings`                                                                                         | Kept while the license exists                                                                                                                                                                                                                                                                                                                                                                                          |
| Store notifications (as received)                                                                                                                                                                                                                                                                                                                                                                                                                           | `dist_connector_events`                                                                                          | 30 days                                                                                                                                                                                                                                                                                                                                                                                                                |
| Account sessions (times, sign-in method, browser label)                                                                                                                                                                                                                                                                                                                                                                                                     | `account_sessions`                                                                                               | 14 days while live; an ended session is pruned 30 days after it ended; deleted with the account                                                                                                                                                                                                                                                                                                                        |
| Pending email sign-ins, email gates and passkey ceremonies (the address, the provider identity and profile, a connection's offered birth date, the requesting city and country; a passkey ceremony's challenge, relying party, return path or account id and user handle)                                                                                                                                                                                   | `SingleUseDO` (the sharded single-use store)                                                                     | Until used or expired: 10 minutes for a sign-in, 15 for an email gate, 5 for a passkey ceremony                                                                                                                                                                                                                                                                                                                        |
| Provider profile per sign-in method (name, locale, picture reference) and the account's pictures (provider copies and uploads, re-encoded; metadata discarded, originals never kept)                                                                                                                                                                                                                                                                        | `account_links.profile_json`, `account_avatars`, R2 `avatars/`                                                   | A picture nothing uses is deleted when replaced, or by the nightly sweep after a day (an upload never saved included); everything is deleted with the account                                                                                                                                                                                                                                                          |
| A connection's groups and access-rule claims per sign-in method: the groups its mapped claim reported (at most 100 names) and the values of the claims its claim map lists for access rules; never its name, picture or birth date                                                                                                                                                                                                                          | `account_links.groups_json`, `account_links.claims_json`                                                         | Replaced at each sign-in through that method; deleted with the method and with the account                                                                                                                                                                                                                                                                                                                             |
| Connection domain proofs: per connection and domain, the random TXT token, when the domain was verified and last checked, and whether it is enforced; nothing about a person                                                                                                                                                                                                                                                                                | `identity_connection_domains`                                                                                    | Until the domain is removed from the connection, or the connection is deleted                                                                                                                                                                                                                                                                                                                                          |
| The account's birth date and its source (`user` or `connection:<id>`), optional, only when the person added or accepted it                                                                                                                                                                                                                                                                                                                                  | `accounts.birthdate`, `accounts.birthdate_source`                                                                | Until the person removes it; cleared at once when the account is deleted; a join fills it on the survivor only when the survivor has none, and the join's undo takes it back                                                                                                                                                                                                                                           |
| Passkeys (public key, credential id, counter, transports, user handle, times, AAGUID, synced flag, browser label)                                                                                                                                                                                                                                                                                                                                           | `account_passkeys`, `accounts`                                                                                   | Until the person removes the passkey or the account is deleted                                                                                                                                                                                                                                                                                                                                                         |
| Account overrides: managed config an operator sets for one person on one product, secrets sealed                                                                                                                                                                                                                                                                                                                                                            | `account_overrides` (by the product's pairwise subject)                                                          | Until an operator removes them; deleted with the person's data for the product, with the account and with the product                                                                                                                                                                                                                                                                                                  |
| Cloud Sync settings (declared and open): key, value, edit clock, the writing `clientId` and the last mutation id per client                                                                                                                                                                                                                                                                                                                                 | A `CloudSyncDO` object per product and pairwise subject (`settings`, `setting_members`, `clients`, `tombstones`) | Until the person clears it, deletes their Cloud Sync data or their account, or an operator deletes it (step-up); tombstones 90 days                                                                                                                                                                                                                                                                                    |
| Cloud Sync directory: per product and pairwise subject, the byte and count totals, the quota in force at the last write, the person's `tier_id` and the last device `platform` family that wrote, and when                                                                                                                                                                                                                                                  | `sync_directory` (and the per-product aggregate `sync_product_usage`)                                            | Until the person's Cloud Sync data is deleted; the account merge and deletion hooks remove it                                                                                                                                                                                                                                                                                                                          |
| Cloud Sync daily counters per product and day (accepted exchanges, conflicts); nothing about a person                                                                                                                                                                                                                                                                                                                                                       | `sync_product_daily`                                                                                             | 90 days                                                                                                                                                                                                                                                                                                                                                                                                                |
| The key ring: per product and pairwise subject, the ring id, epoch and `kid`, the sealed recovery blob and the time it was set, the previous ring id, `kid` and its end time; each device's wrap (the root encrypted to the device's key, with the depositing device id); adoption blobs. Nothing the Worker can open                                                                                                                                       | `keyrings`, `keyring_wraps`, `keyring_adopted`                                                                   | A wrap: until its device is removed, unbound or changes keys. The rest: until the person deletes their account or Cloud Sync data, or the product is deleted. A replaced ring: 30 days after a reset                                                                                                                                                                                                                   |
| The license-override migration report, no longer written or read: license id, the license's own email, key names, non-secret config values, the owner's pairwise subject (never a secret value)                                                                                                                                                                                                                                                             | `override_migration_report`                                                                                      | Rows from before the removal stay unread and are no longer deleted with the person's data, the license or the product, or by the 90-day sweep (production has none: no run happened); a later release drops the table                                                                                                                                                                                                  |
| The provisioned-secret move ledger: license id, key name, the owner's pairwise subject and a SHA-256 of each moved entry (never a value)                                                                                                                                                                                                                                                                                                                    | `provisioned_secret_moves`                                                                                       | Until a later release drops the table; a person's rows go with their data for the product and with the account, and every row with the license and the product                                                                                                                                                                                                                                                         |
| The relink tool's history: which pairwise subject a license moved from and to, the reason, the operator, the undo window; for Make floating and Reassign also the license's own name and email before and after                                                                                                                                                                                                                                             | `license_relinks`                                                                                                | The license's name and email in the snapshot are cleared by the nightly job once the 72-hour undo window ends; the row is deleted with the license and with the product; an account deletion clears its account ids                                                                                                                                                                                                    |
| Accepted product terms, and Polaris Key's own once published (product or `_platform`, terms version, the terms URL the gate showed, time accepted)                                                                                                                                                                                                                                                                                                          | `account_terms_acceptances`                                                                                      | For the account's life, one row per terms version (a merge moves them to the survivor); deleted with the account, and a product's rows with the product                                                                                                                                                                                                                                                                |
| Console role bindings: the console role an operator holds, where and over which areas, who granted it (their member id) and when; an invite names the address it was sent to (lower-cased) and nothing else about the person                                                                                                                                                                                                                                | `console_role_bindings`                                                                                          | Until a Superadmin or a granter who could have made it takes it back; deleted with the account and the product it names; an invite expires after 7 days and the nightly job deletes it 7 days after that, and an account erasure deletes the invites for its addresses. Each change also writes an audit row by member id; an invitation is audited by an opaque reference (a peppered hash prefix), never the address |
| Storefront library entries (account, product, time added): an open product added from the Polaris Key storefront, with no license                                                                                                                                                                                                                                                                                                                           | `library_entries`                                                                                                | Until the person removes it; deleted with the account, moved to the survivor on an account merge and back to the joined account on the join's undo, if the survivor still holds it; cleared when the product is deleted                                                                                                                                                                                                |
| Storefront impression dedupe: a daily keyed HMAC of the account id (the salt derived from `KEY_HASH_PEPPER` and the day, never stored), with the product and day; no account id. Not written at all without `KEY_HASH_PEPPER`                                                                                                                                                                                                                               | `storefront_seen`                                                                                                | At most two days (today and yesterday), then deleted by the nightly sweep                                                                                                                                                                                                                                                                                                                                              |
| Storefront daily counters per product, day and path kind (impressions, adds, first activations); nothing about a person                                                                                                                                                                                                                                                                                                                                     | `storefront_daily`                                                                                               | Kept until the product is deleted                                                                                                                                                                                                                                                                                                                                                                                      |
| An account join's undo snapshot (`snapshot_json`): the absorbed account's row (primary email, display name, locale, profile sources, birth date and its source, passkey user handle), its consents (claims shared with each app), terms acceptances, auto-attach blocks and library entries, and the ids of what moved (sign-in methods, passkeys, licenses, sessions, pictures, registry tokens, relinks, pairwise subjects and the devices bound to them) | `account_merges`                                                                                                 | Up to 72 hours: cleared by an undo, deleted by the nightly job once the window ends, and deleted with either account                                                                                                                                                                                                                                                                                                   |
| Personal tokens (`pkeyp_`): the account id, a label the person chose, the token's last four characters, its one scope, and its times (created, expires, last used, revoked). The token itself is never stored, only its HMAC under the key-hash pepper                                                                                                                                                                                                      | `account_tokens`                                                                                                 | Until the person revokes it or it expires, then 90 days; deleted when the account is erased. In an account join a `packages:read` token moves with the account and an `admin` one is revoked (`access_removed`), never moved                                                                                                                                                                                           |
| Device login for the CLI (`pkey login`): the machine name the terminal sends (at most 64 characters), the tool name and version, the request's coarse place and browser, and the approving account, held in the single-use store for 5 minutes, then gone; the machine name stays afterwards only as the label of the token the login mints (`pkey on <host>`, a Personal tokens row above) until that token is purged.                                     | the single-use store (`device-login`); `account_tokens.label`                                                    | 5 minutes; the label as the token row (90 days after it ends; deleted with the account)                                                                                                                                                                                                                                                                                                                                |

### Residue and limits

The Worker's request logs (Cloudflare Workers Logs) are enabled and persisted at full sampling. They are held by Cloudflare under its retention for the account's plan, not by Polaris Key's tables.

What the sections above do not promise, stated plainly:

- **Console audit rows** (`audit`) name the license by id; since October 2026 they no longer copy the
  buyer's email or name. Rows written before that may still hold an address and are deleted by the
  nightly job after 180 days. Account erasure rewrites the rows that name the person as their actor:
  a Discover add through the portal, and a product sign-in's license merge, tier change or license
  choice, record the person's platform subject, name and address. In the erasure batch such a row
  keeps its time, action and license and loses the actor (replaced by the marker `erased-account`),
  the name, the address and the summary. A row is rewritten only when its actor is one of the
  account's platform sign-ins and it concerns the person's own license: an address alone is no link,
  and an operator's console actions on anyone else's license stay attributed. The product's
  developer sees the marker, never the global account id. Removing your data from a single app does
  not rewrite them.
- **A device-code sign-in's start place**. When a device starts a sign-in, the Worker keeps
  the coarse place Cloudflare's edge reports for that request (country and a city or region label)
  on the sign-in record for at most 600 seconds, and shows it to the person who is asked to approve
  the sign-in on the device. It is never stored after that, logged or audited; the audit row names
  only the device label.
- **Merge tombstones** (`account_tombstones` with a merge target, which carry an email hash) are
  deleted after 90 days; an erasure tombstone holds only the account id and is kept, so an erased
  account is never recreated. Subject events (`subject_events`) are deleted
  after 180 days.
- **Store connector events** (raw Apple payloads, Play notifications) are deleted after 30 days.
  Purchase records keep a hashed purchase key, but the re-check ids (a Play purchase token, a
  Steam ID with the DLC app id) are stored in clear in `dist_purchases.detail_json` for as long as
  the license exists.
- **Rate limiting** keys its counters by the client network (an IPv4 address or an IPv6 /64) in a
  Durable Object, for the length of the limit window (minutes to a day); the email-code lockout is
  keyed by the recipient's peppered hash with the requester's IPv4 /24 or IPv6 /48. The object's
  sweep deletes expired counters. They are not part of any export or erasure.
- **Sign-in and notice records.** A console sign-in (accepted, refused or failed) is recorded in
  the platform activity log by the operator's IdP subject, never an email; a security notice that
  reached no address is recorded in the account's activity as counts only. Both follow their
  log's retention, and the account's activity is deleted with the account.
- **Worker invocation logs** are off: request URLs carry single-use tokens and codes.
- **Signed license documents and offline bundles** include the license's name and email. A
  license document for a device an account is signed in on also carries that person's pairwise
  subject for the product (`profile.user`), which is no new personal data: no name, email or
  account id. Once issued they cannot be recalled or erased; they expire with the document.
- **Export and removal.** `GET /api/me/export` and `GET /api/products/<product>/export` hand the
  person a JSON copy of their own data (the whole account, or one product), and
  `DELETE /api/products/<product>/data` removes what is held for them in one product. Each needs a
  sign-in no older than five minutes and is recorded in the account's activity. An export carries no
  credential (no key, token, session id or passkey material), none of the developers' own records
  (audit logs, relink history, purchase records, device fingerprints) and nothing about another
  person; the birth date is in the full export only. A removal keeps the license unless the person
  also removes it, and while it stays the developer can still connect them to the old records
  through it.

- **Erasure.** `DELETE /api/me` records a cancellable request in `account_deletions` and keeps
  the account active for fourteen days. At its deadline the scheduled worker claims the request
  and starts the resumable hard-erasure state machine (`account_erasures`); it deletes
  account-linked data and the request's account activity, retains only the id-only erasure
  tombstone and final receipt, and detaches licenses. The tombstone is kept and reapplied after a
  D1 restore so nothing can recreate the account, and a restored deleted account is
  refused at sign-in and on every request before that cleanup erases it again. Data is not
  encrypted per person (no crypto-shredding), and D1 Time Travel backups keep deleted rows for up to
  30 days.

Deauthorizing a device — from the app, the admin panel, or the customer portal — routes
through `setDeviceStatus()` in `packages/worker/src/core/devices/store.ts`, which purges both tables in the
same operation. Disabling or deleting a license does not purge its devices' data; only deauthorizing a device does. This is why the nightly job
(below) has no step for these two tables: there is no orphaned data for one to collect. The update
outcome counters are the exception: they are aggregates per release, not per device, so they are
not purged with a device; each counter object deletes buckets older than 30 days and every device
record (a device id with the event ids it had counted) idle for 30 days, on its own alarm — it
resumes within minutes until the whole object has been swept — and deletes itself entirely once
nothing is left. Lazy-delta demand rows are the other exception: they count distinct devices per
pair of pack payloads, so they are kept 30 days after the device last reported that pair and then
pruned by the nightly maintenance sweep, whether or not the device still exists.

### The nightly maintenance job

One scheduled job deletes what outlives its purpose elsewhere. It is the Worker's cron
`17 3 * * *` (03:17 UTC, `runScheduledMaintenance` in `packages/worker/src/scheduled.ts`); the
other trigger, every 15 minutes, only polls store connectors. Each step is bounded and safe to run
twice. The steps that delete or scrub personal data:

| What                                                                                                                                              | Deleted when                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Console audit rows (`audit`), customer-portal audit rows (`portal_audit`, including those that belong to no product) and the platform audit trail | 180 days after they were written                                                                                                                                                      |
| Download tokens (`release_download_tokens`)                                                                                                       | Once used, and once expired                                                                                                                                                           |
| A device's count and token                                                                                                                        | the device stops counting and the token hash cleared 90 days after the device was last seen. The device row, its fingerprint and software facts stay until the device is deauthorized |
| A holder move's before and after name and email (`license_relinks`)                                                                               | Scrubbed once its 72-hour undo window ends                                                                                                                                            |
| An account join's undo snapshot (`account_merges`)                                                                                                | Once its undo window ends                                                                                                                                                             |
| A replaced key ring (`previous` marker and its wraps)                                                                                             | 30 days after a reset                                                                                                                                                                 |
| Merge tombstones and subject events                                                                                                               | 90 days and 180 days                                                                                                                                                                  |
| Store connector events                                                                                                                            | 30 days                                                                                                                                                                               |
| Storefront impression dedupe keys (`storefront_seen`)                                                                                             | After yesterday                                                                                                                                                                       |
| Lazy-delta demand rows                                                                                                                            | 30 days after the device last reported the pair                                                                                                                                       |

The same job also prunes housekeeping tables (operations job runs and heartbeats, the refusal log,
CI credentials, registry tokens, the blob collector) and runs the account erasure
steps described above.

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
check-in without losing its place.

A product's **Users** page (Core → Users) shows each person by a random id that exists for that
product only (`ps_…`); another product's console sees a different id for the same person. It
shows that product's licenses, devices, data size and console audit, and, with Identity on, the
person's sign-ins to that product by method kind ("Steam") only. It never shows the Polaris Key
account id, the account's sign-in methods, its birth date, or anything from another product. The
contact email is the license's buyer email; the account's own email appears only when the person
agreed to share it with that product. An admin can export that product's data for the person as JSON,
delete it, detach a license, or move a license to another person of the same product (a fresh
admin sign-in, a recorded reason, an email to both people first, and 72 hours to undo). An admin
can also set the person's **account overrides** for that product (managed config; a secret is
never shown again once saved). No admin can delete, disable, sign out or merge an account, or
change its sign-in methods.

The console's **Members** page (Platform → Members) is the roster of people who can use the console. A
Platform admin and a Superadmin see each member's display name, address, roles (with where each came from and
who granted it), whether they hold the root rule, when they last signed in, and the address of every open
invite. A person is shown by a random member id (`mbr_…`); the Polaris Key account id is never in a response.
Only people with a role appear: the page cannot be used to look up anyone else. A Product admin cannot read it.
A product's **Members** tab (Product → Members) shows a Product admin who holds `members` on it the people
with a role on that product, its open invites, and, read-only, the Superadmins and all-products admins who reach it
from above. Platform admins are never named there. The sign-in screens' "who can give you access" list names up to three
people: that product's admins (only to someone who already holds an area of it) and then Superadmins, by name and
address; anyone else gets the Superadmins alone, the same answer whether or not the product exists.
Platform → Personal tokens (`/account-tokens`) lists every personal token with its label, last four characters
and times, never the token. Most holders are product customers, not console members, so the holder's address is
shown to a Superadmin only; a Platform admin sees `null` there (as on the product Users page) and revokes a token
by its id.

## What an end user can see

The customer portal already lists a user's own devices with their platform, versions, and
first/last-seen times, and lets them disconnect any of them — which purges that device's
fingerprint and facts.
