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

:::note[What a halt reaches]
A pause or halt stops offering the release on that outlet in the signed channel feed, the
[app-updater feeds](/docs/services/update/updater-feeds/) (the Sparkle appcast, `/update/version`
and the rest), the [storefront feeds](/docs/services/distribution/feeds/) and the public
[download page](/docs/users/downloads/); they list the previous release instead. (The appcast
of a product that publishes no release records keeps its GitHub-resolved path and does not read
rollouts.) The storefront
feeds that list releases (AltStore, AltStore PAL, F-Droid, Scoop and Flathub) also leave out a
release whose rollout is below 100%. **Obtainium does not follow holds.** Its config is a
pointer, not a release: in F-Droid repository mode it follows the `fdroid-repo` outlet's holds,
and in direct-link mode it follows the moving `builds/<channel>/<buildId>` download, which
applies yanks and pins but not holds. To take a release off every surface, moving downloads
included, **yank it** or **pin the channel** to an earlier release
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

The Distribution console section lists the rollouts, and its Matrix tab carries the controls.

Every change, from either door, is audited as `distribution.rollout.<verb>` (`set`, `pause`,
`resume`, `halt`, `complete`), with the session's subject or `ci:<subject>`.

**Automatically** — the [telemetry auto-halt](/docs/services/distribution/update-health/#the-auto-halt),
when an operator turns it on, halts an active self-hosted rollout whose devices report too many
reverts or boot rollbacks. It goes through the same implementation with a third, automatic actor
that may **only halt**: every other verb is refused with `reason: system_halt_only`. Its halt
writes `source: auto-halt` and `updated_by: system:auto-halt`, and its one
`distribution.rollout.halt` audit row names the numbers that tripped it. Nothing automatic ever
resumes, ramps, completes or starts a rollout; lifting the halt is your `resume`.

## Pack rollouts and halts

A pack release rolls out, pauses, resumes and halts per outlet through the same rows and the
same controls as the app: pass the pack's id as the deliverable
(`pkey distribution rollout --deliverable <packId> …`, `{ "deliverable": "<packId>" }` on the
routes). The signed channel feed carries them as **gates** under
`packSets.outlets.<outletId>.gates`, keyed by the target release's record hash, for every rollout
on the feed's channel whose release a stored pack set offers, on an outlet where the pack floats:

| Rollout state                    | Gate                                                 |
| -------------------------------- | ---------------------------------------------------- |
| `active` or `paused`, below 100% | `{ halted: false, rollout: { bp, salt }, fallback }` |
| `halted`                         | `{ halted: true, fallback }`: a pack-only rollback   |
| `complete`, at 100%, or mirrored | none (a mirrored rollout gates only when halted)     |

A device outside the bucket, or on a halted gate, takes `fallback` instead: the release the sets
name **without** the gated releases (the previous set), or `null` when its rows disagree, in which
case the device keeps what it has. A device never downgrades a pack it already installed. Other
outlets carry no gate. A pack whose transport cannot float on an outlet (`pinned` there) gets
none either.

## Store rollouts

A store's own staged rollout — Apple's seven-day phased release, Play's `userFraction` — is
**mirrored** from the store by its connector, and controlled through the connector, not here.
Such a row has `mirrored = 1` and its connector's kind as `source`, and every direct edit is
refused with `rollout_mirrored`. Apple's phased release is mirrored by the
[App Store Connect connector](/docs/services/distribution/app-store-connect/#phased-release) and
each Play track's staged rollout by the
[Google Play connector](/docs/services/distribution/google-play/#how-play-maps), both audited as
`distribution.rollout.mirror`. The Play connector's halt is also the one an opt-in vitals
auto-halt uses (`connector:play-vitals`). The telemetry auto-halt never halts a mirrored rollout:
it raises an alert for you to act on with the connector's own control.

## See also

- [Byte delivery and delivery access](/docs/services/distribution/delivery/)
- [Update health](/docs/services/distribution/update-health/) — the funnel, the auto-halt and
  Sentry halt candidates.
- [Channels and policy](/docs/services/release/channels/) — yanks and pins, today's
  emergency stop.
