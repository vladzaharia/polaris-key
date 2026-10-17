# I-37 Device-code phishing boundary (R1-07/R8-03)

| Field       | Value                                                                                                                       |
| ----------- | --------------------------------------------------------------------------------------------------------------------------- |
| Phase       | I: Identity: one Polaris Key account, then per-app identity (S-16)                                                          |
| Size        | 0.6–1 engineer-weeks                                                                                                        |
| Depends on  | [I-08](I-08-app-passthrough.md), [I-15](I-15-native-redirect.md)                                                            |
| Unblocks    | [I-38](I-38-hosted-passport-worker-csp.md), [I-40](I-40-account-initiated-pairing.md), [PX-14](PX-14-passthrough-header.md) |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                                                       |
| Plan mode   | yes: [I-37 plan](../plans/I-37.md) requires owner approval before implementation                                            |
| Gates       | plan-mode, drift-gate, threat-model, workerd, portal-e2e, ui-snapshots                                                      |
| Human input | Owner approval of the device-holder proof, legacy-flow policy and customer-facing refusal copy in the plan's decision table |
| Repo        | `vladzaharia/polaris-key`                                                                                                   |

## Goal

Close the live RFC 8628 remote-phishing residual **R1-07/R8-03** for a
`verificationUriComplete` link. Since a device code and browser cookie cannot
prove that the person who authenticated intends to sign in the starter's device,
the default plan fails closed: a device-code flow cannot complete an
account-bound sign-in, chooser, consent, attach, claim, migrate, or token mint
unless a separately approved, unforwardable device-holder channel exists. The
device stays `pending` until the authorised, approved replacement flow completes.

## Why

The existing `__Host-pk_lcb` cookie binds a callback to the browser that confirmed
the code, which stops a starter who confirms with curl and forwards the authorize
URL. It does not stop a starter from forwarding `verificationUriComplete`: the victim
then confirms in their own browser, receives the cookie, authenticates, and may see
the licence chooser for the starter's client-supplied `deviceName`. The current
threat model records that as open R1-07/R8-03; `deviceName`, the user code, CSRF, and
the browser binder are presentation or browser-origin controls, not proof that the
browser controls the device code.

## Read first

- `AGENTS.md`, `docs/security/THREAT-MODEL.md` “The device-code user-code page
  (P1-06)” and “Remote phishing (RFC 8628 §5.4)”.
- `docs/research/2026-09-29-godot-omniplatform/program/plans/I-37.md`.
- `docs/research/2026-09-29-godot-omniplatform/program/plans/I-04.md` §2.4 and
  §G; [I-08](I-08-app-passthrough.md); and
  [PX-W13](PX-W13-passthrough-metadata.md).
- `packages/worker/src/services/identity/oidc.ts`:
  `confirmDeviceFlow`, `renderDeviceConfirmation`, `handleAuthDeviceEntry`, and
  `handleAuthCallback`; `packages/worker/src/services/identity/passthrough/request.ts`.
- `packages/worker/test/attack/R8-oidc.test.ts` R1-07/R8-03 cases and
  `packages/docs/src/content/docs/features/sign-in/device-flow.md`.

## Scope

**In:**

- A fail-closed, server-side device-code capability marker that prevents
  account-bound device-code completion until the owner approves an independent,
  unforwardable device-holder channel. The marker must be unforgeable or
  bypassable by a party who has only a user code, a request handle, `state`, a
  callback URL, or a client-supplied device label.
- The Worker changes necessary to carry, enforce, expire and atomically abandon
  that capability; the portal-card hand-off that presents data only through the
  browser-bound request record; and the protocol, service documentation and
  threat model changes specified by the approved plan.
- Regression and attack tests for the direct URL, typed code, QR,
  `verificationUriComplete`, callback, chooser, claim and migrate paths.

**Out** (and where it belongs instead):

- A cosmetic confirmation-only page or trusting `deviceName` as an anti-phishing
  control (not a fix; the label is attacker supplied).
- Replacing the existing `__Host-pk_lcb` or `__Host-pk_req` protections for
  non-device flows (→ I-08 / PX-W13).
- Changing device-code wire versioning, token formats, or unrelated identity
  policies (→ the owning approved plan).
- Product rendering refinements after the secure hand-off (→ PX-14 and I-38).

## Design notes

- **Current mechanism.** `/identity/auth/device` accepts a user code, mints a
  single-use CSRF token, and `confirmDeviceFlow` spends it, stamps `confirmedAt`,
  stores a peppered hash of a random `__Host-pk_lcb` binder, deletes the user-code
  index, and 303s to the IdP. `handleAuthCallback` requires that binder. The legacy
  `/device/verify?device_code=` path uses the same confirmation function.
- **Why it remains live-open.** In the complete-URI variant the victim, not the
  starter, makes that confirmation in their own browser. Therefore the victim holds
  a valid `__Host-pk_lcb` and can authenticate into a flow whose device code and
  enrolled device remain with the starter. `__Host-pk_req` similarly binds a
  request handle to its creating browser; it cannot by itself prove possession of
  the device code.
- **Security invariant.** Before callback, chooser, consent, token mint, identity
  disclosure to the device poll, `attachLicense`, claim, or migrate, the Worker
  must enforce the stored fail-closed device-code capability. Current inputs
  cannot satisfy it for an account-bound completion: a separately approved
  channel must prove user intent in a way a starter cannot obtain by forwarding
  `verificationUriComplete`. A missing, malformed, expired, replayed, cross-flow,
  or wrong-channel capability must mint nothing, attach nothing, and return the
  same generic restart/refusal response that does not reveal whether a code or
  account existed.
- **Compatibility.** `verificationUriComplete` remains a user-code convenience URL
  only if the resulting flow is incapable of an account-bound outcome. The owner
  must choose whether to keep it under that rule or remove it from discovery; no
  user-code re-entry, device-mediated hand-off, or silent fallback may be claimed
  as a solution without the separately approved trust channel.
- **No secret in a URL.** The device code remains absent from URLs, HTML, form
  fields, request handles, logs, audit detail, and client-side storage. Do not
  convert device-code possession into a reusable bearer capability.

## Steps

1. Write and obtain approval for `plans/I-37.md`; reconcile its binding with
   I-04 §2.4/G and I-08 before implementation.
2. Implement the plan's default fail-closed device-code capability in the
   Worker route/service boundaries. Make every callback, chooser, consent and
   poll decision read the stored marker atomically with existing single-use
   artefact primitives; retain the 600-second flow lifetime and do not log
   secrets.
3. Wire the approved portal/card refusal and recovery route. The card may fetch
   presentation through the existing opaque, browser-bound request handle, but
   neither that handle nor either binder cookie authorises account-bound
   device-code completion.
4. Make callback, chooser/consent and `/device/poll` reject an unapproved
   device-code flow before any account-, licence-, device-, token- or
   attachment-affecting operation.
5. Update `docs/security/THREAT-MODEL.md`, `docs/security/WIRE-CONTRACT-V4.md`
   only if the approved transport contract changes, the device-flow feature
   documentation, and the I-04/I-08 statements that currently overstate browser
   binding as the R1-07 closure.
6. Add the tests and real portal/Worker evidence below, run the required checks,
   set I-37 `in-review`, and retain the explicit owner decision in the plan.

## Acceptance criteria

- [ ] A malicious starter can forward `verificationUriComplete` to a victim who
      confirms and authenticates, but cannot reach callback completion, chooser,
      consent, `ready`, claim, migrate, `attachLicense`, a token, or any
      licence/device write for the starter's flow (attack tests).
- [ ] The replacement same-device route completes: `authorize` then `token` on I-08's endpoints (web), and I-15's loopback/scheme redirects (CLI, desktop, mobile). There is no poll on that route, so the former "poll stays `pending`" check does not apply. A user-code-only browser, altered device label, foreign flow, expired flow, or replayed continuation is refused (tests).
- [ ] **Deploy gate and recorded regression (lead, 2026-10-17).** I-37 ships in the same tag as I-08 and I-15 (I-15 is now a dependency). Browserless native TV and console apps have no account-bound sign-in after this change; key entry and I-13 store tokens remain. The lead accepted that regression and recorded it in the rollout record; I-40 plans the account-initiated pairing that may replace it.
- [ ] Existing curl-forwarded-authorize R1-07 and legacy
      `/identity/auth/device/verify?device_code=` cases remain protected; all
      failures are generic, no secret appears in URLs/HTML/loggable bodies, and
      no callback fallback mints or mutates state (tests).
- [ ] The card cannot read a request handle without `__Host-pk_req`; the callback
      still requires `__Host-pk_lcb`; the new proof complements rather than
      weakens both (Worker and portal-e2e tests).
- [ ] Threat model, protocol/service docs and I-04/I-08 planning text describe
      the deployed invariant and the remaining residuals exactly; R1-07/R8-03 is
      marked closed only when its exploit tests fail for the intended reason.
- [ ] The green gate passes (`AGENTS.md`), including every gate in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- R8-oidc identityBinders oidcLicenseChoice
mise exec node@22 -- pnpm --filter @polaris-key/worker typecheck:workerd
mise exec node@22 -- pnpm --filter @polaris-key/worker test:workerd
mise exec node@22 -- pnpm --filter @polaris-key/admin test -- portal
mise exec node@22 -- pnpm gen --check
```

## Hand-off

I-38 and PX-14 may rely only on the approved secure device-code continuation, its
generic refusal behaviour, and the fact that a display label is not a trust signal.
They must not treat a request handle or either binder cookie as device-code proof.
The planning agent sets `--set I-37 awaiting-approval` with the plan. After owner
approval, the implementer follows the approved plan and sets `--set I-37 in-review`;
after review the lead records the final commit with `--set I-37 done`.
