# P5-03 Google Play connector: tracks, staged rollout, halt, update priority, Reporting API

| Field       | Value                                                                                                                                                                                                                    |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase       | P5: Distribution connectors and native plugins                                                                                                                                                                           |
| Size        | 1.5–2 engineer-weeks                                                                                                                                                                                                     |
| Depends on  | [P5-01](P5-01-outlet-credentials.md), [P2b-03](P2b-03-availability-keys.md)                                                                                                                                              |
| Unblocks    | [P6-01](P6-01-commerce-bridge.md)                                                                                                                                                                                        |
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
- **Reporting API names are unverified** (metric-set and metric names, notes/E2 §A1). Confirm them
  (S-07 row 17) before writing `vitals.ts`, and keep the fixtures in step.
- **Quota:** 3,000 queries a minute per bucket; the poller is far below it, but back off on 429.
- **Dependency gap.** Mirrored rollouts live in P2b-04's `dist_rollouts`, which is not a declared
  dependency. If it has not landed, guard the mirror and say so in the PR.
- **Threat model:** a stolen service-account key can change rollouts for the one app it is invited
  to; scope it there and to release permissions only.

## Steps

1. Fixtures for `edits.insert`, `tracks.list`, `tracks.patch`, `edits.commit`, `edits.delete`, the
   token endpoint and one Reporting API query.
2. Client, poller, mapping; tests.
3. Controls with audit; confirmation for halting a completed release.
4. Vitals auto-halt behind the operator setting.
5. Threat model and operator docs.

## Acceptance criteria

- [ ] `pnpm --filter @polaris-key/worker test -- play` covers: mapping of all four `status` values;
      `userFraction` 0.05 → 500 bp; a track release naming two version codes; an unknown internal
      track id read from `tracks.list`; an edit invalidated mid-poll (the poll retries next tick,
      writes nothing partial); 429 backoff.
- [ ] Each control sends the documented PATCH and commit to the fake server, writes one audit row
      and re-reads state; setting priority on a release already rolling out is refused.
- [ ] With the vitals setting off, no Reporting API call is made; with it on, a rate over the
      threshold with enough sample halts once and audits once.
- [ ] The credential is reached only through `openOutletCredential`.
- [ ] The threat model covers the key; operator docs describe the least-privilege setup.
- [ ] The green gate passes (`AGENTS.md`), including `test:workerd`.

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
