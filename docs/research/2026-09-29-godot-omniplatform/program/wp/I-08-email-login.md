# I-08 Email login method: flow-bound email codes and magic links, hosted page with Turnstile, revocable product sessions, device-code confirm screen and callback binding

| Field       | Value                                                                                                                                                                                |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase       | I: Identity service (S-16) (phase-1, MVI)                                                                                                                                            |
| Size        | 1–1.4 engineer-weeks                                                                                                                                                                 |
| Depends on  | [I-02](I-02-single-use-store.md), [I-04](I-04-identity-plan.md), [I-06](I-06-users-and-links.md), [I-21](I-21-email-delivery.md)                                                     |
| Unblocks    | [I-09](I-09-pocket-id-migration.md), [I-11](I-11-sdk-identity-v2-email.md), [I-14](I-14-passkeys.md), [I-16](I-16-product-issuer.md)                                                 |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                                                                                                                |
| Plan mode   | yes: executes the approved [`plans/I-04.md`](../plans/I-04.md) (no separate plan)                                                                                                    |
| Gates       | plan mode; `errors.json` (rule 3), transcripts (rule 1), `gen:constants -- --check`; rule 10 (OpenAPI + `routeCoverage`); THREAT-MODEL; D1 migration; `TABLE_OWNERS`; `test:workerd` |
| Human input | a Turnstile site key and secret per environment (Cloudflare)                                                                                                                         |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                            |

## Goal

Products can offer email sign-in: `POST /<p>/identity/email/start` and `/verify` (flow-bound one-time codes) and magic links, a product-branded hosted page with Turnstile, in-SDK start gated on a registered device token, enumeration-safe responses; a signed, revocable, product-scoped browser session replaces the fused document; and the device-code confirm screen and callback binding close R1-07.

## Why

Most indie and Godot studios have no IdP (J2, G6). The email routes are device wire, so this executes the approved I-04 plan. Device code becomes the front door for email and upstream sign-in on TVs and Godot, so the R1-07 phishing residual must close here or device-code email sign-in waits ([S-16 §5.3](../../notes/S-16-identity-service.md#53-wire-impact), [S-16 §5.4](../../notes/S-16-identity-service.md#54-threat-model-deltas) items 4, 6, 7; [S-16 §9](../../notes/S-16-identity-service.md#9-risks-and-open-questions) risk 9).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode).
- [S-16 owner decisions](../../notes/S-16-identity-service.md) (2026-10-04, the note's header).
- [`plans/I-04.md`](../plans/I-04.md) (this package executes it), [S-16 §5.4](../../notes/S-16-identity-service.md#54-threat-model-deltas) items 4, 6 and 7, [S-16 §8](../../notes/S-16-identity-service.md#8-work-packages) row I-08, [S-16 §10](../../notes/S-16-identity-service.md#10-owner-decisions) D16.
- `packages/worker/src/services/identity/browserSession.ts:76-99`, `doc.ts:7-12`, `oidc.ts:80`.
- `packages/worker/src/core/brandHtml.ts` (`renderBrandPage`), `migrations/0008_portal.sql:57` (`branding_json`).
- `docs/security/THREAT-MODEL.md:2148-2154` (R1-07).

## Scope

**In:**

- Wave order: contract (from I-04) → `errors.json` (rule 3) → routes → transcripts (rule 1) → OpenAPI + `routeCoverage` (rule 10).
- Email code and magic-link flows on I-02's single-use store and limiters, sent through I-21.
- Hosted page with Turnstile; magic-link landing `POST`.
- `identity_sessions`: signed, revocable, listable sessions keyed `(product, id hash)`.
- Device-code confirm screen and callback binding.
- Discovery `methods[]` advertises `email` when enabled.

**Out** (and where it belongs instead):

- SDK calls (→ I-11).
- Passkeys (→ I-14).
- Sending infrastructure and DNS (→ I-21).

## Design notes

- **Email-code verify-side limits (safety defaults):** 6-digit codes, 10-minute lifetime, dead after 5 wrong attempts; a new code for the same recipient and flow invalidates the old one; 10 wrong attempts across codes in an hour lock the recipient out of new codes for 15 minutes, answered exactly like success.
- **Send side:** per-recipient (hashed) 5 an hour and 20 a day; per-IP and per-network limits; per-product daily cap; identical responses for known and unknown emails; a landing-page `POST` so link prefetchers cannot burn magic links; Turnstile on the hosted page.
- **Binding:** `start` returns an opaque `flow_id` bound to product, login method and requester (the device token's device, or a hash of the browser's flow cookie); `verify` checks all three. A code for product B's flow or another device's flow cannot be redeemed at A.
- **In-SDK start** requires a registered device token (3 starts an hour per device, on top of per-recipient and per-network limits). A product can turn in-SDK start off; then, and in any SDK without a device token, the SDK opens the hosted page (Turnstile runs there) and completes through device code or loopback.
- **Magic link opened on another device** completes the requesting flow, not the opening browser: it shows "Confirm sign-in to <Product> on <device>, requested at <time>" and a Confirm `POST`; it gets its own session only with the requesting flow's cookie.
- The email names the product and the requesting device and says "never share this code". New email sign-ins never link new identities to an existing user without that user's session.
- **Device-code confirm screen (R1-07):** bind the IdP or email callback to the browser that confirmed the user code; the screen names the product, the login method and the requesting device (reported name and platform, labelled "reported by the device"); an explicit Confirm `POST` after sign-in, never auto-completing; the code lives at most 10 minutes (`FLOW_TTL_SECONDS = 600`); warn when the approving browser's network or country differs from the requester's, with the text "only continue if this code is on your own screen".
- **Tenant isolation on the shared origin:** cookie `Path` is not a boundary on `key.plrs.im`. Cookie name carries the slug; every session lookup is `(product, hash)`; a test asserts product A's cookie is rejected at product B; no cross-product SSO. `branding_json` is data, never markup, rendered into Polaris templates under the strict CSP; every hosted page carries the fixed line "Sign-in for <Product>, operated by Polaris Key" with the slug; the validator reserves Polaris, Polaris Key, plrs, portal, console and admin as names.
- Write THREAT-MODEL sections for §5.4 items 4, 6 and 7, and the D-14 replacement decision record named in the I-04 plan.

## Steps

1. `errors.json` and contract types from the plan.
2. Routes on the single-use store with limit tests.
3. Sessions and the fused-document removal.
4. Hosted pages, confirm screens and Turnstile.
5. Transcripts, OpenAPI, THREAT-MODEL.

## Acceptance criteria

- [ ] Every limit and lifetime above is enforced (tests, including lockout-looks-like-success).
- [ ] A code from another product's or another device's flow is refused (tests).
- [ ] Known and unknown emails produce byte-identical `start` responses (test).
- [ ] Product A's session cookie is rejected at product B (test).
- [ ] Device-code completion requires the Confirm `POST` from the browser that entered the user code (test); the screen shows the device as "reported by the device".
- [ ] `verify` returns the existing activation response; `PROTOCOL_VERSION` unchanged.
- [ ] Transcripts recorded; `errors.json`, OpenAPI and `routeCoverage` updated; THREAT-MODEL sections written.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- identity email session devicecode
mise exec node@22 -- pnpm gen:transcripts -- --check
mise exec node@22 -- pnpm gen:constants -- --check
mise exec node@22 -- pnpm --filter @polaris-key/worker test:workerd
```

## Hand-off

- I-11 implements the SDK side against these transcripts.
- I-09 moves platform end users onto this login.
- I-14 adds passkeys behind a verified email.

The role agent sets `--set I-08 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set I-08 done`.
