# P6-03 Update funnel, auto-halt from telemetry, and Sentry integration

| Field       | Value                                                                                                                                                                                                         |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | P6: Commerce, ops, web                                                                                                                                                                                        |
| Size        | 1–1.5 engineer-weeks                                                                                                                                                                                          |
| Depends on  | [P3-03](P3-03-feed-composition.md), [P2b-04](P2b-04-rollouts-delivery.md)                                                                                                                                     |
| Unblocks    | none                                                                                                                                                                                                          |
| Role        | `pkey-implementer`                                                                                                                                                                                            |
| Plan mode   | no, unless the event shape goes into `shared-protocol` without an approved plan (see Design notes)                                                                                                            |
| Gates       | none listed. In practice: a Durable Object binding (`wrangler.toml`), rule 10 or a narrative-only decision for the Sentry hook, `docs/PRIVACY.md`, and the console's help-link tables if a docs page is added |
| Human input | none required; a Sentry organisation with an internal integration (client secret) to try the webhook                                                                                                          |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                     |

## Goal

Update outcomes that devices report (`update_offered`, `update_downloaded`, `update_applied`,
`update_confirmed`, `update_reverted`, `pack_failed`, `boot_rolled_back`) are counted per product,
deliverable, release and outlet. The console shows the funnel offered → downloaded → applied →
confirmed/reverted. When an active self-hosted outlet rollout crosses an operator-set threshold with
enough sample, distribution halts it automatically and says why. A Sentry alert webhook can open a
halt candidate that an operator confirms.

## Why

- "Auto-halt: update's outcome events are aggregated in a Durable Object or Analytics Engine, and
  distribution halts the outlet rollout on a threshold with a minimum sample"
  ([§3.9](../../README.md#39-rollouts-halts-and-telemetry)); the events are listed in
  [§3.6](../../README.md#36-update-what-an-installed-app-should-do-next) ("Telemetry").
- The console's "Update health" surface (funnel, pack failures, auto-halt state) is item 6 of
  [§6.2](../../README.md#62-administrator-operator).
- Boot-guard rollbacks (`boot_rolled_back`) exist so the server can halt a bad rollout
  ([§5.6](../../README.md#56-code-updates-without---main-pack)).

## Read first

- `AGENTS.md`; P2b-04's `dist_rollouts` and its halt path; P3-03's feed composition (halts reach
  devices through the signed feed); P3-01's approved plan (whether it defines the event shape).
- `packages/worker/src/core/devices.ts:855-1000`: the report allowlist `REPORT_KEYS` (unknown keys
  are dropped silently), `boundedReport`, `handleReport` (16 KiB cap; the report is a snapshot
  that overwrites the last one).
- `packages/shared-protocol/src/core.ts:171-190` (`DeviceFacts`, the report's wire type).
- `packages/worker/src/rateLimitDo.ts` and `wrangler.toml` (the existing Durable Object binding);
  `docs/PRIVACY.md`.

## Scope

**In:**

- An allowlisted report key, proposed `updates`: a bounded array (e.g. at most 16) of
  `{eventId, event, deliverable, release, fromRelease?, outlet, channel, packSetId?, at, code?}`
  with strict validation; unknown events dropped.
- Aggregation in a Durable Object, proposed `UpdateHealthDo`, one per (product, deliverable,
  release): windowed counters per outlet and event, deduplicated on `eventId`; a Core accessor
  `readUpdateHealth(...)`.
- Auto-halt in distribution: on a scheduled tick (the connector cron if P5-02 or P5-03 added it,
  otherwise add one in `wrangler.toml` and dispatch on `event.cron`), every `active`, non-mirrored
  rollout is checked against its product's operator-owned policy, off by default, for example
  `{minSample: 200, maxRevertRate: 0.05, maxBootRollbackRate: 0.02, windowHours: 6}`. A trip
  halts through P2b-04's halt path with `source: "auto-halt"` and one audit row naming the
  numbers.
- Admin API for the funnel and the auto-halt state (narrative-only), and a console panel in the
  Distribution section.
- Sentry: a webhook `POST /{product}/distribution/hooks/sentry` (name proposed) verifying
  `Sentry-Hook-Signature` (HMAC-SHA256 of the body with the integration's client secret, stored as
  outlet-credential kind `sentry-integration`), mapping the alert's `release` and tags to a
  rollout, and opening a halt candidate the operator confirms. Document the tags the SDKs should
  set (`release = <deliverable>@<version>+<build>`, `environment = <channel>`, `pkey.outlet`,
  `pkey.packSetId`).
- `docs/PRIVACY.md`: the new telemetry, what it contains and how long it is kept.

**Out** (and where it belongs instead):

- Emitting the events: the Godot updater and packs (P3-10, P4-08) emit them; other SDKs have no
  owner yet (flagged).
- Play-vitals auto-halt (→ [P5-03](P5-03-play-connector.md)); both use the same halt path.
- Halting store outlets: their rollouts are mirrored; a halt there is a connector control, and auto
  halt only raises an alert for them.
- Crash-free rate pulled from Sentry's API into the console (needs a Sentry auth token; not owned).

## Design notes

- **The event names are fixed.** P3-01's approved plan puts the seven `updateEvent` values in
  `conformance/parity/enums.json` (plan §2.10), emitted in every SDK by `gen:constants`. This
  package owns the event shapes, not the names. `installId` for bucketing is the device id.
- **Where the event shape lives.** Every SDK emits these events, so the natural home is
  `DeviceFacts` in `packages/shared-protocol/src/core.ts`, and CLAUDE.md puts every
  `shared-protocol` change in plan mode. It is additive, optional and not a signed document, so
  `PROTOCOL_VERSION` does not change. If P3-01's (or P4-01's) approved plan already defines it,
  implement that. If not, either get a short plan approved by `pkey-wire-planner` first, or follow
  P1-05's precedent for `engine` and `outlet` (Worker allowlist and the OpenAPI report schema only,
  `shared-protocol` untouched) and record the choice in the PR.
- **The report is a snapshot**, not an event log: `handleReport` overwrites `reported`. Count events
  at ingest, deduplicated on `eventId`, so retries do not double-count.
- **Why a Durable Object:** counters need read-your-writes and no external API token; Analytics
  Engine would need an account API token to query. Keep D1 writes off the hot report path.
- **Minimum sample and hysteresis.** Never halt on fewer events than `minSample`; after a halt, do not
  auto-resume.
- **Outlet comes from the event**, validated against the product's outlets; an unknown outlet is
  counted under `unknown` and never triggers a halt.
- **Privacy.** Events carry no hardware values and no user identifiers beyond the device id already
  known to the Worker (AGENTS.md rule 7).

## Steps

1. Settle where the event shape lives (an approved plan, or P1-05's Worker-only precedent).
2. Allowlist key, validation and tests in the report suite.
3. `UpdateHealthDo`, the binding, the Core accessor; tests.
4. Auto-halt evaluation and audit; tests with synthetic counters.
5. Sentry hook and halt candidates; route coverage decision; tests.
6. Admin API, console panel, `PRIVACY.md`.

## Acceptance criteria

- [x] Report tests: valid `updates` are counted once even when the same report is retried; malformed
      entries and unknown events are dropped; the 16 KiB cap still holds.
- [x] Auto-halt tests: below `minSample` nothing happens; above the threshold one halt and one audit
      row; a mirrored store rollout is never halted by this path.
- [x] Sentry hook tests: bad signature refused; a valid alert for a known release opens one
      candidate; confirming it halts.
- [x] The Sentry route is in OpenAPI and `routeCoverage`, or listed narrative-only with a reason.
- [x] `PRIVACY.md` describes the events.
- [x] The green gate passes (`AGENTS.md`), including `test:workerd`.

## Corrections from implementation

Where the code disagreed with this brief, the code won:

- **Event shape: P1-05's precedent.** P3-01's plan (§2.10) fixes only the seven names; no plan
  defines the shape. The `updates` key is in the Worker allowlist (`core/devices.ts`
  `REPORT_KEYS`, bounded by `core/updateHealth.ts` `boundedUpdates`) and the OpenAPI report
  schema (`UpdateOutcomeEvent`) only; `shared-protocol`'s `DeviceFacts` is untouched, so no plan
  mode. The Worker has no generated `updateEvent` constant, so `UPDATE_EVENTS` is spelled once in
  `core/updateHealth.ts` and pinned to `enums.json` by `test/updateHealth.test.ts`.
- **No migration (0046 is unused).** The auto-halt settings use P5-03's `dist_connector_settings`
  (connector `auto-halt`), and halt candidates, trips, store alerts and the last reading use
  P5-02's `dist_connector_objects` (connectors `sentry` and `auto-halt`); Sentry deliveries are
  stored in `dist_connector_events`. `dist_rollouts.source` already admitted `auto-halt` (0038).
- **The auto-halt judges distinct devices, not raw events.** Counters are deduplicated on
  (device, `eventId`) as asked, and the object also keeps distinct-device counts per event; the
  rates are `update_reverted` and `boot_rolled_back` devices over `update_applied` devices, and
  `minSample` is applied devices. One device can move a rate by at most one.
- **Unknown outlets** are not validated at ingest (that needs Distribution's tables on Core's
  report path). They are counted as reported; a rollout row's outlet is always a declared one, so
  they can never match a rollout or trip, and the console sums them as `unknown`. Each object
  caps the (outlet, channel) pairs it tracks at 32, folding the rest into an overflow bucket.
- **Halt-only is enforced in `applyRollout`.** A third `RolloutActor` kind, `system`, is refused
  every verb but `halt` (`system_halt_only`); its halt records `source: auto-halt`,
  `updated_by: system:auto-halt` and the numbers in the one audit row.
- **Trips once.** A `trip` marker per (deliverable, outlet, channel, release) stops a second halt
  after an operator resumes (P5-03's vitals behaviour). A mirrored store rollout over the
  threshold gets an `alert` marker and one `distribution.auto_halt.alert` audit row.
- **The Sentry hook is not a store connector.** It is routed explicitly in `routes.ts`
  (`/distribution/hooks/sentry`) rather than added to `CONNECTORS`, so it has no poll, no
  controls and no entry in the connectors list. Only `Sentry-Hook-Resource: event_alert` with
  `action: triggered` is acted on (it is the resource that carries the event's `release`, `environment` and
  tags); everything else is stored as `ignored`. Dedupe is on the body's SHA-256.
- **Console**: a new **Update health** tab in the Distribution section (`distribution-health`,
  docs `/docs/services/distribution/update-health/`), not a panel on the overview; the admin
  API is `…/distribution/update-health` (narrative-only).
- **`UPDATE_HEALTH` is optional in `Env`.** Unbound, reports still store `updates` and nothing is
  counted; the funnel reports `counting: false` and the auto-halt judges nothing.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- report updateHealth autoHalt sentry
mise exec node@22 -- pnpm --filter @polaris-key/worker test:workerd
```

## Hand-off

- `readUpdateHealth` and the funnel admin API for console work; the auto-halt source value
  `auto-halt` on `dist_rollouts`.
- The Sentry tagging convention for SDK docs.
- Set the status: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P6-03 done`.
