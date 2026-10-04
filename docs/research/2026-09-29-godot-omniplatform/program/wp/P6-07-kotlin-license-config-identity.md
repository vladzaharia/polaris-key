# P6-07 Kotlin SDK licence, config, devices, identity and release services

| Field       | Value                                                                                                                                                                      |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | P6: Commerce, ops, web                                                                                                                                                     |
| Size        | 1.5–2 engineer-weeks                                                                                                                                                       |
| Depends on  | [P6-06](P6-06-kotlin-core-runner.md)                                                                                                                                       |
| Unblocks    | [P6-05](P6-05-kotlin-sdk.md), [P6-08](P6-08-kotlin-update-packs.md), [P6-11](P6-11-kotlin-compose-ui-kit.md)                                                               |
| Role        | `pkey-sdk-porter`                                                                                                                                                          |
| Plan mode   | no                                                                                                                                                                         |
| Gates       | `parity:check`, the Kotlin runner's `gate-matrix.json`, `config-matrix.json` and transcript replay, `gen:mirrors` (Kotlin catalog mirror), `pnpm gen:constants -- --check` |
| Human input | none                                                                                                                                                                       |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                  |

Slice b of [P6-05](P6-05-kotlin-sdk.md).

## Goal

The Kotlin SDK gains the service modules `:license`, `:config`, `:identity` and `:release`, the
device operations (facts, register, manage, report), and the umbrella `:sdk` with `PolarisKeyClient`,
so a one-dependency adopter can gate, resolve config, sign in and read a changelog. Every behaviour
is proved by the same corpus files and HTTP transcripts as Node and Swift, replayed through the
runner [P6-06](P6-06-kotlin-core-runner.md) built. A reviewer can tell it happened when the rows
listed below are `implemented` and `:conformance:test` replays every transcript that names them.

## Why

- These are the product-facing services of the registry's `license`, `config`, `devices`,
  `identity` and `release` families, and the ones a native Android app adopts first.
- Swift's `PolarisKeyLicense`, `PolarisKeyConfig`, `PolarisKeyIdentity`, `PolarisKeyRelease` and the
  `PolarisKey` umbrella are the structural model, and the transcripts
  ([P1b-03](P1b-03-http-transcripts.md)) make "byte-identical verdicts" checkable.

## Read first

- `AGENTS.md`; [P6-06](P6-06-kotlin-core-runner.md) and its hand-off; `.claude/agents/pkey-sdk-porter.md`.
- `sdks/swift/Sources/PolarisKeyLicense`, `PolarisKeyConfig`, `PolarisKeyIdentity`,
  `PolarisKeyRelease`, `PolarisKey/PolarisKeyClient.swift`.
- `conformance/corpus/v2/gate-matrix.json`, `config-matrix.json`; every transcript in
  `conformance/transcripts/` (activate, register, devicecode, edge-mint, config-schema-fetch,
  release-changelog\*, commerce-claim, telemetry-report, register-reregister-401).
- `tools/gen-mirrors.ts` (the Swift mirror emitter) and `tools/gen-mirrors.test.ts`.
- [P1b-06](P1b-06-reregister-401.md), [P1b-07](P1b-07-license-config-release-gaps.md),
  [P1b-08](P1b-08-devicecode-edgemint-ports.md) (the behaviours that must match).

## Scope

**In:**

- `:license`: gate, activate, enroll, deactivate, entitlements, channels, re-register on 401.
- `:config`: resolution, list, secrets, schema fetch, edge-mint, facts; the catalog mirror.
- Devices: facts, register, manage, report (the fingerprint function is [P6-06](P6-06-kotlin-core-runner.md);
  Android inputs are [P6-12](P6-12-kotlin-android-glue.md)).
- `:identity`: RFC 8628 device-code sign-in; the OIDC redirect stays a host-supplied sign-in
  closure, as in Swift.
- `:release`: changelog, download URLs, the release record.
- `:sdk` umbrella: `PolarisKeyClient` and re-exports (`api` dependencies), so `polaris-key-sdk` is
  the one-line dependency. Update and packs facets are added by [P6-08](P6-08-kotlin-update-packs.md).
- A Kotlin emitter in `tools/gen-mirrors.ts` (`--lang ... kotlin`) with its test, so a product's
  config catalog compiles to typed Kotlin.
- Runner additions: `gate-matrix.json`, `config-matrix.json` and every transcript above, with the
  `@pkey-feature` tags.
- `maven-publish` configuration on each new module (local `build/repo` only).
- Flip in `sdks/kotlin/parity.json`: `license.gate`, `license.activate`, `license.enroll`,
  `license.deactivate`, `license.entitlements`, `license.channels`, `license.reregister`,
  `config.resolve`, `config.list`, `config.secret`, `config.schema`, `config.mint`,
  `config.mirror`, `devices.facts`, `devices.register`, `devices.manage`, `devices.report`,
  `identity.devicecode`, `release.changelog`, `release.download`, `release.record`.

**Out** (and where it belongs instead):

- `identity.oidc` and `commerce.receipt` stay `planned`, `unowned`, with the same notes as Swift
  (Play Billing is a store edge, not an SDK service; the server side is [P6-01](P6-01-commerce-bridge.md)).
- Update, packs, boot guard (→ [P6-08](P6-08-kotlin-update-packs.md)).
- Any screen (→ [P6-11](P6-11-kotlin-compose-ui-kit.md)).
- New corpus or transcript cases: file a `pkey-wire-planner` package; do not edit `conformance/`.

## Design notes

- Each module depends on `:core` only (never on a sibling), as Swift's targets do; `:sdk` is the one
  place they meet.
- Public API is `suspend` and `Flow`, errors are the typed set from `:core`, and every public type
  is explicit-API (`explicitApi()` as `:platform` already uses).
- Re-registration on a 401 must behave as P1b-06 specified, proved by `register-reregister-401.json`.
- No Android types in these modules; the device-facts input that needs `Build` or the package
  manager arrives through a `DeviceFactsSource` port filled in by [P6-12](P6-12-kotlin-android-glue.md)
  (a JVM implementation ships here).

## Steps

1. `:license` with `gate-matrix.json` and its transcripts.
2. `:config` and the mirror emitter, with `config-matrix.json` and transcripts.
3. Devices and `:identity`.
4. `:release` and the umbrella.
5. `parity.json`, docs sections, READMEs.

## Acceptance criteria

- [ ] `:conformance:test` passes every case in `gate-matrix.json` and `config-matrix.json` and
      replays every transcript naming one of the flipped rows.
- [ ] Every row listed in Scope is `implemented` (or carries its registry-allowed `na`), the two
      unowned rows keep their notes, and `parity:check` is green.
- [ ] `tools/gen-mirrors.ts --lang kotlin` output compiles in a test module and its test is in the gate.
- [ ] No module in this package depends on a sibling service module or on Android.
- [ ] The green gate passes (`AGENTS.md`) and the `kotlin` CI job is green.

## Verify

```sh
( cd sdks/kotlin && ./gradlew :license:test :config:test :identity:test :release:test :sdk:test :conformance:test )
mise exec node@22 -- pnpm parity:check -- --check
mise exec node@22 -- pnpm exec vitest run tools/gen-mirrors.test.ts
```

## Hand-off

- `PolarisKeyClient` and the service modules: [P6-08](P6-08-kotlin-update-packs.md) adds the
  `update` facet, [P6-11](P6-11-kotlin-compose-ui-kit.md) renders the services' state.
- The `DeviceFactsSource` port for [P6-12](P6-12-kotlin-android-glue.md).
- The role agent sets `--set P6-07 in-review` when it hands off. After review, the lead adds the last
  commit of the PR:
  `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P6-07 done`.
