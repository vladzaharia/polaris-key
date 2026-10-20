# I-37 Device-code phishing boundary (R1-07/R8-03)

| Field       | Value                                                                                                 |
| ----------- | ----------------------------------------------------------------------------------------------------- |
| Phase       | I: Identity: one Polaris Key account, then per-app identity (S-16)                                    |
| Size        | 0.6–0.8 engineer-weeks                                                                                |
| Depends on  | [I-08](I-08-app-passthrough.md), [LK-04](LK-04-cross-host-sign-in.md)                                 |
| Unblocks    | [I-37b](I-37b-device-code-denied-kits.md), [I-40](I-40-account-initiated-pairing.md)                  |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                                 |
| Plan mode   | yes: [I-37 plan](../plans/I-37.md), approved 2026-10-19                                               |
| Gates       | plan-mode, drift-gate, rule-10, threat-model, workerd                                                 |
| Human input | Done: D1–D8 and the page copy, approved by the lead under the owner's delegated authority, 2026-10-19 |
| Repo        | `vladzaharia/polaris-key`                                                                             |

> **Re-plan (2026-10-19).** The plan replaces D1.A (fail closed, needs I-15) with an **explicit approval after sign-in**, enforced by a server-side marker. `portal-e2e` and `ui-snapshots` moved to [I-38a](I-38a-hosted-worker-pages-locker.md) (the hosted look, done) and PX-14a (the card). Worker only; no wire change; `PROTOCOL_VERSION` stays 4.

## Goal

Reduce the live remote-phishing residual **R1-07/R8-03** for a `verificationUriComplete` link. A device-code flow does nothing account-bound until the browser that confirmed the code and signed in presses **Sign in on {device}** on `GET|POST /<p>/identity/auth/device/approve`. Until then `/device/poll` answers `pending`; Deny makes it answer `error`. The P1-07 attach is retired on device code and `/device/verify` is retired.

R1-07 is **reduced, not closed**: a person persuaded to press the button still authorizes the starter's one device on their licence (seat-checked, revocable). The threat model says so.

## Why

The `__Host-pk_lcb` binder proves which browser confirmed the code. It cannot prove that the person in it holds the device, because a forwarded `verificationUriComplete` makes a victim confirm in their own browser. The device label, user code, CSRF and the binder are presentation or browser-origin controls, not proof of intent. An explicit decision, shown with the app, account, device label, code, and where and when the request started, is the control that remains.

## Read first

- `AGENTS.md`; `docs/security/THREAT-MODEL.md` "The device-code user-code page (P1-06)" and "Remote phishing (RFC 8628 §5.4)".
- [`plans/I-37.md`](../plans/I-37.md) in full (decisions D1–D8, §6 server contract, §10 tests).
- `packages/worker/src/services/identity/productOidc/` (`deviceFlow.ts`, `callback.ts`, `chooser.ts`, `poll.ts`, `pages.ts`, `deviceApproval.ts`).

## Scope

**In:** the `approvedAt` marker on the flow record; the approval page and its single writer (`decideDeviceFlow`); the poll gate; the callback and chooser changes; the attach retired; `/device/verify` retired; the entry page naming no product; rule-10 (route, descriptor, OpenAPI, `routeCoverage`, the route oracle); threat model, PRIVACY, SIGN-IN.md and the sign-in docs; tests.

**Out:** SDK and kit changes, the `devicecode-denied` transcript, kit copy (→ I-37b); the card's DeviceConfirm (→ PX-14a, which calls `decideDeviceFlow`); account-initiated pairing (→ I-40, optional).

## Acceptance criteria

- [x] After the callback, every poll answers `pending`: no identity, no `confirm`, no token; licence, device and audit counts are unchanged until approval. After approval the next poll is `ready` with exactly one device row (`deviceApproval.test.ts`).
- [x] Approval comes only from the browser that confirmed the code and signed in: a missing, foreign or index-less binder, a cross-site POST, a request handle or `__Host-pk_req` alone, a label, user code or `state` are refused with the generic page and write nothing.
- [x] A missing, replayed, stale or foreign page token, and an expired flow, write nothing; of two racing decisions exactly one wins.
- [x] Deny and **Not you?** make the poll answer `error` and drop the identity; Cancel on the chooser is Deny; a choice sets `approvedAt` in the update that records it.
- [x] The attach is retired on device code (`attachable: false`, `attachLicense: true` read as `false`); the `OPEN (R1-07 / R8-03, P1-07 …)` cases are `FIXED`, and a `RESIDUAL (R1-07)` case asserts the approved-phish outcome (one seat-checked device, no claim, no migrate).
- [x] A legacy record (a device id but no `viaDeviceCode`, or a malformed `approvedAt`) is unapproved and never reaches `activateFromIdentity`.
- [x] `/device/verify` answers the start-again page and reads nothing; neither entry page names the product before the code resolves (B9.3).
- [x] Rule 10: route in `routes.ts` (descriptor surface), OpenAPI, `routeCoverage`, the route oracle re-recorded by whole mode, `pnpm gen docs-reference`. No migration, table, `Env` member or error code.
- [x] `THREAT-MODEL.md` (fifth control, "Remote phishing" closed/open lists, the attach marked retired), `PRIVACY.md`, `SIGN-IN.md` §3.13, `device-flow.md` and `troubleshooting.md` say what is deployed.
- [x] `pnpm gen transcripts` regenerated (the device's conversation is unchanged in shape; only seeded values move).
- [ ] The green gate passes (`AGENTS.md`), including every gate in the header. See the report for the pre-existing integ failures.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- deviceApproval R8-oidc identityBinders oidcLicenseChoice platformDeviceEntry customerDevicePage routeCoverage serviceRouteOracle limits boundaries
mise exec node@22 -- pnpm --filter @polaris-key/worker typecheck:workerd
mise exec node@22 -- pnpm --filter @polaris-key/worker test:workerd
mise exec node@22 -- pnpm gen --check
```

## Hand-off

PX-14a renders the same decision in the card and calls `decideDeviceFlow`; neither a request handle nor `__Host-pk_req` is approval. I-37b teaches the six SDKs the `devicecode-denied` transcript. A display label is never a trust signal.
