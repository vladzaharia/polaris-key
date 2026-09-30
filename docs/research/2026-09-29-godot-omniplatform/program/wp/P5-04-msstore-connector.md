# P5-04 Microsoft Store status connector

| Field       | Value                                                                                                                                                                                                      |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | P5: Distribution connectors and native plugins                                                                                                                                                             |
| Size        | 0.5–1 engineer-weeks                                                                                                                                                                                       |
| Depends on  | [P5-01](P5-01-outlet-credentials.md), [P2b-03](P2b-03-availability-keys.md), [S-07](S-07-policy-recheck.md)                                                                                                |
| Unblocks    | none                                                                                                                                                                                                       |
| Role        | `pkey-implementer`                                                                                                                                                                                         |
| Plan mode   | no                                                                                                                                                                                                         |
| Gates       | none listed; it stores a new credential kind, so update the threat model's outlet-credential row. No public route                                                                                          |
| Human input | a Partner Center app registration: an Entra ID app with the Manager role (tenant id, client id, client secret, seller id); the Store product id in `.pkey/distribution`; the first submission made by hand |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                  |

## Goal

For a product with an `ms-store` outlet and an `ms-partner-center` outlet credential, distribution
shows the state of the latest Store submission and of each package flight, and the gradual-rollout
percentage, as availability, submissions and mirrored rollouts. The connector reads only; it never
submits, publishes or changes a rollout.

## Why

- The Microsoft Store is the third store outlet in the report's priority order ("ASC and Play first,
  then the Microsoft Store", [§12](../../README.md#12-risks-and-open-questions) scope creep). Its
  connector is "submission status and package-flight rollout via the Store APIs"
  ([§3.8](../../README.md#38-distribution-distribution-service)).
- Games must ship as MSIX and update only through the Store (policy 10.2.5), and certification can
  take up to three business days (notes/E3 §A1.2). The console and the signed feed need to know when
  a version is actually live there ([§4.4](../../README.md#44-windows)).
- `msstore` publishing works for free products only and needs a manual first submission (notes/E3
  §A1.2), so CI does the publishing and Polaris Key records the outcome.

## Read first

- `AGENTS.md`; P5-01's hand-off (`openOutletCredential`, the sealed token-cache helper); P2b-03's
  availability and submission writers; P5-02's `connectors/index.ts` if it has landed.
- notes/E3 §A1.1–§A1.3 (MSIX path, `msstore` CLI, flights, gradual rollout, certification lag).
- Microsoft's Store submission API documentation for MSIX apps. **The research did not fetch it**
  (notes/E3 §A1.2 marks it "not fetched"), so confirm endpoints and field names first.

## Scope

**In:**

- `services/distribution/connectors/msstore/`: `token.ts` (Entra client-credentials token for the
  Store API, cached with P5-01's sealed-cache helper), `client.ts`, `poll.ts`, `map.ts`; registered
  in `connectors/index.ts` and polled on the shared connector cron.
- Read the application, its last published and pending submissions and their status, the package
  flights and their submissions, and each submission's package-rollout fields.
- Map submission status → submissions and availability for the app release whose MSIX 4-part
  version matches `release_builds.build_number` (platform `windows`, format `msix`); package
  rollout percentage → mirrored `dist_rollouts` (`source: "ms-store"`); flight → channel through the
  manifest (e.g. a flight named for `beta`).
- Fixtures under `packages/worker/test/fixtures/msstore/` recorded from the documentation, and a
  fake token endpoint and API.

**Out** (and where it belongs instead):

- Publishing, metadata edits, and rollout changes (increase, halt, finalise): CI with `msstore` or
  the GitHub Action. A control surface can follow once the read path has run; no work package owns
  it yet.
- Store add-ons and in-product purchases (policy 10.8.1): not in [P6-01](P6-01-commerce-bridge.md)
  either; no work package owns Microsoft Store commerce.
- `StoreContext` update checks on the device (→ [P5-07](P5-07-desktop-plugins.md)).

## Design notes

- **Endpoint facts to confirm before coding.** From Microsoft's submission API documentation (not
  from the research): token from
  `https://login.microsoftonline.com/<tenantId>/oauth2/token` with `grant_type=client_credentials`
  and `resource=https://manage.devcenter.microsoft.com`; application at
  `https://manage.devcenter.microsoft.com/v1.0/my/applications/<applicationId>` with
  `lastPublishedApplicationSubmission` and `pendingApplicationSubmission`; a submission's `status`
  (e.g. `CommitStarted`, `PreProcessing`, `Certification`, `Release`, `Published`, and the
  `…Failed` states) with `statusDetails`; `packageRollout` (`isPackageRollout`,
  `packageRolloutPercentage`, `packageRolloutStatus`); flights under `…/listflights`. If the
  documentation disagrees, the documentation wins and the fixtures follow it. S-07 rows 11 and 18
  re-check these facts; use its findings if it has run.
- **Gradual rollout is MSIX-only and never rolls back installed users** when halted (notes/E3
  §A1.2). Mirror it for information; it is not an access control.
- **Certification lag.** Record `submitted_at` and `reviewed_at` so the console can show time in
  certification.
- **Credential.** `ms-partner-center` holds the client secret; `meta_json` shows tenant, client and
  seller ids. Scope the Entra app to the Manager role in Partner Center, nothing wider.

## Steps

1. Confirm the endpoints against Microsoft's documentation; record fixtures.
2. Token acquisition with the sealed cache; client; tests.
3. Poller and mapping; tests.
4. Operator docs (credential setup, what the connector does and does not do); threat-model row.

## Acceptance criteria

- [ ] `pnpm --filter @polaris-key/worker test -- msstore` covers: token cached and refreshed; each
      submission status mapped; a failed certification recorded as rejected with its details; a
      package rollout at 25 % mirrored as 2,500 bp; a flight mapped to its channel; an unknown flight
      ignored and logged.
- [ ] No request other than GET is ever sent to the Store API (asserted against the fake server).
- [ ] Products without the credential, or with distribution disabled, are skipped.
- [ ] The green gate passes (`AGENTS.md`).

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- msstore scheduled
mise exec node@22 -- pnpm typecheck
```

With a real registration (human): store the credential, publish a flight submission from CI, and
watch its status move through certification.

## Hand-off

- Microsoft Store availability, submissions and mirrored rollouts in distribution, read by the
  signed feed (P3-03) and the console matrix (P2b-06).
- Set the status: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P5-04 done`.
