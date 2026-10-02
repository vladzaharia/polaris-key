---
title: "The device principal"
description: "Registration policies, keyless minting, pkeyt_ tokens, the self-service device roster, and the facts/telemetry surface."
sidebar:
  order: 2
---

A **device** is an authorized install of a product, bound to a per-device bearer token
(`pkeyt_…`). It is a **Core** principal, not a licensing one: under an `open` or
`requires-identity` registration policy a device holds a token with no license behind it and
still fetches signed config documents.

Until wire contract v3 there was exactly one way to become a device — present a license key.
That made "device" a licensing concept, which is precisely what the service split undoes.

## Device ids

The device id is client-chosen and travels in the `X-PKey-Device` header. Every SDK derives it
the same way, on the device, so the raw OS identifier never crosses the wire:

```
deviceId = base64url(sha256("pkey-device:<product-slug>:<raw>"))[0..32]
```

`<raw>` is the platform machine identifier (macOS `IOPlatformUUID`, Windows `MachineGuid`,
Linux `/etc/machine-id`, else `/var/lib/dbus/machine-id`; a blank file or systemd's
`uninitialized` marker is skipped), falling back to a random UUID when none can be read. The
Linux value is the same anchor the fingerprint uses (WIRE-CONTRACT-V3 §6.1 rule 2), and the SDK
persists the id it derived, so a later change of the source never changes an installed device's
id. The prefix
`pkey-device:` is a **hash domain** and is frozen — renaming it would orphan every enrolled
device. The formula is pinned by `conformance/corpus/v2/fingerprint.json`.

### Containers

Without a machine-id a Linux host has no fingerprint anchor, so it gets no anchor bonus and no
keyless (free-tier) enrolment: `/enroll` answers `fingerprint_required`. Give the container one:
mount the host's `/etc/machine-id` read-only, or create one at first start and keep it in a
volume. Never bake one into an image (installing `dbus` at build time writes
`/var/lib/dbus/machine-id`): every container of that image, on every host, would then share it,
and so share one device id and one free licence.

Two different acceptance rules apply server-side:

- **Registration** requires the strict form, `/^[A-Za-z0-9_-]{32}$/`. It is a new endpoint with
  no compatibility history.
- **Activation** accepts any non-empty string, for clients that shipped before the formula was
  pinned.

The check is a well-formedness gate, not authentication. What it buys is that the value going
into a primary key, a KV key, and a signed document's `deviceId` claim is bounded, opaque, and
free of separators.

## Registration policies

`devices.registration` is one of three values, stored inside `products.services_json` beside
the enablement flags.

| Policy              | `POST /<p>/devices/register` behaviour                                        |
| ------------------- | ----------------------------------------------------------------------------- |
| `open`              | Mint for any caller. Rate-limited by edge IP; fingerprint optional.           |
| `requires-identity` | Same endpoint, but only for a caller carrying a live product browser session. |
| `requires-license`  | Refuse permanently. Activation and enrollment are the only mint paths.        |

### The derived default

The policy is optional, and undeclared means "follow the services", not "somebody chose
`open`":

```
requires-license   if License is enabled
requires-identity  else if Identity is enabled
open               otherwise
```

The order is by how much the product already knows about the caller. A licensed product
already has a mint path, so the keyless door stays shut; an identity product can authenticate
a human, so registration is possible but must go through that; a product with neither has
nobody to ask and nothing to protect a seat pool with.

Undeclared is stored as **absent**, never resolved at ingest. A product that later turns
License off therefore moves to the derived `open` instead of staying pinned to a value nobody
wrote. The policy lives in the same column as the enablement set precisely because its default
is a function of that set — reading a policy from one place while deriving its default from
another is how the two drift.

Two of the coherence rules the enablement API applies
(`PATCH /manage/api/products/<slug>/services`) turn on the registration policy, and both reject
by stable code:

- `registration_requires_identity` — a declared `requires-identity` with Identity off. There is
  no login to stand behind, so the product has taken registration away rather than restricted
  it.
- `config_without_activation` — Config on, License off, and a declared `requires-license`. That
  closes the only mint path such a product has.

:::caution
`validateServices` runs on the **admin** path only. Manifest ingest goes straight to
serialization, so a repo-authored `devices.registration: requires-identity` on an
identity-disabled product reaches storage unvalidated. The runtime check inside
`authorizeRegistration` — enablement first, then descriptor, then hook, failing closed at each
step — is what actually stands between that and a minted token.
:::

## `POST /<p>/devices/register`

Keyless means keyless: no `Authorization` header is read. Presenting one is not an error
either — a client that sends a stale device token alongside a re-registration is asking for a
fresh credential, not authenticating with the old one.

The order of operations is load-bearing:

1. **Method.** Anything but `POST` is a 405.
2. **`requires-license` refuses first**, before the limiter. A policy that can never say yes
   must not be able to have its limiter budget consumed by requests it was never going to
   answer, and refusing without a Durable Object round-trip keeps that case cheap under exactly
   the flood that would try it.
3. **Rate limit**, bucket `register`, keyed by edge IP, **10 requests per 60 seconds**, failing
   **closed**. It runs _before_ the identity exchange: the exchange reads a cookie, hashes it,
   and touches KV and D1, so gating it on an unauthenticated budget is what stops a flood of
   forged cookies from turning a rate-limited endpoint into an unmetered session-probing
   oracle. Over-limit is `429 rate_limited`.
4. **The identity exchange**, for `requires-identity` only. Core asks the registry through
   `ServiceDescriptor.authorizeRegistration` rather than importing Identity; the hook is
   checked behind the enablement flag and fails closed on a missing descriptor or a missing
   implementation.
5. **Device id.** Missing or malformed is `400 bad_request`.
6. **The takeover guard.** Re-registering an id that is already _registered_ rotates its token,
   which is what a client that lost its credential needs — including one whose row was
   deauthorized, since an unlicensed device holds no seat. Re-registering an id bound to a real
   **license** must never work: registration rewrites `license_id`, so allowing it would let
   anyone who knows a licensed device's id evict that device from its seat. Products where both
   paths coexist are why this is a check and not an assumption.
7. **The optional fingerprint**, read from the body. Absent, empty, oversized (over 4 KiB), or
   unparseable all mean "no fingerprint", never an error. There is no tier here to demand one.
8. **Mint**, and write the `devices` row, the fingerprint row if one was presented, and the KV
   token record.

Success is `200` with `cache-control: no-store`:

```json
{ "token": "pkeyt_…", "deviceId": "…" }
```

`deviceId` is echoed even though the caller chose it: it is what the signed documents will
carry in their `deviceId` claim, so a client that echoes it back has server confirmation of the
binding rather than an assumption about it.

### One refusal, four causes

Every refusal is the same body — `403` with `registration_closed` — for `requires-license`,
`requires-identity` with no session, `requires-identity` on a product whose Identity service is
off, and a device id already bound to a real license. A caller learns that it may not register
and nothing about why. Distinguishing them would let a prober map which products run which
services, and would turn a credential-free endpoint into an oracle for "is this device id
licensed".

## `pkeyt_` tokens

A device token is `pkeyt_` followed by 43 base64url characters (256 bits of entropy). It is
shown once, at mint, and stored only as a peppered hash. A hot record in KV carries
`product`, `deviceId`, and `licenseId`.

Validation refuses on **shape** first — `/^pkeyt_[A-Za-z0-9_-]{43,}$/` — before the pepper HMAC
and the KV/D1 reads it would otherwise cost. That rejection is an explicit rule rather than a
consequence of no such hash existing, which would be a fact about the current contents of a
table rather than about the code. The length is a floor, not an equality, so widening the
entropy later is not a wire break.

For a device that registered rather than activated, `devices.license_id` holds the **empty
string**. The column is `TEXT NOT NULL` and SQLite cannot relax that in place; the sentinel is a
value no minted license id can collide with (`randomId` always emits `lic_…`), and
`getLicense(db, product, "")` finds nothing, so validation sees `license: null` — exactly the
service-independent shape it already handles.

:::caution
Never group by that sentinel. Every unlicensed device of a product shares it, so asking a
"devices of license `''`" query for a roster would hand one caller the whole product's device
list. The code keys off `valid.license` being null, not off the id.
:::

### Two different questions

Wire contract §6 splits what used to be one check:

```
core.validateDeviceToken               token -> device row
license.requireLicensedDevice          token -> device row, AND the license is usable
```

Every surface that was license-gated before still calls the second one, applying the usability
check in exactly the position it used to occupy. `GET /<p>/config/document` takes the core-only
answer outright — that is the wire-level guarantee that Config works without License.

Core's own surfaces take it **conditionally**: the license check applies if and only if the
product runs the License service. A config-only product's devices could otherwise fetch a
signed config document but not rename the device that fetched it. The relaxation is scoped to
the enablement flag, not to the presence of a license row, so a licensed product's behaviour is
unchanged — an expired, revoked, or missing license is still a 401.

One more guard rides here: the KV hot record is back-filled only after every check has passed.
Writing it as soon as the device row was found meant replaying a just-revoked token silently
recreated the record that revocation had purged.

## The device roster

`GET /<p>/devices` returns the caller's roster and which entry is itself:

```json
{
  "currentDeviceId": "…",
  "devices": [
    {
      "id": "…",
      "licenseId": "…",
      "label": null,
      "status": "authorized",
      "current": true,
      "firstSeen": 0,
      "lastSeen": 0,
      "userAgent": null,
      "platform": null,
      "arch": null,
      "appVersion": null,
      "sdkName": null,
      "sdkVersion": null
    }
  ]
}
```

`platform`, `arch` and `sdkName` are what the device's requests sent as `X-PKey-Platform`,
`X-PKey-Arch` and `X-PKey-SDK`, stored canonically (WIRE-CONTRACT-V3 §5.2): `macos`, `ios`,
`android`, `windows`, `linux` or `web`; `arm64`, `x86_64`, `armv7` or `wasm32`; and the SDK id
(`node`, `react`, `python`, `swift`, `godot`). An older SDK's spelling (`darwin`, `win32`, `x64`,
`AMD64`, `@polaris-key/node`, `PolarisKeySwift`, …) is mapped to its canonical value when it is
written, and a migration converged the rows stored before the mapping existed. Any other value
is stored as sent, and an empty header leaves the stored value as it was.

What that list contains depends on how the device came to exist. For an **activated** device it
is the seat pool: the caller paid for those seats and managing them is the point of the
surface. For a **registered** device there is no pool, so the list is exactly itself.

`GET /<p>/devices/<id>` returns the same roster body; the id in the path is not used to narrow
a GET.

### Mutations are self-only

`PATCH` and `DELETE` need a path id — a bare `/<p>/devices` is `400 bad_request`. An id that is
not in the caller's roster at all is a `404`. An id that _is_ in the roster but is not the
caller's own device is `403 forbidden`, with the message "a device token may only manage its own
device".

A device token authenticates **one device**, not the license. Listing siblings is legitimate
self-service; mutating one is not — any device could otherwise relabel or deauthorize every
other install on the same license, and the DELETE arm purges the victim's fingerprint, so the
eviction would not even be recoverable by re-activating the same hardware. Cross-device
management belongs on the portal, which authenticates the license _owner_.

- **`PATCH`** sets the label: a non-empty string, trimmed and truncated to 120 characters, or
  `null`. Invalid JSON is `400 bad_request`.
- **`DELETE`** retires the binding — deauthorize the row (which purges its fingerprint and facts)
  and evict the KV token record, so the credential stops working now rather than at KV expiry.

Both answer `{"ok": true}`; PATCH also echoes the updated device.

Separately, both signed-document routes call Core's `touchDeviceMetadata` to fold the request's
client metadata headers into the row and stamp `last_seen`. Whichever services a product runs, a
device that is talking to the worker is recorded as seen.

## `POST /<p>/devices/report`

Device facts: the device's current software snapshot — OS, runtime, hardware summary, locale,
timezone, and product-declared probe results. Overwritten on each report; no history is kept.
There is no full installed-application enumeration, only probes the product declared.

This was `/<p>/config/report` before the split. It was always anti-fraud telemetry living under
a config path; §6 makes it a Core surface, with the same allowlist, the same caps, and the same
401 — now scoped by the same license rule as the roster.

The bounds, in order:

- **Body size.** A declared `content-length` over 16 KiB is refused before the read, and the
  read itself is re-checked against 16 KiB. Either is `413 body_too_large`.
- **Unparseable JSON** is `400 bad_request`; an empty body is treated as an empty report.
- **The key allowlist.** Exactly these survive: `os`, `hardware`, `runtime`, `locale`,
  `timezone`, `probes`, `sdk`, `sdkVersion`, `appVersion`, `platform`, `arch`, `gate`, `config`,
  `entitlements`, `timestamp`, `engine`, `outlet`. Anything else is dropped **silently** — a new
  client field that is not added to the list vanishes without an error anywhere.
- **Engine and outlet.** `engine` is a game engine's build facts (the Godot SDK sends it). Only
  its known fields survive — `id` (such as `godot-4.7`), `version`, `renderer`, `videoAdapter`,
  `videoVendor`, `videoApi`, `display` as strings truncated to 128 characters, and `debug` as a
  boolean; any other field, or a field of the wrong type, is dropped, and a non-object `engine`
  is dropped whole. `outlet` is where the install came from: the build's stamped outlet,
  refined on the device by outlet detection (`direct`, `steam`, `itch`, `app-store`, …). Only
  the outlet id or kind is sent, never a raw signal, and nothing when it is unknown. It is
  truncated to 64 characters; the id is not validated, so a newer client's outlet is kept. Both are stored on `devices.reported_json` only; the typed
  `device_facts` columns do not change.
- **Probes.** At most **32** entries. Each must be an object with a boolean `present`; anything
  else is skipped. Probe ids are truncated to 64 characters and the optional `version` string to 64. `probes` is the one open-ended map a client controls, so it carries its own bound on top of
  the body cap: a truncated inventory must not be able to ride in under 16 KiB.

The accepted report is stored twice — verbatim on `devices.reported_json`, and projected into
the flat `device_facts` row (strings truncated to 128 characters, numbers truncated to
integers). Response is `{"ok": true}`.

Clients treat this as best-effort and swallow errors: telemetry must never fail a sync.

## See also

- [Fingerprints](/docs/services/core/fingerprints/) — what a presented fingerprint contains and
  how it is matched.
- [Errors and limits](/docs/services/core/errors/) — the wire error shapes and the rate-limit
  buckets.
- [D1 data model](/docs/reference/data-model/) — the `devices`, `device_fingerprints`, and
  `device_facts` columns.
- [Public route table](/docs/reference/routes/) — every route with its owning service.
