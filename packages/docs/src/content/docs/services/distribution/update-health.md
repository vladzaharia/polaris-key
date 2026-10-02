---
sidebar:
  order: 7
title: "Update health"
description: "The update outcome events devices report, the funnel the console shows per rollout, the opt-in halt-only auto-halt on revert and boot-rollback rates, and Sentry alerts that open halt candidates an operator confirms — with the SDK tagging convention."
---

After a release reaches a device, the device says what happened: it was offered the update,
downloaded it, applied it, confirmed the new version booted — or reverted, failed to mount a pack,
or rolled back at boot. Distribution counts those **update outcome events** per release, outlet
and channel, shows them as a funnel, and can halt a rollout on them automatically. A Sentry alert
on a release can open a **halt candidate** for you to confirm.

## Reporting events

Devices send events in the `updates` key of the ordinary device report,
`POST /<product>/devices/report` (the same request that carries the software snapshot). It is an
array of at most 16 entries:

```json
{
  "updates": [
    {
      "eventId": "0f5c2a9e-reverted",
      "event": "update_reverted",
      "deliverable": "app",
      "release": "v1.4.0",
      "fromRelease": "v1.3.0",
      "outlet": "direct",
      "channel": "stable",
      "at": 1700000600,
      "code": "boot_failed"
    }
  ]
}
```

| Field         | Required | Meaning                                                                    |
| ------------- | -------- | -------------------------------------------------------------------------- |
| `eventId`     | yes      | unique per event, chosen by the device (`[A-Za-z0-9._:-]`, ≤ 64)           |
| `event`       | yes      | one of the seven names below                                               |
| `deliverable` | yes      | `app`, or a pack id                                                        |
| `release`     | yes      | the release id the event is about (the feed's `releaseId`)                 |
| `fromRelease` | no       | the release the device moved from                                          |
| `outlet`      | yes      | the outlet the build came through (its build stamp's outlet id)            |
| `channel`     | yes      | the release channel                                                        |
| `packSetId`   | no       | the pack set, for pack events                                              |
| `at`          | yes      | epoch seconds                                                              |
| `code`        | no       | a short machine-readable reason (`[A-Za-z0-9._:-]`, ≤ 64), no message text |

The seven names are fixed for every SDK (the `updateEvent` enum in
`conformance/parity/enums.json`): `update_offered`, `update_downloaded`, `update_applied`,
`update_confirmed`, `update_reverted`, `pack_failed` and `boot_rolled_back`.

The Worker validates every entry strictly. An entry with a missing or malformed field, or an
unknown event name, is dropped and the rest are kept; unknown fields are stripped. The report's
16 KiB cap still applies to the whole body. A device may resend an event (a retried report, or
the same queue in the next report): it is counted once, because counting is deduplicated on the
device and its `eventId`. An `at` in the future counts as now; one older than 30 days is not
counted. Counting never costs the device its report: if the counters are unavailable the report is
still stored and answered `200`, and a later resend counts the event then.

Today the Godot updater and packs emit these events. Other SDKs have no emitter yet.

## What is counted

Each (product, deliverable, release) has its own set of counters, kept in a Durable Object rather
than in D1, so reporting never writes the database. For every outlet, channel and event, in
hourly buckets, it keeps two numbers:

- **events** — distinct events (after the dedupe above);
- **devices** — distinct devices that reported the event, counted once per device however many
  events it sends. Rates and the auto-halt use this number, so one device can move a rate by at
  most one.

An event naming an outlet the product does not declare, or a channel it does not know (the
built-in channels, its manual channels and any channel an app release was published to), is
counted in one `unknown` bucket: shown, never judged, and unable to crowd out a real outlet. An event
naming a release Release does not know counts nothing, and one report is counted for at most two
releases. One
device counts at most 64 events per release and introduces at most 8 (outlet, channel) pairs;
beyond that its events count nothing, or count as `unknown`. Buckets older than 30 days, and the
per-device records (the event ids it counted) of a device idle for 30 days, are deleted. See
[Privacy](#privacy).

## The funnel

The Distribution section's **Update health** tab shows, for every rollout, the funnel offered →
downloaded → applied → confirmed / reverted, plus pack failures and boot rollbacks, in distinct
devices over the last week (the number's tooltip is the event count), and the revert and boot
rollback rates. The admin API behind it is narrative-only:

```
GET  /manage/api/products/<slug>/distribution/update-health[?windowHours=N]   # N ≤ 720
POST /manage/api/products/<slug>/distribution/update-health/settings
POST /manage/api/products/<slug>/distribution/update-health/candidates/<id>/confirm
POST /manage/api/products/<slug>/distribution/update-health/candidates/<id>/dismiss
```

## The auto-halt

The auto-halt is **off by default**. When you turn it on, every 15 minutes (the connector cron)
Distribution looks at each `active` rollout of the product:

| Setting               | Default | Meaning                                                             |
| --------------------- | ------- | ------------------------------------------------------------------- |
| `windowHours`         | 6       | the last N whole hours, up to and including the current one (1–168) |
| `minSample`           | 200     | devices that **applied** the release on that outlet and channel     |
| `maxRevertRate`       | 0.05    | `update_reverted` devices ÷ `update_applied` devices                |
| `maxBootRollbackRate` | 0.02    | `boot_rolled_back` devices ÷ `update_applied` devices               |

- Below `minSample` applied devices, nothing happens, however bad the rate.
- Above a threshold, a **self-hosted** rollout is halted, through the same halt as the console
  and CI, with `source: auto-halt`. One `distribution.rollout.halt` audit row (actor
  `system:auto-halt`) names the rate, the counts and the window.
- A **store** rollout (mirrored from App Store Connect or Google Play) is never halted here;
  halting it is a store control. The auto-halt raises an alert on the tab instead (and one
  `distribution.auto_halt.alert` audit row), and you halt it with the connector.
- A rollout trips **once** per release, outlet and channel. If you resume it, the auto-halt does
  not halt it again. It never resumes, ramps, completes or starts anything: it can only halt.
- If the counters cannot be read, or a read is incomplete, nothing is judged (the tab's last
  reading says why). A halt that races a change to the rollout is retried on the next tick.

:::caution[Open registration]
The auto-halt counts distinct devices, so one device moves a rate by at most one. But under open
registration devices are cheap: keyless registration allows 10 per minute per IP, so about twenty
minutes reaches the default `minSample` of 200. Fake devices can then halt a rollout (the safe
direction), or report fake applies that dilute a real revert rate below the threshold. For an
open-registration product, raise `minSample` well above what anyone would bother to register, or
leave the auto-halt off. Either way it is a safety net, not a guarantee: watch the funnel.
:::

The settings are yours alone: they are saved only from the tab (a platform-admin session, audited
as `distribution.auto_halt.settings`). No `.pkey/` manifest, resync or CI token can change them,
so a push to the product's repository can never switch on an automatic halt.

What a halt does to devices is what any halt does: see
[Rollouts and halts](/docs/services/distribution/rollouts/).

## Sentry alerts

A Sentry alert can open a **halt candidate**. A candidate halts nothing: you confirm it (which
halts the rollout, audited as you) or dismiss it, on the tab.

To connect a Sentry organisation:

1. In Sentry, create an **internal integration** with the **Alert Rule Action** and webhooks
   enabled, and set its webhook URL to `https://key.plrs.im/<product>/distribution/hooks/sentry`.
2. Store its **client secret** as an outlet credential of kind `sentry-integration` (Platform →
   Secrets → Outlet credentials). Without one, the hook answers not-found.
3. Add the integration as an action on an issue alert rule.

Sentry signs each delivery with the client secret (`Sentry-Hook-Signature`, hex HMAC-SHA256 of the
body); a missing or wrong signature is refused before anything else happens, deliveries are
rate-limited per product, and a redelivered body is answered as a duplicate. Only a triggered
issue alert (`Sentry-Hook-Resource: event_alert`) is acted on; other resources are stored and
ignored. The alert's event is mapped to rollouts by the tags below; every matching active or
paused, self-hosted rollout of that release gets one candidate, and a repeated alert adds to its
count. A confirmed or dismissed candidate is not reopened. Of the alert, a candidate keeps only
the rule name and Sentry's issue id, and the delivery log keeps only the resource, action, rule,
issue id, release, environment and outlet — never the crash message, exception, user or other
tags.

### Tagging convention for SDKs

Set these on the Sentry client so an alert can be mapped to a rollout:

| Sentry field / tag | Value                                  | Example        |
| ------------------ | -------------------------------------- | -------------- |
| `release`          | `<deliverable>@<version>+<build>`      | `app@1.4.0+12` |
| `environment`      | the release channel                    | `stable`       |
| `pkey.outlet`      | the outlet id from the build stamp     | `direct`       |
| `pkey.packSetId`   | the active pack set, when there is one | `levels-2026a` |

The version is resolved through the release catalog: `1.4.0+12` exactly, then `1.4.0`, then the
tag `v1.4.0`. Without `pkey.outlet`, every self-hosted rollout of the release on that channel
becomes a candidate.

Pulling a crash-free rate from Sentry's API into the console needs a Sentry auth token and is not
offered.

## Privacy

An update event carries release identifiers, an outlet, a channel, a time and an optional short
code. It carries no hardware value, no user identifier and no message text. The counters keep one
record per device — its device id, which the Worker already holds for every registered device,
and the event ids it counted — only to count distinct devices and dedupe, and delete it once the
device has been idle for 30 days. The latest report's `updates` array is
also kept, like the rest of the report, as part of the device's last snapshot until the next
report replaces it or the device is deleted. See `docs/PRIVACY.md` in the repository.
