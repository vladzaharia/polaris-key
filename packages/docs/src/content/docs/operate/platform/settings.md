---
title: "Platform settings"
description: "The instance-wide settings: the eight that can change at runtime, how precedence works, and what the read-only inventory shows."
sidebar:
  order: 13
---

Platform settings apply to the whole instance, not to one product. Almost all of them are
deploy-time: they live in `wrangler.toml` or as Worker secrets and change only with a deploy.
Eight can also be changed at runtime, without a deploy: four background-job settings, the two
reserved-name settings, the key-entry refusal switch and the hosted-assets switch. Every change is
recorded in the
[platform trail](/docs/admin/activity/#the-platform-trail).

In the console this is **Platform → Settings** (`#/platform/settings`; `#/platform` opens it).

## The runtime settings

| Setting                           | What it does                                                                                        | Values                                     |
| --------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `LAZY_DELTAS`                     | Turns lazy hot-pair deltas on or off, in both Worker scripts.                                       | `on` or `off` (default `off`)              |
| `LAZY_DELTA_MAX_BYTES`            | The largest payload, on either side of a pair, the delta consumer will encode.                      | 1 MiB to 32 MiB, in bytes (default 32 MiB) |
| `BLOB_GC_MODE`                    | Turns the nightly blob collector on or off.                                                         | `on` or `off` (default `on`)               |
| `BLOB_GC_GRACE_DAYS`              | How long an object stays unreferenced before the collector may delete it.                           | 1 to 365 days (default 30)                 |
| `LICENSING_RESERVED_NAMES`        | What happens to a catalog flag that declares a reserved entitlement name with an incompatible type. | `warn` or `error` (default `warn`)         |
| `IDENTITY_RESERVED_DISPLAY_NAMES` | What happens to a product or listing name that uses a platform or store name.                       | `warn` or `error` (default `warn`)         |
| `KEYENTRY_REFUSALS`               | Lets Identity products refuse key entry past the per-licence limit and on owned licences.           | `on` or `off` (default `off`)              |
| `ASSET_HOSTING`                   | Serves Polaris Key's own copies of product images and mirrors release files (hosted assets).        | `on` or `off` (default `on`)               |

32 MiB is the measured ceiling of the delta consumer, so a runtime size cap can only lower it.
"Lower" is measured against that 32 MiB ceiling, not against the deploy-time `LAZY_DELTA_MAX_BYTES`
in `[vars]`: a deploy-time cap of 8 MiB does not stop the console storing 16 MiB, which then wins.
The collector's grace never bounds deletion on its own: the bucket's 180-day age lock still
applies.

`LICENSING_RESERVED_NAMES` is S-19's `licensing.reservedNames`. The platform sets a few
entitlements itself (`channels`, `deviceLimit`, `app.minVersion`, `app.maxVersion`,
`license.tier`, `license.tierLabel`) and reserves the `license.`, `app.` and `pkey.` prefixes for
future ones. A product flag that declares one of these names is always valid when it keeps the
system key's type and only narrows it (see
[reserved entitlement names](/docs/build/manifest/authoring/#reserved-entitlement-names)). With
`warn`, an incompatible declaration is accepted and reported; with `error`, link, resync and the
console's catalog publish refuse it. The setting starts at `warn` for a window of two minor
releases or 60 days, whichever is later, and then moves to `error`. Neither value changes what a
device is signed: the platform's own value of a system key always wins.

`IDENTITY_RESERVED_DISPLAY_NAMES` is `identity.reservedDisplayNames`. The sign-in card says
"<App> wants you to sign in", so a product may not present itself as Polaris Key, Apple, the App
Store, Google, Google Play, Steam, Valve, Epic Games, Microsoft, Xbox, PlayStation, Nintendo or
itch.io (see [display names](/docs/build/manifest/authoring/#display-names)). With `warn`, such a
`product.name`, `listing.name` or `listing.developerName` is accepted and reported; with `error`,
link, resync and the console's listing edits refuse it. Either way the sign-in card shows the
product slug in a neutral frame instead of a reserved name. The setting starts at `warn` for two
minor releases or 60 days, whichever is later. It sits under Identity & access in the console.

`KEYENTRY_REFUSALS` is `identity.keyEntryRefusals`, the rollout switch for
[key entries](/docs/services/identity/#key-entries). Key entries are counted either way. On, a
product with Identity on refuses a new device a key whose licence is in no account and has used
every key entry, with a link to add the key to an account; a device already using its key is never
refused. Turn it on only once the SDKs that show the refusal are released. Turning it either way
asks first. It sits under Identity & access in the console.

`ASSET_HOSTING` is `assets.hosting.enabled`, the hosted-assets rollback switch. Off, every
surface goes back to the developer's own image URLs and the portal's media proxy, release-file
mirroring stops, and the legacy download streams from GitHub; the stored copies stay, release
files already copied keep serving from their copies, and image URLs already handed out keep
working. It is not a security gate, so it uses runtime precedence:
an unreadable settings store does not turn it off. It sits under Delivery in the console. Each
product's quotas and its own mirroring switch are on its
[Presentation page](/docs/admin/presentation/#hosting-and-quotas).

Nothing else can become a runtime setting. Origins, the platform admin group, the admin identity
provider, the issuer allowlist, key material, session lengths, rate limits, retention periods and
bucket names stay deploy-time, because a console session that could change them could make
itself permanent. A test refuses any of them in the settings registry.

## Precedence

Each setting resolves in this order:

1. a valid runtime value stored from the console;
2. the deploy-time value in the environment's `[vars]`;
3. the code default.

The two on/off switches add one rule: a deploy-time `off` is a **hard off**. With
`LAZY_DELTAS = "off"` or `BLOB_GC_MODE = "off"` in `[vars]`, no runtime value can turn the job on.
That is the break-glass that still works if a console session is compromised, because it needs a
deploy. The committed value of `LAZY_DELTAS` in both TOML files is `"runtime"`, which means the
console decides. Any other value that is not `on`, `off` or `runtime` (`false`, `0`, `disabled`, a
typo) is also a hard off, and the settings page warns about it: a mistyped kill switch never reads
as permission for the console to turn the job on.

A stored value that fails validation is never applied: the setting falls through to the next
source, and the settings list shows the stored value as invalid.

Changes reach every Worker isolate within 30 seconds. The nightly cron and the delta consumer
read the settings fresh at the start of each run.

## In the console

Platform → Settings has these sections, top to bottom.

- **Warnings.** Each warning the API returns (the console still shares the customer sign-in
  client, `PLATFORM_KEK_ID` set, `PLATFORM_KEK` kept as a legacy key beside
  `PLATFORM_KEK_KEYS`, `PORTAL_SESSION_SECRET` unset) is shown first.
- **Background jobs.** The four background-job settings. Each row shows the effective value and a source
  badge: _Code default_, _Deploy var_ or _Set in console_ (with who set it and when). Each row
  saves on its own:
  - The two switches apply when you flip them. Turning a job **on** asks first and lists what
    changes. Turning one **off** applies at once, with **Undo** in the confirmation toast.
  - The two numbers have their own Save bar. The size cap is entered in MiB, from 1 to 32. It can
    only lower the measured 32 MiB ceiling, so a larger value is refused before it is sent.
    Raising the cap or lowering the collector's grace asks first. The other direction saves at
    once, with Undo.
  - A switch whose deploy var is `off` is **locked**. The row says that the deploy var is a hard
    off. If a console value is stored, the row says it applies once the deploy var allows it.
  - **Revert…** removes the console value after a confirmation that names the value you get
    back: the deploy var's, or the code default.
  - A stored value outside the bounds is flagged as not applied.
  - If the settings store cannot be read, the switches show _Off: store unreadable_ and nothing
    can be saved.
- **Licensing.** The reserved-names setting as a Warn / Refuse choice (switching to Refuse asks
  first), the reserved keys with the rule the platform applies to each, and every registered
  product whose catalog declares a reserved name, each declaration marked compatible or not with
  the reason. Check this list before switching to Refuse: a product marked incompatible would
  fail its next resync.
- **Delivery.** The hosted-assets switch (`ASSET_HOSTING`; turning it either way asks first),
  then the deploy-time delivery values, read-only.
- **Identity & access.** The reserved display-name setting and the key-entry refusal switch, then
  the deploy-time values, read-only.
- **Email.** The deploy-time values, read-only. Identity
  shows the console's own client (`ADMIN_OIDC_ISSUER`, `ADMIN_OIDC_CLIENT_ID`) above the platform
  client the portal and products use (`PLATFORM_OIDC_*`).
- **Limits.** The code constants: retention, the bucket's age lock, the collector's shortest
  grace and the delta size ceiling. Collapsed until you open it.
- **Keyring.** The KEK keyring, read-only: which KEK secrets are set, the `PLATFORM_KEK_ACTIVE`
  and `PLATFORM_KEK_ID` kid names, the active key, every key in the ring with how many values it
  seals, and the re-seal progress. Values under a key that has left the ring are flagged as
  unopenable. While `PLATFORM_KEK` is set beside `PLATFORM_KEK_KEYS`, its kid is marked
  _Legacy, open only_, and a **Legacy key** row says how many values (and which sealed Worker
  secrets) are still under it, or _Safe to delete PLATFORM_KEK_ once none are. When the ring does
  not parse, the section says the keyring is unusable. Rotation and the re-seal sweep follow the
  [KEK runbook](/docs/admin/kek/).
- **Secrets.** Each platform secret as _Set_ or _Not set_, with what it is for and what being
  unset means.
- **History.** Each settings change from the platform trail, with who made it and the value
  before and after, newest first.

### When someone else saved first

Every save sends the version the page loaded. If someone changed the setting since, nothing is
changed and the row says so, with a **Reload** button. Reload shows the current value and who set
it. A number you typed stays in its field: press Save to apply it on top of the new value, or
Discard to keep the current one.

## The API

All four routes are for platform admins only (403 otherwise), and the two writes need the CSRF
header like every console mutation.

```http
GET /manage/api/platform/settings
```

Returns:

- `settings`: one entry per runtime setting, with the effective `value`, its `source`
  (`runtime`, `deploy`, `default`, or `failsafe` when the store could not be read and a switch
  resolved to off), `forcedOff` for a deploy-time hard off, the raw `deployValue`, the `stored`
  row (value, whether it is valid, who set it and when), bounds, and the `version` the next write
  must send;
- `deployTime`: the deploy-time values that are not credentials, such as the environment, the
  admin group, the issuer and client id of the console's client (`ADMIN_OIDC_*`) and of the
  platform client (`PLATFORM_OIDC_*`), the parsed issuer allowlist, the origins, the bucket and
  the KEK kid names;
- `secrets`: every platform secret as `{ name, set }`. The value, its length and any hash of it
  are never returned;
- `constants`: code constants that act as policy, such as the admin session length and the audit
  retention;
- `warnings`: `console_oidc_shared` while the console signs in through the platform client
  because `ADMIN_OIDC_ISSUER` or `ADMIN_OIDC_CLIENT_ID` is unset (`names` lists which);
  `PLATFORM_KEK_ID` is set; `kek_keyring_unusable` while the KEK keyring does not load (the
  message gives the reason, naming kids only); `kek_legacy_open_only` while `PLATFORM_KEK` is set
  beside `PLATFORM_KEK_KEYS` and is the only source of its kid, so it is kept as the legacy key,
  open-only (the message names its kid; a same-bytes copy of a `PLATFORM_KEK_KEYS` entry is not
  flagged); or `PORTAL_SESSION_SECRET` is unset, so the portal signs its sessions with the admin
  secret.

```http
PATCH /manage/api/platform/settings/<key>
{ "value": 14, "expectedVersion": 3 }
```

Stores a runtime value. `expectedVersion` is the `version` from the list (0 when there is no
runtime value yet). The answer is the updated setting, or:

- `404` for a key that is not a runtime setting;
- `422` (`reason: "invalid_value"`) for a value outside the setting's bounds;
- `409` (`reason: "version_conflict"`, with `currentVersion`) when someone else changed it since
  you loaded it. Reload and review before you retry.

A runtime `on` stored under a deploy-time hard off is accepted, but the answer shows
`forcedOff: true` and the effective value stays `off`.

```http
DELETE /manage/api/platform/settings/<key>?expectedVersion=3
```

Removes the runtime value, so the setting reverts to the deploy-time value or the code default.
It is version-guarded in the same way, and answers `404` when there is no runtime value. The row
is kept as a tombstone and its version keeps counting up, so a version you loaded before the
delete can never be accepted afterwards; the next write carries the version the list reports.

```http
GET /manage/api/platform/reserved-names
```

Read-only. Returns the `mode` the reserved-names setting resolves to (`warn` or `error`), the
reserved `keys` (each with its `type` and the `rule` the platform applies), the reserved
`prefixes`, and `products`: every registered product whose active catalog declares a reserved
name, with its `catalogVersion` and one `declarations` entry per declared name
(`{ key, compatible, problem }`, `problem` saying why an incompatible one is incompatible).

## Reference

- [KEK runbook](/docs/admin/kek/): the keyring the Keyring section reads.
- [Activity](/docs/admin/activity/#the-platform-trail): the platform trail these changes write.
- [Deploying to production](/docs/admin/deploy/): where the deploy-time values are set.
