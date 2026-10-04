---
title: "Distribution matrix"
description: "The console's releases × outlets grid: availability, store review and rollout per cell, and the pause, resume, halt and complete controls."
sidebar:
  order: 12
---

**Distribution → Matrix** shows the app's most recent releases (twenty by default) against every
outlet the product declares in `.pkey/distribution`. Each cell answers three questions about one
release on one outlet: is it available there, where does it stand in the store's review, and how
far has it rolled out.

## Reading a cell

- **Availability** is the best state any of the release's builds is in on that outlet: `live`,
  `approved`, `in-review`, `processing`, `pending`, `rejected` or `removed`. A self-hosted outlet
  (direct downloads, AltStore, Obtainium, the F-Droid repository) shows `live (derived)` as soon
  as Polaris Key holds the build's bytes, with no report needed. A store outlet shows only what CI
  (`distribution:report`) or a store connector reported. Hover the badge to see each build's
  record and where it came from. A yanked release derives nothing; a stored report on it stays
  visible.
- **Review** is the store submission state (`prepared`, `submitted`, `in-review`, `approved`,
  `rejected`, `pending-developer-release`, `released`, `cancelled`), when one has been reported.
- **Rollout** is one line per channel the release is rolling out on: the state (`active`,
  `paused`, `halted`, `complete`) and the percentage of devices it is offered to.

The row header lists each build's payload with its size and SHA-256 (click to copy), and
**Files** opens the release's full file list, the same components as the Releases view.

## Controls

Each rollout line has **Pause**, **Resume**, **Halt** and **Complete**. Only the moves the
rollout's current state allows are enabled:

| From       | Allowed                   |
| ---------- | ------------------------- |
| `active`   | Pause, Halt, Complete     |
| `paused`   | Resume, Halt              |
| `halted`   | Resume                    |
| `complete` | none: start a new release |

Every control asks for confirmation first and states what it will do. It calls the same
rollout route CI uses (`distribution:rollout`), is audited under your name in **Activity**, and
is refused if the rollout moved to another release since the matrix was loaded.

A rollout **mirrored** from a store connector (an App Store phased release, a Play staged
rollout) says so and has every control disabled: the store owns it, so change it in the store and
the connector brings the new state back.

## What a pause or halt reaches

A pause or halt stops offering the release on that outlet in the signed channel feed, the
app-updater feeds (the Sparkle appcast, `/update/version` and the rest), the storefront feeds
(AltStore, F-Droid, Scoop) and the public [download page](/docs/users/downloads/), which list
the previous release instead. Moving download URLs apply yanks and pins, not holds: to take a
release off every surface, yank it or pin the channel under **Release → Releases**. See
[Rollouts and halts](/docs/services/distribution/rollouts/).

## Readiness and store mirrors

Each app release's cell also carries a `readiness` object in the matrix API: the blockers,
whether Polaris Key holds the release on that outlet (its availability then reads `pending`)
and, on a store outlet it cannot hold, a warning; see
[Outlet readiness](/docs/services/distribution/availability/#outlet-readiness). The console
shows it on **Releases → Compatibility**. Rollout and review states mirrored from the store
connectors (App Store, Google Play, Microsoft Store) appear in the same cells.
