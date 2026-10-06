# PX-12 Login card v2: identifier-first with `UsualMethodHint` (G30), code entry, passkeys with conditional UI, Apple/Google/Steam per product, license-key path, `AccountUpgrade` skippable and forced

| Field       | Value                                                                                                                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase       | PX: Customer portal (docs/design/PORTAL.md) (phase B: new API, S-16, S-17)                                                                                                                             |
| Size        | 0.4–0.8 engineer-weeks                                                                                                                                                                                 |
| Depends on  | [PX-05](PX-05-login-card-today.md), [PX-W4](PX-W4-email-code.md), [PX-W9](PX-W9-key-entry-counting.md), [I-16](I-16-passkeys.md), [I-06](I-06-login-providers.md)                                      |
| Unblocks    | [PX-14](PX-14-passthrough-header.md), [PX-15](PX-15-after-sign-in.md), [PX-21](PX-21-email-gate-ui.md)                                                                                                 |
| Role        | `pkey-implementer`                                                                                                                                                                                     |
| Plan mode   | no                                                                                                                                                                                                     |
| Gates       | the PORTAL.md §11 green gate; CSP browser test (zero violations); admin build; `pnpm --filter @polaris-key/admin test:e2e` with zero CSP violations; `vitest-axe` on new page components; THREAT-MODEL |
| Human input | none                                                                                                                                                                                                   |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                              |

## Amendments from approved plans (2026-10-05)

The owner approved the plans below on 2026-10-05. These amendments win over the text of this brief where they differ.

- **[`plans/PX-W9.md`](../plans/PX-W9.md):** Q4: a signed-out, read-only `POST /api/key/preview` feeds the meter and never counts; "Skip" counts nothing; the copy "This was entry 3" becomes "This will be entry 3".

## Sign-in alignment (2026-10-05): SIGN-IN.md

[`docs/design/SIGN-IN.md`](../../../../design/SIGN-IN.md) is the canonical sign-in experience, and `plans/I-04.md`
§F (the reconciliation, with delegated decisions 16–24) is its wire counterpart. Where this brief
differs from either, they win. Copy comes from SIGN-IN.md §5.2 (`signin.*`, US "license").
**No device-wire change** (`PROTOCOL_VERSION` 4, `corpusVersion` 2). For this package:

- Copy per SIGN-IN.md §3.3–§3.4: no lede on portal direct; the logo-only provider row (Apple, Google, Steam); **Have a license key?** and **Sign in with another device** under a rule; six-cell code input as one field; "{n} tries left."; no "Polaris Key · key.plrs.im" footer. Skip only when an app sent the person (D-36).

## Follow-ups from the 2026-10-06 reviews

Checked against `main` at `148439c4f`. Each item names the package whose review raised it.

- **Passkey button and conditional UI** ([I-16](I-16-passkeys.md)). I-16 shipped the Worker half
  only: `POST /api/signin/passkey/options` and `/verify`, and `auth.passkey` in
  `GET /api/capabilities`. The card has no passkey button yet. The email field already carries
  `autocomplete="username webauthn"`. When verify refuses with `unknownCredential: true` (no account
  holds that credential id), call `PublicKeyCredential.signalUnknownCredential({ rpId, credentialId })`
  where the browser has it, so the authenticator stops offering a passkey that can no longer sign
  in. Every other refusal stays the one `401 unauthorized`.
- **Send a new code on the expired-link page** ([PX-W4](PX-W4-email-code.md), which left it out).
  SIGN-IN.md §3.13 and §4.12 (frame 15) want the Worker's expired or used code/link page to offer
  **Send a new code** to the masked address and land on CodeStep with `returnTo` and the request
  handle intact. Today a flow lives exactly as long as its code (10 minutes), so `expiredLinkPage`
  (`card/emailSignIn.ts`) knows no address and takes the spec's "without a known address" branch
  (**Sign in again**). Three things are needed:
  - a flow record that outlives its code (I-07's flow lifetime);
  - a no-JS form `POST` path from that page into the resend;
  - `GET /api/signin/flow`, so the SPA can read the flow (the masked address, `resendIn`) when it
    lands on the code step after that plain `POST`.

  Only `POST /api/signin/flow` (the asking browser's poll) exists today. A new route needs its
  OpenAPI operation, a `PORTAL_KIND_PATHS` row in `routeCoverage.test.ts` (rule 10) and a line on
  the docs site's portal page.

- **Already done (PX-W4):** `SignInPage.tsx` resends through `POST /api/signin/email/resend`, counts
  down from `resendIn`, shows a 429's `retryAfter`, handles the per-flow cap and returns to the
  email step on `signin_expired`. `CodeEntry` keeps that behaviour; there is nothing left to build
  for the resend itself.

## Goal

The login card is identifier-first with the usual-method hint from the `pk_last_method` cookie, code entry, passkey button and conditional UI, the logo-only Apple/Google/Steam row per product, the license-key path, and `AccountUpgrade` (skippable while entries remain, forced at zero with the entries meter).

## Why

The full sign-in experience ([PORTAL.md §4.1](../../../../design/PORTAL.md#41-the-login-card)); providers must ship together with the email gate (PX-21, [PORTAL.md §11.4](../../../../design/PORTAL.md#114-order)). PORTAL.md sizes this M (2–4 agent-days); the owner approved the design on 2026-10-04.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [docs/design/PORTAL.md](../../../../design/PORTAL.md) in full once, then: [PORTAL.md §11.3](../../../../design/PORTAL.md#113-phase-b-features-on-the-new-api-s-16-and-s-17) (this package's row) and [PORTAL.md §11.4](../../../../design/PORTAL.md#114-order).
- [PORTAL.md §4.1](../../../../design/PORTAL.md#41-the-login-card), [PORTAL.md §4.3](../../../../design/PORTAL.md#43-known-account-you-usually-sign-in-with-steam), [PORTAL.md §4.4](../../../../design/PORTAL.md#44-enter-the-code), [PORTAL.md §4.5](../../../../design/PORTAL.md#45-use-a-license-key), [PORTAL.md §4.6](../../../../design/PORTAL.md#46-key-entry-the-account-upgrade-skippable-then-forced), [PORTAL.md §10.2](../../../../design/PORTAL.md#102-gaps-the-worker-must-close), [PORTAL.md §11.4](../../../../design/PORTAL.md#114-order)
- `docs/design/BRAND.md` and `@polaris-key/brand`; the console kit in `packages/admin/src/ui/`.

## Scope

**In:**

- `MethodStack`, `UsualMethodHint` (sets and reads `pk_last_method`: kind and a salted email hash, no PII), `CodeEntry`, passkey button and conditional UI, `ProviderRow`, license-key path, `AccountUpgrade`.

**Out** (and where it belongs instead):

- Email gate step (→ PX-21; must ship in the same release as the providers)

## Design notes

- **Providers** (owner decisions): one login card for every entry; the provider row is logo-only Apple, Google and Steam, filtered per product by where it ships; no Discord anywhere.
- **License keys** are the real format `pkey_<product>_<22 base64url>`; `KeyField` never groups or changes case and trims whitespace only.
- **Email field autocomplete:** wave 1 (PX-05) ships `autocomplete="email"`; with passkeys this changes to `username webauthn` (§4.1) so conditional UI can offer them.
- **THREAT-MODEL note (G30):** the hint is never derived from a server lookup (no enumeration).
- **Dependency ids.** PORTAL.md §10.3 and §11 were written against the first revision of phase I; the graph maps them onto the re-cut S-16 ids (see README §8, phase PX): portal I-06 → I-05 (accounts, links, pairwise subjects), I-05 and I-20 (Google, Apple) and I-12's web Steam → I-06, I-08 (email login) → I-07, I-14 (passkeys) → I-16, I-13 (native redirect) → I-15, I-15 (sessions) → I-07, I-16 (per-product issuer) → I-08 for layer 1 (I-21 later), S-17 → U-05.

## Steps

1. Re-read the PORTAL.md sections above and the matching mockups in `docs/design/portal/`; verify this brief against the code and record any correction here.
2. Implement the **In** list in small commits prefixed `PX-12:`.
3. Add the tests named in the acceptance criteria.
4. Run the green gate and the extra gates in the header; set `--set PX-12 in-review`.

## Acceptance criteria

- [ ] WebAuthn mocks cover passkey sign-in and conditional UI.
- [ ] Forced-upgrade test at zero entries; skippable while entries remain.
- [ ] No-enumeration test: responses and timing do not reveal whether an email has an account.
- [ ] `pnpm --filter @polaris-key/admin build` passes and `pnpm --filter @polaris-key/admin test:e2e` reports zero CSP violations.
- [ ] `vitest-axe` passes on every new or changed page component; one `h1` per screen (§9).
- [ ] No horizontal page scroll at 360 px on every screen this package touches (§8).
- [ ] The green gate passes (`AGENTS.md` and PORTAL.md §11), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin test:e2e
```

## Hand-off

PX-14, PX-15 and PX-21 build on the v2 card.

The role agent sets `--set PX-12 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set PX-12 done`.
