# PX-W14 Approve a new device (G29) on the I-02 store: start, approve with step-up for new locations, poll

| Field       | Value                                                                                                                   |
| ----------- | ----------------------------------------------------------------------------------------------------------------------- |
| Phase       | PX: Customer portal (docs/design/PORTAL.md) (phase W: Worker additions)                                                 |
| Size        | 0.4–0.8 engineer-weeks                                                                                                  |
| Depends on  | [I-02](I-02-single-use-store.md)                                                                                        |
| Unblocks    | [PX-15](PX-15-after-sign-in.md)                                                                                         |
| Role        | `pkey-implementer`                                                                                                      |
| Plan mode   | no                                                                                                                      |
| Gates       | the PORTAL.md §11 green gate; rule 10 (OpenAPI + `routeCoverage`); THREAT-MODEL; `typecheck:workerd` and `test:workerd` |
| Human input | none                                                                                                                    |
| Repo        | `vladzaharia/polaris-key`                                                                                               |

## Goal

`POST /api/device-login/start` returns `{code, qr, expiresIn}` on the I-02 single-use store, `POST /api/device-login/approve {code}` approves from a signed-in session with step-up for new locations, and `GET /api/device-login/:id` polls; every approval is audited and emailed.

## Why

Signing in on a new device by approving from a known one ([PORTAL.md §4.23](../../../../design/PORTAL.md#423-sign-in-with-another-device), [PORTAL.md §4.24](../../../../design/PORTAL.md#424-approve-a-new-device)). PORTAL.md sizes this M (2–4 agent-days); the owner approved the design on 2026-10-04.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [docs/design/PORTAL.md](../../../../design/PORTAL.md) in full once, then: [PORTAL.md §11.2](../../../../design/PORTAL.md#112-phase-w-worker-additions) (this package's row) and [PORTAL.md §11.4](../../../../design/PORTAL.md#114-order).
- [PORTAL.md §4.23](../../../../design/PORTAL.md#423-sign-in-with-another-device), [PORTAL.md §4.24](../../../../design/PORTAL.md#424-approve-a-new-device), [PORTAL.md §10.2](../../../../design/PORTAL.md#102-gaps-the-worker-must-close)
- the I-02 single-use store
- `docs/security/THREAT-MODEL.md`

## Scope

**In:**

- The three routes; audit and notice.

**Out** (and where it belongs instead):

- UI (→ PX-15)

## Design notes

- **Rule 10:** every new public route gets its OpenAPI operation and a `routeCoverage` entry in the same change (`test/routeCoverage.test.ts`).
- **THREAT-MODEL (phishing):** short expiry, location shown to the approver, never auto-approve.
- **Overlap with the re-cut S-16/S-17 graph:** I-08 also names QR sign-in on another device. PORTAL.md is the approved UI and API spec for this surface; whichever package lands first owns the shared code and the other narrows its scope to what is left (the lead reconciles the briefs).

## Corrections (PX-W14, verified against the code)

- **A fourth route, `POST /api/device-login/lookup {code}`.** §4.24 shows the approver the asking
  device (browser and OS, coarse place, when) before **Deny** or **Approve**, and the THREAT-MODEL
  line asks for the location to be shown; G29's three routes have no read for that. `lookup` reads
  only; `approve` takes `{code, decision: "approve" | "deny"}` with no default, which is also how
  **Deny** reaches the server.
- **Rule 10 is the OpenAPI spec plus `routeCoverage`'s `PORTAL_KIND_PATHS`,** as PX-W1 and PX-W10
  did (PORTAL.md §10.1's "narrative-only" predates them), plus the docs site's portal page.
- **Step-up is "a sign-in no older than 5 minutes"** (`STEP_UP_MAX_AGE_SECONDS`, the account
  links'), the portal's only step-up until I-14/I-15. **"New location"** is the asking device's
  country differing from the approver's, or either unknown (fail closed), in one function
  (`isNewLocation`) that I-15's sign-in history can replace.
- **The QR encoder moved to `src/core/qr.ts`** (it was Distribution's, and rule 6 forbids Identity
  importing it). `qr` is an SVG `data:` URI (the portal CSP allows `img-src data:`), next to
  `approveUrl`.
- **The poll is bound to the starting browser** by an `HttpOnly` cookie, and every "not there"
  answer is `410 expired`. The email is the existing, until now unwired, `newDeviceSignInNotice`.
- **I-08 overlap:** this package lands the shared code (single-use kinds `device-login` and
  `device-login-code`, `services/identity/portal/deviceLogin.ts`); I-08 narrows to what is left.

## Steps

1. Re-read the PORTAL.md sections above and the matching mockups in `docs/design/portal/`; verify this brief against the code and record any correction here.
2. Implement the **In** list in small commits prefixed `PX-W14:`.
3. Add the tests named in the acceptance criteria.
4. Run the green gate and the extra gates in the header; set `--set PX-W14 in-review`.

## Acceptance criteria

- [ ] Codes expire and are single-use (tests); approval never happens without an explicit action.
- [ ] OpenAPI and `routeCoverage` cover every route; a THREAT-MODEL row exists.
- [ ] `pnpm --filter @polaris-key/worker typecheck:workerd` and `test:workerd` pass; `gen:transcripts -- --check` stays green.
- [ ] The green gate passes (`AGENTS.md` and PORTAL.md §11), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- portal
```

## Hand-off

PX-15 builds `DeviceApproval` on both sides.

The role agent sets `--set PX-W14 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set PX-W14 done`.
