# PX-W4 Email code for the account sign-in on the I-02 single-use store

| Field       | Value                                                                                                                   |
| ----------- | ----------------------------------------------------------------------------------------------------------------------- |
| Phase       | PX: Customer portal (docs/design/PORTAL.md) (phase W: Worker additions)                                                 |
| Size        | 0.4–0.8 engineer-weeks                                                                                                  |
| Depends on  | [I-02](I-02-single-use-store.md)                                                                                        |
| Unblocks    | [PX-12](PX-12-login-card-v2.md)                                                                                         |
| Role        | `pkey-implementer`                                                                                                      |
| Plan mode   | no                                                                                                                      |
| Gates       | the PORTAL.md §11 green gate; rule 10 (OpenAPI + `routeCoverage`); THREAT-MODEL; `typecheck:workerd` and `test:workerd` |
| Human input | none                                                                                                                    |
| Repo        | `vladzaharia/polaris-key`                                                                                               |

## Goal

The account sign-in accepts a six-digit email code issued and consumed atomically on the I-02 single-use store, with rate limits in the `_portal` buckets and enumeration-safe responses, so the login card can offer "Email me a code" next to the magic link.

## Why

Codes work across devices where links do not ([PORTAL.md §4.4](../../../../design/PORTAL.md#44-enter-the-code)); I-02's atomic store makes them safe. PORTAL.md sizes this M (2–4 agent-days); the owner approved the design on 2026-10-04.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [docs/design/PORTAL.md](../../../../design/PORTAL.md) in full once, then: [PORTAL.md §11.2](../../../../design/PORTAL.md#112-phase-w-worker-additions) (this package's row) and [PORTAL.md §11.4](../../../../design/PORTAL.md#114-order).
- [PORTAL.md §4.4](../../../../design/PORTAL.md#44-enter-the-code), [PORTAL.md §10.2](../../../../design/PORTAL.md#102-gaps-the-worker-must-close)
- the I-02 single-use store (`wp/I-02-single-use-store.md`)
- `packages/worker/src/services/identity/portal/auth.ts`, `packages/worker/src/services/identity/portal/email.ts`

## Scope

**In:**

- Code issue and verify routes for the account sign-in on the I-02 store.
- Rate limits in the `_portal` buckets; enumeration-safe responses.

**Out** (and where it belongs instead):

- UI (→ PX-12)
- Product email login inside apps (→ I-07)

## Design notes

- **Rule 10:** every new public route gets its OpenAPI operation and a `routeCoverage` entry in the same change (`test/routeCoverage.test.ts`).
- **Overlap with the re-cut S-16/S-17 graph:** I-07 also names email codes for the login card. PORTAL.md is the approved UI and API spec for this surface; whichever package lands first owns the shared code and the other narrows its scope to what is left (the lead reconciles the briefs).
- **Dependency ids.** PORTAL.md §10.3 and §11 were written against the first revision of phase I; the graph maps them onto the re-cut S-16 ids (see README §8, phase PX): portal I-06 → I-05 (accounts, links, pairwise subjects), I-05 and I-20 (Google, Apple) and I-12's web Steam → I-06, I-08 (email login) → I-07, I-14 (passkeys) → I-16, I-13 (native redirect) → I-15, I-15 (sessions) → I-07, I-16 (per-product issuer) → I-08 for layer 1 (I-21 later), S-17 → U-05.

## Steps

1. Re-read the PORTAL.md sections above and the matching mockups in `docs/design/portal/`; verify this brief against the code and record any correction here.
2. Implement the **In** list in small commits prefixed `PX-W4:`.
3. Add the tests named in the acceptance criteria.
4. Run the green gate and the extra gates in the header; set `--set PX-W4 in-review`.

## Acceptance criteria

- [x] Responses are identical for known and unknown addresses (test: the start's in `identityCardEmail.test.ts`; the resend's, and a refused resend's, in `portalEmailCode.test.ts`).
- [x] A code is single-use under concurrent verify (test on the I-02 store: `portalEmailCode.test.ts` over the real `SingleUseDO` class, `test-workerd/emailCode.test.ts` on the real object).
- [x] OpenAPI and `routeCoverage` cover the new routes (`resendCardEmailCode`, `PORTAL_KIND_PATHS`).
- [x] `pnpm --filter @polaris-key/worker typecheck:workerd` and `test:workerd` pass; `gen:transcripts -- --check` stays green.
- [x] The green gate passes (`AGENTS.md` and PORTAL.md §11), including every drift gate listed in the header.

## Corrections from the code (implementer, 2026-10-06)

- **I-07 landed first and owns the shared code** (the overlap note above). The issue
  (`POST /api/signin/email/start`) and the verify (`POST /api/signin/email/verify`) already run on
  I-02's store in the `_portal` scope, with byte-identical start answers for known and unknown addresses
  (`test/identityCardEmail.test.ts`), and both are in OpenAPI and `routeCoverage`. PX-W4 narrows to
  what is left of PORTAL.md §4.4: the **Resend** the code step needs.
- **What PX-W4 adds.** `POST /api/signin/email/resend` (`card/emailSignIn.ts`): a new code and
  link for this browser's flow, to the address it started with, keeping `returnTo`. It needs no new
  Turnstile token (the flow passed one), shares the start's per-address minute bucket
  (`portalMagic`), waits `EMAIL_RESEND_AFTER_SECONDS` (60) after the last code, sends at most
  `EMAIL_SENDS_PER_FLOW` (5) emails per flow, start included, and keeps every I-02 send limit with
  the start's enumeration rule (a refused send answers like a sent one). It retires the flow
  atomically, so the previous code and link stop working and two racing resends mail once. The
  start and the resend now answer `resendIn` for the card's countdown.
- **Rule 10 for portal routes is OpenAPI after all.** PORTAL.md §10.1 said the spec must not list
  `/api/*`; the code moved on (PX-W1 and I-07 pinned portal routes in `PORTAL_KIND_PATHS`), so the
  resend gets its OpenAPI operation and `routeCoverage` row, plus the docs portal page. §10.1 is
  corrected to match (lead, 2026-10-06).
- **The card's half ships with it (lead, 2026-10-06).** So the resend works end to end before PX-12,
  `SignInPage.tsx` resends through `POST /api/signin/email/resend` rather than a second start
  (which would need a fresh Turnstile token and leave the old link alive), counts down from
  `resendIn`, shows a 429's `retryAfter` as the countdown, says at the per-flow cap that no more codes
  can be sent and the latest still works, and goes back to the email step (address kept) on
  `signin_expired`. So that "429 without `retryAfter`" means only the cap, the resend's per-address
  minute refusal carries `retryAfter: 60` too. PX-12 keeps the rest of the card.
- **Concurrency test.** The I-02 primitive already had one (`emailLimits.test.ts`, the workerd
  `singleUse.test.ts`); PX-W4 adds the route-level race in both lanes (`test/portalEmailCode.test.ts`,
  `test-workerd/emailCode.test.ts`).
- **Left out (follow-up).** The expired-link Worker page's **Send a new code** (SIGN-IN.md §3.13,
  §4.12) needs a flow that outlives its code (today both live 10 minutes, so the page never knows
  the address) and a way for the SPA to land on the code step after a plain form `POST`. That is a
  change to I-07's flow lifetime plus PX-12's landing, not an issue or verify route.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- portal
```

## Hand-off

PX-12 renders `CodeEntry` against these routes.

The role agent sets `--set PX-W4 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set PX-W4 done`.
