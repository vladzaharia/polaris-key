# I-07 Login card and email: identifier-first card, email code and magic link, Turnstile, the required first-provider-sign-in interstitial (no code for a provider-verified email), profile import with avatars in R2, account sessions

| Field       | Value                                                                                                                                                                                                                                   |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | I: Identity: one Polaris Key account, then per-app identity (S-16) (layer-1, phase-1a)                                                                                                                                                  |
| Size        | 1.2–1.7 engineer-weeks                                                                                                                                                                                                                  |
| Depends on  | [I-02](I-02-single-use-store.md), [I-05](I-05-accounts-core.md), [I-18](I-18-email-delivery.md)                                                                                                                                         |
| Unblocks    | [I-08](I-08-app-passthrough.md), [I-11](I-11-portal-library.md), [I-16](I-16-passkeys.md), [I-17](I-17-pocket-id-migration.md), [PX-W12](PX-W12-sign-in-methods-api.md), [PX-13](PX-13-account-v2.md), [PX-W18](PX-W18-signin-hints.md) |
| Role        | `pkey-implementer`                                                                                                                                                                                                                      |
| Plan mode   | no: follows the approved [`plans/I-04.md`](../plans/I-04.md) where it names this package                                                                                                                                                |
| Gates       | D1 migration; `TABLE_OWNERS`; THREAT-MODEL; rule 10 (OpenAPI + `routeCoverage`); `test:workerd`; console CSP parity; cross-product session test; CSP parity                                                                             |
| Human input | a Turnstile site key and secret per environment (Cloudflare); an R2 bucket or prefix for copied avatars per environment                                                                                                                 |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                               |

## Goal

`key.plrs.im` has one Polaris-branded login card: identifier-first email, then the methods (passkey when enrolled, Apple, Google, Steam, email code or magic link). A person's first sign-in through a provider passes the required interstitial that confirms their email and shows imported profile data. Account sessions are revocable and listable.

## Why

The card is the only place account credentials are entered, for the portal and for every app ([S-16 §1](../../notes/S-16-identity-service.md#1-summary-and-recommendation); D17, accepted by the owner 2026-10-04). It is platform-level, like the account: it serves the portal for every product, and apps reach it only through I-08's passthrough when their Identity toggle is on. The owner made the interstitial required and decided that a provider-verified email needs no code of ours ([S-16 owner decisions](../../notes/S-16-identity-service.md)).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`; `plans/I-04.md`.
- [S-16 owner decisions](../../notes/S-16-identity-service.md) (the header block, including the 2026-10-04 email-confirmation join offer; the interstitial and profile import headers), [S-16 §5.1](../../notes/S-16-identity-service.md#51-concepts-and-data-model) rules ("The interstitial follows the same rule"), [S-16 §5.4](../../notes/S-16-identity-service.md#54-threat-model-deltas) items 4, 7 and 14, [S-16 §5.7](../../notes/S-16-identity-service.md#57-portal-surface) (the login card), [S-16 §8](../../notes/S-16-identity-service.md#8-work-packages) row I-07.
- `packages/worker/src/core/singleUse.ts`, `packages/worker/src/core/emailLimits.ts` (I-02's primitives), `packages/worker/src/core/brandHtml.ts`, `packages/worker/src/services/identity/portal/{session,email,auth}.ts`, `browserSession.ts`.

## Scope

**In:**

- Identifier-first card; email code and magic link on I-02's single-use store and limiters, sent through I-18; magic link opened on another device shows "Confirm sign-in, requested at <time> from <place>" and completes the requesting flow; landing-page `POST`; Turnstile.
- **The interstitial** on the first sign-in through any provider (Apple, Google, Steam, and later platform identities): email prefilled from the provider (including an Apple relay address), editable to a real address; Terms acceptance when a product requires it; the join offer when the confirmed email belongs to another account (below).
- Profile import: name, picture and locale where offered (Google; Apple name on first consent; Steam persona and avatar), shown in the interstitial for adjustment; avatars copied into R2 (same-origin, stable URLs); explicit choices stick, untouched values refresh on sign-in.
- `account_sessions`: host-only cookie on `key.plrs.im`, `SameSite=Lax`, `HttpOnly`, revocable, listable, "sign out everywhere"; never readable or settable by product routes.
- The "add another way to sign in" nudge after first sign-in.

**Out** (and where it belongs instead):

- Passthrough header, Continue-to-App and device code (→ I-08); passkeys (→ I-16).
- The portal's Profile and sign-in-method settings pages (→ I-11).
- Sending infrastructure and DNS (→ I-18).

## Design notes

- **Email verification rule (owner, 2026-10-04).** An email the provider asserts as verified (Google `email_verified: true`; Apple's email, including private relay) is accepted without our code. Only an address the user types, or one the provider does not mark verified, gets a one-time code. The verified address becomes the account's primary email and drives the claim rules, notices and matching. Steam and other providers with no email start with an empty field.
- **If the confirmed email belongs to another account, offer to join (owner, 2026-10-04).** The step stops and offers "Join with your existing Polaris Key account". Both identities must be proven in one session: the person signs in to that account by any of its methods, then confirms the join. A code to that address counts as that sign-in only if the address is an active email sign-in method on that account. If the new provider identity has no account yet, joining links it to the existing account; if it already has one, joining is a merge under I-05's rules (D21: the survivor's pairwise subject wins, the other becomes an alias, the developer gets `subject.merged`). Declining means choosing a different email. The step never joins silently and never by email match alone.
- **Email limits (safety defaults, from I-02):** 6-digit codes, 10-minute life, dead after 5 wrong attempts, recipient lockout after 10 in an hour answered like success; per-recipient 5 an hour and 20 a day; per-IP and per-network limits; identical responses for known and unknown emails.
- The card is Polaris-branded; product branding appears only in I-08's passthrough header. Every page runs under the strict CSP.
- Never auto-link by email across accounts (owner).

## Steps

1. Card pages and the account session.
2. Email code and magic link flows with limit tests.
3. Interstitial with the verified-email rule and the join offer.
4. Profile import and R2 avatars.

## Acceptance criteria

- [ ] A Google sign-in with `email_verified: true` completes the interstitial without a code; a typed address and an unverified provider email each require a code (tests).
- [ ] An interstitial email owned by another account never creates a second account or joins silently (test); accepting the offer joins only after both identities are proven in the same session (test), linking a new identity or merging an existing account through I-05 (tests).
- [ ] Known and unknown emails produce byte-identical start responses (test); every limit and lifetime above is enforced (tests).
- [ ] Imported avatars are served from R2 on the Polaris origin (test); account deletion can find and remove them (hook for I-11).
- [ ] No product route receives or sets the account cookie (test); CSP parity holds.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- identity card email interstitial session
mise exec node@22 -- pnpm --filter @polaris-key/worker test:workerd
```

## Hand-off

- I-08 puts the passthrough header on this card; I-11 builds account settings on these sessions.
- I-16 adds passkeys behind a verified email; I-17 moves Pocket ID users onto this card.

The role agent sets `--set I-07 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set I-07 done`.
