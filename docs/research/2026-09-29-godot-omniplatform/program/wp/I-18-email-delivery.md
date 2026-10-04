# I-18 Email delivery operations: SPF, DKIM and DMARC on an auth sending subdomain, "<App> via Polaris Key" sender name, suppression, per-product caps, `email_unavailable`, Apple private-relay registration

| Field       | Value                                                                                                                                                                                         |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | I: Identity: one Polaris Key account, then per-app identity (S-16) (layer-1, phase-0–1a)                                                                                                      |
| Size        | 0.6–0.85 engineer-weeks                                                                                                                                                                       |
| Depends on  | [I-02](I-02-single-use-store.md)                                                                                                                                                              |
| Unblocks    | [I-07](I-07-login-card-email.md)                                                                                                                                                              |
| Role        | `pkey-implementer`                                                                                                                                                                            |
| Plan mode   | no: follows the approved [`plans/I-04.md`](../plans/I-04.md) where it names this package                                                                                                      |
| Gates       | `wrangler.toml`; THREAT-MODEL; D1 migration; `TABLE_OWNERS`; deliverability check on staging                                                                                                  |
| Human input | owner DNS: SPF, DKIM and DMARC for the auth sending subdomain of plrs.im, and its Cloudflare Email Service onboarding; Apple private-relay sender registration in the Apple developer account |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                     |

## Goal

Sign-in email leaves a dedicated auth sending subdomain of `plrs.im` with aligned SPF, DKIM and DMARC; passthrough mail uses "<App> via Polaris Key" under the reserved-name validator; suppression is applied before every send; per-product caps keep one tenant from draining the shared sender; throttling answers `email_unavailable`; and Apple private-relay delivery works.

## Why

Every sign-in email for every developer leaves one Polaris sender, so its reputation is shared ([S-16 §9](../../notes/S-16-identity-service.md#9-risks-and-open-questions) risk 9). The card's email codes need it from day one (I-07).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [S-16 §5.2](../../notes/S-16-identity-service.md#52-developer-facing-surface) (branding and sender name), [S-16 §5.4](../../notes/S-16-identity-service.md#54-threat-model-deltas) items 4 and 7, [S-16 §8](../../notes/S-16-identity-service.md#8-work-packages) row I-18, [S-16 §9](../../notes/S-16-identity-service.md#9-risks-and-open-questions) risk 9.
- `packages/worker/src/services/identity/portal/email.ts`, `packages/worker/src/core/emailLimits.ts` (the placeholder daily cap I-02 left), `packages/worker/wrangler.toml`.

## Scope

**In:**

- Sending configuration for the auth subdomain; the "<App> via Polaris Key" display name from the product's display name, with the reserved-name validator, a length cap and no control characters, quotes or angle brackets; the "via Polaris Key" suffix fixed.
- Hashed suppression list; bounce and complaint handling where Cloudflare Email Service exposes it [U]; per-product daily caps (replacing I-02's placeholder default); `email_unavailable` fallback.
- Apple private-relay sender registration (owner action) and a test send.

**Out** (and where it belongs instead):

- The email flows themselves (→ I-07).

## Design notes

- DNS and the Apple registration are owner actions; agents never touch DNS or accounts.
- Whether the Email Service exposes bounce events is open [U]; record what exists.

## Steps

1. Sender configuration and display-name validator.
2. Suppression, caps and `email_unavailable`.
3. Staging deliverability check after the owner's DNS change.

## Acceptance criteria

- [ ] A reserved or header-breaking display name is refused (tests).
- [ ] A suppressed address is never sent to (test); a capped product gets `email_unavailable` (test).
- [ ] Staging mail passes SPF, DKIM and DMARC alignment (recorded in the PR).
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- email
```

## Hand-off

- I-07 sends through this; I-06's Apple relay addresses receive mail once the registration is done.

The role agent sets `--set I-18 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set I-18 done`.
