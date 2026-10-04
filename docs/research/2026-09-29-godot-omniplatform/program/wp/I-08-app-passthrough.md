# I-08 App passthrough: the "<App> wants you to sign in" header, Continue-to-App grants, device code onto the card with callback binding, QR sign-in, and the web redirect (authorize plus PKCE code exchange) that gives product web apps a browser device token

| Field       | Value                                                                                                                                                                                                                                         |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | I: Identity: one Polaris Key account, then per-app identity (S-16) (layer-1, phase-1a)                                                                                                                                                        |
| Size        | 1.2–1.7 engineer-weeks                                                                                                                                                                                                                        |
| Depends on  | [I-04](I-04-account-contract-plan.md), [I-07](I-07-login-card-email.md)                                                                                                                                                                       |
| Unblocks    | [I-10a](I-10a-sdk-identity-node-react-python.md), [I-10b](I-10b-sdk-identity-swift-kotlin-godot.md), [I-15](I-15-native-redirect.md), [U-05](U-05-cloud-sync-do.md), [U-20](U-20-sdk-settings-react.md), [PX-14](PX-14-passthrough-header.md) |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                                                                                                                                                                         |
| Plan mode   | yes: executes the approved [`plans/I-04.md`](../plans/I-04.md) (no separate plan)                                                                                                                                                             |
| Gates       | plan mode; `errors.json` (rule 3), transcripts (rule 1), `gen:constants -- --check`; rule 10 (OpenAPI + `routeCoverage`); THREAT-MODEL; `test:workerd`                                                                                        |
| Human input | none                                                                                                                                                                                                                                          |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                     |

## Goal

An app can send a person to the login card and get them back signed in: the card carries a persistent "<App> wants you to sign in" header and ends with "Continue to <App>"; device code lands on the card with callback binding and an explicit Continue; a person can approve a sign-in on another device by QR; and a product web app gets a browser device token through a PKCE web redirect, never through a token in a URL.

## Why

Passthrough is how an app with the Identity service on reaches the shared account without hosting credential entry ([S-16 §5.3](../../notes/S-16-identity-service.md#53-wire-impact); D17, accepted). It is the core of the per-product Identity service (owner, 2026-10-04): the account itself is platform-level, but "<App> wants you to sign in" exists only for products whose `identity` toggle is on. Device code becomes a main front door against an account holding every developer's licences, so R1-07 closes here ([S-16 §5.4](../../notes/S-16-identity-service.md#54-threat-model-deltas) item 6). The web redirect is S-17's browser principal (decision 19) and the only way to web Cloud Sync (decision 23, decided by the owner 2026-10-04 in the final answers); Cloud Sync needs sign-in and requires Identity, so the sign-in this package delivers is how every device reaches Cloud Sync ([S-17 §6](../../notes/S-17-user-data-sync.md#6-phases-and-work-packages)).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode); [`plans/I-04.md`](../plans/I-04.md) (this package executes it).
- [S-16 owner decisions](../../notes/S-16-identity-service.md), [S-16 §5.3](../../notes/S-16-identity-service.md#53-wire-impact) (passthrough and web redirect rows, the notes below the table), [S-16 §5.4](../../notes/S-16-identity-service.md#54-threat-model-deltas) items 6, 7 and 13, [S-16 §8](../../notes/S-16-identity-service.md#8-work-packages) row I-08.
- [S-17 §6](../../notes/S-17-user-data-sync.md#6-phases-and-work-packages) ("I-08 gains a new wire row"), [S-17 §7.3](../../notes/S-17-user-data-sync.md#73-owner-decisions) decision 19.
- `packages/worker/src/services/identity/oidc.ts:80` (`FLOW_TTL_SECONDS`), `packages/worker/src/core/cors.ts`, `packages/worker/src/core/brandHtml.ts`, `docs/security/THREAT-MODEL.md:2148-2154` (R1-07); P0-05's `web.origins`.

## Scope

**In:**

- Wave order: contract (I-04) → `errors.json` (rule 3) → routes → transcripts (rule 1) → OpenAPI + `routeCoverage` (rule 10).
- Passthrough header from `branding_json` as data, product slug in fixed text; "Continue to <App>" recorded in `account_product_grants` with the consented profile claims.
- Device code onto the card: callback bound to the browser that confirmed the user code; the card names the app and the device ("reported by the device"); explicit Continue `POST`, never auto-completing even with an account session; codes live at most 10 minutes; a warning when network or country differ. Poll result members `subject` and `attachable`.
- QR sign-in on another device for the card.
- **Web redirect:** `GET /<p>/identity/authorize` (`redirect_uri`, `state`, `code_challenge`, S256 only) → card → `302` to `redirect_uri?code=…&state=…`; `POST /<p>/identity/redirect/token` (route name per I-04) with `code` and `code_verifier` returns the activation response (browser device token, device id, pairwise subject); CORS for the product's `web.origins` only, without credentials.
- Per-product start rate limits; discovery advertises the routes.
- **Behind the product's `identity` toggle** (owner, 2026-10-04): with it off, `authorize`, the code exchange and device-code passthrough answer as for an unknown service and discovery advertises no sign-in routes; the card never shows a passthrough header for that product.

**Out** (and where it belongs instead):

- SDK calls (→ I-10a, I-10b); native redirect URIs on the same token route (→ I-15).
- Attach and key-entry refusals (→ I-09).

## Design notes

- **Never a token in a URL or fragment.** The code lives 60 seconds, is single use in I-02's store, and is bound to the `code_challenge`, the product, the origin and the redirect URI. `redirect_uri`'s origin must equal a `web.origins` entry exactly (scheme, host, port) and its path must be in `identity.redirectPaths`; no wildcard, prefix or suffix matching; a mismatch shows an error on the card and never redirects.
- **No silent grants (D22, accepted by the owner 2026-10-04).** No silent SSO into apps: the first sign-in to each app needs "Continue to <App>"; later web redirects may skip it, device code never does.
- **Bounded yield.** A flow returns only the product the card names, its licences, its pairwise subject and the consented claims; never an account session. Anyone can start a flow for any product (no registered clients in layer 1): the card's product name, explicit Continue, exact origin matching and start rate limits are the mitigation ([S-16 §5.4](../../notes/S-16-identity-service.md#54-threat-model-deltas) item 6 residual).
- `PROTOCOL_VERSION` unchanged; additive and feature-detected.
- The first-party session cookie is never accepted on Cloud Sync routes (S-17 decision 19).

## Steps

1. `errors.json` and contract types from the plan.
2. Passthrough header, grants and Continue.
3. Device-code binding and confirm screen; QR.
4. Authorize and code exchange with CORS.
5. Transcripts, OpenAPI, THREAT-MODEL sections for items 6, 7 and 13.

## Acceptance criteria

- [ ] Device-code completion requires the Continue `POST` from the browser that entered the user code (test).
- [ ] An unlisted origin, an unlisted path or a near-match is refused without a redirect (tests); a replayed or expired code and a wrong verifier are refused (tests).
- [ ] The exchange answers CORS for listed origins only, never with credentials (test).
- [ ] An existing account session does not skip Continue on a first sign-in to an app, nor ever on device code (tests).
- [ ] With the product's Identity toggle off, every passthrough route is refused and discovery lists none (test).
- [ ] Transcripts recorded; `errors.json`, OpenAPI and `routeCoverage` updated; THREAT-MODEL sections written; `PROTOCOL_VERSION` unchanged.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- identity passthrough devicecode redirect
mise exec node@22 -- pnpm gen:transcripts -- --check
mise exec node@22 -- pnpm gen:constants -- --check
```

## Hand-off

- I-10a (React web redirect) and I-10b implement the SDK side against these transcripts.
- I-15 reuses the token route for native redirect URIs; U-20 uses the browser device token for web Cloud Sync.

The role agent sets `--set I-08 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set I-08 done`.
