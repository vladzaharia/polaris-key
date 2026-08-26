# R8 — OIDC / OAuth / identity bootstrap

Red-team lane: the **device-code flow**, **magic links**, **claim trust**, and **cross-flow
confusion** across the three OIDC flows that share one platform IdP client
(`packages/worker/src/platformOidc.ts:9-30`).

- Repo: `/Users/vlad/.paseo/worktrees/2hzk6ip2/lewd-owl`, branch `lewd-owl` @ `bd26e0b`
- PoC suite: `packages/worker/test/attack/R8-oidc.test.ts` — **28/28 passing**
  (`export PATH="$HOME/.local/share/mise/installs/node/22/bin:$PATH"; cd packages/worker && npx vitest run test/attack/R8-oidc.test.ts`)
- No source file was modified. Full worker suite is unaffected by this file
  (the one unrelated failure in the tree is `test/attack/R11-data.test.ts`, another lane).
- Every `it()` in the PoC suite is phrased as the **attacker's claim**: a _passing_ test means
  the attack works.

## Headline

**`GET /<product>/auth/poll` is an unauthenticated credential-minting oracle keyed on a value
that OAuth defines as non-secret.** `pollAuthFlow` (`src/oidc.ts:823-855`) takes `device` straight
off the query string and passes it to `authorizeAndMint(..., flow.licenseId, deviceId, now)`
without ever comparing it to `flow.deviceId` — the exact binding the sibling
`POST /auth/device/poll` _does_ enforce at `src/oidc.ts:903-904`. Anyone who observes an OAuth
`state` (browser history, IdP access log, Referer chain, screen share) within the 10-minute flow
TTL mints a **live `pkeyt_` device token on someone else's license, bound to a device id they
chose**. `/auth/poll` is not vestigial — it is advertised as `pollUrl` in the public discovery
document (`src/discovery.ts:103`).

Three structural properties turn that into a chain:

1. `GET /auth/device/verify?device_code=…&confirm=1` (`src/oidc.ts:624-635`) is an unauthenticated
   GET that **returns the OAuth `state` and `nonce` in its `Location` header** and mutates state
   as a side effect — so a _device code_ is sufficient to obtain a _state_, and the device code
   is the thing the product is designed to display (`verificationUri === verificationUriComplete`).
2. There is **zero rate limiting anywhere in `src/oidc.ts`** — `grep -c rateLimit src/oidc.ts` is
   `0`, while `licensing.ts`, `enroll.ts`, `edgeMint.ts`, `admin/auth.ts` and `portal/auth.ts` all
   use the Durable-Object limiter.
3. The flow record is **re-PUT rather than deleted** after a successful loopback callback
   (`src/oidc.ts:814-816`), so `state` is not single-use and a second callback overwrites the
   bound license.

Positively: PKCE, the nonce binding, the asymmetric-alg allowlist, the confidential-client
fail-closed path, the poll-surface failure-reason suppression, and the product-scoped KV
namespacing all hold up under attack (see **REFUTED**).

---

## R8-01 — `/auth/poll` mints a device token for an ATTACKER-CHOSEN device id

|               |                                                                                                                                                                                |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Severity**  | **Critical**                                                                                                                                                                   |
| **File:line** | `packages/worker/src/oidc.ts:823-855` (`pollAuthFlow`), `:858-874` (`handleAuthPoll`); contrast `:903-904`; route `src/index.ts:132-133`; advertised at `src/discovery.ts:103` |
| **CWE**       | CWE-287 Improper Authentication; CWE-863 Incorrect Authorization; CWE-522 (bearer use of a non-secret)                                                                         |
| **PoC**       | ✅ `R8-01 › ATTACK: knowing only 'state', an attacker mints a LIVE device token…` and `› ATTACK: /auth/poll is an unauthenticated bypass of BOTH guards…`                      |

### The defect

```ts
// src/oidc.ts:823-855 — deviceId comes from the caller, flow.deviceId is never consulted
async function pollAuthFlow(env, db, product, state, deviceId, now) {
  if (!state || !deviceId) return errorResponse(400, ...);
  const raw = await env.HOT.get(flowKey(product.slug, state));
  if (!raw) return json({ status: "timeout" });
  const flow = JSON.parse(raw) as FlowRecord;
  if (flow.error) return json({ status: "error" });
  if (!flow.licenseId) return json({ status: "pending" });
  token = await authorizeAndMint(env, db, product, flow.licenseId, deviceId, now);
  //                                                               ^^^^^^^^ attacker-chosen
```

`FlowRecord.deviceId` is populated by `handleAuthDeviceStart` (`:507`, `:573`) and read exactly
once — at `:766-767`, purely to decide whether to merge an enrolled license. It is **never** used
as an authorization input.

`handleAuthDevicePoll` proves the binding was intended:

```ts
// src/oidc.ts:903-905
if (deviceFlow.deviceId !== deviceId)
  return errorResponse(401, "unauthorized", "device mismatch");
if (!deviceFlow.confirmedAt) return json({ status: "pending" });
```

`/auth/poll` bypasses **both** of those guards. The PoC demonstrates the same flow being refused
a `401` on `/auth/device/poll` and served a `ready` token on `/auth/poll` seconds later.

### Preconditions

The attacker must learn the flow's `state` inside the 600-second `FLOW_TTL_SECONDS` window.
`state` is a **non-secret** by construction (RFC 6749 §10.12 / OAuth 2.0 Security BCP): it is a
query parameter on the IdP authorize URL and on the callback URL. Realistic sources:

- the IdP's own access log and any reverse proxy in front of it;
- the victim's browser history / open tab / synced history;
- the `Referer` sent when the user navigates away from the callback page (that page sets **no**
  `Referrer-Policy` — `src/oidc.ts:817-820`);
- **a device code** — see R8-02, which turns any `device_code` into `state` + `nonce`;
- any browser extension, screen share, or terminal scrollback.

`state` is 128 bits (`b64url(randomBytes(16))`, `:500`), so it is not _guessable_ — but with no
rate limit the endpoint is an unbounded oracle, and the value was never designed to be secret.

### Exploit (end to end, exactly as in the PoC)

1. Victim's CLI: `POST /djdl/auth/device/start {deviceId:"victim-cli"}` → `{deviceCode, verificationUri}`.
2. Attacker (holding only `deviceCode`): `GET /djdl/auth/device/verify?device_code=…&confirm=1`
   → `302`, and `Location` is the IdP authorize URL carrying `state` and `nonce`.
3. Victim completes sign-in; `GET /djdl/auth/callback?code=…&state=…` binds `flow.licenseId`.
4. Attacker: `GET /djdl/auth/poll?state=<state>&device=ATTACKER-DEVICE`
   → `{"status":"ready","token":"pkeyt_…"}`.
5. `validateDeviceToken()` confirms the token: `device_id === "ATTACKER-DEVICE"`,
   `license.sub === "victim-sub"`, `license.email === "victim@corp.com"`.
6. `GET /djdl/config` with that bearer returns **200** and a JWS-verified `ManagedConfigDoc`
   carrying the victim's tier (`entitlements["license.tier"] === "pro"`), their entitlements,
   their provisioned secrets, and their identity profile.
7. The flow is deleted on the attacker's successful poll, so the **victim's own CLI now gets
   `{"status":"timeout"}`** — the theft is also a denial of service.

### Impact

Full impersonation of another customer's license from an unauthenticated request: entitlements,
provisioned secrets (`payload.secrets`, e.g. VPN subscription URLs), the identity profile in the
signed document, and a persistent device seat that survives until an operator deauthorizes it.

**Mitigating factor (honest):** `authorizeAndMint` runs the real seat check, so if the license is
already at `policy_device_limit` the mint fails with `device_limit` and the attack yields
`{"status":"error"}`. The default `default_device_limit` is 5.

### Fix direction

1. In `pollAuthFlow`, require `flow.deviceId` and reject unless `flow.deviceId === deviceId`
   (mirror `:903-904`). For browser flows that legitimately have no `deviceId`, gate on the
   presence of `returnTo`/session instead of allowing a free-form device.
2. Stop treating `state` as an authorization credential. Issue a separate high-entropy
   **poll secret** at `beginAuthFlow`, return it only to the client that started the flow, and
   require it on `/auth/poll` (this is what RFC 8628's `device_code` is for).
3. Add rate limiting to `/auth/poll` keyed on `clientIp(req)` and on `state`.
4. Consider retiring `/auth/poll` in favour of `/auth/device/poll` and removing `pollUrl` from
   discovery.

---

## R8-02 — Device-code flow: CSRF-able GET that discloses `state`/`nonce`, non-secret user code, unenforced `interval`

|               |                                                                                                                                                                     |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Severity**  | **High** (primary enabler for R8-01)                                                                                                                                |
| **File:line** | `packages/worker/src/oidc.ts:589-599` (start), `:611-661` (verify), `:198-203` (`deviceUserCode`), `:624-635` (confirm)                                             |
| **CWE**       | CWE-352 CSRF; CWE-598 sensitive data in a GET query string; CWE-307 missing throttling                                                                              |
| **PoC**       | ✅ `R8-02 › ATTACK: an unauthenticated GET turns a device_code into the OAuth state+nonce…`, `› …ships no security headers…`, `› userCode is a case-folded PREFIX…` |

### The defects (four, compounding)

1. **`confirm=1` is an unauthenticated GET state mutation that leaks the flow secrets.**
   `src/oidc.ts:624-635` sets `record.confirmedAt` and redirects to `record.authorizeUrl`. No
   cookie, no CSRF token, no POST, no `Sec-Fetch-Site` check. The `302 Location` contains
   `state` **and** `nonce`, i.e. everything R8-01 and R8-04 need. Any `<img src>` or prefetch on
   any page the victim visits performs the confirmation on their behalf.
2. **The device code travels in a URL.** `verificationUri === verificationUriComplete`
   (`:589-595`) — there is no separate short-code entry step, so the full 128-bit secret ends up
   in a QR code, terminal scrollback, browser history, and the address bar.
3. **The user code is a case-folded prefix of the device code.** `deviceUserCode(deviceCode)`
   returns `deviceCode.slice(0,8).toUpperCase()` with a dash (`:198-203`, called at `:576`).
   The PoC asserts `userCode.replace("-","") === deviceCode.slice(0,8).toUpperCase()`. The value
   the UX treats as _public_ is literally the first third of the value the KV lookup treats as
   _secret_. (Residual entropy is still ~84 bits, so this is not directly brute-forceable — the
   problem is the design inversion, and that partial-secret disclosure composes badly with any
   future logging/telemetry of the "public" code.)
4. **`interval: 2` is advertised (`:597`) and never enforced.** No `slow_down`, no attempt
   counter, no rate limit. The PoC fires 50 back-to-back `/auth/device/poll` calls with zero
   delay and gets 50 × HTTP 200.

Additionally the confirmation page (`:640-660`) is served with **only** `content-type` — the PoC
asserts `referrer-policy`, `content-security-policy`, `x-frame-options`, `x-content-type-options`
and `cache-control` are all absent, while the URL in the address bar contains the device code.
The platform _has_ header helpers (`src/securityHeaders.ts`, `src/portal/headers.ts`); this
response does not use them.

### Fix direction

- Make confirmation a `POST` with an origin-bound CSRF token minted on the GET render.
- Never put `state`/`nonce` in a `Location` the attacker can trigger: redirect only after a
  successful POST, and set `Referrer-Policy: no-referrer` + `Cache-Control: no-store` + the
  standard header bundle on the verify page.
- Generate `userCode` independently of `deviceCode` (RFC 8628 §6.1 style, e.g. `BCDF-GHJK` from a
  separate CSPRNG draw with an ambiguity-free alphabet) and look flows up by `userCode` on the
  human path.
- Enforce `interval` server-side, return `slow_down`, and cap attempts per `device_code`.

---

## R8-03 — Login CSRF / session fixation: no flow on any of the three surfaces is bound to the visitor's browser

|               |                                                                                                                                                                                           |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Severity**  | **Medium** (High for the admin surface — see R1-01, independently found)                                                                                                                  |
| **File:line** | product `src/oidc.ts:73-83` (`FlowRecord`), `:500-510`, `:684-820`; portal `src/portal/auth.ts:27-32`, `:191-198`, `:220-300`; admin `src/admin/auth.ts:32-36`, `:163-170`, `:188-232`    |
| **CWE**       | CWE-352 CSRF; CWE-384 Session Fixation                                                                                                                                                    |
| **PoC**       | ✅ `R8-03 › ATTACK: the product flow record carries NO browser binding…`, `› …the ADMIN flow (/manage/callback) is equally unbound…`, `› …the PORTAL flow (/callback) is equally unbound` |

All three `FlowRecord` shapes are asserted exhaustively by the PoC and contain **only** PKCE
material:

- product: `{ nonce, redirectUri, returnTo, verifier }`
- portal: `{ nonce, redirectUri, verifier }`
- admin: `{ nonce, redirectUri, verifier }`

No cookie, no IP, no user-agent, no per-browser CSRF nonce. The `state` therefore proves only
"some flow was started", never "_this browser_ started it" — which is precisely the property the
OAuth 2.0 Security BCP §4.7 requires. The PoC completes each callback from a request carrying a
foreign `Cookie` and a foreign `User-Agent` and receives:

- product: `302` + `Set-Cookie: pkey_djdl_session=…` (attacker's license, in the victim's browser)
- portal: `302` + `Set-Cookie: pkey_portal=…` (attacker's portal account)
- admin: `302 /manage/` + `Set-Cookie: pkey_admin=…` (attacker's admin session)

Classic impact: the victim operates under the attacker's identity — links their payment method,
claims their license key, uploads to the attacker's account, or (admin) performs privileged
actions the attacker later reads out of the audit log.

### Sub-finding R8-03b — `safeReturnTo` permits `/manage` paths in the PRODUCT flow

`src/oidc.ts:205-215` checks origin only. Its portal twin at `src/portal/auth.ts:94-105` adds
`if (parsed.pathname.startsWith("/manage")) return undefined;`. The PoC shows
`GET /djdl/auth/start?return_to=https://key.plrs.im/manage/products/djdl` is accepted and stored.
The landing page is the admin SPA, which still requires the admin cookie — so this is **not** a
privilege escalation. It is an inconsistent guard that lets a product sign-in deposit the user on
the admin surface (useful for phishing), and the divergence itself is a maintenance hazard.
Severity **Low**.

### Fix direction

Bind the flow to the browser: set a short-lived `HttpOnly; SameSite=Lax` cookie carrying a
random flow id at `/auth/start` (`/login`, `/manage/login`), store its hash in the flow record,
and require an exact match at the callback. Delete the cookie on completion. Add
`if (parsed.pathname.startsWith("/manage")) return undefined;` to `oidc.ts:205-215`.

---

## R8-04 — OIDC `state` is not single-use on the loopback path → flow injection

|               |                                                                                                                |
| ------------- | -------------------------------------------------------------------------------------------------------------- |
| **Severity**  | **High**                                                                                                       |
| **File:line** | `packages/worker/src/oidc.ts:814-816` (re-PUT instead of delete), `:782` (`flow.licenseId = result.licenseId`) |
| **CWE**       | CWE-384 Session Fixation; CWE-294 Authentication Bypass by Capture-Replay                                      |
| **PoC**       | ✅ `R8-04 › ATTACK: a second callback on the same state overwrites the bound license…`                         |

On the browser path (`returnTo` set) the flow is deleted (`:797`). On the **loopback/device**
path it is written back:

```ts
// src/oidc.ts:814-816
await env.HOT.put(flowKey(product.slug, state), JSON.stringify(flow), {
  expirationTtl: FLOW_TTL_SECONDS,
});
```

So the state stays live for the rest of the 600 s until somebody polls. An attacker who scraped
`state` **and** `nonce` off the authorize URL (R8-02 hands them both over) runs the IdP leg under
their _own_ account, replays `GET /auth/callback?code=<their code>&state=<victim state>`, and
**overwrites `flow.licenseId` with their own license**. The victim's CLI then polls
`/auth/device/poll` — passing every guard, correct device id, confirmed flow — and receives a
token for the **attacker's** license. The PoC asserts `valid.license.sub === "attacker-sub"`.

Impact: the victim's application silently runs on an attacker-controlled license, so the attacker
dictates the victim's `config`, `entitlements` and **`secrets`** (provisioned URLs the app will
fetch), and sees the victim's device in their own device list. This is config/secret injection into
a trusted client via the sign-in path.

### Fix direction

Delete the flow record at the top of `handleAuthCallback` (read-and-delete), and carry the result
to the poller in a _separate_, single-use, poll-secret-keyed record. Reject a second callback for
a consumed state.

---

## R8-05 — Claim trust: empty `sub`, unverified `email`, truthiness-only provisioning, no `iat`/`azp` checks

|               |                                                                                                                                                                                                                        |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Severity**  | **Medium**                                                                                                                                                                                                             |
| **File:line** | `packages/worker/src/oidc.ts:663-681` (`mapClaims`), `:675` (`sub`), `:676` (`email`), `:245-247` (truthiness), `:748-752` (`jwtVerify` options); contrast `src/admin/auth.ts:216`, `src/portal/auth.ts:115, 280, 286` |
| **CWE**       | CWE-345 Insufficient Verification of Data Authenticity; CWE-843 Type Confusion; CWE-1025 Comparison Using Wrong Factors                                                                                                |
| **PoC**       | ✅ four tests under `R8-05 claim trust`                                                                                                                                                                                |

### R8-05a — empty `sub` collapses distinct identities onto ONE license row

`mapClaims` does `sub: String(payload.sub ?? "")` (`:675`) and nothing downstream checks the
result. Admin (`admin/auth.ts:216 — if (!identity || !identity.sub)`) and portal
(`portal/auth.ts:280 — if (!identity.sub) return htmlError(401, …)`) both reject an empty subject;
**the product flow does not**. `getLicenseBySub(db, slug, "")` (`repo.ts:675-685`) therefore
matches every previous `sub=""` row.

The PoC drives two full signed-ID-token callbacks with **no `sub` claim** and different emails,
and asserts the `licenses` table ends with exactly **one** row, `sub === ""`, whose `email` is the
_second_ (attacker's) identity — last writer wins a shared license. Consequences: cross-identity
entitlement bleed, cross-identity device seats, and audit records attributed to `actor_sub: ""`.

`String(payload.sub ?? "")` is also a type-confusion hazard: a non-string `sub` is coerced, so
`123` and `"123"` collide, `["a"]` becomes `"a"`, and `{}` becomes `"[object Object]"`.

**Precondition:** an IdP that omits or mistypes `sub`. Reachable in practice because
`oidc_config.provider = 'custom'` lets each product point at an arbitrary issuer
(`src/oidc.ts:137-162`), so the trust decision is per-product configuration, not a platform invariant.

### R8-05b — `email_verified` is never consulted; the unverified email is _signed_

`src/oidc.ts:676` takes `email` verbatim. The portal explicitly does the opposite
(`portal/auth.ts:115` computes `emailVerified`, and `:286` passes
`email: identity.emailVerified ? identity.email : undefined`).

The PoC signs an ID token with `email: "ceo@victim-corp.com", email_verified: false`, and shows the
value:

1. lands in `licenses.email`;
2. reaches the **JWS-signed** `ManagedConfigDoc` as `payload.profile.email` (via
   `docProfile()` at `src/licenseCore.ts:63-71`) — so any product that authorizes on
   `doc.profile.email` is authorizing on an unverified attacker-supplied string that the platform
   has cryptographically vouched for;
3. is matched by the portal's auto-linker, which links licenses to accounts on exactly this
   column: `SELECT product, id FROM licenses WHERE lower(email) = ?` (`src/portal/repo.ts:276`).

### R8-05c — provisioning hooks are truthiness-only

`src/oidc.ts:247` skips only `undefined | null | false`. The PoC shows the claim values
`"false"`, `"0"`, `0`, `[]`, `{}` and `"null"` **all** switch an entitlement to
`{state:"enforced", value:true}`. An IdP that emits `"isPro": "false"` grants Pro. (The in-tree
test `oidcEdge.test.ts:189` covers only the boolean `false` case.)

### R8-05d — no `maxTokenAge`, `clockTolerance`, `azp`, `at_hash` or `hd`

`jwtVerify` is called with only `{ issuer, audience, algorithms }` in all three verifiers
(`oidc.ts:748-752`, `portal/auth.ts:266-270`, `admin/auth.ts:120-124`). The PoC activates
successfully with an ID token whose `iat` is **30 days old** and whose `azp` names a different
client. `exp` is the only freshness control, and it is entirely the IdP's choice.

### Fix direction

- `if (!identity.sub) return errorResponse(401, …)` in `handleAuthCallback`, and require
  `typeof payload.sub === "string" && payload.sub.length > 0` in `mapClaims` (no `String()` coercion).
- Only persist `email` when `payload.email_verified === true`; otherwise store `null`. Consider
  scoping the portal's email auto-link to verified emails only.
- Change the provisioning predicate to an explicit truth test (`=== true`, or a per-hook
  `match` expression), and reject `""`/`"false"`/`"0"`/empty containers.
- Pass `maxTokenAge: "5m"` and `clockTolerance: 30` to `jwtVerify`; verify `azp === clientId`
  when present, and add an optional `hd` allowlist.

---

## R8-06 — Unguarded `JSON.parse` on config columns takes the sign-in path down (and one host allowlist fails open)

|               |                                                                                                                                                                |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Severity**  | **Low**                                                                                                                                                        |
| **File:line** | `packages/worker/src/oidc.ts:265-268` (`allowed_hosts_json`), `:251` (`entitlement_value_json`), `:298-303` (`group_role_map_json`), `:260` (`String.replace`) |
| **CWE**       | CWE-248 Uncaught Exception; CWE-636 Not Failing Securely                                                                                                       |
| **PoC**       | ✅ four tests under `R8-06 unguarded JSON.parse in the sign-in path`                                                                                           |

Three `JSON.parse` calls on the OIDC sign-in path have no `try/catch`, and nothing between them
and `handleAuthCallback` catches either. The PoC asserts
`await expect(callback(ctx, "S")).rejects.toThrow(SyntaxError)` — the handler **rejects** rather
than returning a controlled 5xx, so on Workers the request dies as an unhandled exception with a
generic 1101 and every sign-in for that product is wedged until an operator fixes the row. Note
`redirectUriAllowed` (`:223-232`) _is_ wrapped — the inconsistency is the tell.

**`allowed_hosts_json` fails open when NULL** (`:265-268`): `const allowed = h.allowed_hosts_json ? … : null;` and the host check runs only `if (allowed)`. This is the _shipped_ default —
`stmtInsertProvisioning` (`repo.ts:537`) writes `NULL` whenever a manifest omits `allowedHosts`.
The PoC shows a hook with a `NULL` allowlist emitting
`secrets["proxy.url"] = "https://exfil.attacker.test/u"` unchallenged. (The template is
admin/manifest-controlled, so this is a defence-in-depth loss, not direct user-controlled SSRF —
see REFUTED for why a claim value cannot move the host.)

**`String.replace` with a string pattern replaces only the first occurrence** (`:260`). The PoC
shows `https://vpn.example/{claim}/token/{claim}` producing
`https://vpn.example/u/token/{claim}` — a literal placeholder shipped to the client inside a
"secret". Use `replaceAll` or `/\{claim\}/g`.

### Fix direction

Wrap all three parses in `try/catch` and fail closed (skip the hook / deny the group map, and
emit an audit record). Change `allowed_hosts_json` to fail **closed** when the hook declares a
`secret_url_template` but no allowlist. Use `replaceAll`.

---

## R8-07 — `redirect_uris_json` allowlist fails open when the column is NULL

|               |                                                                                                      |
| ------------- | ---------------------------------------------------------------------------------------------------- |
| **Severity**  | **Low**                                                                                              |
| **File:line** | `packages/worker/src/oidc.ts:223-232`, used at `:504-506` and `:705-708`                             |
| **CWE**       | CWE-636 Not Failing Securely                                                                         |
| **PoC**       | ✅ `R8-07 › ATTACK: with redirect_uris_json NULL, any Host header produces an accepted redirect_uri` |

`if (!oidc.redirect_uris_json) return true;`. The PoC sets the column to `NULL` and shows
`GET https://evil.attacker.test/djdl/auth/start` returning `302` with
`redirect_uri=https://evil.attacker.test/djdl/auth/callback`, then restores the column and gets
the correct `400`.

**Honest severity:** no shipped writer produces `NULL` — `stmtInsertOidcConfig` (`repo.ts:452`)
always writes `JSON.stringify(o.redirectUris)`, which is `"[]"` when the manifest omits the field,
and `"[]"` fails _closed_. The `NULL` state is reachable only through hand-written SQL, a
pre-`0001` row, or a future writer. The IdP's own registered-redirect check is the real backstop.

Related, and worth recording: **neither the admin nor the portal flow has any worker-side
redirect-URI allowlist at all** (`admin/auth.ts:166`, `portal/auth.ts:194` both compute
`${url.origin}/…` and use it unconditionally). Those flows depend entirely on the IdP.

### Fix direction

`if (!oidc.redirect_uris_json) return false;` plus a startup/registration validation that a
product with OIDC enabled has a non-empty allowlist. Add the same allowlist to the admin and
portal flows, or pin them to a configured canonical origin rather than the request `Host`.

---

## R8-08 — Portal magic link: 72-bit token in a URL query string, stored unhashed, unrate-limited verify

|               |                                                                                                                                                      |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Severity**  | **Medium**                                                                                                                                           |
| **File:line** | `packages/worker/src/portal/auth.ts:348` (`randomId("magic")`), `:349-355` (URL + KV write), `:370-397` (`handleMagicVerify`); `src/crypto.ts:42-44` |
| **CWE**       | CWE-598 Sensitive Data in Query String; CWE-522 Insufficiently Protected Credentials; CWE-307 Missing Throttling                                     |
| **PoC**       | ✅ `R8-08 › ATTACK: the magic token is 72 bits, stored UNHASHED…`, `› ATTACK: /magic/verify has NO rate limit, unlike /magic/start`                  |

Three distinct weaknesses, only one of which matters much:

1. **Entropy — not exploitable, but well below the platform's own bar.** `randomId(prefix)` is
   `${prefix}_${b64url(randomBytes(9))}` — **72 bits**. The PoC asserts the 12-character body.
   _Honest assessment: brute force is infeasible._ Even at 10⁵ guesses/second against the 600 s
   TTL, an attacker covers ~6×10⁷ of 4.7×10²¹ values (~10⁻¹³). The finding is a **consistency**
   gap: `mintToken()` (device + browser-session tokens) is **256 bits** and peppered-HMAC-hashed
   at rest, and the portal download token is too. The magic link — a full account-takeover
   primitive — is the weakest credential in the system.
2. **Stored unhashed, keyed by the raw secret, with the target email as the value.** The PoC
   asserts `kv.keys()` contains `portal:magic:<raw token>` and that the value contains
   `victim@corp.com`. Any KV read primitive (a bug in a KV-key-building path, an operator with
   dashboard access, a backup, a `list` on the `portal:magic:` prefix) yields **immediately
   usable sign-in credentials for every pending link, with the target account named**. Contrast
   `browserSession.ts:93` (`sessionKey(product, await hashKey(token, env.KEY_HASH_PEPPER))`).
3. **The secret rides in a URL query string** (`:349-351`) — Referer leakage, corporate TLS
   proxies, email-security link scanners that pre-fetch (which also _consumes_ the link, since
   `:385` deletes it), browser history, and shoulder-surfing.
4. **`/magic/verify` has no rate limit** while `/magic/start` does (`:309-315`, limit 8/60 s).
   The PoC fires 100 verify attempts and asserts the DO limiter is never consulted, then shows
   12 `start` calls do trip it. Defence-in-depth loss and a free enumeration/timing oracle.

### Fix direction

Mint the magic token with `mintToken()` (256-bit), store `hashKey(token, env.KEY_HASH_PEPPER)`
as the KV key, keep the email in the _value_ only (or store an account id), deliver the token in
the URL **fragment** or via a POST-back interstitial, and add
`rateLimitOk(env, "_portal", { bucket: "portalMagicVerify", id: clientIp(req), limit: 10, windowSec: 60 })`
to `handleMagicVerify`.

---

## R8-09 — `createRemoteJWKSet` is constructed per request in all three verifiers

|               |                                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------ |
| **Severity**  | **Low**                                                                                          |
| **File:line** | `packages/worker/src/oidc.ts:743-745`, `src/portal/auth.ts:261-263`, `src/admin/auth.ts:116-118` |
| **CWE**       | CWE-770 Allocation Without Limits or Throttling                                                  |
| **PoC**       | Code-verified (no runtime PoC — the suite mocks `createRemoteJWKSet` by design)                  |

`createRemoteJWKSet` caches inside the object it returns. Building a new one on every request
discards the cache, so **each unauthenticated callback triggers an outbound JWKS fetch to the
issuer**. No `cacheMaxAge`, `cooldownDuration` or `timeoutDuration` is set, so the defaults apply
and there is no floor on refetch frequency under attack. Combined with the total absence of rate
limiting on `/auth/callback` (R8-01), an unauthenticated caller has a direct lever on the
worker's outbound fetch volume — self-inflicted subrequest exhaustion and traffic amplification at
the IdP (which may rate-limit or ban the worker, denying sign-in platform-wide).

### Fix direction

Hoist one `createRemoteJWKSet` per issuer into a module-level `Map<string, JWKSet>` and pass
`{ cooldownDuration: 30_000, cacheMaxAge: 600_000, timeoutDuration: 5_000 }`.

---

## R8-10 — No rate limiting anywhere in `src/oidc.ts`

|               |                                                                          |
| ------------- | ------------------------------------------------------------------------ |
| **Severity**  | **Medium** (multiplier on R8-01, R8-02, R8-04, R8-09)                    |
| **File:line** | `packages/worker/src/oidc.ts` — `grep -c rateLimit` returns `0`          |
| **CWE**       | CWE-307 Improper Restriction of Excessive Authentication Attempts        |
| **PoC**       | ✅ `R8-01 › ATTACK: repeated /auth/poll guesses are never rate limited…` |

Every other credential-adjacent module uses the Durable-Object limiter — `licensing.ts:299,363`,
`enroll.ts:129`, `edgeMint.ts:176`, `admin/auth.ts:150,195`, `portal/auth.ts:172,309`,
`portal/api.ts:273`. `oidc.ts` uses it **nowhere**, on any of its six handlers.

The PoC spies on `env.RL.get` and drives 200 `/auth/poll` requests plus one call to each of
`handleAuthStart`, `handleAuthDeviceStart`, `handleAuthDeviceVerify`, `handleAuthDevicePoll` and
`handleAuthCallback`, then asserts the limiter was **never** consulted. Consequences: unbounded
`state`/`device_code` probing, unbounded KV writes via `/auth/device/start` (each call writes two
KV entries with a 600 s TTL, and `deviceId` is caller-supplied and unvalidated), and unbounded
outbound IdP token-exchange + JWKS fetches via `/auth/callback`.

### Fix direction

Add `rateLimitOk` to all six handlers, keyed on `clientIp(req)` and — for poll surfaces — on the
`state`/`device_code` as a second bucket so a single flow cannot be hammered from a botnet.

---

# REFUTED

Hypotheses that were tested and did **not** hold. Each has a passing PoC asserting the _secure_
behaviour, so they double as regression tests.

| #   | Hypothesis                                                                             | Verdict                                                                                                                                                                                                                                                                   |
| --- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | The nonce binding can be skipped by omitting the `nonce` claim                         | **Refuted.** `oidc.ts:754-757` rejects unconditionally (`typeof claims.nonce !== "string" \|\| claims.nonce !== flow.nonce`). PoC: signed token with no `nonce` → `401`. Same guard exists in `portal/auth.ts:272` and `admin/auth.ts:128`.                               |
| 2   | An `alg: none` / HMAC-signed ID token is accepted                                      | **Refuted.** `ALLOWED_ID_TOKEN_ALGS = ["RS256","ES256","EdDSA"]` (`oidc.ts:36`) is passed to `jwtVerify`. PoC: valid `HS256` token → `401`.                                                                                                                               |
| 3   | A claim value can hijack the host of a templated secret                                | **Refuted.** `encodeURIComponent(String(claimVal))` (`oidc.ts:262`) escapes `/`, `:` and `@`. PoC: claim `"@evil.test/x"` still yields `new URL(v).host === "vpn.example"`. (The _fail-open on NULL allowlist_ is a separate, confirmed issue — R8-06.)                   |
| 4   | `/auth/poll` can mint on a disabled or expired license                                 | **Refuted.** `authorizeAndMint` → `authorizeDevice` → `licenseUsable` (`licenseCore.ts:143-150, 267`). PoC: disabled license → `{"status":"error"}`, and the license row is untouched.                                                                                    |
| 5   | The poll surface enumerates IdP failure reasons                                        | **Refuted.** `oidc.ts:836-837` returns a bare `{status:"error"}`, and every failure path deletes the flow (`:728, 735, 739, 759, 779`). PoC: a flow carrying `error: "id-token-invalid"` never surfaces the string.                                                       |
| 6   | Cross-product state confusion — one product's `state` polls another product's endpoint | **Refuted.** KV keys are product-scoped (`flowKey` = `p:<product>:flow:<state>`, `oidc.ts:190-192`), and `loadProduct` runs before dispatch (`index.ts:83`). PoC: a `djdl` flow polled through the `other` product returns `timeout`.                                     |
| 7   | `redirect_uris_json` fails open **in practice**                                        | **Partially refuted.** The code does fail open on `NULL` (R8-07, confirmed by PoC), but no shipped writer produces `NULL` — `repo.ts:452` writes `"[]"` when the manifest omits the field, and `"[]"` fails closed. Downgraded from the hypothesised severity to **Low**. |
| 8   | 72-bit magic-link tokens are brute-forceable                                           | **Refuted as an entropy attack.** ~4.7×10²¹ values against a 600 s TTL. The real, confirmed issues are unhashed at-rest storage, query-string delivery, and the missing verify rate limit (R8-08).                                                                        |
| 9   | `safeReturnTo` allowing `/manage` is a privilege escalation                            | **Refuted as escalation.** The product session cookie is `Path=/djdl` (`browserSession.ts:65`) and the admin SPA gates on `pkey_admin`. Real but **Low** as an inconsistency / phishing aid (R8-03b).                                                                     |
| 10  | The confidential-client path can be downgraded to a public client                      | **Refuted.** `resolveOidcConfig` (`oidc.ts:141-156`) returns a 500 `misconfigured` when a declared `client_secret_secret` cannot be unsealed, _before_ the token exchange. Already covered by `oidcEdge.test.ts:762-805`.                                                 |

---

## What the existing tests miss

`test/oidc.test.ts` and `test/oidcEdge.test.ts` (37 tests) are thorough on the properties they
chose, but they encode the device binding only on the surface that _has_ it:

- `oidcEdge.test.ts:425-446` — "rejects JSON device polls from a different device id" tests
  **`handleAuthDevicePoll`** only. Every `handleAuthPoll` test uses the default
  `device = "dev-1"` (`:245`, `:632-641`), so the missing binding on the _other_ poll surface is
  invisible.
- No test asserts that the `authorizeUrl` in the `confirm=1` redirect is sensitive.
- No test replays a callback on an already-completed state (R8-04).
- `oidcEdge.test.ts:189` covers only the boolean `false` claim, not `"false"` / `0` / `[]` / `{}`.
- No test drives the callback without a `sub` claim.
- No test asserts a rate limit on any OIDC surface.

---

# Remediation

All changes are confined to `packages/worker/src/oidc.ts` plus its tests. The PoC suite
`packages/worker/test/attack/R8-oidc.test.ts` has been **inverted**: the `it()` titles are
unchanged (so they still map to the finding ids above) but every body now asserts the attack
**fails**. It is the regression suite. 28/28 pass; `test/oidc.test.ts` + `test/oidcEdge.test.ts`
(37 tests) pass.

| Finding | Fixed                    | Proof                                                                                                                                 |
| ------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| R8-01   | ✅                       | `R8-01 › ATTACK: knowing only 'state'…`, `› …bypass of BOTH guards…`                                                                  |
| R8-02   | ✅ (partial)             | `R8-02 › ATTACK: an unauthenticated GET turns a device_code…`, `› …ships no security headers…`, `› userCode is a case-folded PREFIX…` |
| R8-03   | ❌ out of scope          | unchanged PoCs still assert the gap                                                                                                   |
| R8-04   | ✅                       | `R8-04 › ATTACK: a second callback on the same state…`                                                                                |
| R8-05   | ✅ (a–d)                 | four tests under `R8-05 claim trust`                                                                                                  |
| R8-06   | ✅                       | four tests under `R8-06 unguarded JSON.parse…`                                                                                        |
| R8-07   | ❌ deliberate            | unchanged PoC still asserts the fail-open                                                                                             |
| R8-08   | ❌ out of scope (portal) | unchanged PoCs                                                                                                                        |
| R8-09   | ❌ out of scope          | code-verified only                                                                                                                    |
| R8-10   | ✅                       | `R8-01 › ATTACK: repeated /auth/poll guesses are never rate limited…`                                                                 |

## R8-01 — `/auth/poll` device-id confusion (Critical)

`pollAuthFlow` now refuses to mint unless **both** guards `handleAuthDevicePoll` enforces hold:

```ts
if (!flow.deviceId || flow.deviceId !== deviceId)
  return json({ status: "error" });
if (!flow.confirmedAt) return json({ status: "pending" });
```

Placed after the `error`/`licenseId` checks and reusing the two existing generic statuses, so
the surface gained no new distinguishable answer (D8 preserved — the `REFUTED: the poll surface
never echoes an IdP failure reason` test still passes).

`FlowRecord.confirmedAt` is new: device confirmation now stamps the **flow** record (the one the
pollers read), not only the device record, so the confirmation is a genuine authorization input
on both poll surfaces. `handleAuthDevicePoll`'s own two checks are kept as defence in depth.

Consequence worth stating plainly: a flow with no `deviceId` — i.e. one started by
`GET /auth/start` without `return_to` — can **never** be completed through `/auth/poll` any
more. That is the intended fail-closed direction (a bare `state` must not be a bearer token);
`/auth/device/start` + either poll surface remains fully functional. `pollUrl` is still
advertised in discovery and still works for device flows.

## R8-02 — device-code CSRF / disclosure / throttle (High)

- Confirmation is now **`POST` only**. `GET` renders the page and is side-effect free; `?confirm=1`
  on a GET is ignored (no mutation, no `Location`, no `state`/`nonce`).
- The GET mints a CSRF token into `DeviceFlowRecord.csrf`; the POST must echo it and is
  additionally refused when an `Origin` header names a foreign origin. The token is deleted on
  use (single-use).
- The confirmation redirect is a `303` carrying `Referrer-Policy: no-referrer` and
  `Cache-Control: no-store`; the same two headers are now on the rendered page, whose URL holds
  the device code.
- `interval` is enforced: a second `/auth/device/poll` within `DEVICE_POLL_INTERVAL_SECONDS`
  returns `429 {"status":"slow_down","interval":2}` (`DeviceFlowRecord.lastPollAt`).
- Rate limiting (R8-10) added to **all six** handlers via `rateLimitOk` — `grep -c rateLimit
src/oidc.ts` is now non-zero. Per-IP buckets: `authStart`/`authDeviceStart`/`authDeviceVerify`
  60·60s, `authCallback` 60·60s, `authPoll`/`authDevicePoll` 120·60s. Poll and callback surfaces
  carry a **second** bucket keyed on the `state`/`device_code` (40·60s and 5·60s), so one flow
  cannot be hammered from a botnet.

**Not fixed (residual, asserted by the inverted PoCs):** `verificationUri ===
verificationUriComplete` and `userCode` remaining a case-folded prefix of `deviceCode`.
Generating an independent RFC 8628 user code changes the public device-flow contract
(`/auth/device/start`'s response shape and the human lookup path) and is a product change, not a
patch. Residual entropy is ~84 bits, so it is not brute-forceable today.

**Not fixed:** the full security-header bundle (`content-security-policy`, `x-frame-options`,
`x-content-type-options`) on the verify page. Two other lanes' PoCs assert their _absence_
(`R1-07b`, `R9-12`); adding them belongs with that remediation so the header policy lands once,
from `src/securityHeaders.ts`, rather than being hand-rolled here.

## R8-04 — non-single-use state (High)

`handleAuthCallback` claims the flow before any outbound call:

```ts
if (flow.consumedAt) return errorResponse(400, "bad_request", "unknown state");
flow.consumedAt = now;
await env.HOT.put(flowKey(product.slug, state), JSON.stringify(flow), { … });
```

The replay answer is byte-identical to the unknown-state answer, so a second callback is
indistinguishable from a stale one. Every pre-existing failure path still deletes the record.
**Caveat:** Workers KV has no compare-and-swap, so this is read-then-write, not a true CAS; the
window is one KV round-trip with no network I/O inside it, versus the previous 600 s window.
Closing it completely needs a Durable Object, which is a design change beyond this fix.

## R8-05 — claim trust (Medium)

- **a** — `mapClaims` no longer coerces: `sub: typeof payload.sub === "string" ? payload.sub : ""`,
  and `handleAuthCallback` returns the generic `401 unauthorized` (deleting the flow) when the
  result is empty — matching `admin/auth.ts:216` and `portal/auth.ts:280`.
- **b** — `email` is taken only when `payload.email_verified === true`; otherwise it is
  `undefined` and nothing is persisted (`licenses.email` stays `NULL`, the signed
  `profile.email` is `""`, and the portal's `lower(email)` auto-linker finds nothing). The
  `name` fallback uses the verified address only.
- **c** — `claimEnables()` replaces truthiness: a real boolean `true`, or a string that is not
  empty/`"false"`/`"0"`/`"null"` (case-insensitive, trimmed). Numbers, arrays and objects no
  longer enable a hook.
- **d** — `jwtVerify` now passes `clockTolerance: 300` and `maxTokenAge: "5m"`.

**Not fixed:** `azp`, `at_hash` and `hd`. `azp` is only meaningful for multi-audience tokens and
an `hd` allowlist needs a new per-product config column (a schema/admin change outside this
file). The control assertion in the R8-05d test documents that both remain unchecked.

## R8-06 — unguarded `JSON.parse` / fail-open allowlist (Low)

All three parses go through `parseJsonColumn<T>()`, which returns `undefined` instead of
throwing. Fail-closed semantics: an unparseable `group_role_map_json` grants nothing, an
unparseable `entitlement_value_json` drops the whole hook, an unparseable **or `NULL`**
`allowed_hosts_json` drops the templated secret. `secret_url_template` uses `replaceAll`, so a
template with two `{claim}`s no longer ships a literal placeholder inside a secret.

## R8-07 — `redirect_uris_json` fail-open on NULL (Low) — NOT FIXED

Deliberate. `redirectUriAllowed` keeps `if (!oidc.redirect_uris_json) return true`. Rationale:
no shipped writer produces `NULL` (`repo.ts:452` always writes at least `"[]"`, which fails
closed), the IdP's own registered-redirect check is the real backstop, and three other lanes'
fixtures (`R10-05`, `R9-01`, `R9-02`) seed `NULL` deliberately. Flipping it is a one-line change
that should land with the startup/registration validation the finding recommends, so products
cannot be left with an empty allowlist and a broken sign-in.

## Cross-lane fallout (expected, not regressions)

Two currently-passing PoCs in **other lanes' files** now fail _because the attack they describe
is fixed_. They are not mine to edit:

- `test/attack/R1-control-plane.test.ts` › `R1-07a` — expects `302` from
  `GET …/auth/device/verify?confirm=1`; it now renders `200` (the fix). The finding it documents
  (self-confirmable device gate) is R8-02 defect 1 and is now closed.
- `test/attack/R9-injection.test.ts` › `R9-12` (first case) — a source-text assertion that
  `oidc.ts` contains `<a href="${escapeHtml(confirmUrl.toString())}"`. That anchor is now a
  `<form method="post">`; the property the test actually checks (every sink is a text node or a
  double-quoted attribute) still holds.

## Test-fixture changes in `test/oidcEdge.test.ts`

No assertion was weakened. Three fixtures were made to match what production actually writes:
`putFlow`/`seedFlow` now include `deviceId` + `confirmedAt` (a flow record without them is not a
pollable flow any more), and the device-verification test drives the POST confirmation with the
CSRF token from the rendered page and expects `303` instead of `302`.
