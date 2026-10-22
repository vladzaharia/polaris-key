# I-37c Device-code poll names a refusal (`error` + `reason: access_denied`); kits tell declined from failed

| Field       | Value                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------ |
| Phase       | I: Identity: one Polaris Key account, then per-app identity (S-16)                                     |
| Size        | 0.4–0.6 engineer-weeks                                                                                 |
| Depends on  | [I-37b](I-37b-device-code-denied-kits.md)                                                              |
| Unblocks    | [I-37d](I-37d-device-mint-retry.md), [UK-64](UK-64-kit-matrix-gaps.md)                                 |
| Role        | `pkey-sdk-porter`                                                                                      |
| Plan mode   | yes: [plans/DENY-01.md](../plans/DENY-01.md) is the approved plan                                      |
| Gates       | drift-gate, corpus, all-sdks, threat-model, rule-10, docs-generated, docs-links, ui-snapshots, workerd |
| Human input | none (D1–D6 decided by the lead: D1 C, D2 `access_denied`, D3 `sign-in-failed`, D4 pin, D6 this id)    |
| Repo        | `vladzaharia/polaris-key`                                                                              |

## Goal

The device-code poll tells a refusal from a failure. A Deny answers
`{"status":"error","reason":"access_denied"}`; every other failure stays the bare `error`. The SDKs
map the first to `sign-in-denied` and the second to `sign-in-failed`, and the kits show the
matching screen. `PROTOCOL_VERSION` stays 4; `uiMatrixVersion` goes 4 to 5.

## Why

Since I-37b every SDK maps any poll `error` to `sign-in-denied`, so the kits say "Sign-in declined"
for N9, a failed activation and a failed mint too. Plan [DENY-01](../plans/DENY-01.md) revisits
[I-37](../plans/I-37.md) D3.

## Read first

- `AGENTS.md` and [plans/DENY-01.md](../plans/DENY-01.md) in full.
- `docs/security/WIRE-CONTRACT-V4.md` §12.10; `packages/worker/src/services/identity/productOidc/poll.ts`.

## Scope

**In, phase 1 (done in this branch):** the contract (§12.10, `DevicePollResponse`, OpenAPI,
`errors.json`), the Worker (`poll.ts`) and its tests, the re-recorded `devicecode-denied` and the
new `devicecode-failed` transcripts, the corpus (SignInHandoff `failed`, the two `cli` `login`
outcomes, `uiMatrixVersion` 5), and the THREAT-MODEL paragraph.

**In, phase 2:** the SDK ports in plan section 5 (ui-core, Node, React, Python, Swift, Kotlin,
Godot), then the docs in plan section 10 step 6.

**Out:** a failed mint as a 5xx (its own package: [I-37d](I-37d-device-mint-retry.md), plan [MINT-01](../plans/MINT-01.md); the Python `aio.py` `code` drop is fixed there).

## Acceptance criteria

- [x] Contract, Worker, transcripts, corpus and THREAT-MODEL (phase 1).
- [x] Every device-code transcript except `devicecode-denied` and the new `devicecode-failed` is byte-identical.
- [x] No SDK still maps a bare `error` to `sign-in-denied`; each replays both transcripts and the new ui-matrix rows (phase 2).
- [x] The docs and CHANGELOG notes (phase 2).
- [ ] The green gate passes (`AGENTS.md`).

## Verify

```sh
mise exec node@22 -- pnpm gen --check
mise exec node@22 -- pnpm --filter @polaris-key/worker test deviceApproval hostedSigninPages oidcLicenseChoice routeCoverage
```

## Hand-off

Phase 2 fans out per SDK; the failing suites are listed in the phase 1 report. The lead sets
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set I-37c done` after review.
