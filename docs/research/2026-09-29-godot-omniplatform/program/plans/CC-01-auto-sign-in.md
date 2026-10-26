# Plan: automatic sign-in (P-8, L-1, L-2, L-12, O-5, the I-13 exchange, the server half of P-5)

> **Edited 2026-10-26 (L.0, plan-combined.md §6).** Approved by the owner on 2026-10-26 with the combined program. Nearby approval is R-2 (commit-reveal code R-3, M advertises R-4); the proof is Core's `pkey-proof/1` (R-6); device keys come from CC-03 and CC-26 (R-5); wire is v5 (R-8).

Planner: pkey-wire-planner, 2026-10-24. Staging read: `/Users/vlad/Repos/pk-wt/_merge`
(`integ/next-stage` @ `b03b279ce`), read only. Inputs: `linking-sync-contract.md` (lead
contract), `research-device-linking.md` §2, §7, §10, `research-identity-devices.md`. Paths below are
repo-relative. End users see **Polaris Locker**; console, CLI, API and developer docs say **Polaris
Key**.

**Wire summary.** No signed document changes. This lands under v5 (`PROTOCOL_VERSION` 5, after CC-04.1) and adds no signed shape; §12.11 goes into WIRE-CONTRACT-V5.md. `DISCOVERY_VERSION` 2, `corpusVersion` 2. Additive unsigned HTTP: one new grant on the existing
`token` route, five new routes, two new discovery members, a `confirm` pending-sign-in status, a
`consent` member on `choice/complete`, two wire error codes, one client code, one new
generated corpus file (proof-input vectors), new transcripts and four feature ids. It is still an
all-languages event (plan mode): every SDK follows, through the packages in §5.

## 0. What exists, and corrections (file:line)

**Exists.**

- Token route, `authorization_code` only: `packages/worker/src/services/identity/passthrough/token.ts:172-175`
  (any other grant is `unsupported_grant_type`). App-mode choice and grant: `token.ts:278-313`,
  `passthrough/grant.ts` (`sg_`, 300 s, bound to product, account, subject, device).
- One relying-party verifier: `packages/worker/src/core/oidc/client.ts:550-622`
  (`verifyIdToken`; `ID_TOKEN_MAX_AGE = "5m"` at :68). Built-in providers: `providers/google.ts:26`
  (`GOOGLE_ISSUER_KEY`), `providers/apple.ts:31-33` (the card's Apple links use tenant `''`;
  "I-13's native subjects carry the developer's team").
- Link lookup without creating accounts: `services/identity/accounts/signIn.ts:156-240`
  (`signIn(…, {linkedOnly: true})`, the `tenantScopes` check at :163-168, "I-13/I-14 fill it" at
  :86-88). Link engine with 5-minute step-up: `accounts/links.ts:36,105-111`.
- Email trust: `providers/vouch.ts:29-41` (`providerVouchesForEmail`).
- Auto-mint under the `license-mint` claim (D4): WIRE-CONTRACT-V4 §12.4.1 "The first automatic
  licence"; `plans/I-27.md` §2.2.
- Bundle ids already read from outlets for App Attest: `core/hooks.ts:1151,1282-1287`
  (`attestationTargets`), `services/distribution/delivery.ts:174-202`.
- Device-code approval marker (I-37): `productOidc/deviceApproval.ts`; poll vocabulary §12.10.
- Notice emails: `core/notify/templates.ts:533` (`newDeviceSignInNotice`, account sessions),
  `:621` (`signInMethodAddedNotice`).
- Single-use store kinds: `core/singleUse.ts:20-75`. `clientNetwork` (IPv4 exact, IPv6 /64):
  `core/rateLimit.ts:394-405`.
- Console page for app sign-in settings: `packages/admin/src/console/sections/identity/pages/AppSignIn.tsx`.

**Corrections.**

| #   | What the inputs say                                                                                                                                                                                | Fact, and what this plan does                                                                                                                                                                                                                                                                                                                                             |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | Native Google tokens verify like the card's                                                                                                                                                        | `client.ts:607-609` refuses any `azp` ≠ `aud`. A Credential Manager token has `aud` = the web (server) client and `azp` = the Android client, so it is refused today. I-13 adds an `authorizedParties` list to `IdTokenExpectations`                                                                                                                                      |
| C2  | SIGN-IN.md §4.4 (`docs/design/SIGN-IN.md:1107-1112`) and S-16 §5.3 (`notes/S-16-identity-service.md:905-909`): a first link or no grant answers `interstitial_required` and the kit opens the card | Superseded by L-1 (in-app confirm when the link exists) and O-5 (no link: regular sign-in, then the link offer). SIGN-IN.md §4.4, D-22 (`:1941`) and §6.1 row "Native exchange" (`:1792`) are rewritten by I-13.1                                                                                                                                                         |
| C3  | SIGN-IN.md D-22: "I-13 is silent only for an already-bound device"; I-13 brief: silent once link and grant exist                                                                                   | Both are true together with SIGN-IN.md O-1 (the one-tap licence confirm, not the contract's O-1). This plan: silent when link + grant exist **and** no choice is due; D-A2 asks the owner to treat "one candidate with a free seat" as not due on this path                                                                                                               |
| C4  | S-16 §5.4 item 13 (`S-16:1037-1040`): a product device token can never add links                                                                                                                   | O-5 makes an app add one. Item 13 is amended with the controls of §4 (fresh same-device sign-in, scoped links, both addresses emailed); I-43 owns the text                                                                                                                                                                                                                |
| C5  | The original I-13 design: the card visit links the token the app supplied                                                                                                                          | A malicious app could supply the attacker's own Google token, so the person's card sign-in would link the **attacker's** global identity to the **victim's** account (takeover on every product and the card). Fixed by D-A3: an app-made link is global only when the provider-vouched email is already verified on the account; otherwise it is scoped to the developer |
| C6  | I-27 §3: "There is no `identity.native`"; the consolidation derives exchange kinds from channels                                                                                                   | Google client ids exist nowhere else, and no outlet carries an Apple team id (`shared-manifest/src/distribution.ts:261-288`). This plan adds `identity.platformSignIn` (D-A1), with outlet bundle ids still unioned in                                                                                                                                                    |
| C7  | Spike §2.3: the vouch approves the device code's `user_code`                                                                                                                                       | A user code is exactly the proof I-37 rejects (a victim can be told to type it), and §12.5.1 rule 5 forbids grants on cross-device channels. This plan uses a dedicated nearby request with a machine-only handle, a device-key binding and a network match                                                                                                               |
| C8  | Spike §2.4: Apple gets `SHA256(n)` as its nonce                                                                                                                                                    | Both providers get the server nonce as is. A device-key proof binds it, so hashing adds nothing (D-A4)                                                                                                                                                                                                                                                                    |
| C9  | `interstitial_required` is "reserved" (WIRE-CONTRACT-V4.md:1576, I-27 §2.1)                                                                                                                        | It is not in `conformance/parity/errors.json`. I-13.1 registers it                                                                                                                                                                                                                                                                                                        |
| C10 | I-37 D7 defers the approval email to I-39                                                                                                                                                          | I-39 is `dropped`. I-40 (re-scoped) builds `appDeviceApprovedNotice`                                                                                                                                                                                                                                                                                                      |
| C11 | I-13 depends on I-10a and I-10b (both `todo`)                                                                                                                                                      | I-13 becomes Worker plus contract only, so those deps move to the SDK packages (§5)                                                                                                                                                                                                                                                                                       |
| C12 | I-40 is an optional TV-pairing planning package                                                                                                                                                    | Re-scoped to the server half of P-5, which answers its goal (a browserless device signs in through a signed-in one) with proximity                                                                                                                                                                                                                                        |

## 1. The flow

**Rungs (L-12).** Each stops on success. "Automatic" (L-2): no login screen drawn by the app, at
most one OS sheet, the L-1 confirm once per app.

| Rung                                     | Apple (Swift; Godot via `native/ios`, `native/macos`)                                                                   | Android (Kotlin `play` flavour; Godot via `:platform`)                                                                         | Web (React, elements)                                        | Desktop (Node/Electron, Python, Kotlin JVM, Godot desktop) |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ | ---------------------------------------------------------- |
| 1 Stored session                         | Keychain device token                                                                                                   | Keystore-wrapped token                                                                                                         | IndexedDB bearer token                                       | DPAPI, libsecret or file                                   |
| 2 Silent restore (I-49)                  | iCloud Keychain restore secret                                                                                          | Block Store restore secret                                                                                                     | none                                                         | none                                                       |
| 3 Silent identity                        | Game Center (games; verifier I-14)                                                                                      | Credential Manager `GetGoogleIdOption(filterByAuthorizedAccounts=true, autoSelectEnabled=true, nonce=n)`; PGS v2 (games; I-14) | FedCM `mediation: "silent"` (Chromium only)                  | none                                                       |
| 4 One OS sheet                           | `ASAuthorizationAppleIDRequest(nonce=n)` with `.preferImmediatelyAvailableCredentials` (fails at once for a new person) | The same call shows the account sheet when several accounts are authorised                                                     | FedCM `mediation: "optional"`, only if the developer opts in | none                                                       |
| 5 Nearby approval (I-40 + Cloud Connect) | tvOS; any device with no platform identity                                                                              | Android TV; the `direct` flavour                                                                                               | none (browsers have no LAN discovery)                        | yes                                                        |
| 6 Regular sign-in (O-5)                  | The SignIn form: claimed HTTPS (I-15), provider row with native Apple                                                   | The SignIn form: Custom Tabs (I-15), provider row with Credential Manager Google                                               | Web redirect (I-08)                                          | Loopback (I-15); device code                               |
| 7 Link offer (O-5)                       | After rung 6 through a same-device channel                                                                              | same                                                                                                                           | same                                                         | same (no platform identity: no offer)                      |

**Scenarios.** "Tap" counts from launch.

1. **First-ever launch, account already linked** (the person used Google on the card before; Google
   `sub` is global). Rung 3 gets a token for nonce `n` → exchange → `200 {status:"confirm"}`
   (no product grant yet) → the L-1 confirm in the SignIn form ("Continue to Nightfall as
   v…@gmail.com", licence line "New: Standard license") → **Continue** → `choice/complete` with
   `consent` and `{kind:"create"}` → the `license-mint` claim mints, the device binds → token. One tap.
2. **Returning launch, same install.** Rung 1. No network wait beyond the normal licence refresh.
3. **New device, app already consented.** Rung 3/4 → exchange. One candidate with a free seat: bound
   silently if the owner accepts D-A2, else one tap. Two or more: `choose` (LicenseChoice). All
   full: `choose` with inline Replace (`choice/devices`). Device already on another licence:
   `choose` with Keep.
4. **No linked account.** Exchange → `403 interstitial_required`, `reason: "no_link"`, `linkHandle`
   (the verified identity, held 600 s). The SignIn form shows (regular sign-in). After a same-device
   sign-in (`authorization_code`), the kit reads `GET link` and shows the offer. **Link** →
   `POST link {linkHandle}` → linked, audited, emailed; no second OS sheet. **No thanks** is stored
   on the device as `sha256(issuer ‖ sub)` and never asked again for that identity. With no handle
   (rung 3/4 found nothing), **Link** fetches a fresh token (one OS sheet) and posts it.
   A brand-new person creates the account on the card; if they choose Google there, the global link
   already exists and no offer shows.
5. **Link conflict.** `POST link` → `409 link_conflict` → "This Google account is linked to another
   Polaris Locker account." with **OK** and the Help link (join accounts). Nothing changes; the
   identity is marked declined on the device.
6. **`device_limit`.** Exchange path: full rows with Replace in the form. Nearby path: on the
   approving device (DeviceLimit with **Manage devices**); the new device keeps waiting.
7. **`license_choice_required`.** A lost mint race or a changed offer on `choice/complete`: the kit
   re-reads `choice/licenses` (the winner's licence, one tap).
8. **Sign-out.** The kit's L1 confirm → flush Cloud Sync → `identity/signout` → the SDK clears the
   stored session and the platform state: Android `clearCredentialState()` (stops auto-select) and
   deletes the Block Store restore secret with a server revoke (I-49); Apple deletes the keychain restore
   item (Cloud Sync's root backup item stays, R-11); web calls `navigator.credentials.preventSilentAccess()` and GIS `disableAutoSelect()`. A
   local `explicitSignOut` flag makes the next launches skip rungs 2–4 and show the SignIn form;
   the next explicit sign-in clears it. This is the Restore Credentials loop answer: nothing
   silent survives a sign-out on that device.
9. **Auto-mint fails closed.** Policy none or unreadable (`parseAutoIssue`) → `choices.state:
"none"` → the no-licence state (key field, Get Nightfall). Store unreachable → `503 unavailable`
   → "Couldn't finish signing in." with **Try again**. Nothing mints without the press.
10. **Nearby (desktop).** The new device D starts a nearby request; the form shows "Approve on your
    phone" and the code. The signed-in device M shows a banner; the person taps the number D shows
    (number matching, D-A9); M approves; D's poll gets the token. D-code fallback stays one tap
    away ("Use a code instead").
11. **Apple credential revoked.** `getCredentialState(forUserID:)` = revoked at launch → the SDK
    signs the device out (scenario 8).
12. **Identity off, or no kinds declared.** Discovery has no `exchange` member; the ladder skips
    rungs 3–4.

## 2. Wire

New WIRE-CONTRACT-V5 subsection **§12.11 Platform sign-in, the link offer and nearby approval**
(written by I-13.1 into V5, after CC-04.1; extended by I-43 and I-40). Types in `@polaris-key/protocol/identity`.

### 2.1 The device proof (`pkey-proof/1`)

The proof is Core's: CC-03.4 owns it (R-6); I-13.6 is deleted. Every new route that binds a device
takes `proof`: an Ed25519 signature (64 bytes, base64url) by the device's P-1 signing key over the
UTF-8 lines, joined by `
`: `pkey-proof/1`, purpose, product slug, `X-PKey-Device`, the value, and
the base64url SHA-256 of the presented provider token or `-`. Every field is pattern-checked to
hold no newline. Purposes: `keys`, `nonce`, `exchange`, `link`, `nearby-start`, `nearby-poll`,
`nearby-approve`, `vouch` and `restore`. Keys are raw 32-byte public keys in base64url. The corpus
pins the bytes and signatures in `device-proof.json` (§2.5).

### 2.2 The I-13 exchange

**Nonce.** `POST /<p>/identity/nonce`, JSON `{signKey, agreeKey}`, `X-PKey-Device`. The exchange calls `registerDeviceKeys(…, {via: "exchange"})`. Answer `200
{nonce, expiresIn: 300}`, `no-store`. `nonce` is 32 random bytes in base64url (43 chars), stored in
SingleUseDO kind `exchange-nonce` under its peppered hash with `{product, deviceId,
keyThumbprint, issuedAt}`. A device row that already has a registered P-1 key must present that
key. Rate limit `identityNonce`: 30 a minute per client network, 10 per device, failing closed.

**Grant.** `POST /<p>/identity/token`, form-encoded (I-27 §2.1):

| Parameter             | Value                                             |
| --------------------- | ------------------------------------------------- |
| `grant_type`          | `urn:ietf:params:oauth:grant-type:token-exchange` |
| `client_id`           | the product slug                                  |
| `subject_token`       | the provider ID token                             |
| `subject_token_type`  | `urn:ietf:params:oauth:token-type:id_token`       |
| `nonce`               | the server nonce                                  |
| `device_key`, `proof` | §2.1 (purpose `exchange`)                         |
| `license_choice`      | `app` (default) or `card`                         |
| `device_name`         | §12.7.1                                           |

The provider is picked by the token's unverified `iss`, then verified strictly. Checks, each a
plain `invalid_grant` (no oracle): signature (gated JWKS cache), `iss`, `aud` ∈ the product's
audiences, `azp` ∈ the product's client ids when present, `exp`, `iat` ≤ 5 minutes, `nonce` equal
to the presented one, the nonce record consumed once and bound to this product, device and key,
and the proof. Audiences that equal a platform built-in client (the card's Google client, the
Polaris Services ID) are refused at resync and at runtime.

| Kind   | `aud`                                                                  | `azp`                                | Link key                                                                                    |
| ------ | ---------------------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------- |
| Google | `identity.platformSignIn.google.serverClientId`                        | `…google.clientIds` or the server id | `(https://accounts.google.com, '', sub)`, then `(…, 'google-client:<serverClientId>', sub)` |
| Apple  | a bundle id from `…apple.bundleIds` ∪ App Store and TestFlight outlets | none                                 | `(https://appleid.apple.com, 'apple-team:<teamId>', sub)`                                   |

Lookup is `signIn(…, {linkedOnly: true})` with the product's tenant scopes; never by email.

**Answers.**

- `200` TokenResponse plus `issued_token_type: "urn:polaris-key:token-type:device"`: link and
  grant exist and no choice is due.
- `200 {status:"confirm", grant, expiresIn:300, consent: ExchangeConsentView, choices:
LicenseChoiceView}`: no `account_product_grants` row, or its `scopeHash` changed (L-1).
  `ExchangeConsentView` = `{client: {appName, developerName, iconUrl, nameVerified}, as:
{provider, email | null}, items: ConsentItem[], scopeHash, firstTime, changed}`. `as.email` is the
  token's own email, so the app learns nothing it did not already hold.
- `200 {status:"choose", …}`: as §12.5.1.
- `403 {error:"interstitial_required", reason, url, linkHandle?, expiresIn?}`: `reason` is
  `no_link` (with `linkHandle` = `lh_` + 43 base64url, kind `exchange-link`, 600 s, bound to
  product, device and key) or `terms` (the product's terms version is unaccepted). `url` is the
  card for this product.
- Existing flat refusals: `not_entitled`, `device_limit`, `license_choice_required`,
  `rate_limited`. Identity off: `404`.

**Completion.** `choice/complete` takes `{grant, choice, consent?: {claims}, deviceName?}`.
`consent` is required on a grant issued with `confirm` (else `400 bad_request`); it writes
`account_product_grants` in the same press that binds and, for `create`, mints (D4).

### 2.3 The link offer (I-43)

- **Step-up.** SingleUseDO kind `signin-fresh`, keyed `(product, deviceId)`, 300 s, written only
  by `authorization_code` at `token` and by `choice/complete` on a grant earned that way (the
  same-device channels: web redirect, I-15 loopback, scheme, claimed HTTPS). Device code, nearby,
  restore and the exchange never write it.
- `GET /<p>/identity/link` (device bearer): `{offer: [{kind, reach}]}`, where `kind` is one of the
  product's kinds with no link on the account in its scope and `reach` is `global`, `developer` or
  `null` (unknown before a token). Empty unless `signin-fresh` is live.
- `POST /<p>/identity/link` (device bearer), JSON: `{linkHandle, proof}` or `{subjectToken, nonce,
signKey, agreeKey, proof}`. It consumes `signin-fresh`, then calls `linkIdentity` (`links.ts:105`).
  Scope (D-A3): Google is global only when `providerVouchesForEmail` holds and the address is
  already verified on this account; else `google-client:<serverClientId>`. Apple is always
  `apple-team:<teamId>`. Answers `200 {linked: {kind, reach}}`; `401 step_up_required`;
  `409 link_conflict`; `400 invalid_grant` (nested); `404 not_found` (handle). Audit
  `identity.link.added` with `via: app`; `signInMethodAddedNotice` gains an "in {app}" variant and
  goes to the primary address **and** the linked identity's verified address.

### 2.4 Nearby approval, server half of P-5 (I-40)

| Route                   | Caller                      | Body                                                                        | Answers                                                                                                                                                                                      |
| ----------------------- | --------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST …/nearby/start`   | new device D                | `{signKey, agreeKey, deviceName?, proof}` (purpose `nearby-start`)          | `201 {request: "nr_…", expiresIn: 300, interval: 3}`; kind `nearby-request` holds product, device, both keys, label, start network, start time                                               |
| `POST …/nearby/approve` | signed-in device M (bearer) | `{request, signKey, agreeKey, decision: "approve"\|"deny", choice?, proof}` | `200 {status:"approved", deviceLabel}`; `200 {status:"choose", choices}` (nothing written); `204` deny; `403 not_nearby`; `403 device_limit`; `403 account_required`; `404 not_found`; `429` |
| `POST …/nearby/poll`    | D                           | `{request, proof}`                                                          | `200 {status:"pending"}`; `429 {status:"slow_down", interval}`; `200 {status:"timeout"}`; `200 {status:"error", reason:"access_denied"}`; `200` TokenResponse once                           |

Rules: `{signKey, agreeKey}` must equal D's start keys (M learns them from D's authenticated `VOUCH_REQ`, §10), and approve registers D's keys (`registerDeviceKeys(…, {via: "nearby"})`);
`clientNetwork(approve) == clientNetwork(start)` or `403 not_nearby` (D-A8); M must hold a sign-in
binding; M's proof uses its registered P-1 key; one decision per request (CAS); the licence is
chosen on M (`license` and `create` only; no Replace in v1, D-A10); D never gets a grant
(§12.5.1 rule 5 holds). Approve binds the seat and writes D's device row; D's first valid poll
issues the token. Budgets: `nearbyStart` 10/min/network; `nearbyApprove` 10/min/device and
5/hour/subject; `nearbyPoll` by `interval`. Audit `identity.nearby.approved` / `.denied` (label
only). Email `appDeviceApprovedNotice` ("{app} signed in on {device}") to the primary address.

**Result and keys (R-2 steps 8 and 9).** M sends `VOUCH_RESULT` (0x8011; display only). If the product is E2E and M holds the ring key R, M also sends `KEYRING_WRAP` (0x0030, an HPKE wrap to the agreeKey from the authenticated `VOUCH_REQ`) over the channel and PUTs the same wrap to `/devices/keyring/wraps/{D}`; D opens R from the channel copy and ignores a server copy that differs. D's form shows "Signed in as {email}" with "Not you?" (login CSRF, new THREAT-MODEL row).

### 2.5 Discovery, errors, transcripts, corpus, features

- **Discovery** (identity fragment, `discovery-identity.json` re-recorded): `exchange: {kinds:
("google"|"apple")[], google?: {serverClientId}}` only when kinds are declared; `nearby: true`;
  endpoints `nonce`, `link`, `nearbyStart`, `nearbyApprove`, `nearbyPoll` (later `restore`). An
  SDK uses a rung only when its endpoint is present.
- **`errors.json`**: `interstitial_required` (wire, identity, 403 flat on token exchange),
  `not_nearby` (wire, identity, 403 on `nearby/approve`), `platform-identity-unavailable` (client:
  no Play services, no declared kind, or the OS refused). Everything else reuses `invalid_grant`,
  `step_up_required`, `link_conflict`, `device_limit`, `license_choice_required`,
  `account_required`, `not_found`, `rate_limited`, `cancelled`, `sign-in-denied`. Then
  `pnpm gen constants`.
- **Transcripts** (`packages/worker/test/transcripts/scenarios/identity.ts`, fixture JWKS):
  `exchange-silent`, `exchange-confirm`, `exchange-choose`, `exchange-no-link`, `exchange-errors`,
  `link-offer`, `link-errors`, `nearby-happy`, `nearby-denied`, `nearby-errors`; re-record
  `discovery-identity` and `locker-discovery-identity`. Godot mirror via `pnpm gen transcripts`.
- **Corpus**: the generated `conformance/corpus/v2/device-proof.json` (`tools/corpus/deviceProof.ts`, with a Godot mirror) is Core's, owned by CC-03.4; it replaces this plan's `identity-proof.json` and CC's peer-matrix pop section. `ui-matrix.json` gains SignIn states (I-46.1). `pnpm gen corpus --check`.
- **`features.json`**: `identity.exchange` (N/A `node`, `python`, `windows`, `linux`, `jvm`,
  `desktop-bridge`: runtime, no OS account), `identity.autosignin` (proof: transcript + unit),
  `identity.link`, `identity.nearby` (N/A `web`: runtime), later `identity.restore`. `pnpm gen parity`.

### 2.6 Routes, manifest, settings (rules 9, 10)

- **Rule 10.** Add `nonce`, `link` (GET, POST), `nearby/start`, `nearby/approve`, `nearby/poll` to
  `services/identity/routes.ts` (`cors: true`; auth `none`, `device`, `none`, `device`, `none`);
  `packages/worker/openapi/polaris-key.v3.yaml`; `test/fixtures/service-route-oracle.json` (added
  rows); buckets in `core/rateLimit.ts`; `pnpm gen docs-reference`.
- **Manifest** (`.pkey/product`, I-42):

  ```yaml
  identity:
    platformSignIn:
      google:
        serverClientId: "1234-abc.apps.googleusercontent.com" # the web client: aud
        clientIds: ["1234-and.apps.googleusercontent.com"] # Android and iOS clients: azp
      apple:
        teamId: "ABCDE12345"
        bundleIds: ["com.example.nightfall.mac"] # unioned with App Store and TestFlight outlets
  ```

  | Code                                | Rule                                                                      | Schema  |
  | ----------------------------------- | ------------------------------------------------------------------------- | ------- |
  | `invalid_identity`                  | widened: `platformSignIn` allowed                                         | rejects |
  | `invalid_identity_platform_sign_in` | unknown member or wrong shape                                             | rejects |
  | `invalid_google_client_id`          | `^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$`, at most 8 `clientIds` | rejects |
  | `invalid_apple_team_id`             | `^[A-Z0-9]{10}$`                                                          | rejects |
  | `invalid_apple_bundle_id`           | the existing `APPLE_BUNDLE_ID` rule, at most 16                           | rejects |
  | `apple_sign_in_without_team`        | `bundleIds` without `teamId`                                              | rejects |
  | `google_client_ids_without_server`  | `clientIds` without `serverClientId`                                      | rejects |

  Mutation rows in `packages/shared-manifest/test/schema-parity.test.ts`, schema
  `schemas/v1/product.schema.json`. Platform-client collisions are Worker-side (resync and runtime).

- **Settings** (`services/identity/settings.ts`, row-backed): `identity.platformSignIn.google.serverClientId`,
  `….google.clientIds`, `….apple.teamId`, `….apple.bundleIds`. `pnpm gen settings`.
- **Tables.** None in wave 1 (SingleUseDO kinds `exchange-nonce`, `exchange-link`, `signin-fresh`,
  `nearby-request`). I-49 adds `identity_restore_keys` (owner `identity`, `TABLE_OWNERS` row,
  migration `00XX_identity_restore_keys.sql`, number from the lead).

### 2.7 Deployed clients and workers

The Worker deploys first. Every SDK in the field ignores the new discovery members and never sends
the grant, so nothing changes for it. A new SDK against an old Worker sees no `exchange` member
and starts at rung 5 or 6; an `unsupported_grant_type` is treated as a failed rung. Rolling the
Worker back leaves links with the new tenant scopes in `account_links`; the card only reads tenant
`''`, so they stay inert until roll-forward. Pending nonces, handles and nearby requests expire in at
most 600 s.

## 3. Per-SDK work (all seven)

Common: `autoSignIn(options) → AutoSignInResult` (`signed-in`, `confirm`, `choose`,
`needs-sign-in` with `linkHandle?`, `device-limit`, `unavailable`); `link.offer()`,
`link.accept()`, `link.decline()`; `signOut()` per scenario 8; the decline store; the proof over
the P-1 key (from Cloud Connect's key store; §10). Kits call `autoSignIn()` from the gate unless
`autoSignIn: false`.

| SDK                                    | Rungs and platform calls                                                                                                                                                                                                                                                                                                                                                                                                                                             | WP   |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| **Swift**                              | `ASAuthorizationController` with `ASAuthorizationAppleIDProvider().createRequest()` (`nonce = n`, scopes `.email`), `.preferImmediatelyAvailableCredentials` at launch, plain `performRequests()` from the provider row and the link offer; `getCredentialState(forUserID:)` at launch; Game Center `GKLocalPlayer.local.authenticateHandler` and `fetchItemsForIdentityVerificationSignature` (verifier I-14); nearby D and M sides over Cloud Connect; tvOS nearby | I-44 |
| **Kotlin**                             | `play` flavour: Credential Manager (`androidx.credentials`, `credentials-play-services-auth`, `googleid`; exact pins ≥ 14 days old, verified at slice time [U]) with `GetGoogleIdOption` (rung 3/4) and `GetSignInWithGoogleOption` (provider row); `clearCredentialState()` on sign-out; PGS v2 `GamesSignInClient.requestServerSideAccess` (verifier I-14); `direct` flavour: rungs 1, 5, 6 only; JVM desktop: 1, 5, 6; Compose kit                                | I-45 |
| **React and elements** (`ui-core`)     | FedCM `navigator.credentials.get({identity: {providers: [{configURL, clientId, nonce}]}, mediation})` where `IdentityCredential` exists; Google's FedCM config URL is [U] and verified in I-46.2, with GIS (`accounts.google.com/gsi/client`, loaded on demand, never bundled) as the fallback; non-extractable WebCrypto Ed25519 key in IndexedDB; Safari and Firefox: rungs 1 and 6; `SignInModel` states for both kits                                            | I-46 |
| **Node** (Electron main), **Python**   | Rungs 1, 5 (D and M sides, so an Electron or CLI app can approve), 6 (loopback, device code); terminal views for the nearby code and the link offer (no platform identity, so no offer)                                                                                                                                                                                                                                                                              | I-47 |
| **Godot**                              | GDScript ladder; iOS and macOS: Sign in with Apple and Game Center in `native/ios/pkey_apple.m` and the macOS binding; Android: Credential Manager and PGS through `:platform` (today `:platform` has neither: add them there, `play`-only); desktop nearby only after L-10's measurement; `PKeySignIn` states                                                                                                                                                       | I-48 |
| Restore (Swift, Kotlin, Godot natives) | iCloud Keychain item (`kSecAttrSynchronizable`, the app's access group) and Block Store (`setShouldBackupToCloud(true)`) holding the restore secret; revoked and deleted on sign-out (the sync-root backup stays, R-11). I-49 builds one `PlatformBackupStore` per native SDK and pins `play-services-auth-blockstore`                                                                                                                                               | I-49 |

**Kit screens** (SignIn form states, no stacked sheet; copy keys in
`packages/brand/kit-copy/*.json`, then `pnpm gen brand ui-matrix corpus`):

| State                               | Copy (en)                                                                                                                                                                                                                                                                                                 |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `confirm` (L-1)                     | `signin.auto.confirm.title` "Continue to {app}"; `….as` "as {email}" (provider glyph; "with your Apple ID" when no email); the licence line from `items`; primary `….primary` "Continue"; secondary `….other` "Use another account"                                                                       |
| `linkOffer` (O-5), global           | `signin.linkOffer.title` "Sign in with {provider} next time?"; `….bodyGlobal` "{app} and other apps that use Polaris Locker sign you in by themselves."; primary `….primary` "Link {provider}"; secondary `….decline` "No thanks"                                                                         |
| `linkOffer`, developer reach        | `….bodyDeveloper` "Apps from {developer} sign you in by themselves." (Apple always; Google when `reach` is `developer` or unknown)                                                                                                                                                                        |
| `linkDone`, `linkConflict`          | `….done` "{provider} linked."; `….conflict` "This {provider} account is linked to another Polaris Locker account."                                                                                                                                                                                        |
| `nearbyWait` (D)                    | `signin.nearby.title` "Approve on your other device"; `….body` "Open {app} on a phone or computer where you're signed in."; code panel; secondary `….code` "Use a code instead"                                                                                                                           |
| `nearbyDone` (D)                    | `signin.nearby.done` "Signed in as {email}"; `….notYou` "Not you?" (R-2 step 9)                                                                                                                                                                                                                           |
| Pre-prompt and menu (I-46.1)        | the L-11 pre-prompt line, and the "Approve a nearby device" account-menu entry                                                                                                                                                                                                                            |
| `NearbyApproval` (M, new component) | `signin.nearby.ask` "Sign in {device}?"; `….askBody` "Tap the code {device} shows" over three 6-digit codes, one of them the SAS (R-3); tapping any other code, or "Not now", denies; `….deny` "Not now"; outcomes `….approved` "{device} is signed in.", `….notNearby` "{device} isn't on your network." |

No copy says "all apps" for Apple. Locales follow the brand process; UX review (BUILT) per kit.

## 4. Console, docs, Help, privacy, threat model

- **Console** (I-42): Identity → App sign-in gains **Platform sign-in**: Google (server client id,
  Android and iOS client ids) and Apple (team id, bundle ids, plus read-only bundle ids from the
  App Store and TestFlight outlets), a status line per kind ("Ready on Android and the web"), and
  a help link (`docsLinks.ts`). Writes go through the settings registry; manifest values win as
  for every row-backed key. Activity verbs (`activityVerbs.ts`) for the new audit actions.
- **Help** (I-50 owns the nearby section of `help/approve-a-sign-in.mdx`, R-14).
- **Developer docs** (I-50): `features/sign-in/automatic.mdx` (ladder, `autoSignIn()`, sign-out
  rules, what "automatic" means), `features/sign-in/platform-setup.md` (Google Cloud clients, Apple
  capability, App Review 4.8 note), `features/sign-in/nearby.md`; generated reference pages
  (routes, errors, settings). Snippets compile in their lanes or say "planned".
- **Help** (I-50, Locker voice): `help/sign-in-automatically.mdx` (what links do, Apple works per
  developer, how to stop: Account → Sign-in methods, or sign out on the device),
  `help/approve-a-sign-in.mdx` gains "Approve a nearby device".
- **`docs/PRIVACY.md`** rows: nonce records (device id, key thumbprint, 300 s); provider ID tokens
  verified once and never stored; link handles (issuer, scope, subject, email, 600 s); nearby
  requests (label, key, start network, 300 s, never logged after); `signin-fresh` (300 s); decline
  memory on the device only; restore keys (I-49: secret hash per product and subject until sign-out,
  revocation or deletion; the secret only in the person's iCloud Keychain or Google backup).
- **`docs/security/THREAT-MODEL.md`**: a new section "Platform sign-in, link offer and nearby
  approval (I-13, I-43, I-40)", and edits to "Login-card providers (I-06)" and S-16 item 13's
  successor:

| Threat                                        | Control                                                                                                                                                                                                      | Residual                                                                              |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| Token replay                                  | Single-use nonce bound to product, device and key; proof over the token hash; 5-minute `iat`                                                                                                                 | A thief who also holds the device key (the device itself)                             |
| Game Center has no nonce (I-14)               | Signature timestamp within 120 s; single-use cache of signature hashes for the window; bundle id ∈ product's                                                                                                 | A signature captured on the device and used first, inside 120 s                       |
| Audience confusion                            | Only the product's declared audiences; platform clients refused both ways; the nonce binds the product                                                                                                       | none known                                                                            |
| Takeover by email match                       | Lookup by `(issuer, tenant, subject)` only, `linkedOnly`; never joins (test)                                                                                                                                 | none                                                                                  |
| Malicious app links an attacker identity (C5) | App links only after a fresh same-device sign-in; Google global only when the vouched address is already verified on the account, else developer-scoped; Apple always team-scoped; both addresses emailed    | A developer can mis-link inside its own scope, where it already controls the product  |
| Forged L-1 confirm                            | The app draws it; a malicious app can skip it. It gains only what a consented sign-in to its own product gives; Connected apps lists it                                                                      | Accepted (L-1)                                                                        |
| Nearby relay phishing (R1-07)                 | No user code or link; handle travels only machine to machine; requester key bound; same client network; number matching; foreground banner, one at a time, cooldown; licence chosen on M; emailed; revocable | An attacker on the same network who also persuades the person to tap the right number |
| Prompt fatigue                                | Number matching; rate limits per M and per subject                                                                                                                                                           | Nuisance banners from same-network devices running the same app                       |
| Restore loop and theft (I-49)                 | Secret only in E2E platform backup; revoked and deleted on sign-out (the sync-root backup item stays); rotated on use                                                                                        | The person's Apple ID or Google account compromise                                    |

## 5. Work packages

_The merged table and waves are plan-combined.md §4. "CC-key" is CC-03 and CC-26; "CC-chan" is CC-05 and CC-15._

Graph rows (deps beyond `done` ones; "CC-key" = the Core device-key module from
plan-cloud-connect, id to be assigned; "CC-chan" = its channel and `VOUCH_REQ`).

| Id                  | Title                                                                                                                                                              | Role                | Weeks   | Deps                               | Plan mode       | Gates                                                         | Notes                                                                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------- | ------- | ---------------------------------- | --------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **I-13** (amend)    | Platform sign-in exchange: nonce, device proof, Google and Apple verifiers, L-1 confirm, `interstitial_required`                                                   | pkey-implementer    | 1.2–1.6 | I-30, I-42                         | yes (this plan) | plan-mode, drift-gate, rule-10, corpus, threat-model, workerd | Worker and contract only; no .6 (the proof is CC-03.4); drop deps I-10a, I-10b; SDKs move to I-44..I-48                                          |
| **I-42**            | `identity.platformSignIn` and `identity.nearby`: manifest, settings, console                                                                                       | pkey-implementer    | 0.4–0.6 | I-09                               | no              | rule-9, drift-gate                                            | Coordinates `invalid_identity` with I-35. identity.nearby is a manifest member and a claimable setting, on by default, with mutation rows (R-13) |
| **I-43**            | Link offer (O-5): fresh same-device sign-in, link route, scoped links, emails                                                                                      | pkey-implementer    | 0.5–0.7 | I-13                               | yes             | rule-10, drift-gate, threat-model                             | Amends S-16 item 13 text                                                                                                                         |
| **I-40** (re-scope) | Nearby approval: server half of P-5                                                                                                                                | pkey-implementer    | 0.8–1.1 | I-13, CC-key                       | yes             | rule-10, drift-gate, threat-model, workerd                    | Was planning-only and optional: now `optional: false`                                                                                            |
| **I-44**            | Swift `autoSignIn()`: Sign in with Apple, Game Center client, link, nearby, SwiftUI states                                                                         | pkey-sdk-porter     | 1.0–1.4 | I-13, I-43, I-46.1, I-10b, CC-26.4 | no              | all-sdks, drift-gate, ui-snapshots                            | Rungs 6–7 and the link offer need I-15; the nearby slice needs I-40 and CC-15 (Swift)                                                            |
| **I-45**            | Kotlin `autoSignIn()`: Credential Manager, PGS v2 client, JVM ladder, Compose states                                                                               | pkey-sdk-porter     | 1.0–1.4 | I-13, I-43, I-46.1, I-10b, CC-26.5 | no              | all-sdks, drift-gate, CI: Android, ui-snapshots               | New pinned deps. Rungs 6–7 need I-15; the nearby slice needs I-40 and CC-15 (Kotlin)                                                             |
| **I-46**            | Web `autoSignIn()`: FedCM/GIS, `ui-core` states, React and elements kits; shared copy and states                                                                   | pkey-sdk-porter     | 1.0–1.4 | I-13, I-43, I-10a                  | no              | all-sdks, drift-gate, corpus (ui-matrix), ui-snapshots        | I-46.1 is wave 1                                                                                                                                 |
| **I-47**            | Node and Python `autoSignIn()`: stored, nearby (D and M), loopback, terminal views                                                                                 | pkey-sdk-porter     | 0.8–1.1 | I-40, CC-chan, I-10a, I-15         | no              | all-sdks, drift-gate                                          |                                                                                                                                                  |
| **I-48**            | Godot `autoSignIn()`: GDScript ladder, Apple and Android natives, `PKeySignIn` states                                                                              | pkey-godot-engineer | 1.0–1.5 | I-13, I-43, I-46.1, I-10b          | no              | all-sdks, drift-gate, corpus (mirror)                         | Rungs 6–7 need I-15; nearby needs I-40 and CC-15 (Godot); desktop after L-10's measurement                                                       |
| **I-49**            | Silent restore: restore secret, one `PlatformBackupStore` per native SDK (iCloud Keychain and Block Store; pins play-services-auth-blockstore), revoke on sign-out | pkey-implementer    | 0.8–1.2 | I-13, I-44, I-45                   | yes             | rule-10, migration, threat-model                              | Wave 2                                                                                                                                           |
| **I-50**            | Automatic sign-in docs, Help and privacy pages                                                                                                                     | pkey-implementer    | 0.4–0.6 | I-13, I-43, I-40                   | no              | docs lints, check:links                                       |                                                                                                                                                  |

**Briefs this plan changes:** I-13 (scope, deps, acceptance: "first exchange answers `confirm`
or `interstitial_required`"), I-40 (re-scope), I-14 (adopt §2.1 and §2.2: the nonce and proof
where the platform allows; Game Center window; Steam and Play Games links made through an app
follow D-A3's scoping, else C5 recurs for Steam), I-15 (the regular sign-in writes `signin-fresh`
and ends on the link offer), I-10a and I-10b (no `exchange` there), I-19 (points at I-50),
I-35 (`invalid_identity` member set), U-06, U-07, U-21 (sign-in may be automatic). Status of I-13,
I-40, I-43 and I-49: `awaiting-approval` with `planRef` this file. _Approved 2026-10-26: the rows are `todo` with `planRef` CC-01 (plan-combined.md)._

**Native packages are split (R-18).** For I-44, I-45 and I-48, rungs 1–4 need I-10a or I-10b only; rungs 6–7 (the regular sign-in and the link offer) need I-15, whose plan (`plans/I-15.md`) is written first and adds the `signin-fresh` write.

## 6. First wave: slices (≤ 60 minutes each)

Wave 1 builds on CC-03: the exchange binds the keys named in the nonce request, and I-13.4 registers them through CC-03's `registerDeviceKeys(…, {via: "exchange"})`. CC-03 lands before I-13.4 and I-40 (the former "no-op before CC-key" is gone). Order: I-42.1 → I-42.2; I-13.1 → (.2, .3 in parallel) → .4 → .5 → .7 → .8; I-43.1
after .4; I-43.2 after .1 and .5; I-46.1 after I-13.1; I-13.9 last.

| Slice      | Goal                                                                                                                                                       | Files                                                                                                                | Tests and gates                                                                                     |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | --- |
| I-42.1     | `identity.platformSignIn` validator, schema, mutation rows                                                                                                 | `shared-manifest/src/index.ts`, `schemas/v1/product.schema.json`, `test/schema-parity.test.ts`                       | `index.test.ts`, `schema-parity`; rule 9; `bundle:action -- --check`                                |
| I-42.2     | Settings rows, resync, reserved-audience refusal, console Platform sign-in group                                                                           | `services/identity/settings.ts`, resync path, `AppSignIn.tsx`, `settingHomes.ts`                                     | settings tests, admin vitest; `pnpm gen settings`; UX BUILT short                                   |
| I-13.1     | Contract: §12.11 text, protocol types, `errors.json` codes, SIGN-IN.md §4.4/D-22/§6.1 rewrite                                                              | `WIRE-CONTRACT-V4.md`, `shared-protocol/src/identity.ts`, `conformance/parity/errors.json`, `docs/design/SIGN-IN.md` | `pnpm gen constants --check`; typecheck                                                             |
| I-13.2     | Nonce route, kind `exchange-nonce`, buckets, OpenAPI, route oracle                                                                                         | `passthrough/nonce.ts` (new), `routes.ts`, `core/singleUse.ts`, `core/rateLimit.ts`, OpenAPI, oracle                 | `nonce.test.ts`, `routeCoverage`, `serviceRouteOracle`, `limits`                                    |
| I-13.3     | Verifiers: `authorizedParties` in `verifyIdToken`; native Google and Apple; audiences resolver (settings ∪ outlets via the `delivery` hook)                | `core/oidc/client.ts`, `providers/native.ts` (new), `core/hooks.ts` (read only)                                      | fixture JWKS: wrong aud, azp, iss, nonce, old iat; card tokens refused; `boundaries`                |
| I-13.4     | The grant: proof check, nonce consume, `linkedOnly` lookup with tenant scopes, answers token / `choose` / `interstitial_required` with `linkHandle`, audit | `passthrough/token.ts`, `passthrough/exchange.ts` (new), kind `exchange-link`                                        | `exchange.test.ts`: cross-team miss, email never joins, replay, foreign key, Identity off           |
| I-13.5     | L-1: `confirm` status, `ExchangeConsentView`, `consent` on `choice/complete`, grant writes, D4 mint                                                        | `passthrough/grant.ts`, `choiceRoutes.ts`, `continue.ts` (shared scope hash)                                         | confirm → complete writes the grant row; missing consent refused; lost mint → 409; store down → 503 |
| ~~I-13.6~~ | Deleted: the proof, its vectors and `client-core/src/proof.ts` are CC-03.4 and CC-26.1                                                                     |                                                                                                                      |                                                                                                     |     |
| I-13.7     | Transcripts and the Node replayer; discovery members                                                                                                       | `test/transcripts/scenarios/identity.ts`, discovery fragment, `sdk-node` replayer                                    | `pnpm gen transcripts --check`; parity rows `planned`                                               |
| I-13.8     | THREAT-MODEL section and I-06 edit, PRIVACY rows                                                                                                           | `docs/security/THREAT-MODEL.md`, `docs/PRIVACY.md`                                                                   | prettier                                                                                            |
| I-43.1     | `signin-fresh` written by same-device grants only                                                                                                          | `passthrough/token.ts`, `choiceRoutes.ts`, `core/singleUse.ts`                                                       | device code, exchange and nearby never write it                                                     |
| I-43.2     | `GET` and `POST link`, scoping rule, email variant to both addresses, audit, transcripts                                                                   | `passthrough/link.ts` (new), `routes.ts`, OpenAPI, `core/notify/templates.ts`, scenarios                             | malicious-token case (C5) refused global; conflict; step-up; `routeCoverage`                        |
| I-46.1     | Copy keys, SignIn states, `NearbyApproval` component, ui-matrix rows                                                                                       | `packages/brand/kit-copy/*.json`, `components.json`, `tools/ui-matrix.ts`                                            | `pnpm gen brand ui-matrix corpus --check`; copy lint; UX review of copy                             |
| I-13.9     | Security review of I-13, I-42, I-43; one fix round                                                                                                         | per finding                                                                                                          | write-up stays local                                                                                |

### Dispatch briefs

Common to every slice:

- Prefix every JS command with `mise exec node@22 --`.
- Tests: `pnpm --filter <pkg> exec vitest run <files>`, only the named files; generators after
  `pnpm build` (or `pnpm exec turbo run build --filter=<pkg>...`); prettier on changed files.
- Before hand-off, run `$PKEY_LEAD/gate.sh` once. Rerun a failed step only, with `GATE_ONLY=<n>`.
- Merge staging once, right before hand-off. Stop every background job.
- Report the changed files, the test results and anything the lead must do.
- Plan mode is satisfied by this approved plan; stop if a slice needs a signed-document change.

**I-42.1** — pkey-implementer (Sonnet 5.5). Plan: §2.6; §9 D-A1. Brief: `wp/I-42-*.md` (new).
Worktree `/Users/vlad/Repos/pk-wt/I-42.1`, branch `wp/I-42.1-platform-sign-in-manifest` from
`integ/next-stage`. Steps: 1. the block and the seven codes. 2. schema. 3. mutation rows. Out of
scope: Worker. Time box 60 min. Hand-off: the normalised shape.

**I-42.2** — pkey-implementer (Sonnet 5.5), then pkey-ux-reviewer (Opus 5.5, BUILT, short). Plan:
§2.6, §4 Console. Worktree `/Users/vlad/Repos/pk-wt/I-42.2`, branch `wp/I-42.2-platform-sign-in-settings`
after .1. Steps: 1. settings rows and resync. 2. the reserved-audience refusal. 3. the console
group; `pnpm gen settings`. Time box 60 min.

**I-13.1** — pkey-implementer (Sonnet 5.5). Plan: §0 C2, C3, C9; §2.1, §2.2, §2.5. Brief:
`wp/I-13-exchange-endpoint.md`. Worktree `/Users/vlad/Repos/pk-wt/I-13.1`, branch
`wp/I-13.1-exchange-contract`. Steps: 1. "Corrections (2026-10-24)" in the brief (C1-C12). 2.
§12.11. 3. types and codes; `pnpm gen constants`. 4. SIGN-IN.md rows. Time box 60 min.

**I-13.2** — pkey-implementer (Sonnet 5.5). Plan: §2.2 Nonce, §2.6 rule 10. Worktree
`/Users/vlad/Repos/pk-wt/I-13.2`, branch `wp/I-13.2-nonce-route` after .1. Steps: 1. route and
kind. 2. buckets. 3. OpenAPI, oracle. Time box 60 min.

**I-13.3** — pkey-implementer (Sonnet 5.5). Plan: §0 C1; §2.2 table. Worktree
`/Users/vlad/Repos/pk-wt/I-13.3`, branch `wp/I-13.3-native-verifiers` after .1. Steps: 1.
`authorizedParties`. 2. native verifiers. 3. audiences resolver. Time box 60 min. Hand-off: the
fixture keys for .7.

**I-13.4** — pkey-implementer (Sonnet 5.5). Plan: §2.1, §2.2 Answers. Worktree
`/Users/vlad/Repos/pk-wt/I-13.4`, branch `wp/I-13.4-exchange-grant` after .2, .3. Steps: 1. proof
and nonce. 2. lookup and outcomes. 3. `linkHandle`. 4. audit. Time box 60 min.

**I-13.5** — pkey-implementer (Sonnet 5.5). Plan: §2.2 Completion; §9 D-A2, D-A5. Worktree
`/Users/vlad/Repos/pk-wt/I-13.5`, branch `wp/I-13.5-confirm-consent` after .4. Steps: 1. `confirm`. 2. `consent` on complete. 3. D-A2 as approved. Time box 60 min.

**I-13.6** — deleted (now CC-03.4).
(see CC-03.4)

**I-13.7** — pkey-implementer (Sonnet 5.5). Plan: §2.5. Worktree `/Users/vlad/Repos/pk-wt/I-13.7`,
branch `wp/I-13.7-exchange-transcripts` after .5, .6. Steps: 1. scenarios. 2. discovery. 3. Node
replayer; `pnpm gen transcripts parity`. Time box 60 min.

**I-13.8** — pkey-implementer (Sonnet 5.5). Plan: §4 threat and privacy. Worktree
`/Users/vlad/Repos/pk-wt/I-13.8`, branch `wp/I-13.8-threat-privacy` after .5. Time box 45 min.

**I-43.1** — pkey-implementer (Sonnet 5.5). Plan: §2.3 Step-up. Worktree
`/Users/vlad/Repos/pk-wt/I-43.1`, branch `wp/I-43.1-fresh-signin` after I-13.4. Time box 45 min.

**I-43.2** — pkey-implementer (Sonnet 5.5). Plan: §0 C4, C5; §2.3; §9 D-A3. Worktree
`/Users/vlad/Repos/pk-wt/I-43.2`, branch `wp/I-43.2-link-route` after I-43.1, I-13.5. Steps: 1.
routes. 2. scoping. 3. email and audit. 4. transcripts; S-16 item 13 note. Time box 60 min.

**I-46.1** — pkey-implementer (Sonnet 5.5), then pkey-ux-reviewer (Opus 5.5) on copy. Plan: §3
Kit screens; §9 D-A9. Worktree `/Users/vlad/Repos/pk-wt/I-46.1`, branch `wp/I-46.1-auto-sign-in-copy`
after I-13.1. Steps: 1. copy keys. 2. states and component. 3. ui-matrix rows; regenerate. Time box 60 min.

**I-13.9** — security reviewer (Sonnet 5.5), then each finding's builder for one fix round. Plan:
§4 threat table; §7 SR-1. Worktree `/Users/vlad/Repos/pk-wt/I-13.9`, branch
`wp/I-13.9-security-fixes` after all above. Steps: 1. review merged diffs from their merge base. 2.
one fix round. 3. `--set I-13 in-review`. Time box 60 min. Write-ups stay local (public repo).

## 7. Security reviews (Sonnet 5.5, one fix round each)

- **SR-1 (I-13.9):** verifiers (aud, azp, iss, nonce, `iat`), proof and nonce binding, tenant
  scopes and the cross-team miss, reserved audiences, no-oracle errors, L-1 completion, `signin-fresh`
  writers, the C5 scoping rule, emails.
- **SR-2 (I-40):** nearby relay phishing, network match, key binding, number matching and fatigue,
  D's poll proof, no grant on D, budgets, the email.
- **SR-3 (I-49):** restore secret custody, revoke on sign-out, rotation, loops.
- **SR-4 (per SDK, light):** key storage and proof (Keychain, Keystore, WebCrypto non-extractable),
  Credential Manager and ASAuthorization nonce handling, FedCM/GIS script loading and CSP, Godot
  bindings.
- **I-14:** its per-verifier reviews add the Game Center window and in-app Steam scoping.
- UX reviews (BUILT, real devices or browsers) for every kit state in §3.

## 8. Owner steps

_Superseded by plan-combined.md §3.2 (one list for all three plans)._

- **Google Cloud** (per product the owner ships, Diceroll and DJDL first): an OAuth consent screen
  (External, app name, support email; scopes `openid email profile`); a **Web** client (the
  server client id; authorised JavaScript origins = the product's `web.origins`); an **Android**
  client per package (package name and the SHA-1 of the Play app signing key, plus upload and debug
  keys); an **iOS** client if Google is offered on iOS. Put the ids in `.pkey/product` or the
  console.
- **Apple Developer** (Certificates, Identifiers & Profiles): enable **Sign in with Apple** on each
  App ID (group a product's iOS and macOS App IDs under one primary App ID), regenerate the
  provisioning profiles, add `com.apple.developer.applesignin` in Xcode; note the Team ID. Game
  Center capability for games (I-14). No Apple account deletions and no user management.
- **Play Console** (games, I-14): link Play Games Services to the same Cloud project.
- **App Review:** an iOS app that offers Google must also offer Sign in with Apple (Guideline 4.8);
  the kits' provider row already does.
- Nothing is needed on Polaris's own Google client or Services ID.

## 9. Open decisions (recommended option first)

_Answered 2026-10-26, all as recommended, in plan-combined.md §3: D-A1 is Q11, D-A2 is Q4, D-A3 is Q5; D-A7 to D-A10 merge into Q2 and R-2; D-A4, D-A5, D-A6, D-A11 to D-A14 are accepted in R-16 (D-A13: no email on a first in-app consent)._

| #     | Question                                                          | Recommendation                                                                                                                                                                      | Alternative                                                                                    |
| ----- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| D-A1  | Where audiences live                                              | **`identity.platformSignIn` (manifest and console), outlet bundle ids unioned in**                                                                                                  | Outlets only plus a product connection for Google (product-scoped, never vouches: wrong model) |
| D-A2  | New device, consented app, exactly one candidate with a free seat | **Bind silently on the exchange path (amends SIGN-IN.md O-1, the one-tap licence confirm, for auto sign-in only); choice still shows for two or more, full, Keep, or a first mint** | Keep SIGN-IN.md O-1's one-tap confirm everywhere                                               |
| D-A3  | Scope of an app-made link                                         | **Google global only when the vouched email is already verified on the account, else `google-client:<id>`; Apple `apple-team:<id>`**                                                | Global as asked (C5 takeover); or all app links developer-scoped                               |
| D-A4  | Apple nonce                                                       | **The server nonce as is, bound by the proof**                                                                                                                                      | SHA-256 of it (Firebase style)                                                                 |
| D-A5  | L-1 on the wire                                                   | **`status: "confirm"` pending grant completed by `choice/complete` with `consent`**                                                                                                 | A separate consent route                                                                       |
| D-A6  | No link                                                           | **`interstitial_required` with `reason: "no_link"` and a `linkHandle` reused by the offer (no second Apple sheet)**                                                                 | A distinct code; a fresh token for the offer                                                   |
| D-A7  | Nearby flow                                                       | **Dedicated nearby request**                                                                                                                                                        | Reuse device code (phishable code, legacy engine, choice on the card)                          |
| D-A8  | Nearby proximity                                                  | **Hard same-client-network match; device code is the fallback**                                                                                                                     | A callout only (lets a remote relay through)                                                   |
| D-A9  | Approver input                                                    | **Number matching (three numbers, one tap)**                                                                                                                                        | Compare and tap Approve                                                                        |
| D-A10 | Licence on nearby                                                 | **Chosen on the approving device; full gives `device_limit` there; no Replace in v1**                                                                                               | Choice on the new device (needs a grant on a cross-device channel)                             |
| D-A11 | Restore rung                                                      | **One restore-secret primitive on iCloud Keychain and Block Store**                                                                                                                 | Android Restore Credentials (WebAuthn-shaped, per-product RP and cert hashes)                  |
| D-A12 | Web at launch                                                     | **FedCM `silent`; a prompt only if the developer opts in**                                                                                                                          | `optional` by default (a browser prompt on first visit)                                        |
| D-A13 | Email on an in-app first consent                                  | **None; Connected apps lists it**                                                                                                                                                   | A notice email per first app sign-in                                                           |
| D-A14 | macOS Local Network prompt on a signed-out first launch           | **Nearby starts after one tap on macOS ("Use my phone"); automatic on Windows and Linux, where D connects out and needs no prompt (L-11 holds)**                                    | Prompt at launch when the developer opts in                                                    |
| D-A15 | Who builds the approver's prompt                                  | **This plan's kit packages (it is a sign-in screen); Cloud Connect supplies the channel**                                                                                           | plan-cloud-connect                                                                             |

## 10. Interfaces

**From plan-cloud-connect (consumed).**

- **CC-key (P-1, Core `core/devices`):** `registerDeviceKeys(db, product, deviceId, {sign,
agree}, {via})`, `deviceSignKey(db, product, deviceId)`, raw 32-byte keys in base64url, and the
  SDK key store each SDK's proof signs with. If CC defines a general request proof, `pkey-proof/1`
  becomes it (CC-03.4, R-6).
- **CC-chan (P-4, P-6; R-2, R-3, R-4):** the signed-in approver M advertises (m=v) and D connects out, **without listening** (no firewall prompt on Windows or Linux); the Noise handshake hash;
  `VOUCH_REQ` (0x8010) = `{v: 1, request, signKey, agreeKey, label, platform, sig}`, where `sig` is
  `pkey-proof/1` purpose `vouch` over `<b64url h>.<request>` (no userCode, no separate pop);
  `VOUCH_RESULT` (0x8011) = `{status}` (approved, denied, expired, not_nearby, device_limit), UX
  only. The number-matching value is R-3's commit-reveal code (`SAS_COMMIT` 0x8014, `SAS_NONCE`
  0x8015, `SAS_REVEAL` 0x8016), not the raw handshake hash.
- After approval, CC issues D's `pkey-peer+jws` on D's first authenticated call and lists D in the
  linked-devices view; `identity/signout` stops renewal.

**To plan-cloud-connect (provided).** The nearby routes (§2.4), their errors, and the rule that the
server, never the channel, decides.

**With plan-cloud-sync.** A device signed in by exchange, restore or the regular sign-in has no
sync root key; `AutoSignInResult` carries `syncKey: "present" | "needed"` and Cloud Sync's flow
obtains it (P-3, P-5 handover over the channel, or recovery). The restore secret (I-49) and P-3's
platform key backup are separate items in the same stores, on sign-out only the restore secret is revoked and deleted; the sync-root backup item stays (R-11, amends §10): deleting a synchronizable keychain item deletes it on every device of that Apple ID. Only Reset encryption, Start over or account deletion removes it. Sign-in makes
`account_required` rarer; nothing in WIRE-CONTRACT-V4 §13 changes.
