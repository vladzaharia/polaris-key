---
sidebar:
  order: 3
title: "Rollouts and halts"
description: "Outlet-scoped rollout percentage, pause, resume, halt and completion — the states, the CI and console controls, mirrored store rollouts, and what a halt does today."
---

A **rollout** offers one release of one deliverable on one outlet's channel to a share of the
fleet. Rollout percentage, pause, resume, halt and completion belong to Distribution, **per
outlet and channel**; the channel pointer, floor, `critical` flag and yanks stay with Release,
per deliverable. Apple's phased release, Play's staged rollout and Polaris Key's own buckets
are all per outlet, which is why the split falls there.

:::caution[What a halt does today]
The [storefront feeds](/docs/services/distribution/feeds/) (AltStore, AltStore PAL, Obtainium,
F-Droid, Scoop and Flathub) honour rollouts: while a release's rollout on an outlet is paused,
halted or below 100%, that outlet's feeds leave it out and list the previous release. Until the
signed channel feed carries rollouts and halts, everything else **keeps serving**: the Sparkle
appcast, `/update/version` and the downloads do not read it. To stop a release reaching every
device now, **yank it** or **pin the channel** to an earlier release
([Channels and policy](/docs/services/release/channels/)).
:::

## The rollout record

One row per (deliverable, outlet, channel), in `dist_rollouts`:

| Field          | Meaning                                                            |
| -------------- | ------------------------------------------------------------------ |
| `release_id`   | the release being rolled out                                       |
| `rollout_bp`   | the share, in basis points from 0 to 10000                         |
| `rollout_salt` | 16 random bytes (hex), drawn fresh for every new release           |
| `state`        | `active`, `paused`, `halted` or `complete`                         |
| `mirrored`     | the row belongs to a store connector, and refuses direct edits     |
| `source`       | who last wrote it: `admin`, `ci`, a connector kind, or `auto-halt` |

A device decides for itself whether it is in a rollout:
`u32(sha256(salt ‖ installId)[0..4]) mod 10000 < rollout_bp`. The Worker never evaluates the
bucket, so the feed it serves is identical for every device. A new release gets a new salt so
the same devices are not always first.

## States and transitions

| Verb       | From               | To                    |
| ---------- | ------------------ | --------------------- |
| `pause`    | `active`           | `paused`              |
| `resume`   | `paused`, `halted` | `active`              |
| `halt`     | `active`, `paused` | `halted`              |
| `complete` | `active`           | `complete` (at 10000) |

Anything else is refused with `409` and `reason: invalid_transition`. A halt is lifted only by
an explicit `resume`.

**Setting** a rollout (`{ releaseId, bp }`) starts a new rollout when the release differs from
the row's — a fresh salt, `active`, whatever state the previous release's rollout was in — and
changes the percentage of the same release while it is `active` or `paused`. It is refused
while the rollout is `halted` (resume it first) or `complete`. A yanked release cannot be
rolled out (`release_yanked`).

A verb may name the release it means (`releaseId`); if the row now holds a different release
the verb is refused (`stale_release`), so a job that halts v1.4.0 never halts the v1.5.0
rollout that replaced it.

## Controls

**From CI** — a `pkeyci_` token with the `distribution:rollout` scope. The scope is
**opt-in**: it is not in the default grant, so an operator adds it to the product's CI
publisher deliberately. The CLI drives the routes on the same credential as
`pkey release publish` ([Publishing from CI](/docs/build/ci/)):

```sh
pkey distribution rollout --product your-product --outlet direct --channel stable \
  --release v1.4.0 --bp 2500            # 25%
pkey distribution halt --product your-product --outlet direct --channel stable --release v1.4.0
pkey distribution resume --product your-product --outlet direct --channel stable
# also: pause, complete; --deliverable for a pack
```

The routes underneath:

```
POST /<product>/distribution/rollouts/<outlet>/<channel>          { deliverable?, releaseId, bp }
POST /<product>/distribution/rollouts/<outlet>/<channel>/pause    { deliverable?, releaseId? }
POST /<product>/distribution/rollouts/<outlet>/<channel>/resume
POST /<product>/distribution/rollouts/<outlet>/<channel>/halt
POST /<product>/distribution/rollouts/<outlet>/<channel>/complete
```

The outlet must be one the product declares (`direct` when it declares none). Answers are
`{ "ok": true, "rollout": { … } }`; refusals use the platform's flat shape with a `reason`
(`unknown_outlet`, `unknown_channel`, `unknown_deliverable`, `unknown_release`, `no_rollout`,
`invalid_body`, `invalid_transition`, `release_yanked`, `rollout_mirrored`, `stale_release`).
No CORS: these are CI routes.

**From the console** — the same verbs under the admin API (narrative-only), plus a list:

```
GET  /manage/api/products/<slug>/distribution/rollouts
POST /manage/api/products/<slug>/distribution/rollouts/<outlet>/<channel>[/<verb>]
```

Every answer carries `effect: { reachesDevices: false, note }`, the caveat above, so a control
never implies more than it does. The Distribution console section lists the rollouts.

Every change, from either door, is audited as `distribution.rollout.<verb>` (`set`, `pause`,
`resume`, `halt`, `complete`), with the session's subject or `ci:<subject>`.

## Store rollouts

A store's own staged rollout — Apple's seven-day phased release, Play's `userFraction` — is
**mirrored** from the store by its connector, and controlled through the connector, not here.
Such a row has `mirrored = 1` and its connector's kind as `source`, and every direct edit is
refused with `rollout_mirrored`. Apple's phased release is mirrored by the
[App Store Connect connector](/docs/services/distribution/app-store-connect/#phased-release) and
each Play track's staged rollout by the
[Google Play connector](/docs/services/distribution/google-play/#how-play-maps), both audited as
`distribution.rollout.mirror`. The Play connector's halt is also the one an opt-in vitals
auto-halt uses (`connector:play-vitals`).

## See also

- [Byte delivery and delivery access](/docs/services/distribution/delivery/)
- [Channels and policy](/docs/services/release/channels/) — yanks and pins, today's
  emergency stop.
