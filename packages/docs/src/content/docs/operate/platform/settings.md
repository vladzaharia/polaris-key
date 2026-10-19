---
title: "Platform settings"
description: "The instance-wide settings: the eight that can change at runtime, how precedence works, and what the read-only inventory shows."
type: "reference"
lastReviewed: "2026-10-16"
sidebar:
  order: 13
---

Platform settings apply to the whole instance, not to one product. Almost all of them are
deploy-time: they live in `wrangler.toml` or as Worker secrets and change only with a deploy.
Some can also be changed at runtime, without a deploy: the background-job settings, the
reserved-name settings, the key-entry refusal switch and the hosted-assets switch. Every change is
recorded in the
[platform trail](/docs/operate/console/activity/#the-platform-trail).

In the console this is **Platform → Settings** (`#/platform/settings`; `#/platform` opens it).

## The runtime settings

| Setting                           | What it does                                                                                        | Values                                     |
| --------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `LAZY_DELTAS`                     | Turns lazy hot-pair deltas on or off, in both Worker scripts.                                       | `on` or `off` (default `off`)              |
| `LAZY_DELTA_MAX_BYTES`            | The largest payload, on either side of a pair, the delta consumer encodes.                          | 1 MiB to 32 MiB, in bytes (default 32 MiB) |
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
[reserved entitlement names](/docs/build/manifest/catalog/#reserved-entitlement-names)). With
`warn`, an incompatible declaration is accepted and reported; with `error`, link, resync and the
console's catalog publish refuse it. The setting starts at `warn` for a window of two minor
releases or 60 days, whichever is later, and then moves to `error`. Neither value changes what a
device is signed: the platform's own value of a system key always wins.

`IDENTITY_RESERVED_DISPLAY_NAMES` is `identity.reservedDisplayNames`. The sign-in card says
"<App> wants you to sign in", so a product may not present itself as Polaris Key, Apple, the App
Store, Google, Google Play, Steam, Valve, Epic Games, Microsoft, Xbox, PlayStation, Nintendo or
itch.io (see [display names](/docs/build/manifest/product/#display-names)). With `warn`, such a
`product.name`, `listing.name` or `listing.developerName` is accepted and reported; with `error`,
link, resync and the console's listing edits refuse it. Either way the sign-in card shows the
product slug in a neutral frame instead of a reserved name. The setting starts at `warn` for two
minor releases or 60 days, whichever is later. It sits under Sign-in in the console.

`KEYENTRY_REFUSALS` is `identity.keyEntryRefusals`, the rollout switch for
[key entries](/docs/features/licensing/activation/#key-entries). Key entries are counted either way. On, a
product with Identity on refuses a new device a key whose licence is in no account and has used
every key entry, with a link to add the key to an account; a device already using its key is never
refused. Turn it on only once the SDKs that show the refusal are released. Turning it either way
asks first. It sits under Sign-in in the console.

`ASSET_HOSTING` is `assets.hosting.enabled`, the hosted-assets rollback switch. Off, every
surface goes back to the developer's own image URLs and the portal's media proxy, release-file
mirroring stops, and the legacy download streams from GitHub; the stored copies stay, release
files already copied keep serving from their copies, and image URLs already handed out keep
working. It is not a security gate, so it uses runtime precedence:
an unreadable settings store does not turn it off. It sits under Delivery in the console. Each
product's quotas and its own mirroring switch are on its
[Presentation page](/docs/operate/console/presentation/#hosting-and-quotas).

`identity.platformTerms` is Polaris Key's own terms: `{version, termsUrl, privacyUrl}`, with
https URLs. It is unset, so no new account is asked to accept anything of Polaris Key's and nothing
is recorded. Set, every new account accepts that terms version before it is created, recorded
beside the products' terms acceptances; the privacy notice is linked, not accepted. The console
does not write it: publishing it is the owner's step in the runbook
(`docs/RUNBOOK.md`, "Publish Polaris Key's terms"), once the terms are reviewed.

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

Platform → Settings has these sections, ordered by use. A section this deployment has nothing to
show in is left out, and a setting whose area no section names appears under Advanced, so none is
dropped. The header's **History** button jumps to the trail at the foot. A rail (wide
screens), pills (tablet) or a picker (phone) jumps between sections; the address keeps the
section (`?section=`), so a link opens there.

- **Platform ready.** What still needs doing: an unreadable settings store, each warning the API
  returns (the console still shares the customer sign-in client, `PLATFORM_KEK_ID` set,
  `PLATFORM_KEK` kept as a legacy key beside `PLATFORM_KEK_KEYS`, `PORTAL_SESSION_SECRET` unset),
  no admin group and no GitHub App. One banner shows the most severe item with a link to where it
  is fixed; **Show all** lists the rest. With nothing to fix the banner is not shown.
- **Product defaults.** The values a product starts from when it sets none of its own: the key-entry
  limit ceiling and the hosted-asset quotas. Every change, and every revert, asks for the L2 confirmation. The dialog leads with the
  products whose value changes, named, with what each goes from and to; its button carries the
  count, and Confirm waits until the count is in. The key-entry ceiling is a bound: it clamps a product that set a higher
  limit and never rewrites its value (raising it releases those products again), and the row lists the products it clamps with what each set
  and what is in effect. The licence defaults (device limit, offline window) are not editable yet.
- **Sign-in.** The reserved display-name setting and the console session length. The identity
  provider's deploy-time values are under Advanced.
- **Storefront and hosting.** The hosted-assets switch (`ASSET_HOSTING`; turning it
  off asks first), then the deploy-time hosts and accounts, read-only. **Package feeds** holds each
  ecosystem's platform policy: _Serve_ (stopping an ecosystem asks first and names every product)
  and a size ceiling in MiB with its own Save bar. A member without Platform edit sees values with a lock
  and one notice at the top saying who to ask.
- **Email and alerts.** The sender address, the legacy sender, the daily cap per product and the
  Apple private relay: deploy-time, read-only. Below them, **Alert destinations**: where
  auto-halts, store and commerce problems, access changes and failing destinations are sent.
  A destination is an email address or an https webhook, with the alerts it takes. A product can
  set its own under its Settings, which replace these for the alerts they take. Adding, changing,
  turning off or removing one needs a sign-in from the last five minutes; turning one on does not. Today only auto-halt alerts (and a
  failing destination's own alert) are sent; the other kinds are marked _Not sent yet_ and start
  when the feature that raises them ships. A product's email address cannot be sent a test. A webhook must be a public https address: `http`, a port
  other than 443, an IP address, `plrs.im` and private names are refused, and a redirect is not
  followed. Its URL and signing secret are stored sealed. The secret (`whsec_…`) is shown once,
  when you add the webhook or issue a new one. Each alert is a JSON body signed in the
  [Standard Webhooks](https://www.standardwebhooks.com/) scheme (`webhook-id`,
  `webhook-timestamp`, `webhook-signature`); reject a timestamp more than five minutes old.
  **Send test** delivers one. A destination that fails three times in a row raises its own alert
  to the others. Every change is in the platform trail.
- **Licensing.** The key-entry refusal switch, the reserved-names setting as a Warn / Refuse choice (switching to Refuse asks
  first), the reserved keys with the rule the platform applies to each, and every registered
  product whose catalog declares a reserved name, each declaration marked compatible or not with
  the reason. Check this list before switching to Refuse: a product marked incompatible would
  fail its next resync.
- **Jobs.** The background-job settings. Each row shows the effective value and a source
  badge: _Code default_, _Deploy var_ or _Set in console_ (with who set it and when). Each row
  saves on its own:
  - The switches apply when you flip them. Turning a job **on** asks first and lists what
    changes. Turning one **off** applies at once, with **Undo** in the confirmation toast.
  - The numbers have their own Save bar. The size cap is entered in MiB, from 1 to 32. It can
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
- **Advanced.**
  - **Identity provider.** The deploy-time values, read-only: the console's own client
    (`ADMIN_OIDC_ISSUER`, `ADMIN_OIDC_CLIENT_ID`) above the platform client the portal and
    products use (`PLATFORM_OIDC_*`), the admin group and the issuer allowlist.
  - **Limits.** The code limits, read-only, grouped as Access, Email, Retention, Storage and
    delivery, Licensing and Requests: session and token lives, email send and attempt caps,
    retention periods, the bucket's age lock, upload and delta sizes. The list comes from the
    Worker, so it matches the build. Collapsed until you open it.
  - **Keyring.** The KEK keyring, read-only: which KEK secrets are set, the `PLATFORM_KEK_ACTIVE`
    and `PLATFORM_KEK_ID` kid names, the active key, every key in the ring with how many values
    it seals, and the re-seal progress. Values under a key that has left the ring are flagged as
    unopenable. While `PLATFORM_KEK` is set beside `PLATFORM_KEK_KEYS`, its kid is marked
    _Legacy, open only_, and a **Legacy key** row says how many values (and which sealed Worker
    secrets) are still under it, or _Safe to delete PLATFORM_KEK_ once none are. When the ring
    does not parse, the section says the keyring is unusable. Rotation and the re-seal sweep
    follow the [KEK runbook](/docs/operate/platform/runbook/rotate-the-kek/).
  - **Secrets.** Each platform secret as _Set_ or _Not set_, with what it is for and what being
    unset means.
- `Recently changed`. Each settings change from the platform trail, with who made it and the
  value before and after, newest first.

### When someone else saved first

Every save sends the version the page loaded. If someone changed the setting since, nothing is
changed and the row says so, with a **Reload** button. Reload shows the current value and who set
it. A number you typed stays in its field: press Save to apply it on top of the new value, or
Discard to keep the current one.

## The API

All four routes are for platform admins only (403 otherwise), and the two writes need the CSRF
header like every console mutation.

```
/manage/api/platform/settings (GET)
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

```
/manage/api/platform/settings/<key> (PATCH)
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

```
/manage/api/platform/settings/<key> (DELETE)?expectedVersion=3
```

Removes the runtime value, so the setting reverts to the deploy-time value or the code default.
It is version-guarded in the same way, and answers `404` when there is no runtime value. The row
is kept as a tombstone and its version keeps counting up, so a version you loaded before the
delete can never be accepted afterwards; the next write carries the version the list reports.

```
/manage/api/platform/reserved-names (GET)
```

Read-only. Returns the `mode` the reserved-names setting resolves to (`warn` or `error`), the
reserved `keys` (each with its `type` and the `rule` the platform applies), the reserved
`prefixes`, and `products`: every registered product whose active catalog declares a reserved
name, with its `catalogVersion` and one `declarations` entry per declared name
(`{ key, compatible, problem }`, `problem` saying why an incompatible one is incompatible).

## Reference

- [KEK runbook](/docs/operate/platform/runbook/rotate-the-kek/): the keyring the Keyring section reads.
- [Activity](/docs/operate/console/activity/#the-platform-trail): the platform trail these changes write.
- [Deploy Polaris Key](/docs/operate/platform/deploy/): where the deploy-time values are set.
