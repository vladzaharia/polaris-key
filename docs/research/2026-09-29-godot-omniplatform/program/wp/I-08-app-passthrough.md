# I-08 App passthrough on an OAuth-shaped authorize and token (absorbs PX-W18)

> **Plan approved (lead, 2026-10-17): [`plans/I-08.md`](../plans/I-08.md).** It narrows this brief: the licence-choice half moves to I-08b, the device-code half to I-37, and the plan wins where they differ.

| Field       | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | I: Identity: one Polaris Key account, then per-app identity (S-16) (layer-1, phase-1a)                                                                                                                                                                                                                                                                                                                                                                   |
| Size        | 0.8–1.1 engineer-weeks                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Depends on  | [I-04](I-04-account-contract-plan.md), [I-07](I-07-login-card-email.md), [I-09](I-09-key-entry-attach.md), [PX-W13](PX-W13-passthrough-metadata.md), [I-26](I-26-legacy-oidc-license-choice.md), [I-27](I-27-plan-identity-consolidation.md), [P0-20](P0-20-split-identity-oidc-ts-extract-issuance.md), [HA-12](HA-12-presentation-discovery.md)                                                                                                        |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [I-08b](I-08b-licence-choice-api.md), [I-15](I-15-native-redirect.md), [I-24a](I-24a-named-user-seats-server.md), [I-36](I-36-sign-in-integration-card.md), [I-37](I-37-device-code-explicit-confirm.md), [I-40](I-40-account-initiated-pairing.md), [U-05](U-05-cloud-sync-do.md), [U-20](U-20-sdk-settings-react.md), [PX-14](PX-14-passthrough-header.md), [SP-40](SP-40-retire-react-cookie-mode-browser.md) |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                                                                                                                                                                                                                                                                                                                                                                                    |
| Plan mode   | yes: executes the approved [`plans/I-27.md`](../plans/I-27.md) (2026-10-08) §2.1, §2.2 and the hints, which amends [`plans/I-04.md`](../plans/I-04.md)                                                                                                                                                                                                                                                                                                   |
| Gates       | plan mode; `errors.json` (rule 3); transcripts (rule 1) with the Swift and Godot mirrors; `gen constants --check`; `parity:check`; rule 10 (OpenAPI + `routeCoverage`); THREAT-MODEL; `test:workerd`                                                                                                                                                                                                                                                     |
| Human input | none                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                                                                                                                                                                                                                |

## Goal

An app sends a person to the login card and gets them back signed in. The card carries a persistent "<App> wants you to sign in" header, and ends with "Continue to <App>". A product web app signs in through an OAuth-shaped `authorize` and `token` with PKCE and gets a browser device token, never a token in a URL. All of it runs only while the product's Identity service is on.

## Why

Passthrough is how an app reaches the one Polaris Key account without hosting credential entry ([S-16 §5.3](../../notes/S-16-identity-service.md#53-wire-impact); D17). Device code becomes a main front door, so R1-07 closes here ([S-16 §5.4](../../notes/S-16-identity-service.md#54-threat-model-deltas) item 6). The web redirect is S-17's browser principal (decision 19) and the way to web Cloud Sync (decision 23).

Sources: [`plans/I-27.md`](../plans/I-27.md) (§2.1, §2.2, §4, the hints from PX-W18), [`plans/I-04.md`](../plans/I-04.md) (§C, §F and §G as I-27 amends them), [`plans/I-09.md`](../plans/I-09.md), [`plans/PX-W13.md`](../plans/PX-W13.md), [`plans/PX-W17.md`](../plans/PX-W17.md), [`plans/PX-W8.md`](../plans/PX-W8.md) Q5, [`plans/PX-W9.md`](../plans/PX-W9.md) and [`plans/UK-02b.md`](../plans/UK-02b.md) §8; the experience is [`SIGN-IN.md`](../../../../design/SIGN-IN.md) (copy from §5.2, `signin.*`).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode).
- [`plans/I-27.md`](../plans/I-27.md) §2.1, §2.2, §4, §10 and its owner decisions; [`plans/I-04.md`](../plans/I-04.md) §C, §F and §G.
- [SIGN-IN.md](../../../../design/SIGN-IN.md) §2.4, §3.6–§3.18, §4.16 and D-78–D-93.
- `packages/worker/src/services/identity/oidc.ts:80` (`FLOW_TTL_SECONDS`), `packages/worker/src/core/cors.ts`, `packages/worker/src/core/brandHtml.ts`, `docs/security/THREAT-MODEL.md:2148-2154` (R1-07).

## Scope

**In:**

- **The authorization server (I-27 §2.1).** The issuer is `<origin>/<p>/identity`; discovery's identity fragment gains `issuer`, the `authorize` and `token` endpoints and `configured: true`. `client_id` is the product slug, a public client with PKCE; any other value is `invalid_client`.
- **`GET /<p>/identity/authorize`:** `response_type=code`, `client_id`, `redirect_uri` (origin in `core.web.origins` and path in `identity.redirectPaths`, both exact), `state` (16 to 512 characters), `code_challenge` with `S256` only, optional `scope` (`profile`, `email`, `cloudSync`; absent means the product's whole `identity.claims` set; `openid` answers `invalid_scope` until I-21), `nonce` (kept for I-21), `login_hint`, and the Polaris extensions `name_hint`, `purpose` (`signin` or `attach`) and `license_choice` (`card` or `app`). A bad `client_id` or `redirect_uri` renders `invalid_client` or `redirect_uri_mismatch` on the card and never redirects. Later errors are `302 redirect_uri?error=…&state=…&iss=<issuer>` with `invalid_request`, `invalid_scope`, `access_denied` (Cancel) or `server_error`. Success is `302 redirect_uri?code=…&state=…&iss=<issuer>` (RFC 9207); the code lives 60 s, single use in I-02's store, bound to the product, `client_id`, `redirect_uri`, `code_challenge` and the granted scope.
- **`POST /<p>/identity/token`** (`grant_type=authorization_code`), form-encoded, `no-store`, CORS for `core.web.origins` only and never with credentials; it requires `X-PKey-Device` and the metadata headers, and a JSON body is `invalid_request`. A `200` carries exactly `access_token` (the `pkeyt_` device token), `token_type: "Bearer"`, `scope` (the granted subset), `schemaVersion`, `device`, `license` (`null` on a licence-less device), `keyEntries` only when the flow entered a key, and `subject`. No `expires_in` and no `refresh_token` before I-21. Errors are RFC 6749's flat body: `invalid_request`, `invalid_client`, `invalid_grant`, `unsupported_grant_type`, `invalid_scope`; the Polaris refusals `not_entitled`, `device_limit`, `license_owned`, `key_entry_limit` and `429 rate_limited` with `retryAfter` are flat too. I-08 deletes "I-21 appends `oauth/authorize`" from WIRE-CONTRACT-V4 §12.8 rule 3 and writes §12.4–§12.5. The `choose` answer arrives with [I-08b](I-08b-licence-choice-api.md); `token` records the mode so it is added without reshaping.
- **Hints (absorbs PX-W18).** `login_hint`, `name_hint` and `purpose` on `authorize`, carried on the request record. A hint prefills the card and never verifies anything. The device-code hints (`auth/device/start`) are dropped: device code fails closed under I-37 ([plan D4](../plans/I-08.md)).
- **The card and its routes.** The header comes from `resolvePresentation` (HA-12) as data. Continue (always shown, plan D3) and Cancel are portal API routes, `POST /api/signin/requests/:handle/continue` and `…/cancel`, each needing the account session, CSRF and the `__Host-pk_req` binder (PX-W13's request handle; the R1-07 binding for the web redirect), and each answering `{redirect}`. Continue records `account_product_grants` with the consented claims (`scope_hash`; Continue reads `AppConsentView`). The code binds the device at `token` through I-09's `bindSignedInDevice`. Worker-rendered refusal pages (`brandHtml`) for `invalid_client` and `redirect_uri_mismatch`. The device-code pages are I-37's. `validateRedirectUri` returns a `ClientKind` so I-15 widens one function.
- **Terms and verified email.** A passthrough sign-in passes the product's `identity.terms` (I-09's reader) into `beginProviderSignIn` as `product.terms`; acceptances live in `account_terms_acceptances`. Each verification point I-08 adds calls `onAccountEmailVerified`; whichever of I-08 and I-09 lands second drops the per-request sweep from `portal/api.ts`.
- **Behind the Identity toggle.** With it off, `authorize`, `token`, and the I-08b choice routes answer as for an unknown service, discovery lists no sign-in routes, and the passthrough context answers `identity_disabled` (PX-W17).
- **Contract artefacts.** `errors.json`: the six OAuth codes `invalid_request`, `invalid_client`, `invalid_grant`, `unsupported_grant_type`, `invalid_scope`, `redirect_uri_mismatch` (`kind: wire`, service `identity`). Transcripts: `redirect-web-happy.json`, `redirect-web-errors.json`, `identity-request-hints.json` (web only), `discovery-identity.json` and `discovery-capabilities.json` (with `issuer`, `authorize`, `token` and `configured: true`); re-record `identity-attach.json` with the sign-in made through `authorize`/`token`. Parity rows `identity.redirect.web` and `identity.signin.hints`, `planned` in all six SDKs. OpenAPI and `routeCoverage` for every new route.

**Out** (and where it belongs instead):

- Licence choice, the choice grant routes, Replace, key entry in the card and the first automatic licence (→ I-08b).
- Device code: card pages, hints, poll members, `devicecode-*` transcripts (→ I-37, PX-14; plan D4). Account-initiated pairing for browserless TV and console apps (→ I-40).
- SDK calls (→ I-10a, I-10b); the native redirect and `request` (→ I-15); token exchange and `interstitial_required` (→ I-13); `openid`, refresh and registered clients (→ I-21).
- Attach, subject, sign-out and `license_owned` (→ I-09); the card's screens (→ PX-14); approval by QR (→ PX-W14).
- The `picture` claim on the device wire (a wire change; I-21's ID token carries it). If I-08 hands an app the picture anywhere, it reads `avatarUrl(accounts.avatar_key)`, made absolute.

## Design notes

- **Never a token in a URL or fragment**, and no wildcard, prefix or suffix matching of `redirect_uri`.
- **No silent grants (D22).** Every web sign-in shows "Continue to <App>" (plan D3); there is no skip until I-21's `prompt`.
- **Bounded yield.** A flow returns only the product the card names, its licences, its pairwise subject and the consented claims, never an account session. The first-party session cookie is never accepted on Cloud Sync routes.
- **The sign-in seat refusal** (`oidc.ts:944`) stays as it is; LX-18's `not_entitled` with `reason: device_limit` carries `manageUrl` from PX-W8's builder.
- `PROTOCOL_VERSION` 4, `DISCOVERY_VERSION` 2, `corpusVersion` 2, `transcriptVersion` 1. Additive and feature-detected; no signed shape changes.

## Screen acceptance (brand transition, 2026-10-09)

Done when every row holds for each screen and state this package ships, checked in the real runtime
(not mockups; native kits on device or simulator), with evidence paths in the PR. A row that cannot
apply says why in one line. One home: EXPERIENCE.md §7.3; kits also follow DL1–DL18.

- [ ] Keyboard: tab order follows reading order; focus always visible (DL9); no trap outside a modal;
      Escape or Cancel backs out of every overlay and step; focus returns to the opener (or the heading
      when it is gone); a route change changes the URL and moves focus to the h1, an inline mutation
      changes neither.
- [ ] Screen readers: landmarks and exactly one h1; every icon-only control named; help and errors
      linked (aria-describedby); one polite announcement per change, none while typing; tables use
      th with scope; status is a word and an icon, never colour alone.
- [ ] Sizing: this surface's UI-KITS §7.1 rows plus 200 % text and 400 % zoom (320 CSS px reflow) with
      no page-level sideways scroll; a dense table scrolls only inside a labelled, focusable region;
      targets ≥ 44 px on customer and touch surfaces, ≥ 24 px with separation in the console.
- [ ] Themes: dark and light; a custom product accent on a light and a dark ground (kits, hosted
      sign-in); forced-colors; prefers-contrast: more; reduced transparency; contrast measured on the render (text 4.5:1, UI 3:1) for every state colour in its service accent, both themes.
- [ ] States: loading (skeleton after the grace), first-run empty, filtered empty, permission refused,
      expired or stale, network and API error with Try again, partial failure, success; input survives a
      failed save; where the API sends expectedVersion, a changed-since-open conflict is named with
      Reload.
- [ ] Motion: tokens only; reduced motion is an instant swap and the outcome still reads; errors appear
      without moving content; progress is real (no invented percentage, nothing loops after a failure);
      no celebration on refunds, revocation, removal, deletion or consent.
- [ ] Hierarchy and copy: one filled primary per state (neutral action ink in console, portal and hosted
      sign-in; the product accent in kits); focus, selected, hover, checked and context
      borders take the accent of the service the element references (data-service; -fg for
      text and edges, base for fills; a non-colour cue stays); status colours (success,
      warning, danger, info, signed) never become a service accent; copy from the catalog, each fact once; no decorative numbers or
      taglines; no text drawn over customer art.
- [ ] Native (kits): Dynamic Type or font scale at the 200 % row, VoiceOver or TalkBack, gamepad and
      D-pad focus, TV and title-safe insets, terminal keys with NO_COLOR, ascii and --json paths.
- [ ] pkey-ux-reviewer passes the built screens (BUILT mode).

## Brand transition (2026-10-09)

Applied from the brand and transition integration ([Brand transition decisions](../BRAND-TRANSITION.md)). This section wins over the text below where they differ.

- [ ] Device-flow confirmation (B9, auth-12) is owned by I-37; I-08 ships no device-code page.

## Steps

1. `errors.json`, contract text and types from I-27 §2.1.
2. `authorize` and `token`, with CORS and the error bodies.
3. Continue and Cancel, the request record's `authz` member, hints.
4. Transcripts, parity rows, OpenAPI, THREAT-MODEL.

## UX coverage (2026-10-09)

Generated from `ux-coverage.json` (read `ux-coverage.md` for the whole map). Do not edit this section by hand; change the coverage file.

- **Builds or backs 11 mockup item(s):** `identity.consent`, `identity.key-step`, `identity.refusals`, `identity.sign-in`, `portal.signin`, `hosted:signin-card`, `hosted:consent`, `hosted:license-choice`, `hosted:key-on-ramp`, `hosted:refusals`, `hosted:oauth-authorize-token`.

## Acceptance criteria

- [ ] Every error row of I-27 §2.1, including that no redirect happens before `client_id` and `redirect_uri` are valid (tests).
- [ ] A code redeemed twice, or with another verifier, `client_id` or `redirect_uri`, is refused; `iss` is present on success and error; `token` accepts a form body only, and its `200` has exactly the listed members (tests).
- [ ] With the product's Identity toggle off, every passthrough route is refused and discovery lists none (test).
- [ ] Transcripts and mirrors recorded; `errors.json`, parity rows, OpenAPI and `routeCoverage` updated; THREAT-MODEL rows for R1-07, the choice grant and Replace; `PROTOCOL_VERSION` unchanged.
- [ ] Docs, in this PR ([docs plan](../../../2026-10-08-docs/README.md) §10): its part of `features/sign-in/*`, `operate/platform/connections`, `help/work-account`, `help/account` and `help/connected-apps`.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

`plans/I-27.md` §10's commands, then:

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- identity authorize token passthrough
mise exec node@22 -- pnpm gen transcripts --check
```

## Hand-off

I-08b adds licence choice on the same `token`; I-10a (React's web redirect) and I-10b implement the SDK side against these transcripts; I-15 adds `request` and the native redirect on the same `token`; I-13 adds token exchange; LX-38 swaps in `accessFor()` and deletes `"license-mint"`; U-20 uses the browser device token for web Cloud Sync.

The role agent sets `--set I-08 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set I-08 done`.
