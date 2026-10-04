---
sidebar:
  order: 6
title: "Google Play connector"
description: "How Distribution follows a product's Google Play tracks — a throwaway edit read on the 15-minute connector cron, availability by version code, staged rollouts mirrored as outlet rollouts — and the operator controls: rollout fraction, halt, resume, complete, the in-app update priority, and the opt-in vitals auto-halt."
---

For a product that ships on Google Play, Distribution can follow every Play track instead of
waiting for CI to report it. The **Google Play connector** reads the Google Play Developer API
with the product's service account and keeps three things current:

- **availability** of each release's Android builds on your `play` and `play-testing` outlets
  (see [Availability, submissions and keys](/docs/services/distribution/availability/)), written
  with `source: play`;
- each track's **staged rollout** (`userFraction`, halted or not), mirrored as an outlet rollout
  (see [Rollouts and halts](/docs/services/distribution/rollouts/#store-rollouts));
- the **in-app update priority** (`inAppUpdatePriority`, 0–5) of every release, which the
  Android plugin's In-App Updates flow reads.

It never uploads a bundle, assigns a build to a track for the first time, or uses internal app
sharing. Those stay with CI and Google's tools. Play has no release or review webhooks, so the
connector reads on the connector cron (every 15 minutes) and after every control.

## Setting it up

The connector runs for a product when all of these hold:

1. **Distribution is on**, and `.pkey/distribution` declares a `play` (or `play-testing`) outlet
   whose identity carries the Android package name and a **track map** — your channel on the
   left, Play's track id on the right:

   ```yaml
   outlets:
     play:
       packageName: gg.acme.dice
       tracks:
         stable: production
         beta: beta
     play-internal:
       kind: play-testing
       packageName: gg.acme.dice
       tracks:
         internal: qa
   ```

   Write the internal-testing track id exactly as Play lists it — some apps have `internal`,
   others `qa`. The connector never assumes one: it reads the track ids from Play and shows any
   track your map does not name (as **unmapped**) without writing anything for it. A Play outlet
   naming another package is ignored; the connector serves one app per product.

2. A **`google-service-account` outlet credential** is stored on the Secrets tab — the service
   account's JSON key file — **pinned** to this product's app: the same package name as the
   `packageName` above (see [Pinning the app](#pinning-the-app)). See
   [Outlet credentials](/docs/admin/secrets-and-keys/#outlet-credentials). A credential bound to
   one of the Play outlets (`outletId`) is preferred over an unbound one.

3. **The first release is made by hand** in Play Console. Google requires the first bundle of a
   new app to be uploaded there before the API can manage it.

Without the credential, without a Play outlet, or with a credential that is not pinned to the
outlet's package, the connector does not run for the product: the poller skips it and every
control is refused. `GET …/distribution/connectors/play` says why in `inert` (`no_outlet`,
`no_credential`, `pin_missing` or `pin_mismatch`, with a sentence on what to do).

**The platform's team key.** A product with no `google-service-account` of its own falls back to the platform's
team-level credential for this store, only for the app a platform admin assigned to the product
(the same `pin_missing` / `pin_mismatch` reasons, with `credentialSource: "platform"`). A key of
the product's own always wins. See [Store connections](/docs/admin/store-connections/).

### Least privilege for the service account

A stolen service-account key can change rollouts for every app it is invited to, so give it as
little as works:

- Create a **dedicated** service account in Google Cloud for this product. It needs no Cloud
  roles at all.
- In Play Console → **Users and permissions**, invite its email to **this one app only** — never
  at the account level.
- Grant **Release to production, exclude devices, and use Play App Signing** and **Release apps
  to testing tracks**, plus **View app information (read-only)** if you turn on the vitals
  auto-halt (the Reporting API needs it). Nothing financial, nothing about users or orders.
- Keep CI's upload key separate from this account if you want uploads and rollout control apart.
- To rotate, create a new key in Google Cloud, store it under the same credential id (cached
  tokens drop with the old value), then delete the old key in Google Cloud.

## Pinning the app

A service account can be invited to more than one app in your Play developer account, and its
controls can change any of them. The app the connector works on is named by the `packageName` in
`.pkey/distribution`, and every resync takes that from the repo. Without a pin, whoever can push
that file could point your service account — and the rollout controls, a halt that rolls a
completed release back among them, and the vitals auto-halt — at another app it can see.

So the credential carries a **pin** that only a platform admin sets: the package name it may be
used for in this product. The connector runs only while the manifest's `packageName` equals the
pin.

- **Set it with the key.** The Secrets tab asks for the package name with the key file. Over the
  API, send it as `pin`:

  ```http
  PUT /manage/api/products/<slug>/outlet-credentials/play
  {"kind": "google-service-account", "value": { …the JSON key file… }, "pin": "gg.acme.dice"}
  ```

- **Re-pin without the key.** The pin icon on the credential's row, or a `PUT` with the pin and no
  value: `{"kind": "google-service-account", "pin": "gg.acme.dice"}`. The key itself, its cached
  tokens and its health are untouched. Rotating the key without a `pin` keeps the old one.
- **Every change is audited** as `outlet_credential.pin`, with the old and the new package name.
- **A credential stored without a pin does nothing** (`pin_missing`); so does one stored before
  the connector required pins. Pin it before you expect the connector to run.

If the manifest's `packageName` changes — a new app, a typo, or someone pointing the product at
another app — the connector stops (`pin_mismatch`): no reads, no mirroring, no vitals check, every
control (`settings` too) refused with `409 credential_pin_mismatch` before any token is minted or
request sent. It stays stopped until the manifest names the pinned package again, or until you
**check that the new package really is this product's app** and re-pin. The pin is checked on the
credential the connector chooses (one bound to a Play outlet before an unbound one); another
credential's pin never stands in for it. Inviting the account to one app only ([above](#least-privilege-for-the-service-account)) is still
the best protection if the key is ever stolen.

## What it reads

Every tick opens a **throwaway edit**, lists its tracks, and deletes it:

```http
POST   /androidpublisher/v3/applications/{packageName}/edits
GET    /androidpublisher/v3/applications/{packageName}/edits/{editId}/tracks
DELETE /androidpublisher/v3/applications/{packageName}/edits/{editId}
```

A fresh edit is a copy of what Play serves now, so that is the truth for every track. Edits are
fragile — Play allows one open edit per user, and a new edit, a change in Play Console or another
commit invalidates the open ones — so the connector never holds one open between requests, and
a read that fails (an edit invalidated mid-read, rate limiting) **writes nothing**: the next tick
reads again. A 429 is retried with backoff.

## How Play maps

A track release names one or more **version codes**. Each one is matched to the release build
whose build number is that version code (platform `android`), so give each Android build its
`buildNumber` in your release descriptor. A release with two version codes (an arm64 and an armv7
build, say) makes both builds available.

| Play status  | Availability | Outlet rollout                  |
| ------------ | ------------ | ------------------------------- |
| `inProgress` | `live`       | `active`, at `userFraction`     |
| `halted`     | `approved`   | `halted`                        |
| `completed`  | `live`       | `complete` (10000 basis points) |
| `draft`      | `pending`    | none — nothing is served        |

`userFraction` becomes basis points: 0.05 is 500. A build on several tracks of one outlet takes
the most-served state. A build the connector reported before that no track of the outlet carries
any more becomes `removed`. A version code no release build carries is shown on the track,
unresolved, and writes nothing.

Each mapped (outlet, channel) mirrors its track's staged release (or, with none, its completed
release) as a rollout row marked `mirrored`, which refuses direct edits; change it with the
controls below. The mirror informs the feed and the console — users who already have a halted
release keep it, and a staged rollout is applied by Play, not by Polaris Key.

## Controls

In the console API, under `/manage/api/products/<slug>/distribution/connectors/play/`:

| `POST`             | Body                                                    | What it changes                                                         |
| ------------------ | ------------------------------------------------------- | ----------------------------------------------------------------------- |
| `rollout/fraction` | `{ track, versionCode \| releaseId, userFraction }`     | sets `userFraction` (0 < f < 1); on a draft, **starts** the rollout     |
| `rollout/halt`     | `{ track, versionCode \| releaseId, confirmRollback? }` | `inProgress` → `halted`                                                 |
| `rollout/resume`   | `{ track, versionCode \| releaseId }`                   | `halted` → `inProgress`                                                 |
| `rollout/complete` | `{ track, versionCode \| releaseId }`                   | `inProgress` → `completed` (everyone)                                   |
| `priority`         | `{ track, versionCode \| releaseId, priority? }`        | `inAppUpdatePriority` on a release that has **not started** rolling out |
| `settings`         | `{ priority?, vitals? }`                                | the priority default and the vitals auto-halt (below)                   |

Each rollout control and `priority` is **one edit**: it reads the track, sends the track's
releases back with only that release changed, and commits with
`changesInReviewBehavior=ERROR_IF_IN_REVIEW` — so a change that would cancel a review in
progress is refused, never forced. It is audited once as `distribution.play.<verb>` with your
identity, then the connector reads a fresh edit: the answer, and the mirror, are what Play says
afterwards. Play can take a while to propagate a commit; the mirror catches up on later ticks. If
Play refuses, the answer is `store_refused` with Google's HTTP status.

Two rules need your attention:

- **The in-app update priority cannot change once a rollout starts.** Set it on a draft with
  `priority`, or let `rollout/fraction` set it when it starts the draft's rollout. On a release
  already rolling out, `priority` answers `priority_locked`.
- **Halting a completed release rolls the track back** to the previously completed release.
  `rollout/halt` on a completed release answers `confirmation_required` until you send
  `confirmRollback: true`.

### Priority policy

When a draft starts rolling out without a priority, the connector picks one: **5** if Release marks
the channel `critical`, **4** if the channel's floor (`minSupported`) is above the version the track
serves now, otherwise your **default** (`settings` → `priority.default`, 0 unless you set it). An
explicit `priority` in the request, or one already on the draft, wins.

## Vitals auto-halt

Off by default. Turn it on with `settings`:

```json
{
  "vitals": {
    "enabled": true,
    "metric": "user-perceived",
    "windowHours": 24,
    "minDistinctUsers": 1000,
    "crashRateThreshold": 0.02,
    "anrRateThreshold": 0.01
  }
}
```

While it is on, each tick that finds a staged (`inProgress`) release on a mapped track reads the
Play Developer Reporting API's crash and ANR rate metric sets — hourly, by version code, over the
last `windowHours` Google has data for. `user-perceived` reads `userPerceivedCrashRate` and
`userPerceivedAnrRate` (Play's own bad-behaviour basis); `all` reads `crashRate` and `anrRate`.
Thresholds are fractions of users (0.02 is 2 %). A release whose rate, weighted across its version
codes, is above a threshold over at least `minDistinctUsers` user-hours is **halted** through the
same path as `rollout/halt`, audited once as `distribution.play.halt` by `connector:play-vitals`
with the reading. A release trips **once**: resuming it is your decision, and the auto-halt does
not fight it. With the setting off, the connector makes no Reporting API call at all.

## Security

- The connector calls only `androidpublisher.googleapis.com` and
  `playdeveloperreporting.googleapis.com`, for the one package your outlet names and your pin
  allows; nothing in a response can redirect it, and a manifest naming another package stops it
  ([Pinning the app](#pinning-the-app)).
- The service-account key never leaves custody: the connector uses short-lived access tokens
  minted from it (one per API scope), every open of the key is in the activity log, and errors
  record an HTTP status, never a response.
- Nothing a repo pushes can turn on the auto-halt or change the priority policy: both are
  operator settings, and every change is audited.

The full analysis is in the threat model (`docs/security/THREAT-MODEL.md`, "Store connectors:
Google Play").
