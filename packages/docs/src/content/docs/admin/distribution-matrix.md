---
title: "Distribution matrix"
description: "The console's Distribution pages: the releases × outlets matrix and its cell drawer, rollouts, outlets and feeds, access, health and outlet credentials."
sidebar:
  order: 12
---

**Distribution → Matrix** shows a deliverable's most recent releases (twenty by default, fifty at
most) against every outlet the product declares in `.pkey/distribution`. Each cell answers one
question about one release on one outlet, and opens a drawer with everything else.

## The toolbar

- **Deliverable**: the app, or any pack. A pack's matrix has no readiness.
- **Channel**: every channel, or one.
- **View** changes only what each cell summarises:

  | View         | The cell shows                                                    |
  | ------------ | ----------------------------------------------------------------- |
  | Availability | the availability, plus the rollout percentage or a readiness hold |
  | Rollouts     | the rollout state and percentage, or nothing                      |
  | Readiness    | Ready, Held with the number of blockers, Not ready or Pending     |

- **Rows**: 20 or 50. When the matrix is full, a note says it shows the newest releases only.

All of these, and the open cell, are in the page's URL
(`#/p/<slug>/distribution/matrix?deliverable=textures&view=readiness&cell=<release>:<outlet>`),
so a link reopens exactly what you were looking at. The grid is one tab stop: arrow keys move
between cells and Enter opens one. Below 768 px wide each release is a card listing its outlets;
**View as grid** brings the grid back.

## The cell drawer

- **Availability**: the best state any build is in on that outlet (`live`, `approved`,
  `in-review`, `processing`, `pending`, `rejected` or `removed`), then each build's record with
  where it came from and since when. A self-hosted outlet (direct downloads, AltStore, Obtainium,
  the F-Droid repository) is `live` as soon as Polaris Key holds the build's bytes, with no report
  needed ("Derived: Polaris Key serves these bytes"). A store outlet shows only what CI
  (`distribution:report`) or a store connector reported. A yanked release derives nothing; a
  stored report on it stays visible.
- **Submission**: the store review state, when it was submitted and when it was reviewed.
- **Readiness** (app releases): whether the release's packs are ready on this outlet, each blocker
  linked to its pack release, and whether Polaris Key holds the release there until they are; see
  [Outlet readiness](/docs/services/distribution/availability/#outlet-readiness). **Override…**
  releases a hold and needs a reason, which is audited; **Clear override** computes the hold
  again. **Refresh readiness** in the page header recomputes every release and says how many
  changed.
- **Rollouts**: one block per channel, with the percentage as a meter and only the moves the
  rollout's state allows:

  | From       | Allowed                                   |
  | ---------- | ----------------------------------------- |
  | `active`   | Pause, Halt, Complete, Set percentage     |
  | `paused`   | Resume, Halt, Set percentage              |
  | `halted`   | Resume                                    |
  | `complete` | none: publish a newer release and roll it |

  **Set percentage…** offers 1, 5, 10, 25, 50 and 100 % or any value. Devices are bucketed by a
  stable hash, so raising the percentage only adds devices. **Start rollout…** (in the drawer and
  the page header) picks the deliverable, outlet, channel, release and the first percentage.

Pause and resume ask for a confirmation that lists what changes; halt and complete are marked as
the stronger actions and their confirm button repeats the verb ("Halt 2.4.0"). Every control calls
the same rollout route CI uses (`distribution:rollout`), is audited under your name in
**Activity**, and is refused if the rollout moved to another release since the page loaded — the
dialog then stays open and says so.

A rollout **mirrored** from a store connector (an App Store phased release, a Play staged
rollout) is read-only and names the store that owns it. When that store's connector is
configured, **Store controls** under it send the store's own verbs: App Store Connect's phased
release pause, resume and release to everyone; Google Play's rollout share, halt, resume and
complete. The connector brings the new state back into the cell.

## What a pause or halt reaches

A pause or halt stops offering the release on that outlet in the signed channel feed, the
app-updater feeds (the Sparkle appcast, `/update/version` and the rest), the storefront feeds
(AltStore, F-Droid, Scoop) and the public [download page](/docs/users/downloads/), which list
the previous release instead. Moving download URLs apply yanks and pins, not holds: to take a
release off every surface, yank it or pin the channel under **Release → Releases**. See
[Rollouts and halts](/docs/services/distribution/rollouts/).

## The other Distribution pages

- **Rollouts** lists every rollout of the product, halted ones first, with its release, outlet,
  channel, percentage, state, source and who changed it when. Filter by state and outlet; each
  row's menu has the same moves as the drawer, and **Open in matrix** opens its cell.
- **Outlets & feeds** lists the declared outlets with their kind, transports and capabilities.
  An outlet's drawer shows its identity, its capabilities against its kind's default, and, for
  AltStore, AltStore PAL, Obtainium, the F-Droid repository, Scoop (the Polaris Key outlet, `direct`) and
  Flathub, the public [feed URL](/docs/services/distribution/feeds/) of each channel with a copy
  button. **Narrow capabilities…** can only narrow below the kind's default; **Revert to
  manifest** (from the source badge) restores it. Below the outlets, **Distribution keys** is the
  signing-key inventory: add, edit or remove an entry, and add or dismiss a key CI reported that
  matches none.
- **Access** sets who may download each deliverable: the app and each pack, each saved on its own;
  see [Delivery access](/docs/services/distribution/delivery/).
- **Health** is [update health](/docs/services/distribution/update-health/): the funnel per
  rollout, the auto-halt and the Sentry halt candidates.
- **Outlet credentials** holds the store keys the connectors use and the Sentry integration
  secret; see [Outlet credentials](/docs/admin/secrets-and-keys/#outlet-credentials). Its
  **Store connectors** cards show each connector's state, which key it uses (the product's own or
  the platform's team key, see [Store connections](/docs/admin/store-connections/)) and its
  configuration actions: App Store Connect **Release this version**, **TestFlight public link**
  and **Webhook setup**; Google Play **Update priority** and **Settings**. **Release this
  version** cannot be undone, so it asks you to type the app's name exactly as App Store Connect
  shows it; the Worker checks the name against App Store Connect before it releases.

The release × outlet readiness also appears on **Release → Compatibility**.
