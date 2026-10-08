# SP-42 Test doubles on the real client, in every SDK

| Field       | Value                                                                                                           |
| ----------- | --------------------------------------------------------------------------------------------------------------- |
| Phase       | SP: SDK parity pass (notes/SDK-PARITY-PASS.md) (SDK usability review (2026-10-08))                              |
| Size        | 1.2–1.8 engineer-weeks                                                                                          |
| Depends on  | [SP-41](SP-41-pkey-dev-a-local-polaris-key-for-integrators.md), [SP-35](SP-35-sdk-api-registry-api-json-0-9.md) |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [AX-10](AX-10-sdk-skills-should-tier.md)                                |
| Role        | `pkey-sdk-porter`                                                                                               |
| Plan mode   | no                                                                                                              |
| Gates       | `all-sdks`                                                                                                      |
| Human input | none                                                                                                            |
| Repo        | `vladzaharia/polaris-key`                                                                                       |

## Goal

Test doubles on the real client, in every SDK, as the [SDK usability review](../../../2026-10-08-sdk-usability/README.md) §10.2 scopes it. Done when every acceptance criterion holds and the green gate passes.

## Why

Eighteen hands-on trials across Node, React, Python, Swift, Kotlin and Godot (the drop-in kit, your own UI, and a newcomer) averaged 5.3/10. This package fixes what they found; the evidence is in [`findings.json`](../../../2026-10-08-sdk-usability/findings.json) and the review's §5 and §7.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [The SDK usability review](../../../2026-10-08-sdk-usability/README.md): §1, §5, the SDK's part of §7, §10.2 (SP-42) and §10.4.

## Scope

**In:** each SDK publishes a testing entry point that drives the **real** client over a scripted transport and a throwaway signer, never a second client: Node `@polaris-key/node/testing`, React `@polaris-key/react/testing` (a test Provider over the real browser adapter), Python `polaris_key.testing` (a mock control plane on httpx `MockTransport`), Swift `PolarisKeyTesting`, Kotlin `polaris-key-testing` (`TestSigner`, `ScriptedTransport`), Godot an optional `polaris_key_testing` folder over a transport seam on `PKeyOptions`. Scenarios match SP-41's keys plus offline. Sample fixtures (`fixtures.ts`, `tidewater_fixtures.py`) move onto it; each terminal kit gets a documented preview entry point that renders any scenario.

**Out** (and where it belongs instead):

- The 0.9 rebuilds and renames (→ SP-35, SP-35b and the UK kit packages); anything §10.1 gives an existing package.

## Design notes

- Doubles drive the real client over a scripted transport and a test signer; there is no second client (§10.4).

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] In each SDK a host test of an activation screen needs 15 lines or fewer and no hand-written claims.
- [ ] Samples import only public modules.
- [ ] `api.json` lists the surface.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate in the header.

## Verify

Each acceptance item's test in its SDK lane, then the full green gate in `AGENTS.md`.

## Hand-off

The role agent sets `--set SP-42 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set SP-42 done`.
