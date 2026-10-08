# LX-17 SDK audit: does each of the six SDKs tolerate a `licenseId` change on a plain refresh (cache, telemetry, activation state)? Tests only, fixes listed for LX-19

| Field       | Value                                                                                   |
| ----------- | --------------------------------------------------------------------------------------- |
| Phase       | LX: Licensing model: licences, grants, entitlements (S-19) (phase A: independent fixes) |
| Size        | 0.3–0.4 engineer-weeks                                                                  |
| Depends on  | none                                                                                    |
| Unblocks    | [LX-19](LX-19-sdks-licensing.md)                                                        |
| Role        | `pkey-sdk-porter`                                                                       |
| Plan mode   | no                                                                                      |
| Gates       | all six SDKs (`parity:check`)                                                           |
| Human input | none                                                                                    |
| Repo        | `vladzaharia/polaris-key`                                                               |

## Goal

A tests-only audit establishes, for each of the six SDKs, whether a `licenseId` change on a plain refresh is tolerated (cache, telemetry, activation state), and lists the fixes LX-19 must make.

## Why

`reanchor: onRefresh` is safe only if every SDK copes (risk 1, [S-19 §10.1](../../notes/S-19-licensing-model.md#101-risks); decision 10).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [S-19 owner decisions](../../notes/S-19-licensing-model.md) (the 2026-10-04 header block; it wins over the sections below it).
- [S-19 §7.5](../../notes/S-19-licensing-model.md#75-anchor-selection-seats-and-re-anchoring), [S-19 §9](../../notes/S-19-licensing-model.md#9-phased-plan-and-work-packages) row LX-17.

## Scope

**In:**

- One test per SDK that changes `licenseId` on refresh; a findings list in the PR.

**Out** (and where it belongs instead):

- Fixes (→ LX-19).

## Design notes

- Node/client-core does not compare `licenseId` today [V]; the others are unverified.

## Steps

1. Write the six tests.
2. Record pass/fail.

## Acceptance criteria

- [x] Each SDK has the test, passing or marked expected-fail with a linked LX-19 fix.
- [x] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Result (2026-10-04)

All six SDKs **pass**: a `licenseId` that changes on a plain refresh (same token, no activation
call) is applied, read by every accessor, carried by the next device report and by the current
device, persisted so a fresh client restores it offline, and followed by a normal 304 on the new
licence. No SDK compares or keys anything on `licenseId`. **LX-19 has no LX-17 fixes to make**, and
LX-21 may enable `reanchor: onRefresh` once LX-10 lands.

| SDK         | Test                                                                        | Result                                                                                            |
| ----------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Node        | `packages/sdk-node/test/licenseIdRefresh.test.ts`                           | pass                                                                                              |
| React / web | `packages/sdk-react/test/licenseIdRefresh.test.ts`                          | pass (browser adapter; telemetry is the typed web N/A; the desktop adapter projects Node's state) |
| Python      | `sdks/python/tests/test_license_id_refresh.py`                              | pass                                                                                              |
| Swift       | `sdks/swift/Tests/PolarisKeyTests/LicenseIdRefreshTests.swift`              | pass                                                                                              |
| Kotlin      | `sdks/kotlin/sdk/src/test/kotlin/im/plrs/key/sdk/LicenseIdRefreshTest.kt`   | pass (JVM; not in the green gate, run with `:sdk:test`)                                           |
| Godot       | `sdks/godot/tests/license/test_license_id_refresh.gd` (license suite group) | pass                                                                                              |

Not failures, noted for LX-19's API work: no SDK signals "this device now runs on another licence"
as its own event (it arrives as an ordinary content change through `onChange` and the state
signals), so a host that wants to show "now runs on Pro" has to compare `licenseId` itself.

## Verify

```sh
mise exec node@22 -- pnpm parity:check
```

## Hand-off

- LX-19 fixes failures; LX-21 may enable `onRefresh` if all pass.

The role agent sets `--set LX-17 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set LX-17 done`.
