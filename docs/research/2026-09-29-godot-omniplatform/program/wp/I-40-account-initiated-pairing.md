# I-40 Account-initiated pairing for browserless TV and console apps

| Field       | Value                                                                                            |
| ----------- | ------------------------------------------------------------------------------------------------ |
| Phase       | I: Identity: one Polaris Key account, then per-app identity (S-16)                               |
| Size        | 0.3–0.5 engineer-weeks                                                                           |
| Depends on  | [I-08](I-08-app-passthrough.md), [I-37](I-37-device-code-explicit-confirm.md)                    |
| Unblocks    | none                                                                                             |
| Role        | `pkey-wire-planner` (planning only)                                                              |
| Plan mode   | yes: planning-only; the plan needs human approval and also covers the package that implements it |
| Gates       | plan-mode, threat-model                                                                          |
| Human input | Owner approval of the pairing threat analysis                                                    |
| Repo        | `vladzaharia/polaris-key`                                                                        |

## Goal

Decide, in an approved plan, whether and how a native TV or console app with no browser can sign in to a Polaris Key account after I-37 makes device code fail closed. The candidate is account-initiated pairing: the person, signed in on their own phone or computer, asks for a pairing code for one product and types it on the device. The plan must say what it proves, what it does not, and either specify the wire, routes, SDK work and rollout or recommend leaving the regression in place.

## Why

I-37 (lead ruling D1.A) removes the account-bound outcome of device code, and I-08 plus I-15 give only devices with a browser a same-device route ([I-08 plan](../plans/I-08.md) §2). Browserless TV and console apps lose account sign-in, which the lead accepted on 2026-10-17 on condition that this package is planned.

## Read first

- [`plans/I-37.md`](../plans/I-37.md) §1-§2 (why no current input proves device-holder intent); [`plans/I-08.md`](../plans/I-08.md) §2 and D1.
- `packages/worker/src/services/identity/portal/deviceLogin.ts` (PX-W14's reverse direction for portal sessions: lookup, explicit approve, location step-up, notice email); `docs/security/THREAT-MODEL.md` R1-07/R8-03.

## Scope

**In:** the threat analysis; the choice between pairing and leaving the regression; if pairing, the contract (routes, `typ`-free records, discovery members), the single-use store kinds, rate limits, copy, the SDK entry points for all six SDKs and the work packages that build them, rollout and rollback.

**Out:** implementing anything (a later package named by the lead after approval); changing I-37's fail-closed ruling.

## Design notes

- **The problem the plan must solve: relay by social engineering.** Pairing flips the direction, so a forwarded link no longer does it, but an attacker who owns a device can still ask the victim to open their portal, generate a code and read it out. The code then binds the victim's account to the attacker's device. I-37 §2 rejects any proof a starter can obtain by instructing a victim. The plan must either show a property that defeats this (for example proof that the typing device is the one in the person's hand, or a cost the attacker cannot meet) or state plainly what residual remains and recommend against shipping.
- Mitigations to evaluate, not assume: the code names the product and the account's own device label, shown at generation with a warning; short expiry and single use; step-up for a new location as in PX-W14; a notice email on every pairing; a per-account cap; the device showing the account's display name for the person to confirm.
- No device code, no secret in a URL, no new bearer capability from possession of a user code.

## Steps

1. Write `plans/I-40.md` with the required sections of `plans/README.md`.
2. Stop for approval.

## Acceptance criteria

- [ ] The plan names the relay attack and its residual, and the lead's decision is recorded.
- [ ] If pairing is approved, the plan names the contract, every SDK and the work package for each.

## Verify

```sh
node docs/research/2026-09-29-godot-omniplatform/program/check.mjs
```

## Hand-off

The planner sets `--set I-40 awaiting-approval` and stops.
