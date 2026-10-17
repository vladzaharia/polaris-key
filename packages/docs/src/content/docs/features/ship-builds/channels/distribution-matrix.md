---
title: "The distribution matrix"
description: "The console view of every release on every channel: the matrix, its toolbar and the cell drawer."
type: "reference"
lastReviewed: "2026-10-16"
sidebar:
  order: 2
---

## The matrix

**Distribution → Rollouts**, in its **Matrix** view, shows a deliverable's most recent releases
(twenty by default, fifty at most) against every channel the product declares in
`.pkey/distribution`. The matrix is not a sidebar item of its own: its old address and the `g m`
shortcut open that view. Each cell answers one
question about one release on one channel, and opens a drawer with everything else.

## The toolbar

- **Deliverable**: the app, or any pack. A pack's matrix has no readiness.
- **Release track**: every release track, or one.
- **View** changes only what each cell summarizes:

  | View         | The cell shows                                                    |
  | ------------ | ----------------------------------------------------------------- |
  | Availability | the availability, plus the rollout percentage or a readiness hold |
  | Rollouts     | the rollout state and percentage, or nothing                      |
  | Readiness    | Ready, Held with the number of blockers, Not ready or Pending     |

- **Rows**: 20 or 50. When the matrix is full, a note says it shows the newest releases only.

All of these, and the open cell, are in the page's URL
(`#/p/<slug>/distribution/matrix?deliverable=textures&view=readiness&cell=<release>:<outlet>`),
so a link reopens exactly what you were looking at. The grid is one tab stop: arrow keys move
between cells and Enter opens one. Below 768 px wide each release is a card listing its channels;
**View as grid** brings the grid back.

## The cell drawer

- **Availability**: the best state any build is in on that channel (`live`, `approved`,
  `in-review`, `processing`, `pending`, `rejected` or `removed`), then each build's record with
  where it came from and since when. A self-hosted channel (direct downloads, AltStore, Obtainium,
  the F-Droid repository) is `live` once Polaris Key holds the build's bytes, with no report
  needed ("Derived: Polaris Key serves these bytes"). A store channel shows only what CI
  (`distribution:report`) or a store connector reported. A yanked release derives nothing; a
  stored report on it stays visible.
- **Submission**: the store review state, when it was submitted and when it was reviewed.
- **Readiness** (app releases): whether the release's packs are ready on this channel, each blocker
  linked to its pack release, and whether Polaris Key holds the release there until they are; see
  [Channel readiness](/docs/features/ship-builds/channels/availability/#channel-readiness). **Override…**
  releases a hold and needs a reason, which is audited; **Clear override** computes the hold
  again. **Refresh readiness** in the page header recomputes every release and says how many
  changed.
- **Rollouts**: one block per release track, with the percentage as a meter and only the moves the
  rollout's state allows:

  | From       | Allowed                                   |
  | ---------- | ----------------------------------------- |
  | `active`   | Pause, Halt, Complete, Set percentage     |
  | `paused`   | Resume, Halt, Set percentage              |
  | `halted`   | Resume                                    |
  | `complete` | none: publish a newer release and roll it |

  **Set percentage…** offers 1, 5, 10, 25, 50 and 100 % or any value. Devices are bucketed by a
  stable hash, so raising the percentage only adds devices. **Start rollout…** (in the drawer and
  the page header) picks the deliverable, channel, release track, release and the first percentage.

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
