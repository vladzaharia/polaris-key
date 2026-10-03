# P6-02 Device trust tiers from App Attest and Play Integrity

| Field       | Value                                                                                                                                                                                                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | P6: Commerce, ops, web                                                                                                                                                                                                                                                    |
| Size        | 1–1.5 engineer-weeks                                                                                                                                                                                                                                                      |
| Depends on  | [P5-05](P5-05-apple-plugin-package.md), [P5-06](P5-06-kotlin-aar.md), [P5-01](P5-01-outlet-credentials.md)                                                                                                                                                                |
| Unblocks    | none                                                                                                                                                                                                                                                                      |
| Role        | `pkey-implementer`                                                                                                                                                                                                                                                        |
| Plan mode   | no (server-side only; stop and escalate if a signed document would change)                                                                                                                                                                                                |
| Gates       | threat model; also rule 10 (two new Core routes), a D1 migration, `test:workerd`, `ci:macos` and `ci:android` for the native additions, and `parity.json`                                                                                                                 |
| Human input | none listed. In practice: the App Attest capability on the App ID and the Team ID; a Google Cloud project linked in Play Console with the Play Integrity API enabled, its project number, and a service account stored as an outlet credential; devices for the checklist |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                                 |

## Goal

A device can prove it is a genuine store install: an iOS build attests a key with App Attest, an
Android build presents a Play Integrity verdict, and the Worker verifies either one against a fresh
challenge. A verified device is recorded at trust level `attested`; every other device, including
sideloaded builds that cannot attest, stays `basic`. Operators can require `attested` for chosen
operations (edge-mint, gated delivery, commerce claims), in log-only mode by default. The device
token and the signed documents do not change.

## Why

- "Optionally, App Attest / Play Integrity to raise trust in a device token (sideloaded builds can't
  attest; give them a lower trust tier)" ([§3.10](../../README.md#310-commerce-and-entitlements)),
  scheduled in P6 ([§10](../../README.md#10-roadmap-and-effort)).
- Under `open` registration anyone can obtain a device token, and edge-mint and gated delivery trust
  it ([§9.1](../../README.md#91-polaris-key-worth-fixing-regardless-of-godot) #5). Attestation is the
  one signal a script cannot fake cheaply on store builds.
- Anti-piracy realism still applies: this protects delivery and server-side features, not the
  client (report §12).

## Read first

- `AGENTS.md`; `docs/security/THREAT-MODEL.md`; the glossary
  `packages/docs/src/content/docs/start/concepts.md` ("tier" already means a licence tier).
- notes/E1 §F5 (App Attest: challenge, RP ID, counter, `aaguid`, key loss on reinstall), notes/E2
  §A5 and §E3 (Play Integrity verdicts, standard vs classic requests, quotas, decode).
- `packages/worker/src/core/devices.ts` (`validateDeviceToken`, device rows), `src/core/register.ts`,
  `src/services/config/mint.ts:202-219` (the mint guard), P6-01's `core/x509.ts` if it has landed.
- P5-01's hand-off (`openOutletCredential`, `googleAccessToken`, the reach-test allowlist).

## Scope

**In:**

- **Vocabulary.** Code says `trust_level` (`basic` | `attested`), not "tier", because the glossary
  reserves tier for licence tiers. Add a glossary entry in the same PR.
- **Migration:** `devices` gains `trust_level`, `attested_at`, `attestation_json` (verdict summary,
  never raw tokens); products gain an operator-owned `trust_policy_json` with `trust_policy_source`
  (the `*_source` pattern), for example
  `{mint: "basic", gatedDelivery: "basic", commerceClaim: "basic", enforce: false}`.
- **Routes** (Core; names proposed; rule 10): `POST /{product}/devices/attest/challenge` → a
  single-use challenge (KV, 5 minutes, bound to the device id); `POST /{product}/devices/attest` with
  `{kind: "app-attest", keyId, attestation, challenge}` or
  `{kind: "play-integrity", token, challenge}`.
- **App Attest verification:** CBOR attestation object; `x5c` chain to the pinned Apple App
  Attestation Root CA (shared `core/x509.ts`); nonce `SHA-256(authData ‖ clientDataHash)` equal to
  the certificate extension `1.2.840.113635.100.8.2`; key hash equal to `keyId`; RP ID hash of
  `<TeamID>.<bundleId>` (from the outlet identity); counter 0; `aaguid` production or development
  per the product's setting. Store the public key for later assertions.
- **Play Integrity verification:** `decodeIntegrityToken` for the package with a Google token from
  a `google-service-account` credential (scope `https://www.googleapis.com/auth/playintegrity`);
  `requestHash` equal to the challenge binding; package name; `PLAY_RECOGNIZED`;
  `MEETS_DEVICE_INTEGRITY`; licensing verdict recorded; timestamp fresh. Add `core/attestation.ts`
  to P5-01's reach-test allowlist with a comment saying why.
- **Enforcement points:** edge-mint (Config, through a Core accessor), gated delivery
  (distribution), commerce claim (P6-01). Log-only by default: a would-be refusal is audited, not
  enforced, until the operator sets `enforce`.
- **Native additions:** `DCAppAttestService` (generate, attest, assert) in P5-05's
  `PolarisKeyPlatform`; the standard Integrity API (`prepareIntegrityToken`, `request` with a
  request hash) in P5-06's `play` flavour.
- **Godot:** `PolarisKey.devices.attest()` (coroutine) through `PKeyApple`/`PKeyAndroid`, returning
  `Unsupported` with reason `runtime` on desktop and web and `outlet` on sideload installs; a
  registry entry `devices.attest` with those allowed N/As.
- Console: the trust level and last verdict on the product-wide devices list (P0-06's view).

**Out** (and where it belongs instead):

- Assertions on every sensitive request (App Attest `generateAssertion`, counter checks): stored for
  later, not required here.
- Android Keystore key attestation for sideload builds (notes/E2 §A5 leaves it unresearched).
- Attestation in Node, Python, Swift and React (→ `planned`; no work package owns them).
- Carrying the trust level in a signed document (that would be a wire change and plan mode).

## Design notes

- **Fail closed on verification, fail open on policy.** A bad attestation never raises the level;
  a missing one leaves `basic`. Only an operator's `enforce: true` turns `basic` into a refusal.
- **Keys die on reinstall, device migration and restore** (notes/E1 §F5): re-attest when the SDK's
  stored key id is gone; do not treat it as fraud.
- **Quotas.** Play Integrity allows 10,000 requests and 10,000 decodes a day per app by default;
  rate-limit attestation per device (e.g. once an hour) with `core/rateLimit.ts`.
- **Web, desktop and sideload** cannot attest; their `basic` level is expected, not suspicious.
- **What can be built before a human supplies anything:** App Attest with a generated test chain
  (pinned root overridable in tests only) and CBOR fixtures, Play Integrity against a fake decode
  endpoint, the Godot stubs. Real verdicts need the capability, the linked Cloud project and devices.

## Steps

1. Migration, glossary entry, challenge route; tests.
2. App Attest verifier (`core/x509.ts` shared with P6-01) with generated fixtures.
3. Play Integrity decode with a fake endpoint; the reach-test allowlist entry.
4. Policy and the three enforcement points in log-only mode; audit rows.
5. Native additions (Swift and Kotlin) with fakes; Godot `devices.attest`; `parity.json`.
6. Threat model; operator docs; device checklist (human): a TestFlight build and an internal-track
   build reach `attested`; a sideloaded build stays `basic`.

## Acceptance criteria

- [ ] Worker tests cover: challenge single use and expiry; a valid App Attest object raises the
      level; wrong RP ID, wrong nonce, broken chain or non-zero counter do not; a Play verdict
      without `MEETS_DEVICE_INTEGRITY` or with a stale timestamp does not; the per-device rate limit.
- [ ] With `enforce: false`, a `basic` device mints and an audit row records the would-be refusal;
      with `enforce: true`, it gets a typed refusal.
- [ ] OpenAPI and `routeCoverage` include both routes; generated pages are fresh.
- [ ] Swift and Kotlin unit tests cover the new native calls against fakes; headless Godot tests
      cover the `Unsupported` reasons.
- [ ] The threat model and the glossary are updated.
- [ ] `parity.json` manifests are updated for every SDK this changes (once P1b-01 has landed).
- [ ] The green gate passes (`AGENTS.md`), including `test:workerd`.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- attest routeCoverage
mise exec node@22 -- pnpm --filter @polaris-key/worker test:workerd
( cd sdks/swift && swift test )
( cd sdks/kotlin && ./gradlew :platform:test )
```

## Hand-off

- `trust_level` on devices and the Core accessor that edge-mint, distribution and the commerce
  bridge consult; `trust_policy_json` as an operator-owned setting.
- `devices.attest` in the Godot SDK and the native calls in the Apple package and the AAR.
- Set the status: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P6-02 done`.

## Corrections from implementation

Recorded by the implementer on 2026-10-03. The code is the fact where this brief and the code
disagree.

- **The Team ID is operator-owned, not from the outlet identity.** No `.pkey/distribution` outlet
  identity carries a Team ID (`app-store` has `appleId` and `bundleId`). The RP ID is
  `<teamId>.<bundleId>` with `teamId` from the operator's trust policy (`appAttest.teamId`) and the
  bundle ids of the live `app-store` and `testflight` outlets. The policy also carries the aaguid
  environment (`appAttest.environment`) and, for the client, the Play cloud project number
  (`playIntegrity.cloudProjectNumber`, returned with each challenge as `play.cloudProjectNumber`).
- **`trust_policy_source` is `default` or `admin`, never `manifest`.** No manifest field, ingest or
  resync writes the policy (so rule 9 does not apply). It is written by a new platform-admin
  resource, `GET|PUT|DELETE /manage/api/products/<slug>/trust-policy` (narrative-only, like every
  admin route), audited as `trust_policy.set` / `trust_policy.reset`. There is no console editor for
  the policy yet (follow-up); the console's product-wide devices list shows the trust level and the
  last verdict, as scoped.
- **Module split.** `core/attestation.ts` holds the two routes and the Play decode (the one file on
  the reach-test token allowlist); the pure verifiers are `core/appAttest.ts` (pinned Apple root),
  `core/playIntegrity.ts`, `core/cbor.ts` and `core/x509.ts`; the policy and the accessor the
  enforcement points call are `core/deviceTrust.ts` (`trustRefusal(env, db, product, device, op,
now, shape)`). P6-01 had not landed, so `core/x509.ts` was written here: ECDSA P-256/P-384 only,
  which covers Apple Root CA - G3 chains too.
- **Play credential and pin.** No new outlet-credential kind or pin: the existing
  `google-service-account` kind with its `packageName` pin (P5-03) is reused, chosen by
  Distribution's own `resolvePlaySetup` through a new optional descriptor-hook method,
  `Delivery.attestationTargets()` (which also lists the Apple bundle ids). `core/attestation.ts` is
  added to the reach test's `TOKENS_IMPORT_ALLOW_FILES` (it may call `googleAccessToken`, not
  `openOutletCredential`), with a guard test that the entry stays that narrow.
- **Challenge binding.** The challenge response carries `requestHash =
base64url(SHA-256("pkey-attest/1:<product>:<deviceId>:<challenge>"))`; App Attest's client data
  hash is `SHA-256(UTF-8(requestHash))` and a standard Play request passes `requestHash` verbatim.
- **Errors and limits.** Three new wire codes in `conformance/parity/errors.json`:
  `attestation_required` (403, an enforced refusal), `attestation_rejected` (422) and
  `attestation_unavailable` (409 not set up, 503 Google unreachable). Rate limits, per device and
  fail-closed: `attestChallenge` 10/hour, `attest` 4/hour.
- **Enforcement points.** Edge-mint (`services/config/mint.ts`, after the per-device budget) and
  gated delivery: `core/entitledAccess.ts`'s `accessRefusal` (the `licensed`/`authenticated` and
  `entitled` modes, after the existing checks pass) and `entitlementFlagRefusal` (the pack gate,
  after the flag is held). The commerce claim is defined in the policy (`commerceClaim`) but has no
  call site: P6-01 has not landed and must call `trustRefusal(…, "commerceClaim", …)` from its claim
  route.
- **Not in the brief: resets.** A keyless re-registration or a licence (re)bind of an existing
  device id resets the level to `basic` (`resetDeviceTrust`), because the id is client-chosen and a
  new token minted without the old one is not proof of the attested install. A token rotation keeps
  the level.
- **CORS.** The two routes are excluded from CORS (no browser can attest), in `core/cors.ts` and the
  routeCoverage exclusion list.
- **Native and Godot names.** Swift (`PolarisKeyPlatform/AppAttest.swift`): commands
  `app_attest_supported`, `app_attest_attest {requestHash, keyId?}`, `app_attest_assert` behind the
  `AppAttestClient` seam (unsupported `runtime` on macOS, the simulator and extensions). Kotlin
  (play flavour): `play.PlayIntegrity` over `com.google.android.play:integrity` 1.6.0, Godot binding
  ops `integrity_prepare` / `integrity_token` (the direct flavour answers unsupported `outlet`).
  Godot: `PolarisKey.devices.attest()` returns a `PKeyResult` whose detail is
  `{trust_level, kind, attested_at}`; the App Attest key id is kept in the Keychain store and
  regenerated on `invalid_key`. The cloud project number comes from the challenge, else the new
  `PKeyOptions.play_cloud_project_number`. The capability engine registers a
  `devices.attest|outlet` detector so `supports()` agrees with `attest()`. No CI change was
  needed: the existing `apple` and `android` jobs run the new Swift, Kotlin and Godot suites.
  The Swift SDK client itself stays `planned` (unowned) for `devices.attest`, as do Node, Python
  and React as runtime N/As.
- **Migration number.** The migrations are `0053_a`–`0053_e` (lead decision: P4-17 keeps 0051,
  P6-01 takes 0052).
