---
title: "Platform settings"
description: "The instance-wide settings: which four can change at runtime, how precedence works, and what the read-only inventory shows."
sidebar:
  order: 13
---

Platform settings apply to the whole instance, not to one product. Almost all of them are
deploy-time: they live in `wrangler.toml` or as Worker secrets and change only with a deploy.
Four background-job settings can also be changed at runtime, without a deploy, and every change
is recorded in the [platform trail](/docs/admin/activity/#the-platform-trail).

## The runtime settings

| Setting                | What it does                                                                   | Values                                     |
| ---------------------- | ------------------------------------------------------------------------------ | ------------------------------------------ |
| `LAZY_DELTAS`          | Turns lazy hot-pair deltas on or off, in both Worker scripts.                  | `on` or `off` (default `off`)              |
| `LAZY_DELTA_MAX_BYTES` | The largest payload, on either side of a pair, the delta consumer will encode. | 1 MiB to 32 MiB, in bytes (default 32 MiB) |
| `BLOB_GC_MODE`         | Turns the nightly blob collector on or off.                                    | `on` or `off` (default `on`)               |
| `BLOB_GC_GRACE_DAYS`   | How long an object stays unreferenced before the collector may delete it.      | 1 to 365 days (default 30)                 |

32 MiB is the measured ceiling of the delta consumer, so a runtime size cap can only lower it.
"Lower" is measured against that 32 MiB ceiling, not against the deploy-time `LAZY_DELTA_MAX_BYTES`
in `[vars]`: a deploy-time cap of 8 MiB does not stop the console storing 16 MiB, which then wins.
The collector's grace never bounds deletion on its own: the bucket's 180-day age lock still
applies.

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

## The API

All three routes are for platform admins only (403 otherwise), and the two writes need the CSRF
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
  admin group, the identity provider's issuer and client id, the parsed issuer allowlist, the
  origins, the bucket and the KEK kid names. A value that came from a legacy `ADMIN_OIDC_*` name
  says so in `legacyName`;
- `secrets`: every platform secret as `{ name, set }`. The value, its length and any hash of it
  are never returned;
- `constants`: code constants that act as policy, such as the admin session length and the audit
  retention;
- `warnings`: the legacy `ADMIN_OIDC_*` names are what resolved; `PLATFORM_KEK_ID` is set; or
  `PORTAL_SESSION_SECRET` is unset, so the portal signs its sessions with the admin secret.

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

## Reference

- [Activity](/docs/admin/activity/#the-platform-trail): the platform trail these changes write.
- [Deploying to production](/docs/admin/deploy/): where the deploy-time values are set.
