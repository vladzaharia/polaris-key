---
sidebar:
  order: 7
title: "Compatibility and the device simulator"
description: "The console's Compatibility tab: the matrix of app releases against pack releases with each cell's state, the live contentApi levels and per-outlet liveness, and the simulator that shows what a device running one app release on one outlet gets."
---

Floors, holds, pack channels, store lag and transports interact. Without a view of them an
operator learns what a device gets only when the device gets it. The **Compatibility** tab in the
Release section answers it before then, in two read-only views. Nothing here edits a floor, a
hold, a pin or a yank: floors and yanks are set under
[Channels](/docs/services/release/channels/), pins and holds in `.pkey/release`
([Packs](/docs/services/release/packs/#app-releases-content-pins-and-embeds)).

## The matrix

Rows are app releases, columns are pack releases grouped by pack. Each cell takes the first state
that applies:

| State          | Meaning                                                                                                                                                                                                                                 |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `revoked`      | a revocation record names the pack release ([Revocations](/docs/services/release/packs/#revocations)). The cell still says when the app release pins or holds it, because those devices are the ones the revocation reaches             |
| `pinned`       | the app release pins it                                                                                                                                                                                                                 |
| `held`         | the app release holds it                                                                                                                                                                                                                |
| `compatible`   | a variant of it admits the app release: for a `compatible` pack, its `requires.contentApi.app` range holds the app release's level and it runs on an engine the app release's builds declare; for a `standalone` pack, the engine alone |
| `incompatible` | otherwise. A `pinned` pack reaches a device only through a pin, so every other cell of it is incompatible                                                                                                                               |

Two markers ride on top of the state:

- **Current** (a ring): this pack release is the member of the stored pack set that serves the
  app release, the one the signed feed lists for it. A compatible release that is not current was
  passed over: an older one, one below a floor, or one a dependency or conflict ruled out.
- **Yanked** (struck through): yanked is a modifier, never a state. Revoking a release also yanks
  it.

Each cell's reason is its tooltip, for example "contentApi >=3 <4 excludes level 4".

The **live levels** are the contentApi levels of the app releases each channel serves at or above
its floor. They are the levels resolution stores sets for and the feed carries, so they never
depend on store availability. An app release row shows its level (highlighted when live), the
channels it is live on, and a warning with the count of **unsatisfied** packs: the packs no release
satisfies at one of its selectors, each with its reason (`no-release`, `content-api`, `engine`,
`variant`, `content-floor`, `dependency` or `conflict`).

The **Outlets** column is the per-outlet liveness overlay. It comes from Distribution's own matrix
([Distribution matrix](/docs/admin/distribution-matrix/)), fetched separately, so Release's answer
never reads Distribution. An outlet is listed when the app release is live there, marked **held**
when outlet readiness holds the release because a pack it needs is not live on that outlet yet, and
**not ready** on a store outlet Polaris Key cannot hold
([Outlet readiness](/docs/services/distribution/availability/#outlet-readiness)). When
Distribution is off, the overlay says so and the matrix still renders.

The matrix shows every live app release plus the last 10 per channel, and every pack release that
is a set member plus the last 10 per pack. **Show more** pages the rest in.

## What does this device get?

Pick an app release, a platform, an outlet and, optionally, a variant (`texture=etc2;tier=hd`, a
value can be a preference list such as `texture=astc,etc2`), a device id and a device's reported
`packSetId`. The simulator answers with:

- the **decision** a fresh device running that app release reaches (`packs`, `binary`, `store`,
  `blocked` with its reason, `none`), and its boot value;
- the **set** the device runs after that check and its **packSetId**, the value an SDK reports.
  Given a reported `packSetId`, it says whether the two match;
- per pack, the **declared** binding and the **effective** one with the reason: pinned by the app
  release, held by it, or pinned by a transport that cannot deliver content between app releases
  ("compatible (pinned by play-pad on play)"); the **feed target** selected for the device's
  level, platform, engine and variant, and the **gate** on it (a halt, or a rollout with the
  device's bucket and the fallback it takes outside it); the **floor** that applies; the
  **unsatisfied** markers for the selector; the **revocations** that name it; and what the device
  installs, unmounts and runs;
- the feed it decided from: channel-wide or per platform, any content member the size cap left
  out, and the app rollout on the outlet.

There is no second implementation. The Worker composes the document the feed route would sign for
that channel and platform, signs it in memory (it is never stored or returned), and runs
client-core's update check over it, exactly as an SDK does on a device with no cache: it verifies
the feed and the records, fetches every revocation and replacement by hash, computes the rollout
buckets from the device id and decides. The device's active set before the check is its build's
embedded baselines. Without a device id the device is outside every client-evaluated rollout, as an
SDK without one is.

A device on an older app release on a self-updating outlet is offered the newer build first, and
content waits behind that offer; the simulator shows that answer rather than a set the device would
not take.

## The console API

Both routes are read-only, under `/manage/api/products/<slug>/` and behind the same platform-admin
session as the rest of the console.

| Method and path                                                                                     | Answers                                                                                                                                                                                                                                                                                                                    |
| --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET release/compat[?limit=N]`                                                                      | `channels`, `liveLevels` (per channel) and `levels`; `packs[]`; `appReleases[]` (level, `live`, `liveOn`, yank, platforms, engines, pins, holds, `unsatisfied[]`); `packReleases[]` (requirements, yank, `revoked`, `current`); `cells[]` (`state`, `current`, `yanked`, `reason`); `hidden`. `limit` is 1–100, default 10 |
| `GET update/simulate?appRelease=&platform=[&outlet=&variant=&channel=&device=&methods=&packSetId=]` | `selector`, `feed`, `decision` (client-core's `UpdateDecision`), `boot`, `errors`, `set[]`, `packSetId`, `activePackSetId`, `reported`, `block`, `packs[]` and `notes[]`. `channel` defaults to `stable` and `methods` to `download`. 400 names the bad field; 404 an unknown app release or outlet                        |

Support tooling reads the simulate answer's shape: given a device's reported app release and
`packSetId`, it reproduces that device's content.
