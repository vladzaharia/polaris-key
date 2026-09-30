# P2b-03 Availability, submissions (CI-reported first) and the key inventory

| Field       | Value                                                                                                                                                                                                                                                             |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | P2b: Distribution core                                                                                                                                                                                                                                            |
| Size        | 1 engineer-weeks                                                                                                                                                                                                                                                  |
| Depends on  | [P2b-02](P2b-02-distribution-manifest.md), [P2-06](P2-06-publish-cli-action.md)                                                                                                                                                                                   |
| Unblocks    | [P2b-05](P2b-05-storefront-feeds.md), [P2b-06](P2b-06-download-page-matrix.md), [P3-03](P3-03-feed-composition.md), [P4-05](P4-05-pack-transports-cdn.md), [P5-02](P5-02-asc-connector.md), [P5-03](P5-03-play-connector.md), [P5-04](P5-04-msstore-connector.md) |
| Role        | `pkey-implementer`                                                                                                                                                                                                                                                |
| Plan mode   | no                                                                                                                                                                                                                                                                |
| Gates       | rule 10 (the CI report route); D1 migration + `TABLE_OWNERS`; `docs gen:check`; threat model for the key inventory (not in the graph's gates, but it is the independent check on signing keys)                                                                    |
| Human input | none                                                                                                                                                                                                                                                              |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                         |

## Goal

Distribution records, per release and outlet, whether a build is **available** there and where it
stands in a store's **submission** lifecycle. Until connectors exist (P5), CI reports both with
`pkey distribution report` using its `pkeyci_` token. Self-hosted outlets need no report: their
availability is derived from release's truth. A per-product **key inventory** lists signing keys
by purpose with SHA-256 fingerprints; operators own it and CI can only report what it observed.
The `delivery` hook exposes all three.

## Why

"Is it in the App Store yet?" has no answer in Polaris Key today: a release is one GitHub release
and resolution is per release, not per (release, outlet) ([notes/A1 §7](../../notes/A1-release-update.md#7-update-policy-gaps-relevant-to-games)).
The research gives distribution `dist_availability`, `dist_submissions` and `dist_keys`, with CI
reports for outlets without connectors ([README §3.8](../../README.md#38-distribution-distribution-service)
"Data model", [§11](../../README.md#11-decisions-needed) decision 7: read-only state first).
Android developer verification (regional enforcement from 2026-09-30, broader in 2027) makes
signing keys per package something to track and publish
([notes/E2 §B1](../../notes/E2-android.md#b1-android-developer-verification-status-at-2026-09-29),
[README §12](../../README.md#12-risks-and-open-questions) "Key custody is permanent").

## Read first

- `AGENTS.md` (rules 5, 6, 10), `CLAUDE.md`.
- [README §3.8](../../README.md#38-distribution-distribution-service), [§6.1](../../README.md#61-developer-adopter)
  (the matrix "filling in" on release day), [§6.2](../../README.md#62-administrator-operator) item 3
  (key inventory with fingerprints), [§6.3](../../README.md#63-player-end-user) (fingerprints on
  the download page).
- [notes/E2 §B1 and §C2](../../notes/E2-android.md#c2-self-hosted-f-droid-compatible-repo) (verification,
  the F-Droid repo key); [notes/E1 §A](../../notes/E1-apple.md) and [notes/E3](../../notes/E3-windows-linux-web.md)
  (store states to map onto the vocabulary).
- Hand-offs: [P2b-01](P2b-01-distribution-service.md) (`hooks`, `delivery`),
  [P2b-02](P2b-02-distribution-manifest.md) (`dist_outlets`, kinds, transports),
  [P2-02](P2-02-trusted-publisher.md) (`requireCiScope`, the `distribution:report` scope),
  [P2-06](P2-06-publish-cli-action.md) (CLI plumbing).
- Code: `packages/worker/src/services/distribution/`, `src/core/hooks.ts`,
  `src/core/adminApi.ts` (audit), `openapi/polaris-key.v3.yaml`, `test/routeCoverage.test.ts:63-89`,
  `packages/cli/src/index.ts`.

## Scope

**In:**

- **Tables** (migration; `TABLE_OWNERS` under `distribution`; README names plus `source` and
  timestamps):
  - `dist_availability(product, release_id, build_id, outlet_id, transport, state, since, platform_ref_json, detail_json, source, updated_at)`,
    PK `(product, release_id, build_id, outlet_id)` (`build_id` `''` when the report is per release);
  - `dist_submissions(product, release_id, outlet_id, state, submitted_at, reviewed_at, detail_json, source, updated_at)`,
    PK `(product, release_id, outlet_id)`;
  - `dist_keys(product, purpose, fingerprint_sha256, outlet_id, notes, registered_at, source, created_at, modified_at)`,
    PK `(product, purpose, fingerprint_sha256)`, plus `observed_json` for CI-observed mismatches.
- **CI report route** (rule 10): `POST /{product}/distribution/report`, `pkeyci_` token with
  `distribution:report`, body
  `{type: "availability" | "submission" | "key", releaseId | {deliverable, version}, outlet, buildId?, state, since?, platformRef?, detail?}`
  (for `key`: `{purpose, sha256, outlet?}`). Validates the outlet (declared, not removed), the
  release and build (through `releaseCatalog`), and the state vocabulary. Audited.
- **Derived availability:** for outlets whose transport is `pkey-cdn`, `embedded` or `web`, the
  `delivery` hook reports `live` for a release that has a matching build with a stored or GitHub
  location, without a row.
- **`delivery` hook:** `availability(releaseId)`, `submissions(releaseId)`, `keys({purpose?})`.
- **Admin API** (narrative-only): `GET …/distribution/availability?release=`,
  `GET …/distribution/submissions`, and the key inventory: `GET`, `PUT` (upsert by purpose and
  fingerprint), `DELETE`, and a `registered` flag for Android developer verification.
- **CLI:** `pkey distribution report availability|submission|key …` on P2-06's token plumbing.
- Docs: `services/distribution/availability.md` and a key-inventory section; threat model.

**Out** (and where it belongs instead):

- Store connectors that write these tables from webhooks and polling (→ P5-02, P5-03, P5-04);
  registering keys through the Android Developer Console API (no owner; operator flag only here).
- Rollouts, halts and delivery access (→ [P2b-04](P2b-04-rollouts-delivery.md)); readiness holds
  (→ P4-14); the matrix view (→ [P2b-06](P2b-06-download-page-matrix.md)).
- Public exposure of availability in the signed feed (→ P3-03).

## Design notes

- **State vocabularies** (proposed; P5-02 to P5-04 map store states onto them):
  - availability: `pending`, `processing`, `in-review`, `approved`, `live`, `rejected`, `removed`;
  - submission: `prepared`, `submitted`, `in-review`, `approved`, `rejected`,
    `pending-developer-release`, `released`, `cancelled`.
    A report may move a state backwards (a rejection after review); keep the current state and
    write every change to the audit log.
- **`source`** is `ci`, `admin`, or a connector kind (`asc`, `play`, `ms-store`) once P5 lands.
  Nothing here stops a connector overwriting a CI report; P5 decides precedence per outlet.
- **Store-assigned ids** (ASC build id, Play version code, Steam depot manifest) live in
  `platform_ref_json`, never in release: they arrive after signing (README §3.3).
- **The key inventory is operator-owned.** Its fingerprints are what players and AppVerifier check
  a download against, so they are the independent control against a compromised pipeline. CI may
  report the fingerprint it signed with (`type: key`); a report that does not match an inventory
  entry for that purpose is stored in `observed_json` and flagged, and never changes the entry.
- **Purposes** (proposed): `android-app-signing`, `android-upload`, `android-sideload`,
  `fdroid-repo`, `sparkle-ed25519`, `release` (the CI release key, the name P3-03 uses),
  `msix-publisher`. Fingerprints are lowercase
  hex SHA-256 of the certificate (or of the raw public key for Ed25519), validated on write.
- **Semi-trusted input.** A CI report can make the matrix and feeds show a wrong state, but it
  cannot ship code or change a key. Record CI reports as a §5 input in the threat model.
- **Enablement.** The route is in the distribution namespace; with distribution off it is the
  registry not-found, and the hook is `null`.
- Errors reuse `ErrorCode` with a `reason` (no new `PolarisErrorCode`).

## Steps

1. Migration, `TABLE_OWNERS`, `docs gen`.
2. Store module and the `delivery` hook functions, with derived availability; tests.
3. Report route, OpenAPI entry, `routeCoverage` row; tests for every validation and the scope.
4. Admin endpoints for availability, submissions and keys; audit.
5. CLI subcommand and tests; docs; threat model.

## Acceptance criteria

- [ ] A CI report with `distribution:report` records availability for (release, build, outlet);
      one without the scope, for an undeclared or removed outlet, an unknown release or build, or
      an unknown state is refused and writes nothing.
- [ ] A `pkey-cdn` outlet shows `live` for a release with a matching build and no row; an
      `app-store` outlet shows nothing until reported.
- [ ] A CI key report that differs from the inventory is flagged and does not change it; an
      operator change is audited.
- [ ] `pkey distribution report` works end to end against the Worker in a test.
- [ ] `routeCoverage` passes; `docs gen:check` is clean; the threat model lists the new input.
- [ ] The green gate passes (`AGENTS.md`).

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- distribution routeCoverage
mise exec node@22 -- pnpm --filter @polaris-key/cli test
mise exec node@22 -- pnpm --filter @polaris-key/docs gen:check
mise exec node@22 -- pnpm typecheck
```

## Hand-off

- The vocabularies, `source` values and the `delivery` hook functions are what P2b-05 (live
  releases per outlet), P2b-06 (matrix cells, fingerprints on the download page), P3-03 (per-outlet
  availability in the feed), P4-05, P4-14 and the P5 connectors use.
- `dist_keys` purposes feed P2b-05's F-Droid fingerprint and P3-03's `release` entries.
- Set the status: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P2b-03 done`.
