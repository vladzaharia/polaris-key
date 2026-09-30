# P5-02 App Store Connect connector: webhooks, TestFlight, phased release, Background Assets states

| Field       | Value                                                                                                                                                                                                            |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | P5: Distribution connectors and native plugins                                                                                                                                                                   |
| Size        | 2 engineer-weeks                                                                                                                                                                                                 |
| Depends on  | [P5-01](P5-01-outlet-credentials.md), [P2b-03](P2b-03-availability-keys.md), [P2b-04](P2b-04-rollouts-delivery.md), [S-07](S-07-policy-recheck.md)                                                               |
| Unblocks    | [P5-08](P5-08-platform-pack-transports.md), [P6-01](P6-01-commerce-bridge.md)                                                                                                                                    |
| Role        | `pkey-implementer`                                                                                                                                                                                               |
| Plan mode   | no                                                                                                                                                                                                               |
| Gates       | rule 10 (OpenAPI + `routeCoverage` + regenerated routes page); threat model; `wrangler.toml` cron trigger; `test:workerd`                                                                                        |
| Human input | an App Store Connect **team** API key with the App Manager role (`.p8`, key id, issuer id); the ASC webhook secret (or let the connector register the webhook); the app's Apple ID and bundle id in the manifest |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                        |

## Goal

For a product whose `.pkey/distribution` declares `app-store` or `testflight` and whose operator has
stored an `asc-api-key` outlet credential, the `distribution` service knows the App Store and
TestFlight state of every build and version: build processing, internal and external TestFlight,
app-version state, phased release and Background Asset version states. Signed ASC webhooks drive it,
and a poller covers what has no webhook. An operator can pause, resume or complete a phased release,
release a `PENDING_DEVELOPER_RELEASE` version, and toggle a public TestFlight link. All of it is
built and tested against recorded payloads and a fake ASC server before any real key exists.

## Why

- Store state is the missing half of availability: "is it in the App Store yet" has no answer today,
  and the iTunes lookup API is undocumented for `bundleId` and lags by hours (notes/E1 §A2). The
  report makes Polaris Key's availability record authoritative, fed by webhooks
  ([§3.8](../../README.md#38-distribution-distribution-service), App Store Connect).
- Phased release must be mirrored so the signed feed and the console agree with Apple
  ([§3.9](../../README.md#39-rollouts-halts-and-telemetry)).
- Background Asset states are the availability of `apple-ba` packs and the input to readiness holds
  ([CONTENT §7](../../CONTENT.md#7-transports), README §3.7).
- Decision 7 in [§11](../../README.md#11-decisions-needed): read-only state first, controls second,
  uploads never.

## Read first

- `AGENTS.md`; this brief's dependencies' hand-offs (P5-01 accessor and `ascToken`; P2b-03's
  availability and submission writers and state enum).
- [S-07](S-07-policy-recheck.md) rows 4, 6 and 16 (Apple terms, guidelines, ASC API facts), read in
  [notes/S-07](../../notes/S-07.md) (re-checked 2026-09-30: all three unchanged; exactly 12 `WebhookEventType`s, up to
  ten webhooks per app, API 4.5 latest listed, 200 GB and 200 asset packs). Re-run them with
  `prototype/policy-recheck/recheck.mjs --rows 4,6,16` if more than a month has passed.
- notes/E1 §A1 (endpoints, the 12 `WebhookEventType`s, `x-apple-signature`, payload envelope,
  gaps, rate limits) and §E5 (Background Asset versions and states).
- `packages/worker/src/githubWebhook.ts`: HMAC check (`verifySignature`, line 58) and delivery
  dedupe in KV (`DELIVERY_TTL_SECONDS`, line 16). Copy the pattern.
- `src/services/release/githubApp.ts` (`FetchImpl` injection at line 30; `backoffMillis` and
  `isRateLimited` at 273-298).
- `src/scheduled.ts` and `src/index.ts:59-65` (`scheduled()` ignores `event.cron` today);
  `wrangler.toml` `[triggers]` (one daily cron).
- `packages/worker/openapi/polaris-key.v3.yaml`, `test/routeCoverage.test.ts`.

## Scope

**In:**

- `services/distribution/connectors/asc/`: `client.ts` (base URL fixed to
  `https://api.appstoreconnect.apple.com/`, JSON:API paging, `X-Rate-Limit` parsing, 429 backoff),
  `webhook.ts`, `map.ts`, `poll.ts`, `controls.ts`.
- `services/distribution/connectors/index.ts` with a `DistributionConnector` interface
  (`kind`, `poll(ctx)`, optional `webhook(ctx)`, `controls`). If P5-03 or P5-04 created it first,
  reuse theirs.
- Webhook route `POST /{product}/distribution/hooks/asc` (name proposed): HMAC over the raw body,
  constant-time compare, dedupe on `data.id` (7 days in KV), 2xx fast, then fetch the instance with
  the API and write state. Unknown event types answer 204 and are logged.
- Mapping of all 12 event types (below), of `AppVersionState` and the legacy `AppStoreVersionState`,
  of `internalBuildState`/`externalBuildState`, and of Background Asset version states.
- Poller on a new cron (e.g. `*/15 * * * *`), dispatched on `event.cron` in `scheduled.ts`: phased
  release (`appStoreVersionPhasedReleases`: `phasedReleaseState`, `currentDayNumber`), review
  submissions, internal TestFlight, and reconciliation of webhook-driven objects.
- Phased release mirrored into `dist_rollouts` (`mirrored = 1`, `source = "asc"`), day → basis
  points by Apple's schedule 1, 2, 5, 10, 20, 50, 100 %.
- Controls in distribution's `adminHandle`: phased release pause/resume/complete
  (`PATCH …/appStoreVersionPhasedReleases/{id}`), release a held version
  (`POST /v1/appStoreVersionReleaseRequests`), public TestFlight link on/off (`betaGroups`).
  Each is audited and re-reads state afterwards.
- A "register webhook" admin action: generate a secret, store it as `asc-webhook-secret`, call
  `POST /v1/webhooks` for the app with the event types, then `POST /v1/webhookPings`.
- Recorded fixtures under `packages/worker/test/fixtures/asc/` and a fake ASC server.

**Out** (and where it belongs instead):

- Uploading builds or asset packs (CI and vendor tools; asset-pack upload → [P5-08](P5-08-platform-pack-transports.md)).
- Creating review submissions ("submit" in §3.8's control list): not in this package; propose it as
  a follow-up once read-only state has run for a while.
- Mapping an asset-pack id to a pack release, and retiring asset packs (→ P5-08); readiness holds
  themselves (→ [P4-14](P4-14-readiness-gc-rollouts.md)).
- App Store Server Notifications and in-app purchases (→ [P6-01](P6-01-commerce-bridge.md)).
- `ALTERNATIVE_DISTRIBUTION_*` events beyond storing them raw (AltStore PAL is P2b-05's source).
- Console rendering beyond what P2b-06's matrix shows from availability rows.

## Design notes

- **Webhook is a hint; the API GET is truth.** Payloads are thin, delivery is at least once and can
  be redelivered by hand. Background-asset events carry `relationships.instance` without a `data`
  wrapper (notes/E1 §A1); parse both shapes.
- **Event handling** (types are exact):

  | Event                                                                                                                                                     | Effect                                                            |
  | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
  | `APP_STORE_VERSION_APP_VERSION_STATE_UPDATED`                                                                                                             | availability and submission of the app release on `app-store`     |
  | `BUILD_UPLOAD_STATE_UPDATED`                                                                                                                              | build processed (link `version` to `release_builds.build_number`) |
  | `BUILD_BETA_DETAIL_EXTERNAL_BUILD_STATE_UPDATED`                                                                                                          | availability on `testflight`                                      |
  | `BACKGROUND_ASSET_VERSION_STATE_UPDATED`, `…_INTERNAL_BETA_RELEASE_CREATED`, `…_EXTERNAL_BETA_RELEASE_STATE_UPDATED`, `…_APP_STORE_RELEASE_STATE_UPDATED` | availability with transport `apple-ba`                            |
  | `BETA_FEEDBACK_SCREENSHOT_SUBMISSION_CREATED`, `BETA_FEEDBACK_CRASH_SUBMISSION_CREATED`, `ALTERNATIVE_DISTRIBUTION_*` (3)                                 | stored raw, no state change                                       |

- **States.** Use P2b-03's availability and submission vocabulary. If it left gaps, propose:
  `READY_FOR_DISTRIBUTION` and legacy `READY_FOR_SALE` → `live`; `PENDING_DEVELOPER_RELEASE` →
  `approved-held`; `WAITING_FOR_REVIEW`/`IN_REVIEW` → submission `in-review`; `REJECTED`,
  `METADATA_REJECTED`, `INVALID_BINARY` → `rejected`; `REPLACED_WITH_NEW_VERSION` → `superseded`.
- **Linking.** ASC ids (app, build, version, asset pack, asset-pack version) go into
  `platform_ref_json`; they are store-assigned after signing, so they never enter a release record
  (README §3.3). A Background Asset state that no pack release claims yet is stored unresolved and
  shown as such; P5-08 supplies the mapping.
- **Phased release** pauses up to 30 days and never applies to manual App Store downloads; the
  mirror is informative for the feed, not an access control.
- **No iTunes lookup.** Do not add it anywhere.
- **Tokens and budget.** `ascToken` from P5-01 (≤ 20 min, reused). The limit is per key over a
  rolling hour (Apple's example header shows 3,500; actual limits vary). Read `X-Rate-Limit` and
  slow the poller as the remainder drops.
- **Dependency gap.** `dist_rollouts` is P2b-04's table and P2b-04 is not a declared dependency.
  If it has not landed, ship the phased-release mirror behind a check and say so in the PR.
- **Threat model:** webhook forgery (HMAC), replay (dedupe), SSRF (fixed host), and the blast
  radius of a stolen App Manager key (metadata and release control, not signing).

## Steps

1. Fixtures: one recorded payload per event type (from Apple's documentation examples), and fake
   responses for every GET and PATCH used.
2. Client, webhook route, mapping; OpenAPI entry and the `routeCoverage` table; regenerate the
   routes page.
3. Poller and the cron dispatch; phased-release mirror.
4. Controls and the register-webhook action, audited.
5. Threat model; operator docs for the connector under `packages/docs/src/content/docs/`.

## Acceptance criteria

- [ ] `pnpm --filter @polaris-key/worker test -- asc` covers: valid, invalid, missing and
      wrong-prefix `x-apple-signature`; a redelivered `data.id` changes nothing; each of the 12
      event types is mapped or explicitly ignored; `READY_FOR_SALE` and `READY_FOR_DISTRIBUTION`
      both yield `live`; phased day 3 → 500 bp; `PAUSED` mirrors as `paused`; a 429 backs off.
- [ ] Each control sends the exact documented request to the fake server, writes one audit row,
      and re-reads state.
- [ ] With distribution disabled, or without an `asc-api-key` credential, the webhook answers the
      service not-found shape and the poller skips the product.
- [ ] The credential is only reached through `openOutletCredential` (the P5-01 reach test passes).
- [ ] OpenAPI and `routeCoverage` include the route; `docs gen:check` passes.
- [ ] The threat model covers the webhook and the key.
- [ ] The green gate passes (`AGENTS.md`), including `test:workerd`.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- asc routeCoverage scheduled
mise exec node@22 -- pnpm --filter @polaris-key/docs gen:check
mise exec node@22 -- pnpm --filter @polaris-key/worker test:workerd
```

With a real key (human): store the credential, run "register webhook", upload a TestFlight build
and watch availability move; pause and resume a phased release on a test app.

## Hand-off

- `services/distribution/connectors/` and the `DistributionConnector` interface; the cron dispatch.
- ASC ids in `platform_ref_json`, and `apple-ba` availability rows that P5-08 links to pack
  releases and P4-14's readiness hold reads.
- `connectors/asc/client.ts` for any later ASC call (P5-08's asset-pack housekeeping).
- Set the status: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P5-02 done`.
