# I-21 Email delivery operations for sign-in mail: dedicated auth sending subdomain, suppression, per-product caps, `email_unavailable` fallback

| Field       | Value                                                                                                                                                                                         |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | I: Identity service (S-16) (phase-1, MVI)                                                                                                                                                     |
| Size        | 0.6–0.85 engineer-weeks                                                                                                                                                                       |
| Depends on  | [I-02](I-02-single-use-store.md)                                                                                                                                                              |
| Unblocks    | [I-08](I-08-email-login.md)                                                                                                                                                                   |
| Role        | `pkey-implementer`                                                                                                                                                                            |
| Plan mode   | no: follows the approved [`plans/I-04.md`](../plans/I-04.md) where it names this package                                                                                                      |
| Gates       | `wrangler.toml` bindings; THREAT-MODEL; D1 migration; `TABLE_OWNERS`                                                                                                                          |
| Human input | owner DNS: SPF, DKIM and DMARC for the auth sending subdomain of plrs.im, and its Cloudflare Email Service onboarding; Apple private-relay sender registration in the Apple developer account |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                     |

## Goal

Sign-in email is deliverable and its failure is contained: a dedicated auth sending subdomain of `plrs.im` with SPF, DKIM and DMARC, per-product sender display names, bounce and complaint handling where the Email Service exposes it, a hashed suppression list, per-product daily caps, an `email_unavailable` fallback with an operator alert, and Apple private-relay sender registration.

## Why

Every product's sign-in mail leaves one Polaris sender; one abused tenant or a quota cut stops email sign-in for all ([S-16 §9](../../notes/S-16-identity-service.md#9-risks-and-open-questions) risk 7, [S-16 §5.4](../../notes/S-16-identity-service.md#54-threat-model-deltas) item 4).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode).
- [S-16 owner decisions](../../notes/S-16-identity-service.md) (2026-10-04, the note's header).
- [S-16 §5.4](../../notes/S-16-identity-service.md#54-threat-model-deltas) item 4, [S-16 §8](../../notes/S-16-identity-service.md#8-work-packages) row I-21, [S-16 §9](../../notes/S-16-identity-service.md#9-risks-and-open-questions) risk 7.
- `packages/worker/src/services/identity/portal/email.ts`, `wrangler.toml`; skill-level docs for Cloudflare Email Service.

## Scope

**In:**

- Sending from a dedicated auth subdomain (reputation separate from portal mail).
- Display name "<Product> via Polaris Key".
- Bounce and complaint handling where exposed [U], and a hashed suppression list.
- Per-product daily send caps (I-02's limiter; this package sets the default).
- On throttling or quota exhaustion: `email_unavailable`, the UI offers other methods, and an operator alert.
- Runbook: DNS records, Email Service onboarding, Apple private-relay registration.
- Deliverability check on staging.

**Out** (and where it belongs instead):

- Per-product custom sender domains (later).

## Design notes

- **Deliverability requirements (safety defaults):** SPF, DKIM and DMARC aligned on the auth subdomain; suppression applied before every send; caps per product so one tenant cannot drain the shared quota.
- DNS and the Apple registration are owner actions; agents never touch DNS or accounts.
- Whether the Email Service exposes bounce events is open [U]; record what exists.

## Steps

1. Sender config and suppression list with tests.
2. Caps and `email_unavailable`.
3. Runbook; owner actions listed in the PR; staging deliverability check after deploy.

## Acceptance criteria

- [ ] A suppressed address is never sent to (test).
- [ ] Exceeding the product cap returns `email_unavailable` and raises an alert (test).
- [ ] Runbook lists the exact DNS records and the Apple registration step.
- [ ] Staging deliverability result recorded (or marked pending owner DNS).
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- identity email
```

## Hand-off

- I-08 sends through this path; I-20's Apple relay users receive mail once registration is done.

The role agent sets `--set I-21 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set I-21 done`.
