---
sidebar:
  order: 4
title: "Availability, submissions and keys"
description: "Whether a release is available on each outlet and where it stands in a store's review, reported from CI or written by a store connector; derived availability for self-hosted outlets; and the operator-owned signing-key inventory."
---

"Is it in the App Store yet?" is a question about one release on one outlet. Distribution keeps
two answers per release and outlet — **availability** (is the build there?) and the
**submission** state (where is it in the store's review?) — and, per product, a **key inventory**
of the signing keys a download is checked against.

CI reports what each store says with `pkey distribution report`, and a store connector writes
it directly — the App Store and TestFlight through the
[App Store Connect connector](/docs/services/distribution/app-store-connect/), Google Play
tracks through the [Google Play connector](/docs/services/distribution/google-play/). Self-hosted outlets need no report: their availability follows from
what Release already knows.

## Availability

One record per (release, build, outlet), in `dist_availability`. A record without a build
(`buildId` empty) is about the whole release: a store that ships one binary per release, or a
report that does not know the build.

| State        | Meaning                                                    |
| ------------ | ---------------------------------------------------------- |
| `pending`    | known to the outlet, nothing happening yet                 |
| `processing` | the store is processing the upload                         |
| `in-review`  | in the store's review                                      |
| `approved`   | approved, not yet live                                     |
| `live`       | players can get it from this outlet                        |
| `rejected`   | refused by the store                                       |
| `removed`    | was available, no longer is (pulled, delisted, superseded) |

A state can move backwards — a rejection after review, a removal after going live. The record
keeps the **current** state, with `since` (when it entered that state); every change is in the
audit log as `distribution.availability.report`.

Store-assigned ids — an App Store Connect build id, a Play version code, a Steam depot manifest —
arrive after signing, so they never live on the release. A report carries them in
`platformRef`, stored on the availability record.

### Derived availability for self-hosted outlets

An outlet Polaris Key hosts itself shows `live` **without a report**. That is an outlet whose kind
is `direct`, `web`, `altstore`, `obtainium`, `fdroid-repo` or `app-installer`, and whose
transport for the release's deliverable is `pkey-cdn`, `embedded` or `web`. It shows `live` for
every build of the release that:

- the outlet carries — the build its identity names (`artifact`) when it names one; `web`
  builds on a `web` outlet; the listed `platforms` on a `direct` outlet that lists them; any build
  otherwise, and a platform-independent pack variant everywhere;
- has its payload stored by Polaris Key or located on GitHub.

A yanked release derives nothing. Derived records carry `source: "derived"` and `derived: true`.

A **pack release** derives by its own rule, per its transport on the outlet:

- `pkey-cdn` and `web`: `live` per variant once every object its signed record names (`full`,
  the files index and gaps, every delta) is stored with the recorded SHA-256 and length and held
  by a reference of this product. One object missing, or its reference gone, keeps that variant
  not live. The file blobs an index names were checked at ingest.
- `embedded`: ready by construction, with no report: one record per (app release, outlet) for
  each unyanked app release that pins the pack release and has a build the outlet carries that
  embeds the pack (its `embeds`, or every `baseline: embedded` pack when it says nothing), with
  `detail: {appReleaseId, buildIds}`. The SDK still verifies the marker and hash on the device.
- any other transport: nothing; it is stored and shown "not supported yet".

Every other kind — `app-store`, `testflight`, `play`, `steam`, `itch`, … — shows **nothing until
it is reported**, whatever its transport: every outlet's default transport is `pkey-cdn`, so the
transport alone cannot tell a store from our own CDN.

A stored record wins. A report for (release, build, outlet) replaces the derived record for
that build, and a per-release report replaces every derived record on that outlet — so a CI job
can mark a self-hosted build `removed`.

## Outlet readiness

An app release must not go live on an outlet before its **required pack set** is available
through that outlet's transport (CONTENT §6.4). Distribution computes readiness per
(app release, outlet): the app release's `required` pins and holds, plus the `required` compatible
and standalone packs of the stored pack sets at its contentApi level on every channel it is live
on, for the platforms the outlet serves. Then, per required pack release and its transport there:

| Transport                             | Ready when                                                                                                                |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `embedded`, `play-pad`, `steam-depot` | always: the build carries it                                                                                              |
| `pkey-cdn`, `web`                     | every object its record names is stored and held, and the pack is fetchable (an `entitled` pack with no gate is not)      |
| `apple-ba`                            | a stored availability record on the outlet says `approved` or `live`, for the level's asset pack (`<pack>-c<contentApi>`) |
| `msix-optional`, `flatpak-ext`        | a stored availability record says `approved` or `live`                                                                    |
| anything else                         | never (fail closed)                                                                                                       |

The state is `pending` (the set cannot be computed yet, for example while sets are unresolved),
`blocked` (with the first blocking pack release), `ready` or `overridden`. On an outlet Polaris
Key controls (`direct`, `web`, `altstore`, `altstore-pal`, `obtainium`, `fdroid-repo`,
`app-installer`, `flathub`) a `pending` or `blocked` release is **held**: its `live` records read
`pending`, so the signed feed's per-outlet `live` stays on the previous release and the storefront
feeds skip it. On a store outlet it cannot hold, readiness records the blocker and a **warning**;
hold the release in the store yourself (P5-08 adds connector holds).

The hold is computed on every read, so a new app release is held from its first request.
`dist_readiness` keeps the snapshot the console reads: an availability report refreshes the app
releases it can affect, and the connector cron refreshes all live ones (every state change is
audited as `distribution.readiness.<state>`). The [matrix](/docs/admin/distribution-matrix/) shows each
app release's readiness per cell.

An operator can **override** a hold (`POST …/readiness/<appReleaseId>/<outletId>/override` with a
`reason`, audited as `distribution.readiness.override`). The override survives every recompute
and resync until it is cleared (`…/clear`).

## Submissions

One record per (release, outlet), in `dist_submissions`:

| State                       | Meaning                                                |
| --------------------------- | ------------------------------------------------------ |
| `prepared`                  | the store listing or version exists, not yet submitted |
| `submitted`                 | submitted for review                                   |
| `in-review`                 | under review                                           |
| `approved`                  | approved                                               |
| `rejected`                  | rejected                                               |
| `pending-developer-release` | approved, waiting for a manual release                 |
| `released`                  | released to players                                    |
| `cancelled`                 | withdrawn                                              |

`submittedAt` is set when the record enters `submitted`, `reviewedAt` when it enters `approved` or
`rejected`. Changes are audited as `distribution.submission.report`.

## Reporting from CI

```sh
# Availability of one build (or omit --build for the whole release).
pkey distribution report availability --product your-product --outlet app-store \
  --release v1.4.0 --build ios --state in-review --platform-ref '{"ascBuildId":"abc-123"}'

# By version instead of release id (--deliverable defaults to the app).
pkey distribution report submission --product your-product --outlet app-store \
  --version 1.4.0 --state submitted

# The fingerprint this job signed with.
pkey distribution report key --product your-product --purpose android-app-signing \
  --sha256 "$SIGNING_CERT_SHA256" --outlet play   # colons and upper case are accepted
```

The commands use the same credential as `pkey release publish` — see
[Publishing from CI](/docs/build/ci/). They need the `distribution:report` scope, which the
default grant includes. `--since` (epoch seconds) backdates the state change; without it the
time is now, or unchanged while the state is. `--platform-ref` and `--detail` take a JSON object;
omitting `--platform-ref` keeps the stored one.

Every report is checked before anything is written: the outlet must be one the product declares
(and has not removed), the release and build must exist, and the state must be in the type's
vocabulary. A refused report writes nothing. The route underneath is
`POST /<product>/distribution/report`; refusals use the platform's flat shape with a `reason`
(`unknown_outlet`, `unknown_release`, `unknown_build`, `invalid_state`, `unknown_purpose`,
`invalid_fingerprint`, `invalid_body`; and `too_many_observations` once a product holds 64 key
observations nobody has reviewed).

Reports are **semi-trusted**. A wrong report can make the matrix and feeds show a wrong state, but
it cannot ship code and cannot change a key. A store's connector writes these records too
(`source` is then `asc`, later `play` or `ms-store`). Whichever wrote last wins, and every change
is audited with its writer; a connector re-reads the store on its next poll, so a stale CI report
on a connector-run outlet does not last.

## The key inventory

Per product, the signing keys by **purpose**, each with the lower-case hex SHA-256 fingerprint of
its certificate (of the raw public key for Ed25519):

| Purpose               | Key                                                              |
| --------------------- | ---------------------------------------------------------------- |
| `android-app-signing` | the key Play (or your own pipeline) signs the installed APK with |
| `android-upload`      | the upload key Play verifies uploads against                     |
| `android-sideload`    | the key a sideloaded or Obtainium APK is signed with             |
| `fdroid-repo`         | the self-hosted F-Droid repository's index key                   |
| `sparkle-ed25519`     | the Sparkle EdDSA key macOS updates are signed with              |
| `release`             | the CI release key the signed update feed is signed with         |
| `msix-publisher`      | the MSIX publisher certificate                                   |

The inventory is **operator-owned**. Its fingerprints are what players, the download page,
F-Droid clients and AppVerifier check a download against, which makes it the independent check
on a compromised pipeline: nothing CI says can change it.

- **A CI key report** (`pkey distribution report key`) that matches an entry records, on that
  entry, when and by whom it was last seen. One that matches **no** entry for its purpose is kept
  as an **observation**, flagged, and changes nothing: every entry of that purpose shows
  `flagged`, and the command exits 1 so the job fails visibly. An operator then **adopts** the
  observation (a deliberate rotation becomes an entry) or **dismisses** it.
- **Android developer verification.** Each entry carries a `registered` flag: the operator's record
  that the key is registered with Google for developer verification (enforced regionally from
  2026-09-30). Registration itself happens in Google's console; Polaris Key only records it.

Every operator change is audited (`distribution.key.upsert`, `distribution.key.delete`,
`distribution.key.dismiss`), and every CI report too (`distribution.key.observed`,
`distribution.key.mismatch`).

## The console API

Narrative-only (not in the wire spec), under `/manage/api/products/<slug>/distribution`:

| Method   | Path                                           | Does                                                                                                                                             |
| -------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET`    | `availability?release=<id>`                    | the release on every outlet: stored and derived records, records on removed outlets flagged `outletRemoved`                                      |
| `GET`    | `submissions[?release=<id>]`                   | submission records, newest first                                                                                                                 |
| `GET`    | `keys`                                         | `{ purposes, keys, observations }` — the inventory and the CI observations outside it                                                            |
| `PUT`    | `keys`                                         | `{ purpose, sha256, outlet?, notes?, registered? }` — add or update an entry by purpose and fingerprint (adopting an observation); `null` clears |
| `DELETE` | `keys/<purpose>/<sha256>`                      | remove an entry, or dismiss an observation                                                                                                       |
| `GET`    | `readiness[?release=<id>]`                     | the readiness snapshot, or one app release's readiness computed now, per outlet                                                                  |
| `POST`   | `readiness/refresh`                            | recompute the snapshot                                                                                                                           |
| `POST`   | `readiness/<id>/<outlet>/override` · `…/clear` | `{ reason }` — release the hold (audited), or hand it back to the computation                                                                    |

Availability and submissions are read-only in the console: CI reports them, and store connectors
write them (`source: asc` for App Store Connect).

## Reading it from another service

Distribution's `delivery` descriptor hook answers `availability(releaseId)`,
`submissions(releaseId)` and `keys({ purpose? })` — live outlets only, and the inventory without
observations. With Distribution off the hook is `null` and the report route is not found.

## See also

- [Rollouts and halts](/docs/services/distribution/rollouts/) — the other CI control, with its own
  opt-in scope.
- [Distribution: outlets, transports and listing](/docs/build/manifest/distribution/) — declaring
  the outlets these records are about.
