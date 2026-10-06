# I-08 App passthrough: the "<App> wants you to sign in" header, Continue-to-App grants, device code onto the card with callback binding, QR sign-in, and the web redirect (authorize plus PKCE code exchange) that gives product web apps a browser device token

| Field       | Value                                                                                                                                                                                                                                                                                    |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | I: Identity: one Polaris Key account, then per-app identity (S-16) (layer-1, phase-1a)                                                                                                                                                                                                   |
| Size        | 1.2–1.7 engineer-weeks                                                                                                                                                                                                                                                                   |
| Depends on  | [I-04](I-04-account-contract-plan.md), [I-07](I-07-login-card-email.md), [I-09](I-09-key-entry-attach.md), [PX-W13](PX-W13-passthrough-metadata.md), [I-26](I-26-legacy-oidc-license-choice.md)                                                                                          |
| Unblocks    | [I-10a](I-10a-sdk-identity-node-react-python.md), [I-10b](I-10b-sdk-identity-swift-kotlin-godot.md), [I-15](I-15-native-redirect.md), [I-24a](I-24a-named-user-seats-server.md), [U-05](U-05-cloud-sync-do.md), [U-20](U-20-sdk-settings-react.md), [PX-14](PX-14-passthrough-header.md) |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                                                                                                                                                                                                                    |
| Plan mode   | yes: executes the approved [`plans/I-04.md`](../plans/I-04.md) (no separate plan)                                                                                                                                                                                                        |
| Gates       | plan mode; `errors.json` (rule 3), transcripts (rule 1), `gen:constants -- --check`; rule 10 (OpenAPI + `routeCoverage`); THREAT-MODEL; `test:workerd`                                                                                                                                   |
| Human input | none                                                                                                                                                                                                                                                                                     |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                                                |

## Amendments from approved plans (2026-10-05)

The owner approved the plans below on 2026-10-05. These amendments win over the text of this brief where they differ.

- **[`plans/I-09.md`](../plans/I-09.md):** call `bindSignedInDevice`; re-record `identity-attach.json` with real device-code sign-in; `accountPortal` is I-09's, not I-08's.
- **[`plans/PX-W13.md`](../plans/PX-W13.md):** reuse PX-W13's request handle and `__Host-pk_req` binder for the R1-07 callback binding; write `account_product_grants.scope_hash` on Continue; Continue reads `AppConsentView`.
- **[`plans/PX-W17.md`](../plans/PX-W17.md):** the passthrough context answers `identity_disabled`, and reads `identityEnabled`.
- **[`plans/PX-W8.md`](../plans/PX-W8.md):** Q5: the sign-in seat refusal (`oidc.ts:944`) stays as it is in I-08; LX-18's `not_entitled` with `reason: device_limit` carries `manageUrl` from the same builder.

## Owner decision (2026-10-05): licence choice at sign-in

The owner decided on 2026-10-05 that every sign-in that binds a device asks the person which licence to use (**Choose a license for this device**, with an inline **Replace a device** on full licences), never silently mints a second auto-issued licence, and treats the rank-first rule as the preselected default only. The verbatim decision, the card API and the delegated decisions are in [`plans/I-04.md`](../plans/I-04.md), "Owner decision (2026-10-05): licence choice at sign-in"; that section wins over this brief where they differ. **The device wire does not change** (`PROTOCOL_VERSION` 4, no corpus change).

For this package:

- **Dependencies.** I-08 now depends on **I-09**, for `rankAnchorCandidates` and
  `bindSignedInDevice(…, choice)`; on **PX-W13**, for the request handle, the binder and the
  consent route; and on **I-26**, so that the two packages edit `oidc.ts` in sequence.
- **Card API** (I-04 amendment §C). Add `GET /api/signin/requests/:handle/licenses`
  (`LicenseChoiceView`) and `GET …/licenses/:licenseId/devices` (`ReplaceView`). The Continue
  `POST` gains `choice` (`license` with an optional `replaceDeviceId`, `keep` or `create`). Every
  binding route stores the choice in its flow or code record: device code with its QR, the web
  redirect and, later, I-15.
- **`freeAccountDevice()`.** Extract it from the portal's `handleDeviceDelete`. The portal DELETE
  and the card's Replace call the same function, with the same ownership check, `portal_enabled`
  check, `portalDeviceDisconnect` budget (20 per 60 s, shared by both surfaces), audit row
  `portal.device.disconnect` and `deviceRemovedNotice` email. A blocked Replace answers
  `429 rate_limited` with `retryAfter`.
- **`errors.json`**: `license_choice_required` (409, identity).
- **Transcripts**: `devicecode-choose.json`, `devicecode-replace.json`,
  `devicecode-choice-required.json`, `devicecode-autoissue.json` and `redirect-web-choose.json`.
- **OpenAPI and `routeCoverage`** for the two routes (rule 10), and THREAT-MODEL notes.
- **Retire the legacy page.** When the card takes over the device page (PX-14), delete I-26's
  legacy chooser page and keep its rule. `provider: platform` products with Identity on stop
  calling `activateFromIdentity`'s `sub`-keyed mint.
- **Acceptance (additions).**
  - Sign-in never mints while the account holds a usable licence, unless `choice.kind` is
    `create` (test).
  - Continue without a choice answers 409 when the step was shown (test).
  - Replace and the portal's Remove share one rate-limit budget and write the same audit row
    (test).

## Sign-in alignment (2026-10-05): SIGN-IN.md

[`docs/design/SIGN-IN.md`](../../../../design/SIGN-IN.md) is the canonical sign-in experience, and `plans/I-04.md`
§F (the reconciliation, with delegated decisions 16–24) is its wire counterpart. Where this brief
differs from either, they win. Copy comes from SIGN-IN.md §5.2 (`signin.*`, US "license").
**No device-wire change** (`PROTOCOL_VERSION` 4, `corpusVersion` 2). For this package:

- **Two steps.** LicenseChoiceStep, then ConsentStep (first time or a scope change) showing the chosen license with **Change** (SIGN-IN.md §3.6, §3.8). With no Consent, **Use this license and continue** is the explicit Continue D22 requires.
- **Card API per `plans/I-04.md` §C as amended by §F:** `LicenseChoice` gains `current` and `access` (`"seats" | "account"`, `seats.limit: null` for Account-wide); `keep` is true only for a licence outside `choices`; `create` gains `access`; `getLicense` gains `keyEntry`. `ReplaceView` answers `404 not_found` for an Account-wide licence.
- **Replace in one D1 batch** (§F.3): `freeAccountDevice()` (already extracted on the I-26 branch, `portal/freeDevice.ts`) returns its statements and the Continue appends the guarded seat claim; `signin.replace.racedAfterFree` only if the claim cannot join the batch. The device-replaced email is the `deviceRemovedNotice` variant of SIGN-IN.md §3.15.
- **Cancel returns `access_denied`** on every surface (§F.8): redirect `error=access_denied`, device code denies the code. No new poll answer.
- **The device-code `confirm`/attach** is offered only after **Keep** (unchanged rule, I-04 decision 4). Drop approval-by-QR from scope: PX-W14 owns it (SIGN-IN.md D-18). `verification_uri` is `<origin>/device`; `/tv` is an alias for TV and console screens (D-16).
- **ReturnStep variants** per SIGN-IN.md §3.10; the Worker device-code pages (`renderDeviceEntry`, `renderDeviceConfirmation`, `signedInPage`) become the card with the app header (§3.13, with UX-43).
- **Transcripts:** add `devicecode-account-wide.json` (I-04 §F.6) to §C's list; `gen:transcripts` writes the Swift and Godot mirrors.
- **THREAT-MODEL:** the ReplaceDevice row (fresh-session step-up, shared `portalDeviceDisconnect` budget, the confirm naming both devices, the notice). Retire I-26's page when the card ships, keeping its rule.

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
