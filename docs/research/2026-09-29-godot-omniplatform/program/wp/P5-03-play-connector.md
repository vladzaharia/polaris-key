# P5-03 Google Play connector: tracks, staged rollout, halt, update priority, Reporting API

| Field       | Value                                                                                                                                                                                                                    |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase       | P5: Distribution connectors and native plugins                                                                                                                                                                           |
| Size        | 1.5–2 engineer-weeks                                                                                                                                                                                                     |
| Depends on  | [P5-01](P5-01-outlet-credentials.md), [P2b-03](P2b-03-availability-keys.md), [P2b-04](P2b-04-rollouts-delivery.md), [S-07](S-07-policy-recheck.md)                                                                       |
| Unblocks    | [P5-08](P5-08-platform-pack-transports.md), [P6-01](P6-01-commerce-bridge.md)                                                                                                                                            |
| Role        | `pkey-implementer`                                                                                                                                                                                                       |
| Plan mode   | no                                                                                                                                                                                                                       |
| Gates       | threat model; the shared connector cron in `wrangler.toml`; `test:workerd`. No public route, so no rule 10 change                                                                                                        |
| Human input | a Play service-account JSON key (Google Cloud service account invited in Play Console with release permissions on this app only); the package name and track map in `.pkey/distribution`; the first release made by hand |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                |

## Goal

For a product whose `.pkey/distribution` declares a `play` outlet and whose operator has stored a
`google-service-account` outlet credential, distribution mirrors every Play track (release version
codes, `status`, `userFraction`, `inAppUpdatePriority`) into availability and outlet rollouts, and
lets an operator ramp, halt, resume and complete a staged rollout and set the in-app update
priority. An opt-in auto-halt reads crash and ANR rates from the Play Developer Reporting API. It is
all built against recorded responses and a fake Google API before a real key exists.

## Why

- Play has no review or release webhooks; the only way to know what is live per track is to read a
  fresh edit (notes/E2 §A1, "Tracks"). Report
  [§3.8](../../README.md#38-distribution-distribution-service), Google Play.
- Staged rollout and halt are distribution's outlet rollouts for store outlets, mirrored from and
  controlled through the connector ([§3.9](../../README.md#39-rollouts-halts-and-telemetry)).
- `inAppUpdatePriority` (0–5) is what the Android plugin's In-App Updates flow keys on (notes/E2
  §E2; [P5-06](P5-06-kotlin-aar.md)).
- The commerce bridge reuses this connector's Google client and credential ([P6-01](P6-01-commerce-bridge.md)).

## Read first

- `AGENTS.md`; the hand-offs of P5-01 (`googleAccessToken`, `openOutletCredential`) and P2b-03
  (availability writer, state enum); P5-02's `connectors/index.ts` if it has landed.
- notes/E2 §A1 (edits workflow, tracks, status enum, staged-rollout payloads, quotas, the
  "one open edit per user" constraint) and §E2 (priority policy), §F item 3.
- `packages/worker/src/scheduled.ts`, `src/index.ts:59-65`, `wrangler.toml` `[triggers]`.
- `src/services/release/githubApp.ts` for the `FetchImpl` and backoff pattern.

## Scope

**In:**

- `services/distribution/connectors/play/`: `client.ts` (base
  `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/{packageName}/`, scope
  `https://www.googleapis.com/auth/androidpublisher`), `poll.ts`, `map.ts`, `controls.ts`,
  `vitals.ts`. Registers with `connectors/index.ts` (create it as P5-02 describes if absent).
- Reading state with a throwaway edit: `edits.insert` → `edits.tracks.list` → `edits.delete`, on the
  shared connector cron. Never hold an edit open between requests.
- Mapping: each track release → availability of the builds whose `versionCode` equals
  `release_builds.build_number` (platform `android`); track → channel through the manifest's
  `play.tracks` map (e.g. `stable: production`, `beta: beta`); `userFraction` → `rollout_bp`
  (`round(f × 10000)`); `status` → rollout state (`inProgress` → `active`, `halted` → `halted`,
  `completed` → `complete`, `draft` → not served).
- Controls in distribution's `adminHandle`, each one edit: set `userFraction`, halt, resume,
  complete, and set `inAppUpdatePriority` on a release that has not started rolling out. Commit with
  `changesInReviewBehavior=ERROR_IF_IN_REVIEW`. Audited; re-read afterwards.
- Priority policy, operator-owned: `critical` → 5, a raised floor → 4, otherwise a default
  (0 unless set).
- Opt-in auto-halt from the Play Developer Reporting API: crash and ANR rate per `versionCode` over
  a window, with a minimum sample and a threshold, operator-owned and off by default. A trip halts
  through the same control path with `source: "play-vitals"` and one audit row.
- Recorded fixtures under `packages/worker/test/fixtures/play/` and a fake API and token endpoint.

**Out** (and where it belongs instead):

- `edits.bundles.upload`, track assignment of new builds, and internal app sharing: CI with vendor
  tools (report §3.4, "Vendor CLIs do the store uploads").
- RTDN, purchases and acknowledgement (→ [P6-01](P6-01-commerce-bridge.md)); Play Integrity
  (→ [P6-02](P6-02-trust-tiers.md)).
- Telemetry-driven auto-halt (→ [P6-03](P6-03-update-funnel-autohalt.md)); this package only adds
  the Play-vitals trigger. Both use one halt path.
- Android developer verification through the Developer Console API (it needs a per-maintainer OAuth
  grant, not a service account; notes/E2 §B1). No work package owns it yet.

## Design notes

- **Edits are fragile.** One open edit per user; a new edit, a Console change or another commit
  invalidates open edits; commits can take hours to propagate. Reads must tolerate a missing edit;
  controls must re-read state after commit and never assume the change is live.
- **`inAppUpdatePriority` cannot change after rollout starts.** Set it only when starting a rollout;
  the console must say so.
- **Halting a `completed` release rolls back** to the previously completed release (notes/E2 §A1).
  The control asks for explicit confirmation in that case.
- **Track ids.** `production`, `beta`, `alpha` and custom names are documented; the internal track
  may be `internal` or `qa`. Read the ids from `tracks.list`; never hard-code the internal one.
- **Reporting API names are verified** ([notes/S-07-policy-recheck](../../notes/S-07-policy-recheck.md) row 17, read from the v1beta1 discovery document,
  revision 20260928): singleton resources `apps/{app}/crashRateMetricSet` and
  `apps/{app}/anrRateMetricSet` (`vitals.crashrate` and `vitals.anrrate`, methods `get` and `query`);
  metrics `crashRate`, `crashRate7dUserWeighted`, `crashRate28dUserWeighted`,
  `userPerceivedCrashRate` (plus the two weighted variants) and `distinctUsers`, and the same set
  with `anr` for ANRs; dimensions include `versionCode`; scope
  `https://www.googleapis.com/auth/playdeveloperreporting`; DAILY is `America/Los_Angeles`, HOURLY
  is `UTC` and has no weighted metrics. Keep the fixtures in step, and re-run
  `prototype/policy-recheck/recheck.mjs --rows 17` at the start of the package.
- **Quota:** 3,000 queries a minute per bucket; the poller is far below it, but back off on 429.
- **Dependency gap.** Mirrored rollouts live in P2b-04's `dist_rollouts`, which is not a declared
  dependency. If it has not landed, guard the mirror and say so in the PR.
- **Threat model:** a stolen service-account key can change rollouts for the one app it is invited
  to; scope it there and to release permissions only.

## Corrections recorded during implementation (P5-03)

The code was the fact; these are where it, or a decision the brief left open, differs from the
text above.

- **Shared connector plumbing came from P5-02, not from main.** P5-02's `connectors/index.ts`,
  `connectors/state.ts`, `mirrorRollout` (`rollouts.ts`), the `AvailabilityWriter`
  (`availability.ts`), the registry `scheduled` hook and the connector cron were not on main when
  this package started; the branch merges `wp/P5-02-app-store-connect` and registers `play` in its
  `CONNECTORS` rather than creating a second set. The dependency gap the brief names
  (`dist_rollouts`) does not exist: P2b-04 is on main.
- **Operator settings need a table.** The priority default and the vitals settings are
  operator-owned and must survive every push, so they live in a new `dist_connector_settings`
  (migration 0042, `TABLE_OWNERS.distribution`, data-model page regenerated) behind
  `connectors/settings.ts`. The brief's gate list did not name the migration.
- **Availability of a halted release is `approved`, a draft `pending`.** The brief maps status
  only onto rollout state; for availability, `inProgress`/`completed` are `live`, `halted`
  (reviewed, served to no one new) `approved`, `draft` `pending`, and a build no track of the
  outlet carries any more `removed`.
- **Controls live under the connectors admin route P5-02 added:**
  `POST …/distribution/connectors/play/{rollout/fraction,rollout/halt,rollout/resume,rollout/complete,priority,settings}`,
  each rollout control taking `{track, versionCode | releaseId, …}`. A PATCH sends the track's
  releases as read with only the target changed (Play replaces the array); `complete` drops the
  previously completed release.
- **"A raised floor" is read as** Release's channel `minSupported` above the version the track
  serves now (its completed release); `critical` is the channel policy's flag.
- **The Reporting window is HOURLY.** HOURLY is UTC and has no weighted metrics (row 17), so the
  rate is the user-weighted mean of hourly rates across the release's version codes, and the
  minimum sample counts user-hours (Google warns `distinctUsers` does not add across periods).
  Thresholds compare with Google's decimal as a fraction of users — confirm on the first real
  read. Row 17 re-ran PASS at the start of the package (discovery revision now 20260930).
- **The service account is pinned to the package (P5-02f's pin).** The brief let the manifest's
  `packageName` alone choose the app; the account is operator-owned and may see several apps, so a
  repo writer could have aimed the controls and the vitals auto-halt at another app. After the
  merge of main (P5-02f), `google-service-account` is in `OUTLET_CREDENTIAL_PINS` (field
  `packageName`), `resolvePlaySetup` checks the pin before anything opens, and a missing or
  different pin leaves the connector inert: every control (`settings` too) answers 409
  `credential_pin_missing` / `credential_pin_mismatch`, the poll skips, the status shows `inert`.
  The console form requires the package name; `test/playPin.test.ts` covers it. Connector
  migrations renumbered on main: `dist_connector_*` is 0041, this package's settings stay 0042.
- **Fixtures are recorded-shape, not recorded.** No Play account exists; `test/fixtures/play/`
  holds payloads in the documented shapes, labelled as such, to re-record with the first real key.

## Steps

1. Fixtures for `edits.insert`, `tracks.list`, `tracks.patch`, `edits.commit`, `edits.delete`, the
   token endpoint and one Reporting API query.
2. Client, poller, mapping; tests.
3. Controls with audit; confirmation for halting a completed release.
4. Vitals auto-halt behind the operator setting.
5. Threat model and operator docs.

## Acceptance criteria

- [x] `pnpm --filter @polaris-key/worker test -- play` covers: mapping of all four `status` values;
      `userFraction` 0.05 → 500 bp; a track release naming two version codes; an unknown internal
      track id read from `tracks.list`; an edit invalidated mid-poll (the poll retries next tick,
      writes nothing partial); 429 backoff.
- [x] Each control sends the documented PATCH and commit to the fake server, writes one audit row
      and re-reads state; setting priority on a release already rolling out is refused.
- [x] With the vitals setting off, no Reporting API call is made; with it on, a rate over the
      threshold with enough sample halts once and audits once.
- [x] The credential is reached only through `openOutletCredential`.
- [x] The threat model covers the key; operator docs describe the least-privilege setup.
- [x] The green gate passes (`AGENTS.md`), including `test:workerd`.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- play scheduled
mise exec node@22 -- pnpm typecheck
mise exec node@22 -- pnpm --filter @polaris-key/worker test:workerd
```

With a real key (human): store the credential, move an internal-track release to 5 %, halt it,
resume it, and check the mirror after each step.

## Hand-off

- `connectors/play/client.ts` (authenticated Android Publisher client) for P6-01's purchase
  verification and acknowledgement.
- Mirrored Play rollouts and priorities in distribution, which the signed feed (P3-03) and the
  Android plugin's update flow (P5-06) read; the single halt path P6-03 reuses.
- Set the status: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P5-03 done`.
