# SP-51 Kotlin live state and lifecycle

| Field       | Value                                                                              |
| ----------- | ---------------------------------------------------------------------------------- |
| Phase       | SP: SDK parity pass (notes/SDK-PARITY-PASS.md) (SDK usability review (2026-10-08)) |
| Size        | 0.8–1.2 engineer-weeks                                                             |
| Depends on  | none                                                                               |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md)                                             |
| Role        | `pkey-sdk-porter`                                                                  |
| Plan mode   | no                                                                                 |
| Gates       | `ci:kotlin`                                                                        |
| Human input | none                                                                               |
| Repo        | `vladzaharia/polaris-key`                                                          |

## Goal

Kotlin live state and lifecycle, as the [SDK usability review](../../../2026-10-08-sdk-usability/README.md) §10.2 scopes it. Done when every acceptance criterion holds and the green gate passes.

## Why

Eighteen hands-on trials across Node, React, Python, Swift, Kotlin and Godot (the drop-in kit, your own UI, and a newcomer) averaged 5.3/10. This package fixes what they found; the evidence is in [`findings.json`](../../../2026-10-08-sdk-usability/findings.json) and the review's §5 and §7.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [The SDK usability review](../../../2026-10-08-sdk-usability/README.md): §1, §5, the SDK's part of §7, §10.2 (SP-51) and §10.4.

## Scope

**In:** `licenseChanges` and `events` emit on every status transition (deactivate, wipe, 401/revoked, blocked, grace and expiry as the floor moves), with a content-hash fallback; `PolarisGateState` reloads after every sync; `entitlementValue()` gated; boot retries with exponential backoff and a cap, a 401 on `/license/token` final for the pass; de-duplicated syncs; `close()` cancels the scope and releases OkHttp resources; `update.check()` keeps server codes; `listDevices()` reports offline; Play Billing `connect()` with a timeout and disconnect handling.

**Out** (and where it belongs instead):

- The 0.9 rebuilds and renames (→ SP-35, SP-35b and the UK kit packages); anything §10.1 gives an existing package.

## Design notes

- 0.8.x: Kotlin gates `entitlementValue`, matching the other SDKs; 0.9 gates `entitlements.has/value/grants` everywhere (§10.4).

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] Deactivate and a server revoke followed by `sync()` each emit within one tick.
- [ ] A Compose test of a licence revoked in the foreground shows the revoked screen.
- [ ] A boot with a revoked token makes at most 5 token requests a minute.
- [ ] A JVM `main` exits within 1 s of `close()`.
- [ ] `purchase()` without Play returns `BillingFailed(unsupported)` within 10 s.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate in the header.

## Verify

Each acceptance item's test in its SDK lane, then the full green gate in `AGENTS.md`.

## Hand-off

The role agent sets `--set SP-51 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set SP-51 done`.
