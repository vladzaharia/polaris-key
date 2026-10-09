# I-08 App passthrough on an OAuth-shaped authorize and token (absorbs PX-W18)

| Field       | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | I: Identity: one Polaris Key account, then per-app identity (S-16) (layer-1, phase-1a)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Size        | 1.2–1.7 engineer-weeks                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Depends on  | [I-04](I-04-account-contract-plan.md), [I-07](I-07-login-card-email.md), [I-09](I-09-key-entry-attach.md), [PX-W13](PX-W13-passthrough-metadata.md), [I-26](I-26-legacy-oidc-license-choice.md), [I-27](I-27-plan-identity-consolidation.md), [P0-20](P0-20-split-identity-oidc-ts-extract-issuance.md), [HA-12](HA-12-presentation-discovery.md)                                                                                                                                                                                                                               |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [I-10a](I-10a-sdk-identity-node-react-python.md), [I-10b](I-10b-sdk-identity-swift-kotlin-godot.md), [I-15](I-15-native-redirect.md), [I-24a](I-24a-named-user-seats-server.md), [I-32](I-32-product-connections-absorbs-i-22.md), [I-34](I-34-granular-consent-connected-apps.md), [I-36](I-36-sign-in-integration-card.md), [I-37](I-37-device-code-explicit-confirm.md), [U-05](U-05-cloud-sync-do.md), [U-20](U-20-sdk-settings-react.md), [PX-14](PX-14-passthrough-header.md), [SP-40](SP-40-retire-react-cookie-mode-browser.md) |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Plan mode   | yes: executes the approved [`plans/I-27.md`](../plans/I-27.md) (2026-10-08) §2.1, §2.2 and the hints, which amends [`plans/I-04.md`](../plans/I-04.md)                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Gates       | plan mode; `errors.json` (rule 3); transcripts (rule 1) with the Swift and Godot mirrors; `gen:constants -- --check`; `parity:check`; rule 10 (OpenAPI + `routeCoverage`); THREAT-MODEL; `test:workerd`                                                                                                                                                                                                                                                                                                                                                                         |
| Human input | none                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

## Goal

An app sends a person to the login card and gets them back signed in. The card carries a persistent "<App> wants you to sign in" header, lets the person choose a licence, and ends with "Continue to <App>". A product web app signs in through an OAuth-shaped `authorize` and `token` with PKCE and gets a browser device token, never a token in a URL. Device code lands on the same card, bound to the browser that entered the code. All of it runs only while the product's Identity service is on.

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
- **`POST /<p>/identity/token`** (`grant_type=authorization_code`), form-encoded, `no-store`, CORS for `core.web.origins` only and never with credentials; it requires `X-PKey-Device` and the metadata headers, and a JSON body is `invalid_request`. A `200` carries exactly `access_token` (the `pkeyt_` device token), `token_type: "Bearer"`, `scope` (the granted subset), `schemaVersion`, `device`, `license` (`null` on a licence-less device), `keyEntries` only when the flow entered a key, and `subject`. No `expires_in` and no `refresh_token` before I-21. Errors are RFC 6749's flat body: `invalid_request`, `invalid_client`, `invalid_grant`, `unsupported_grant_type`, `invalid_scope`; the Polaris refusals `not_entitled`, `device_limit`, `license_owned`, `key_entry_limit` and `429 rate_limited` with `retryAfter` are flat too. I-08 deletes "I-21 appends `oauth/authorize`" from WIRE-CONTRACT-V4 §12.8 rule 3 and writes §12.4–§12.5.
- **Hints (absorbs PX-W18).** `login_hint`, `name_hint` and `purpose` on `authorize`, and `scope`, `loginHint`, `nameHint` and `purpose` on `auth/device/start`. A hint prefills the card and never verifies anything.
- **Licence choice (I-04 §C, §F, §G).** `GET /api/signin/requests/:handle/licenses` (`LicenseChoiceView`: `current`, `access` (`"seats" | "account"`, never a displayed type), `keep` only for a licence outside `choices`, `create` with `access`, `getLicense` with `keyEntry`) and `GET …/licenses/:licenseId/devices` (`ReplaceView`). The Continue `POST` takes `choice` (`license` with an optional `replaceDeviceId`, `keep`, `create`, or `{kind: "key", key}`) and stores it on every binding route's flow or code record. App mode: `license_choice=app` on `authorize` and the `licenseChoice` member on PX-W13's `request` with its echo; `token` answers `{status: "choose", grant, expiresIn, choices}`; the grant routes `POST /<p>/identity/choice/{licenses,devices,complete,cancel}` (nested Polaris errors, including `400 invalid_grant`), and `choice/complete` answers the same token response; discovery endpoints `choiceLicenses`, `choiceDevices`, `choiceComplete`, `choiceCancel`.
- **First automatic licence (I-27 §2.2, D4).** With no candidate licence and a policy that grants one, the card skips LicenseChoiceStep and always shows ConsentStep ("New: <Tier> license, created when you continue"); that press mints and then binds. Until LX-36 and LX-38: policy is P0-20's `identityIssuePolicy`; the mint is P0-20's `issueLicense(product, holder, via, target, device?)` with an account holder (origin `oidc`, `account_id` set, `sub` NULL, no key; I-08 adds the account arm if P0-20 ships only the identity holder), then I-09's `bindSignedInDevice(…, {kind: "create"})`; uniqueness is a `"license-mint"` `SingleUseKind` claim (`<product>:` plus a peppered hash of the account id, `putArtefact(…, 30, {ifAbsent: true})`). The winner re-reads `rankAnchorCandidates` and mints only if there is still no candidate; a loser answers `409 license_choice_required`; an unreachable store fails closed. Discover's `issueIdentityLicense` takes the same claim.
- **Replace a device.** `freeAccountDevice()` (`portal/freeDevice.ts`) returns its statements and the Continue appends the guarded seat claim in one D1 batch; `signin.replace.racedAfterFree` only if the claim cannot join. Replace shares the portal's `portalDeviceDisconnect` budget (20 per 60 s), audit row and `deviceRemovedNotice` email; a blocked Replace answers `429 rate_limited` with `retryAfter`.
- **The card and its routes.** The header comes from `resolvePresentation` (HA-12) as data; the Continue records `account_product_grants` with the consented claims (`scope_hash` on Continue; Continue reads `AppConsentView`); PX-W13's request handle and `__Host-pk_req` binder carry the R1-07 callback binding; I-09's `bindSignedInDevice` binds. The Worker device-code pages (`renderDeviceEntry`, `renderDeviceConfirmation`, `signedInPage`) become the card with the app header; `verification_uri` is `<origin>/device`, with `/tv` as the TV and console alias; codes live at most 10 minutes; a warning when network or country differ; poll members `subject` and `attachable`. The device-code `confirm`/attach is offered only after **Keep**. Cancel answers `access_denied` on every surface.
- **Key entry in the card.** An app-mode `{kind: "key"}` choice through `choice/complete` records exactly one `app` key entry through PX-W9's `authorizeDevice(…, {keyEntry: {surface: "app"}})`, atomically with the seat claim, and refuses with `key_entry_limit` when the limit applies. Choosing a licence, Keep, Create and Replace are never counted.
- **Terms and verified email.** A passthrough sign-in passes the product's `identity.terms` (I-09's reader) into `beginProviderSignIn` as `product.terms`; acceptances live in `account_terms_acceptances`. Each verification point I-08 adds calls `onAccountEmailVerified`; whichever of I-08 and I-09 lands second drops the per-request sweep from `portal/api.ts`.
- **Behind the Identity toggle.** With it off, `authorize`, `token`, the choice routes and device-code passthrough answer as for an unknown service, discovery lists no sign-in routes, and the passthrough context answers `identity_disabled` (PX-W17).
- **Contract artefacts.** `errors.json`: `license_choice_required` (409) and the six OAuth codes `invalid_request`, `invalid_client`, `invalid_grant`, `unsupported_grant_type`, `invalid_scope`, `redirect_uri_mismatch` (`kind: wire`, service `identity`). Transcripts: `redirect-web-happy.json`, `redirect-web-errors.json`, `redirect-web-choose.json`, `redirect-web-choose-app.json`, `choice-replace-app.json`, `choice-key-app.json` (expects `keyEntries`), `choice-grant-errors.json`, `devicecode-sign-in.json`, `devicecode-choose.json`, `devicecode-replace.json`, `devicecode-choice-required.json`, `devicecode-autoissue.json` (the card skips the choice step), `identity-request-hints.json` and `discovery-identity.json` (with `issuer`, `authorize`, `token` and `configured: true`); re-record `identity-attach.json` with a real device-code sign-in. Parity rows `identity.redirect.web`, `identity.choice` and `identity.signin.hints`, `planned` in all six SDKs. No `ui.kit.signin` row: `ui.signin` covers the form; if the views change or a later decision retires LicenseChoice `new`, I-08 updates the `ui-matrix.json` rows (UK-02b §4.8). OpenAPI and `routeCoverage` for every new route.

**Out** (and where it belongs instead):

- SDK calls (→ I-10a, I-10b); the native redirect and `request` (→ I-15); token exchange and `interstitial_required` (→ I-13); `openid`, refresh and registered clients (→ I-21).
- Attach, subject, sign-out and `license_owned` (→ I-09); the card's screens (→ PX-14); approval by QR (→ PX-W14).
- The `picture` claim on the device wire (a wire change; I-21's ID token carries it). If I-08 hands an app the picture anywhere, it reads `avatarUrl(accounts.avatar_key)`, made absolute.

## Design notes

- **Never a token in a URL or fragment**, and no wildcard, prefix or suffix matching of `redirect_uri`.
- **No silent grants (D22).** The first sign-in to each app needs "Continue to <App>"; later web redirects may skip it; device code never does, and never issues a choice grant.
- **The choice grant (I-04 §G.6).** 32 random bytes, hashed in the KV flow record, 300 s, bound to the product, account, subject, the redeeming `X-PKey-Device` and the PKCE verifier; one per flow, consumed by `complete` or `cancel`; one `404 not_found` for every licence outside the view or not replaceable; 30 reads per grant.
- **Bounded yield.** A flow returns only the product the card names, its licences, its pairwise subject and the consented claims, never an account session. The first-party session cookie is never accepted on Cloud Sync routes.
- **The sign-in seat refusal** (`oidc.ts:944`) stays as it is; LX-18's `not_entitled` with `reason: device_limit` carries `manageUrl` from PX-W8's builder.
- **When the card takes over the device page,** I-26's legacy chooser page goes and its rule stays; `provider: platform` products with Identity on stop calling `activateFromIdentity`'s `sub`-keyed mint.
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
      sign-in); forced-colors; prefers-contrast: more; reduced transparency; contrast measured on the
      render (text 4.5:1, UI 3:1).
- [ ] States: loading (skeleton after the grace), first-run empty, filtered empty, permission refused,
      expired or stale, network and API error with Try again, partial failure, success; input survives a
      failed save; where the API sends expectedVersion, a changed-since-open conflict is named with
      Reload.
- [ ] Motion: tokens only; reduced motion is an instant swap and the outcome still reads; errors appear
      without moving content; progress is real (no invented percentage, nothing loops after a failure);
      no celebration on refunds, revocation, removal, deletion or consent.
- [ ] Hierarchy and copy: one filled primary per state; the section accent marks context only, never
      success, warning or failure; copy from the catalog, each fact once; no decorative numbers or
      taglines; no text drawn over customer art.
- [ ] Native (kits): Dynamic Type or font scale at the 200 % row, VoiceOver or TalkBack, gamepad and
      D-pad focus, TV and title-safe insets, terminal keys with NO_COLOR, ascii and --json paths.
- [ ] pkey-ux-reviewer passes the built screens (BUILT mode).

## Brand transition (2026-10-09)

Applied from the brand and transition integration ([Brand transition decisions](../BRAND-TRANSITION.md)). This section wins over the text below where they differ.

- [ ] The device flow stays pending until an explicit confirm POST from the browser that loaded the page (B9; owned by I-37). A scan is never approval; the TV's poll sees 'pending' until confirmed. (auth-12)

## Steps

1. `errors.json`, contract text and types from I-27 §2.1.
2. `authorize` and `token`, with CORS and the error bodies.
3. The choice API, the grant routes and the first automatic licence.
4. Device code onto the card, with the callback binding and Continue.
5. Transcripts, parity rows, OpenAPI, THREAT-MODEL.

## Acceptance criteria

- [ ] Every error row of I-27 §2.1, including that no redirect happens before `client_id` and `redirect_uri` are valid (tests).
- [ ] A code redeemed twice, or with another verifier, `client_id` or `redirect_uri`, is refused; `iss` is present on success and error; `token` accepts a form body only, and its `200` has exactly the listed members (tests).
- [ ] `choice/complete` and `token` answer the same shape (test).
- [ ] D4: a mint only at Continue; two concurrent Continue presses on one account, and a Continue racing a Discover add, leave exactly one licence; the loser answers `license_choice_required`; an unreachable store mints nothing (tests).
- [ ] Sign-in never mints while the account holds a usable licence unless `choice.kind` is `create`; Continue without a choice answers 409 when the step was shown (tests).
- [ ] Device code never issues a grant; a grant from another device id answers `invalid_grant`; `choice/devices` answers one `404` for unknown, foreign and non-replaceable licences (tests).
- [ ] Replace and the portal's Remove share one budget and write the same audit row (test).
- [ ] Device-code completion requires the Continue `POST` from the browser that entered the user code, and an account session never skips Continue on device code or on a first sign-in to an app (tests).
- [ ] With the product's Identity toggle off, every passthrough route is refused and discovery lists none (test).
- [ ] Transcripts and mirrors recorded; `errors.json`, parity rows, OpenAPI and `routeCoverage` updated; THREAT-MODEL rows for R1-07, the choice grant and Replace; `PROTOCOL_VERSION` unchanged.
- [ ] Docs, in this PR ([docs plan](../../../2026-10-08-docs/README.md) §10): its part of `features/sign-in/*`, `operate/platform/connections`, `help/work-account`, `help/account` and `help/connected-apps`.
- [ ] The device-code approval page shows the product's name, icon and accent, never the slug ([SDK usability review](../../../2026-10-08-sdk-usability/README.md) §10.1).
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

`plans/I-27.md` §10's commands, then:

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- identity authorize token passthrough devicecode
mise exec node@22 -- pnpm gen:transcripts -- --check
```

## Hand-off

I-10a (React's web redirect) and I-10b implement the SDK side against these transcripts; I-15 adds `request` and the native redirect on the same `token`; I-13 adds token exchange; LX-38 swaps in `accessFor()` and deletes `"license-mint"`; U-20 uses the browser device token for web Cloud Sync.

The role agent sets `--set I-08 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set I-08 done`.
