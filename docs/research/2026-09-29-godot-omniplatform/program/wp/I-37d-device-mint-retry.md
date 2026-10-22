# I-37d Device-code poll: a transient failure after approval answers `503 unavailable` and the Worker retries; a refused mint ends the flow

| Field       | Value                                                                                       |
| ----------- | ------------------------------------------------------------------------------------------- |
| Phase       | I: Identity: one Polaris Key account, then per-app identity (S-16)                          |
| Size        | 0.3–0.5 engineer-weeks                                                                      |
| Depends on  | [I-37c](I-37c-device-poll-denied.md)                                                        |
| Unblocks    | none                                                                                        |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                       |
| Plan mode   | yes: [plans/MINT-01.md](../plans/MINT-01.md) is the approved plan                           |
| Gates       | plan-mode, drift-gate, all-sdks, threat-model, rule-10, docs-generated, docs-links, workerd |
| Human input | none (D1–D7 decided by the lead as recommended)                                             |
| Repo        | `vladzaharia/polaris-key`                                                                   |

## Goal

When a sign-in is approved but finishing it hits a transient failure, the sign-in does not end. The poll
answers `503 {"error":"unavailable","message":"try again"}` with `Retry-After`, and the Worker retries four
times (no sooner than 2, 4, 8 and 16 s). A refused mint is final at once. `PROTOCOL_VERSION` stays 4; no corpus change.

## Why

A failed mint went back with its flow and answered the bare `error`, which every SDK reports as a failed
sign-in and stops on, although the approval stands. A raw poller could drive about 300 mint attempts per flow.

## Read first

- `AGENTS.md` and [plans/MINT-01.md](../plans/MINT-01.md) in full.
- `docs/security/WIRE-CONTRACT-V4.md` §12.10; `packages/worker/src/services/identity/productOidc/poll.ts`.

## Scope

**In:** the contract (§12.10, `DevicePollUnavailable`, OpenAPI, `errors.json`), the Worker (`poll.ts`,
`config.ts`) and its tests, the new `devicecode-mint-retry` transcript and the six transcript runners
(Node, React, Python, Swift, Kotlin, Godot) with React's unit test, the Python `aio.py` `code` fix (D7),
the THREAT-MODEL attempt-budget line and the device-flow docs line.

**Out:** poll-loop changes in any SDK, a kit "finishing" state, `Retry-After` handling in SDKs (D5).

## Acceptance criteria

- [ ] Contract, Worker and tests (each path: transient then success, five failures then error then timeout, final refusal, polls in the wait touch no DB, 600 s lapse).
- [ ] Every existing device-code transcript is byte-identical; `devicecode-mint-retry` replays in all six runners.
- [ ] Python `aio.py` keeps `code` for denied and failed, with a test.
- [ ] THREAT-MODEL and docs updated.
- [ ] The green gate passes (`AGENTS.md`).

## Verify

```sh
mise exec node@22 -- pnpm gen --check
mise exec node@22 -- pnpm --filter @polaris-key/worker test oidcEdge R8-oidc oidc deviceApproval routeCoverage
```

## Hand-off

The lead sets `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set I-37d done` after review.
