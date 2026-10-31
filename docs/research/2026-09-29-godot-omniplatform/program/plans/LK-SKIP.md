# Plan: LK-SKIP, continue without an account (the floating-key return)

Planner: pkey-wire-planner, 2026-10-28. **Documents only, no code.** Read on staging
`bb11a9f8c3`. LK-SKIP.1 is already merged there (`0cb3920795`: frame 48's reason lines, no skip
control). Inputs:

- `_lead/plans/UK-42-slices.md` §2 (the slice table, the LK-SKIP notes, Q8 to Q10) and S-24 D13,
  D14, D23 and D24;
- WIRE-CONTRACT-V4 §12.4 and §12.5 (the record) and **WIRE-CONTRACT-V5**, the current spec;
- `shared-protocol/src/identity.ts` and `client-core/src/identityRedirect.ts`;
- `passthrough/{authorize,request,code,token,bind,continue}.ts`;
- `AccountUpgrade.tsx` and `SignInPage.tsx`, SIGN-IN.md §3.9 and the UK-42 holder flow in
  `ui-core/src/browser/driver.ts` and `sdk-react/src/kit/sdk.ts`.

**Correction to the slice table.** It says "V4 amendment, `PROTOCOL_VERSION` stays 4". That
predates CC-04.1. V4 is superseded, so this plan amends **V5**, and `PROTOCOL_VERSION` **stays 5**.

## 1. Summary

The person is on the Polaris Locker card, sent there by an app. They choose **Have a license key?**,
the preview answers `addable` and `skippable`, and they press **Continue without an account**. The
app then gets a device on the key's licence, with no account and no subject. After that, the app
shows UK-42's "Not in an account · Add your name and email".

- `authorize` gains the optional `key_return=allow`. The SDK sends it only when the host opts in,
  and the request view answers `keyReturn: true`.
- A new signed-out card route, `POST /api/signin/requests/{request}/key {key} → {redirect}`, takes
  the request and issues a code that names the key's licence and no account.
- `token` redeems that code by key, as `license/activate` would bind it: `bound_by='key'`, one
  `browser` key entry, and no sign-in binding written. It answers the §12.5 body plus `via: "key"`
  and `keyEntries`, with `subject` normally `null`.
- **Additive.** `PROTOCOL_VERSION` stays 5. The signed corpus is not touched, and two transcripts
  are added. The launch gate `launch.identityKeyReturn` (default off) guards the whole feature.

## 2. Contract

**Which V5 sections change.**

| §            | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| §12.4 table  | Adds the row `key_return`: optional, and its only value is `allow` (any other value is `invalid_request`). It is recorded only when `purpose` is `signin`, the product runs License and the gate is on. Otherwise it is dropped silently.                                                                                                                                                                                                                    |
| new §12.4.2  | **The key return [C]**: the route, the order of its refusals (§6) and the code it issues.                                                                                                                                                                                                                                                                                                                                                                    |
| §12.5 rule 3 | The key-return `200` is exactly the §12.5 members plus `via: "key"` and `keyEntries`. In it, `scope` is `""`, `license` is never `null`, and `subject` is `null`: the bind by key re-binds the device without an account, as `license/activate` does, so it writes no binding and clears any binding the device held (U-02). A `via: "key"` body that breaks any of these is malformed and a client refuses it. The Worker sends it only for a §12.4.2 code. |
| §12.5 rule 5 | On a key code, `license_owned` (with `signInUrl`) and `key_entry_limit` (with `keyEntries` and `manageUrl`) are flat under their own codes, as on `license/activate`. They are not folded into `not_entitled`.                                                                                                                                                                                                                                               |
| §12.2 rule 1 | `browser` also covers redeeming a key-return code. The device is then the app's, not `browser:<licenseId>`, and the entry is counted once, in the seat batch at `token`.                                                                                                                                                                                                                                                                                     |
| §12.7.2      | `SignInRequestView.keyReturn` is `true` on an opted-in request and absent otherwise, so every existing transcript stays byte-identical.                                                                                                                                                                                                                                                                                                                      |
| §9           | One sentence: LK-SKIP changes no counter.                                                                                                                                                                                                                                                                                                                                                                                                                    |

§12.6 (discovery), §12.8 and §12.10 do not change.

**`packages/shared-protocol/src/identity.ts`:**

- `AuthorizeParams.key_return?: "allow"` and `KEY_RETURN_ALLOW`;
- `SignInRequestView.keyReturn?: true`;
- `SignInKeyReturnRequest {key}`, answered by the existing `SignInRedirect`;
- `KeyReturnTokenResponse`, which is `TokenResponse` with `via: "key"`, `subject: string | null`,
  `license` non-null and `keyEntries` required.

`TokenResponse` itself does not change, and `subject` stays required on every other path.

**`packages/client-core/src/identityRedirect.ts`:**

- `StartRedirectOptions.keyReturn?: boolean` appends `key_return=allow` **last**, after
  `license_choice`, so the fixed query order holds. `RedirectPending.keyReturn` records it.
- `parseTokenAnswer(status, body, {keyReturn?})` decides in this order:
  1. non-200: `refused`;
  2. `status: "choose"`: `choose`;
  3. `via: "key"` with the opt-in set: `activated`
     `{accessToken, scope, subject: string | null, schemaVersion, device, license, keyEntries}`;
  4. `via` with any other value, or `via: "key"` without the opt-in: `malformed`;
  5. otherwise, today's rule (`subject` must be a non-empty string): `token`.
- `refused` gains an optional `details`: `limit`, `deviceCount`, `manageUrl`, `keyEntries` and
  `signInUrl`, when the flat body carries them. The kits' DeviceLimit step needs them.

**Why it stays at 5.**

- No `typ`, claim, header or signed shape changes, and `shared-jws` is untouched.
- Deployed Workers ignore unknown `authorize` parameters. They refuse only `request_uri`.
- The subject-less body exists only behind an opt-in that no deployed SDK sends.
- Making `subject` optional for everyone instead would break all six SDKs (`malformed`), and that
  would need the bump.
- The precedent is I-08b's `license_choice=app` and its `choose` body.
- `corpusVersion` 2, `DISCOVERY_VERSION` 2, `CACHE_VERSION` 3 and `transcriptVersion` 1 do not
  change.

## 3. Catalog and manifests

None. There is no validator rule (rule 9), manifest key or `shared-catalog` change.

## 4. Corpus and transcripts

- **Signed corpus:** no change. `pnpm gen corpus --check` stays clean, and neither
  `conformance/corpus/v2/` nor the Godot mirror moves. `ui-matrix` does not change, because the
  kits reuse UK-42's `holders` states.
- **Transcripts:** two new ones, recorded by LK-SKIP.4 through `pnpm gen transcripts`, Godot
  mirror included. Both are tagged `features: ["identity.keyreturn"]` and
  `requires: ["identity.redirect.web"]`, so a `planned` replayer skips them. Never weaken a runner.
  - `redirect-web-key-return.json`:
    1. `browser` authorize with `args.keyReturn: true`;
    2. the request view (`keyReturn: true`), `key/preview`, then `…/key` → `{redirect}`;
    3. `redirectComplete {keyReturn: true}`, expecting `result: "activated"`, the `licenseId`,
       `subject: null`, `keyEntries` and `tokenHeld: true`;
    4. the same callback again, expecting `invalid_grant`.
  - `redirect-web-key-return-limit.json`: a full licence. `token` answers `403 device_limit`, and
    the SDK result carries `limit`, `deviceCount` and `manageUrl`. The code is consumed before the
    bind, so the retry after a refusal at `token` starts from a fresh card press.
- **Registry:** `conformance/parity/features.json` gains `identity.keyreturn`. The id must match
  `FEATURE_ID`, which is lowercase only, so UK-42's `identity.signin.keyReturn` is invalid. Then
  run `pnpm gen constants parity`. There is no new error code, and `errors.json` and `enums.json`
  do not change.
- **Unit vectors** in client-core (no corpus file): the query bytes, the opt-in strictness (a
  `via: "key"` body without the opt-in is `malformed`), the body shape (a `via: "key"` body is
  `malformed` unless `scope` is `""`, `license` is an object, `keyEntries` is `{used, limit}` of
  non-negative integers, `subject` is a pairwise-subject string or `null`, and the other members
  are as in the ordinary answer) and `details`.

## 5. SDKs, in order

Every SDK tells the two answers apart by `via: "key"` **and** its own opt-in, never by `subject`
alone. On `activated` it stores the token as a key activation. It sets the stored subject to the
answered value, which clears it on `null`, and it emits `activated`, never `signedIn`.

| #   | SDK                          | Must                                                                                                                                                                                                                                                                                                                                                                              | WP                       |
| --- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| 1   | client-core                  | the §2 changes and unit vectors                                                                                                                                                                                                                                                                                                                                                   | LK-SKIP.6a               |
| 2   | React and the browser        | `RedirectSignInOptions.keyReturn` and the `activated` outcome. In GateDriver and `kit/sdk.ts` the app starts at once: no ActivateDone, because the card already showed the reasons (D14), and AccountAndLicense shows UK-42's `account.notInAccount` row. A licence that waits for its email shows UK-42's waiting row instead. Also the React replayer, and parity `implemented` | LK-SKIP.6b               |
| 3   | Node                         | `signIn.start({channel: "redirect", keyReturn})`, the `activated` outcome, the replayer, and parity                                                                                                                                                                                                                                                                               | LK-SKIP.7                |
| 4–7 | Python, Swift, Kotlin, Godot | port the opt-in, the `via` rule, `activated` and the replayer (each already implements `identity.redirect.web`)                                                                                                                                                                                                                                                                   | LK-SKIP.8 to .11 (§10.9) |

Until an SDK implements it, its parity row stays `planned` (`wp` set). Such an SDK never sends the
parameter, so the feature is invisible to it. There is no typed N/A, because every runtime has the
redirect.

## 6. Worker

**Launch gate `launch.identityKeyReturn`.** It follows the LG-1 pattern: default off, fail closed.

- Files: `core/settings/launchGates.ts`, `platformRead.ts`, `platform/env.ts`
  (`LAUNCH_IDENTITY_RETURNKEY`, `@editable`), the `wrangler.toml` envs, `dev/world.ts` and
  `test/seed.ts`. Regenerate with `pnpm gen settings platform-inventory`.
- With the gate off, `authorize` drops the parameter, the route answers `404`, and `token` answers
  `invalid_grant` for a key code.
- Adding the gate is a THREAT-MODEL §9 trigger.

**Request kinds (§10.3).** The route serves every request that carries `authz`:

- `web`: now;
- `native`: when I-15 ships. The pushed request carries `key_return` as a §12.4 parameter, and the
  code carries the pusher's device;
- **device code: never.** The request has no `authz`, so the route answers `404`. See §8.

**Card route `POST /api/signin/requests/:request/key` (§10.4).**

- It is a `PORTAL_API_ROUTES` row with `auth: "none"`, and it reads no session.
- Rule 10 needs four things: the OpenAPI path, the `routeCoverage` `portalApi` row, the
  `portalApiRouteTable.test.ts` rows, and the portal API oracle re-recorded with
  `PKEY_RECORD_ORACLE=5` (never mode 2).

Refusals come in this order, and none of them consumes anything:

1. Method `POST` (else `405`). Then `isSameOriginRequest`, `hasJsonContentType` and a JSON body of
   at most 1 KiB (else `404` or `400 invalid_request`).
2. `identityKeyReturn`: 10 a minute per client network, charged before any lookup and failing
   closed. A refusal is `429 rate_limited` with `retryAfter`.
3. Each of these answers `404 not_found`, always in the same shape:
   - `liveRequest`: the binder, a live request and Identity on;
   - `authz.keyReturn`;
   - the gate is on;
   - License is on.
4. `identityKeyReturnRequest`: 5 per request handle per 600 s, keyed by the handle's peppered hash.
   A refusal is `429`.
5. A malformed key is `422 bad_request`. The key's product must be the request's product.
   Otherwise, or for an unknown or inactive key or a missing licence, the answer is
   `401 unauthorized`. These are the preview's answers.
6. A licence in an account: `403 license_owned` with `signInUrl`, whatever
   `identity.keyEntryRefusals` says (§10.4b).
7. Refusals on and `used ≥ limit`: `403 key_entry_limit` with `keyEntries` and `manageUrl`.
8. `takeSignInRequest`: one atomic consume, so a lost race is `404`. It issues a code with
   `{kind: "key", product, clientId, redirectUri, licenseId, keyHash, nonce, scope: []}`, PKCE-bound
   as today. The record also carries `accountId: ""` and `subject: ""`, so a `token` that predates
   LK-SKIP fails closed with `invalid_grant`. It audits `signin.key` with the licence, no actor and
   no key. The answer is `{redirect: "<redirect_uri>?code=…&state=…&iss=…"}`.

Some notes on the route:

- **Seats are not checked here.** The device is unknown until `token` (D5), so `token` checks
  `device_limit` (§10.10).
- The route does not read the portal switches, because this is an activation, not a claim.
- An assigned licence that is still waiting for its email is admitted, as `license/activate` admits
  it.
- **Privacy.** The key is in the POST body only. Not the URL, the redirect, the request or code
  record, sessionStorage, a log or the audit. `keyHash` is the peppered hash D1 already stores, and
  it cannot be presented as a key. The route writes no refusal log, because it has no device, and
  `token` writes one.

**`token` (§10.5).** It branches on `record.kind === "key"` after the redemption and the `client_id`
and `redirect_uri` checks.

- There is no account check, and it never answers `choose`.
- It re-reads the key by `keyHash`. A key that is no longer active, a licence that is no longer
  usable, or a licence whose product differs is `invalid_grant`, and so is a code redeemed with
  `launch.identityKeyReturn`, Identity or License off.
- It repeats the route's owned check whatever `identity.keyEntryRefusals` says: a licence that is
  in an account is a flat `403 license_owned` with `signInUrl`, and nothing is counted.
- It binds through `bindKey`, split so that it takes a key hash and an optional account:
  `keyEntryGate`, then `authorizeDevice` with `boundBy: "key"` and `keyEntry.surface: "browser"`.
  It **skips `setDeviceSubject` and `markFresh`**.
- The device rules are therefore exactly the ones `license/activate` applies to the same key and
  `X-PKey-Device`.
- It audits `signin.token.key` with the device and the licence.

No D1 table and no migration: `browser` already passes the `license_key_entries` CHECK, and
`TABLE_OWNERS` is unchanged. `pnpm gen docs-reference` covers the route, and `pnpm gen settings`
covers the gate's page.

**Card (LK-SKIP.5).** `AccountUpgrade` draws **Continue without an account** (`signin.key.skip`)
with `signin.key.skipNote` only when all of these hold:

- `request.keyReturn`;
- the verdict is `addable` and the upgrade is `skippable`;
- `preview.product.slug === request.client.product`.

The press posts the key held in the `upgrade` step's state and follows `redirect`. Refusals stay
in place:

| Refusal             | What the card shows                                                              |
| ------------------- | -------------------------------------------------------------------------------- |
| `license_owned`     | the §3.9 owned copy                                                              |
| `key_entry_limit`   | the forced body, led by "You can't continue without an account:", no key card    |
| `401`, `422`, `429` | a message under the skip button (a `429` holds it for `retryAfter`, then clears) |
| `404`               | the request's gone state                                                         |

SIGN-IN.md §3.9 drops "Deferred (LK-polish M5)". §4.3 and §6.1 gain the route. The copy keys
exist already.

## 7. Rollout and deployed clients

- **Order:**
  1. .2, the contract;
  2. .3a to .5: the Worker and the card in one deploy (the SPA ships in the Worker's assets), with
     the gate off;
  3. red and green sign-off, then the gate on in staging and then in production;
  4. the SDK releases. They are harmless before the gate is on.
- **Deployed SDKs (all six)** never send `key_return`. Their codes and token answers are
  byte-identical, so nothing changes for them.
- **A new SDK on an old Worker, or with the gate off:** the parameter is ignored and the card shows
  no skip. The SDK still parses a normal sign-in. No discovery member is needed (§10.8).
- **Rollback with a key code in flight** (at most 60 s): the old `token` resolves the empty
  `subject` to no account and answers `invalid_grant`. No seat was taken, because binding happens
  at `token`, so the person retries. Slice .4 pins this with a test of the account path.
- **Requests created before the deploy** carry no `keyReturn`, so they get no skip.

## 8. Security

**THREAT-MODEL:** a new section, "The key return on the card (LK-SKIP)", after I-08b, plus the §9
trigger for the new gate. Its rows:

- **Worth of a code.** Exactly the key, for one device id, for 60 s. It equals `license/activate`
  with that key: one counted entry and no binding. Only a holder of the key can mint one, and the
  app never learns the key.
- **Replay.** The request is consumed atomically, so one press gives one code. The code is single
  use, lives 60 s, and is bound to S256, `client_id` and `redirect_uri`. A wrong verifier ends it.
- **CSRF and forwarded links.** The binder is HttpOnly, Secure and SameSite=Lax, backed by Fetch
  Metadata and a JSON content type. A forwarded card URL is `404`. A forwarded `authorize` link
  binds the victim's own browser, and its code lands at the registered URI, where the app's `state`
  check refuses it. A leaked code yields one seat on the key's licence, which is less than the
  account a leaked sign-in code yields.
- **Opt-in at both ends.** A key code needs `key_return=allow` with `purpose=signin`. A client
  accepts `via: "key"` only when it opted in. `attach` never gets the skip, because it would bind
  the device to a different licence.
- **Device code is excluded** (R1-07). A person talked into confirming a TV's code and typing their
  key would bind the attacker's TV to their licence. Native classes are same-device and PKCE-bound,
  and they follow I-15's sign-in rule.
- **Enumeration.** Keys are 128-bit and the preview already confirms a key, so the route adds no
  oracle. The budgets are in §6. There is no Turnstile, because nothing is emailed.
- **Limits hold.** An owned licence never moves by key through the card (S-16 D24). The entry is
  counted once. `device_limit`, `fingerprint_required` and `hardware_mismatch` come from
  `authorizeDevice`, unchanged.
- **Disclosure.** The answer carries the device, the licence (with its own `name` and `email`, as
  `license/activate` shows any key holder) and `keyEntries`. `subject` is always `null`: the bind by
  key writes no binding and clears any the device held (U-02), so a device signed in on the product
  leaves its account and its Cloud Sync principal, and the answer names no subject whatever bearer
  is presented. It never carries an account, an account email or the key.

**Reviews.**

| Slices       | Review                                        |
| ------------ | --------------------------------------------- |
| .3b, .4      | **red and green**                             |
| .3a, .5, .6a | green (.5 for the key handling)               |
| .2           | wire review, plus a green read of the section |

The red write-ups and any unreleased fix branch stay local, because the repo is public. The gate
turns on only after both sign-offs.

## 9. Slices (each 60 minutes or less, Sonnet 5.5)

The builders are pkey-implementer (Worker and portal) and pkey-sdk-porter (SDKs). The wire and UX
reviewers run on Opus 5.5. Prefix JS commands with `mise exec node@22 --`.

| ID     | Goal                         | Owns                                                                                                                                                                                                                                               | Tests (scoped)                                                                                                                                             | Gen                           | After    | Min     |
| ------ | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | -------- | ------- |
| .1     | Frame 48 reasons             | **merged** `0cb3920795`                                                                                                                                                                                                                            | —                                                                                                                                                          | —                             | —        | —       |
| .2     | Contract and threat model    | `WIRE-CONTRACT-V5.md` (§2 rows); `THREAT-MODEL.md`; `shared-protocol/src/identity.ts`; `features.json`; six `parity.json` (`planned`)                                                                                                              | protocol `test`; `pnpm gen corpus --check` (clean)                                                                                                         | `constants`, `parity`         | approval | 45      |
| .3a    | Gate, `authorize`, view      | `core/settings/{launchGates,platformRead}.ts`; `platform/env.ts`; `wrangler.toml`; `dev/world.ts`; `test/seed.ts`; `passthrough/{authorize,request,routes}.ts`; OpenAPI (parameter, member)                                                        | worker `vitest run test/surfaces/identityAuthorize.test.ts test/surfaces/passthrough.test.ts test/core/launchGates.test.ts test/platformInventory.test.ts` | `settings platform-inventory` | .2       | 45      |
| .3b    | Card route                   | `passthrough/{keyReturn.ts (new),code.ts}`; `portal/api.ts`; OpenAPI path; `test/routeCoverage.test.ts`; `test/services/identity/portalApiRouteTable.test.ts`; the oracle (`=5`); `test/surfaces/keyReturn.test.ts` (new)                          | worker `vitest run test/surfaces/keyReturn.test.ts test/routeCoverage.test.ts test/services/identity/{portalApiRouteTable,portalApiOracle}.test.ts`        | `docs-reference`              | .3a      | 60      |
| .4     | `token` and transcripts      | `passthrough/{token,bind}.ts`; `test/transcripts/scenarios/redirect.ts`; the two transcripts and their Godot mirror (generated)                                                                                                                    | worker `vitest run test/surfaces/keyReturn.test.ts test/surfaces/identityChoice.test.ts`; `pnpm gen transcripts --check` (only the two new files)          | `transcripts`                 | .3b      | 60      |
| .5     | Card control                 | `AccountUpgrade.tsx`; `SignInPage.tsx`; `portal/api/signin.ts`; SIGN-IN.md §3.9, §4.3, §6.1; `e2e/portalRequestStates.ts`                                                                                                                          | admin `vitest run test/portalRequestFlow.test.tsx`; `exec vitest run -c vitest.e2e.config.ts e2e/portalPassport.e2e.test.ts`                               | —                             | .3b      | 60      |
| .6a    | client-core                  | `client-core/src/{identityRedirect,index}.ts`                                                                                                                                                                                                      | client-core `vitest run test/identityRedirect.test.ts`                                                                                                     | —                             | .2       | 45      |
| .6b    | Browser SDK and React kit    | `ui-core/src/browser/sdk/core/signIn.ts`; `browser/sdk/browser/bearer/{redirect,session}.ts`; `browser/driver.ts`; `sdk-react/src/kit/sdk.ts`; `sdk-react/parity.json`; docs `features/sign-in/web-redirect.md`, `build/sdks/react/your-own-ui.md` | ui-core `vitest run test/browserGate.test.ts`; react `vitest run test/transcripts.test.ts test/bearerExchange.test.ts`; the docs snippet lane              | `parity`                      | .4, .6a  | 60      |
| .7     | Node                         | `sdk-node/src/identity/{redirect,signIn}.ts`; `sdk-node/parity.json`; docs `build/sdks/node/your-own-ui.md`                                                                                                                                        | node `vitest run test/identityRedirect.test.ts`; `pnpm --filter @polaris-key/conformance-node test`                                                        | `parity`                      | .4, .6a  | 45      |
| .8–.11 | Python, Swift, Kotlin, Godot | each SDK's `identity/redirect` port, its replayer and `parity.json`                                                                                                                                                                                | each SDK's own suite (CI runs the native replayers)                                                                                                        | `parity`                      | I-15b    | 45 each |

**Lanes:**

- .2 runs first.
- Then the Worker lane runs .3a, .3b and .4. Slice .4 holds the transcripts lane.
- .6a runs after .2, in parallel.
- .5 runs after .3b.
- .6b and .7 run after .4.
- `SignInPage.tsx` has one owner at a time: LK-SKIP.5.

Each slice reruns only its own families, then `pnpm gen --check`.

**Repo-side steps for the lead** (not done here):

1. Register LK-SKIP in `workpackages.json`: a ⚑ plan-mode row, deps UK-42 and I-08b, with a brief
   `wp/LK-SKIP-floating-key-return.md`.
2. Run `pnpm gen graph-index`, then
   `check.mjs --set LK-SKIP awaiting-approval`.
3. Merge this plan PR as the owner's approval.
4. Correct `_lead/plans/UK-42-slices.md`: V5 and 5, and the id `identity.keyreturn`.
5. Note the brief changes in §10.

## 10. Decisions for the owner (recommendation first)

1. **Parameter.** Use `key_return=allow`, an enumerated value like `purpose`, and
   `SignInRequestView.keyReturn: true`. The alternatives are `key_return=1` or a value folded into
   `license_choice`, which is wrong because the choice and the key return are independent.
2. **Answer shape.** Use `via: "key"`, with `subject` present as `string | null` (the device's real
   binding, normally `null`) and `scope: ""`. If `subject` were absent, or `null` were the only
   signal, a device that is already signed in would be mislabelled, and an SDK would infer a key
   activation from a missing member.
3. **Kinds.** Web now and native when I-15 ships, never device code.
4. **Card checks.**
   - a. Use the order in §6 with 10 a minute per network, 5 per handle and no Turnstile.
   - b. Always refuse an owned licence (`license_owned`), even with refusals off. The card never
     offers the skip for one.
5. **Binding surface.** Use `browser`, with no migration. The alternative is a new `card` surface,
   which needs a migration and a contract row.
6. **Kill switch.** Add `launch.identityKeyReturn`, off until the red and green sign-off. The
   alternative is no gate, relying on the opt-in alone.
7. **Kit default.** `<PolarisKeyGate>` and `<pk-gate>` opt in by default, with a prop to turn it
   off. A bare `signIn.start` defaults to off.
8. **Discovery.** Add no member, because old Workers ignore the parameter.
9. **Native SDKs.**
   - **Recommended:** keep them `planned`, and run .8 to .11 with I-15b. Native apps use loopback
     there, and device code (which they use today) is excluded. The native kits already offer
     **Continue without an account** in the app (UK-43).
   - The alternative is to port them now, after .4: four slices of 45 minutes each.
10. **`device_limit` is known only at `token`.** Accept this for v1: the card cannot know the
    device (D5), and the app shows DeviceLimit from `details.manageUrl`. The alternative is to add
    `seats` to `KeyPreview` and warn on the card. Under I-15 the pushed device is known, so the card
    could check it.

**Briefs this plan changes:**

| Brief | Change                                                                                                                                                                                            |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I-15  | `key_return` is a §12.4 parameter that the pushed record keeps. The view's `keyReturn` follows on native requests, and the code keeps the pusher's device, which `token` checks on a key code too |
| I-15b | the native SDKs' opt-in on loopback (LK-SKIP.8 to .11)                                                                                                                                            |
| UK-43 | the native kits render `activated` the way .6b does                                                                                                                                               |
| UK-42 | `identity.keyreturn` replaces `identity.signin.keyReturn`                                                                                                                                         |

## 11. Acceptance

```sh
mise exec node@22 -- pnpm --filter @polaris-key/protocol test
mise exec node@22 -- pnpm gen corpus --check   # clean: no corpus change
mise exec node@22 -- pnpm gen --check          # constants, parity, settings, platform-inventory,
                                               # docs-reference, transcripts (two new files only)
mise exec node@22 -- pnpm --filter @polaris-key/worker exec vitest run test/surfaces/keyReturn.test.ts \
  test/surfaces/identityAuthorize.test.ts test/surfaces/passthrough.test.ts test/routeCoverage.test.ts \
  test/services/identity/portalApiRouteTable.test.ts test/services/identity/portalApiOracle.test.ts
mise exec node@22 -- pnpm --filter @polaris-key/client-core exec vitest run test/identityRedirect.test.ts
mise exec node@22 -- pnpm --filter @polaris-key/admin exec vitest run test/portalRequestFlow.test.tsx
mise exec node@22 -- pnpm --filter @polaris-key/react exec vitest run test/transcripts.test.ts
mise exec node@22 -- pnpm --filter @polaris-key/conformance-node test
```

CI runs the Python, Swift, Kotlin and Godot replayers. They skip the two transcripts while their
rows are `planned`, and every existing transcript stays byte-identical.
