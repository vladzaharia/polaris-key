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
- Platform mail, sent as "Polaris Key" (never "<App> via"), includes the dormant-account warning before deletion at 36 months (D23) and the merge and join notices (D21 and the email-step join offer), all decided by the owner 2026-10-04. Per-product caps never throttle these.
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

## Corrections (as built, 2026-10-04)

- **No `plans/I-04.md` yet.** The header says this package follows the approved I-04 plan where it
  names I-18, but I-04 (plan mode) is still `todo` and no plan exists. Nothing here needed it:
  `email_unavailable` is built as a `reason` in `deliverEmail`'s return value, not as a wire error
  code, so no `conformance/parity/errors.json` entry, SDK constant or route changes. The route that
  answers it (the login card, I-07) adds the wire code under I-04's error-code list.
- **The cap moved.** I-02 charged the per-product daily cap last inside `checkEmailSend`, which
  answers only `{ send }`. It now lives at the send choke point (`deliverEmail`, passthrough mail
  only, after suppression), so a capped product can answer `email_unavailable` (a product-level
  fact naming no recipient), platform mail is never capped, and a suppressed recipient spends no
  budget. `EmailSendRequest.productDailyCap` is gone; the value resolves from the product's
  `email_product_caps` row, then the `EMAIL_PRODUCT_DAILY_CAP` var, then the code default, which
  is 500 (was the 1,000 placeholder).
- **Stale package numbers in the code.** `emailLimits.ts` and THREAT-MODEL named "I-21" for this
  package and "I-08" for the email flows (pre-renumbering); they now say I-18 and I-07.
- **Sender name source.** No `branding_json` field for an app name exists yet, so `<App>` is
  `products.name`, the product's display name, through the validator; a refused name falls back to
  the slug and then to no mail, never to "Polaris Key". The validator is exported for the
  Branding page to reuse at write time.
- **Reserved names extended.** Beyond S-16's list (Polaris, Polaris Key, plrs, portal, console,
  admin), whole names that read as the platform's mailboxes (support, security, noreply,
  postmaster, abuse, billing, account) are refused, and `@` and `\` join the forbidden characters.
- **Subdomain choice.** The auth sending subdomain is `auth.plrs.im`, sender `noreply@auth.plrs.im`.
  Staging sends from the same address, so the staging check proves production's records. Prod keeps
  `noreply@plrs.im` until the owner sets `EMAIL_SENDER_ADDRESS` after onboarding (RUNBOOK
  "Sign-in email (I-18)").
- **Bounce events [U resolved].** Cloudflare Email Service pushes no bounce or complaint events to
  a Worker (docs checked 2026-10-04). The Worker records `E_RECIPIENT_SUPPRESSED` on send;
  `recordDeliveryEvent` is the hook a poller of the REST suppression list or the GraphQL
  `emailSendingAdaptive` dataset would call (follow-up; needs an API token).
- **Apple private relay** is gated by `EMAIL_APPLE_RELAY = "registered"`: until the owner records
  the registration, relay recipients get `email_unavailable` instead of a send that would bounce.
- **No console change.** The per-product cap is set with `wrangler d1 execute` (RUNBOOK) until a
  console page owns it; the console's read-only deploy-variable list does not yet show the three
  new vars.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- email
```

## Hand-off

- I-07 sends through this; I-06's Apple relay addresses receive mail once the registration is done.

The role agent sets `--set I-18 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set I-18 done`.
