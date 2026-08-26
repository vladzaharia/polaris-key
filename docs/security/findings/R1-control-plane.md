# R1 — Control-plane takeover

Red-team lane: an unauthenticated internet attacker reaching **admin session**, **product
signing keys**, the **platform KEK**, or the **ability to mint licenses**.

- Repo: `/Users/vlad/.paseo/worktrees/2hzk6ip2/lewd-owl`, branch `lewd-owl` @ `bd26e0b`
- PoC suite: `packages/worker/test/attack/R1-control-plane.test.ts` — **26/26 passing**.
  Finding IDs below match the test-name prefixes 1:1 (`R1-01` ⇢ tests `R1-01a…c`, etc.).
  Run: `export PATH="$HOME/.local/share/mise/installs/node/22/bin:$PATH"; cd packages/worker; npx vitest run test/attack/R1-control-plane.test.ts`
- Full worker suite after adding the PoCs: **440/440 passing**. No source file was modified.

## Findings index

| ID    | Severity                 | Title                                                                          | PoC        |
| ----- | ------------------------ | ------------------------------------------------------------------------------ | ---------- |
| R1-01 | Medium                   | Login CSRF / admin session fixation on `GET /manage/callback`                  | ✅ passing |
| R1-02 | Medium (latent Critical) | Admin + portal sessions share one HMAC key, no domain separation               | ✅ passing |
| R1-03 | Low                      | State-changing `GET`s bypass the CSRF gate (`/manage/api/logout`, `/logout`)   | ✅ passing |
| R1-04 | Low (latent Medium)      | Audit-write amplification on the cross-product 403 path                        | ✅ passing |
| R1-05 | Medium (latent Critical) | `handleMintAuth` renders D1 HTML unauthenticated, no CSP                       | ✅ passing |
| R1-06 | Low                      | `/manage/*` asset proxy is unauthenticated, escapes its prefix, strips the CSP | ✅ passing |
| R1-07 | Medium                   | Device-code "user confirmation" is self-servable by the flow's starter         | ✅ passing |
| R1-08 | Low                      | Admin cookie has no `__Host-` prefix; first-match cookie parsing               | ✅ passing |
| R1-09 | High (architectural)     | Any same-origin XSS defeats the whole admin cookie hardening story             | static     |

## Headline

There is **no unauthenticated path to the KEK, to a product signing key, or to an admin session**
in the current tree. KEK custody (`src/keyvault.ts`) is sound: AES-256-GCM with a per-value nonce,
`product:kind:id` AAD binding, strict 32-byte key-length validation, fail-closed `open()`. Signing
keys never leave the worker (`handleKeys` returns only the public half). Admin session signing fails
closed with no fallback key.

The real control-plane exposure is **structural**:

1. The admin OIDC flow has **no browser binding** on `state` (R1-01) — a textbook login CSRF /
   session fixation that RFC 9700 §4.7 explicitly requires mitigating. It corrupts the audit
   trail's actor attribution today and becomes privilege escalation the moment product-level RBAC
   lands.
2. **Any XSS anywhere on the platform origin is a full admin takeover** (R1-09). `Path=/manage` +
   `SameSite=Strict` + `HttpOnly` do not contain a same-origin script. Five HTML responses on that
   origin ship with **no CSP at all** (R1-05, R1-06, R1-07, `oidc.ts:817`, `admin/auth.ts:138`),
   which makes them the highest-value targets in the system.
3. Admin and portal sessions are signed by **one HMAC key with no domain-separation tag** (R1-02).
   Today only a field-name coincidence keeps the realms apart.

---

## R1-01 — Login CSRF / admin session fixation on `GET /manage/callback`

|               |                                                                                                                                                     |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Severity**  | **Medium** (High once product-level RBAC lands)                                                                                                     |
| **File:line** | `packages/worker/src/admin/auth.ts:146-232` (login `:146-185`, callback `:188-232`); cookie built at `packages/worker/src/admin/session.ts:188-197` |
| **PoC**       | ✅ passing — `R1-01a`, `R1-01b`, `R1-01c`                                                                                                           |

### The defect

`handleAdminLogin` mints `state`, stores `{verifier, nonce, redirectUri}` in KV under
`admin:flow:<state>` (`auth.ts:163-170`), and returns a bare 302. **It sets no cookie.**
`handleAdminCallback` (`auth.ts:206-231`) looks the flow up by `state` alone and never reads the
`Cookie` header. The flow record contains nothing browser-specific — PoC `R1-01a` asserts its keys
are exactly `nonce`, `redirectUri`, `verifier`, and that the login response carries no `Set-Cookie`.

Consequence: **any browser can redeem any in-flight `(code, state)` pair.** `state` is a CSRF token
for the _IdP_; nothing binds it to the user agent that started the flow.

`SameSite=Strict` on the session cookie is **not** a defense. `SameSite` governs cookies the browser
_sends_; it does not stop a cross-site top-level navigation response from _setting_ a
`SameSite=Strict` cookie.

### Attacker preconditions

The attacker must hold an IdP account whose `groups` satisfy `hasAnyAdminGrant`
(`admin/authz.ts:30-38`), i.e. membership of `PLATFORM_ADMIN_GROUP`. PoC `R1-01c` confirms a
non-admin `code` plants nothing (403, no `Set-Cookie`). This caps today's blast radius; see
"Why High" below.

### Step-by-step exploit

1. Attacker hits `GET /manage/login` from their own machine and reads `state` off the 302 `Location`.
2. Attacker completes sign-in at the IdP as themselves and intercepts the redirect (proxy, devtools,
   blocked navigation) instead of letting the browser follow it, capturing `code`.
3. Attacker causes a victim admin to top-level-navigate to
   `https://key.plrs.im/manage/callback?code=<attacker code>&state=<attacker state>` — a link,
   `window.open`, `<meta refresh>`, or a 302 from any attacker page. `SameSite=Strict` blocks none
   of these.
4. The worker exchanges the code, verifies the ID token (PKCE + nonce both match — they are the
   _attacker's_), passes the group gate, and returns `302 /manage/` with
   `Set-Cookie: pkey_admin=<attacker session>; Path=/manage; HttpOnly; Secure; SameSite=Strict`.
5. The victim's browser is now signed in **as the attacker**. PoC `R1-01b` drives this end-to-end
   with a cookie-less victim request from a different IP/UA, then reads `/manage/api/me` →
   `sub: "attacker-oidc-sub"`, `groups: ["platform-admins"]`.

### Impact — what this does and does not give the attacker (verified)

**It does NOT hand the attacker the planted session token.** `auth.ts:213` deletes the KV flow
_before_ redemption, so a given `(code, state)` is redeemable exactly once, and `issueSession`
(`:227`) mints a fresh token with a fresh CSRF value that is returned only in the response to
whoever made the callback request. The attacker must choose: redeem it themselves, or plant it in
the victim — not both. There is no path here to reading the victim's screen or the planted CSRF
token.

What it _does_ give:

- **Corruption of the audit trail's actor attribution**, which is the module's own stated invariant:
  `admin/session.ts:34` — _"the audit actor is ALWAYS taken from here, never a request field"_.
  After fixation, every product create/delete, key rotation, sealed-secret write and license mint the
  victim performs is recorded under the **attacker's** `sub`/`name`/`email` (`admin/audit.ts:19-31`).
  For a system whose only accountability mechanism is that log, an attacker who can silently
  re-attribute a colleague's privileged actions has broken non-repudiation in both directions.
- **Silent identity switching of an admin browser.** The victim keeps working, unaware, unless they
  read the identity chip the SPA renders from `/api/me`.

### Why Medium today, High tomorrow

Rated **Medium** because the attacker must _already_ hold a `PLATFORM_ADMIN_GROUP` IdP account, and
`canAdminProduct === isPlatformAdmin` today, so there is no privilege gradient to climb — the victim
acts with authority the attacker already has.

It becomes **High** the moment product-level RBAC lands. `admin/authz.ts:21-27` documents
`canAdminProduct` as _"reserved metadata for a future RBAC pass"_ and currently collapses to
`isPlatformAdmin`. When product admins become real, a low-privilege product admin can fixate a
platform admin's browser and have that browser perform platform-scoped work under an identity the
attacker chose — direct privilege escalation. The fix is cheap and should not wait for that change.

### Fix direction

In `handleAdminLogin`, generate a random flow binder, store its hash in the KV flow record, and set
it as a short-lived `HttpOnly; Secure; SameSite=Lax; Path=/manage` cookie (e.g. `pkey_admin_flow`).
In `handleAdminCallback`, require the cookie, constant-time compare against the flow record, and
clear it; reject when absent. `SameSite=Lax` is required on the _binder_ so it survives the IdP's
cross-site redirect back. The portal flow (`portal/auth.ts:191-198, 234-237`) and the product flow
(`oidc.ts:500-510, 696-698`) have the identical gap and want the identical fix.

---

## R1-02 — Admin and portal sessions share one HMAC key with no domain separation

|               |                                                                                                                                                                  |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Severity**  | **Medium** (latent **Critical**)                                                                                                                                 |
| **File:line** | `packages/worker/src/portal/session.ts:61-71`, esp. **`:62`**; `packages/worker/src/admin/session.ts:81-91, 112-134, 137-171`                                    |
| **PoC**       | ✅ passing — `R1-02a` (shared key proven), `R1-02b`/`R1-02c` (replay refuted today), `R1-02d` (latent bypass proven), `R1-02e`/`R1-02f` (parser attacks refuted) |

### The defect

`portal/session.ts:62` — `const material = env.PORTAL_SESSION_SECRET ?? env.ADMIN_SESSION_SECRET;`.
`wrangler.toml:98` documents `PORTAL_SESSION_SECRET` as _optional_ ("falls back to
ADMIN_SESSION_SECRET when omitted"), so the fallback is the expected deployment shape.

Both realms then use the **identical** token construction —
`base64url(JSON) "." base64url(HMAC-SHA256(body))` — over the **same raw key**, with **no realm tag
inside the signed body**. PoC `R1-02a` proves it byte-for-byte: the signature `issuePortalSession`
produces equals `HMAC(ADMIN_SESSION_SECRET, portalBody)`, and the decoded body contains no realm
marker.

### Precise answer: can a portal cookie be replayed as an admin cookie today?

**No — in both directions — and the only guard is a JSON field-name check.**

- Portal → admin: `verifySession` passes the HMAC check, then returns `null` at
  `admin/session.ts:169`: `if (!session.sub || !Array.isArray(session.groups)) return null`. The
  portal body (`{accountId, name, email, csrf, exp}`) has neither field. PoC `R1-02b` — 401 from
  `/manage/api/me`.
- Admin → portal: `verifyPortalSession` returns `null` at `portal/session.ts:125`:
  `if (!session.accountId …)`. The admin body has no `accountId`. PoC `R1-02c`.

So the entire boundary between "anyone with an email address" and "platform administrator" is a
**shape coincidence between two JSON objects signed by the same key**. There is no cryptographic
separation whatsoever.

### The single future change that makes it exploitable

Add `sub` **and** any `groups: string[]` to `PortalSession`. Both are natural near-term additions:
`getOrCreateAccountByIdentity` already carries an OIDC `subject` (`portal/auth.ts:281-290`), and
portal org/team roles are an obvious next feature. PoC `R1-02d` signs one body carrying
`{accountId, sub, groups:["platform-admins"], csrf, exp}` with the shared key and shows **both**
`verifySession` and `verifyPortalSession` accept it.

Reachability if that lands: a portal session is obtainable by **anyone with an email address** via
the magic-link flow (`portal/auth.ts:302-397`) or by any IdP account via `handlePortalCallback` — no
admin group required. Copy the `pkey_portal` value into a `pkey_admin` cookie ⇒ platform admin. Note
the portal cookie is already `Path=/`, so the browser sends it to `/manage/*`; only the cookie
_name_ differs.

### Probes run against the token parser (all refuted, pinned by tests)

- `lastIndexOf(".")` splitting (`admin/session.ts:143`, `portal/session.ts:102`): appending or
  prepending a segment moves the signed input, so a fresh HMAC would be needed. PoC `R1-02e`.
- JSON body manipulation via `name`/`email`: `JSON.stringify` escapes `"`; no claim smuggling.
  PoC `R1-02f`.
- `exp`: both verifiers require `typeof exp === "number"` and `exp > now`; string/absent fails closed.
- `safeEqual` (`admin/session.ts:69-74`): length-first early return plus a non-constant-time JS char
  loop. Not remotely exploitable over the network for a 256-bit tag. **Info.**

### Fix direction

1. Make `PORTAL_SESSION_SECRET` **required** — delete the `??` fallback and fail closed exactly as
   `admin/session.ts:82-83` does.
2. Independently, add domain separation _inside the signed material_: sign `"pkey.admin.v1|" + body`
   vs `"pkey.portal.v1|" + body`, or add a `realm` claim each verifier asserts. Belt and braces —
   (2) alone makes a shared key harmless.

---

## R1-03 — State-changing `GET`s bypass the CSRF gate

|               |                                                                                                                                                     |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Severity**  | **Low**                                                                                                                                             |
| **File:line** | `packages/worker/src/admin/lib/respond.ts:57-60`; `packages/worker/src/admin/api.ts:162-166, 171-173`; `packages/worker/src/portal/auth.ts:399-410` |
| **PoC**       | ✅ passing — `R1-03a` (gate skipped), `R1-03b` (cross-site refuted)                                                                                 |

`isMutation(method)` returns `false` for `GET`/`HEAD`, so `admin/api.ts:163-166` never evaluates the
double-submit token for a `GET`. `GET /manage/api/logout` (`api.ts:171-173`) then clears the session
with no `X-PKey-CSRF` header at all (PoC `R1-03a`).

**Cross-site exploitation is refuted today**: the session gate at `api.ts:154-155` runs first and
`SameSite=Strict` withholds the cookie on a cross-site request, so the route 401s before reaching
the logout branch (PoC `R1-03b`). The finding is that the CSRF gate is _method-shaped_ rather than
_effect-shaped_ — it becomes live the moment the admin cookie is relaxed to `SameSite=Lax`, which is
a common change (it is precisely what makes the post-OIDC redirect land already-authenticated).

`GET /logout` on the portal (`portal/auth.ts:399-410`) is worse: `handlePortalLogout` takes no
arguments and unconditionally returns a clearing `Set-Cookie`, and the portal cookie is
`SameSite=Lax`. `<img src="https://key.plrs.im/logout">` or a top-level navigation is a working
logout-CSRF (nuisance-grade, no privilege impact).

### Fix direction

Make logout a `POST` on both surfaces and route it through the CSRF check; drive `isMutation` off an
explicit per-route effect flag rather than the HTTP method.

---

## R1-04 — Audit-write amplification on the cross-product 403 path

|               |                                                                                           |
| ------------- | ----------------------------------------------------------------------------------------- |
| **Severity**  | **Low** (latent Medium)                                                                   |
| **File:line** | `packages/worker/src/admin/api.ts:68-82`                                                  |
| **PoC**       | ✅ passing — `R1-04a` (amplifier proven), `R1-04b` (unauthenticated reachability refuted) |

`handleProductScoped` writes one `audit` row (`admin/api.ts:72-80`) on every
authenticated-but-unauthorized product access. That branch has **no rate limit** — in fact the admin
API has _no_ rate limiter at all; only `/manage/login` and `/manage/callback` are limited
(`auth.ts:150-160`, `:195-205`). It is reachable by `GET`, so `isMutation` is false and **no CSRF
token is required**. PoC `R1-04a`: 25 × `GET /manage/api/products/djdl/licenses` ⇒ 25 D1 rows, 403
each.

**Refuted as an unauthenticated amplifier, and in fact unreachable today.** The login gate
`hasAnyAdminGrant` (`authz.ts:30-38`) and the product gate `isPlatformAdmin` (`authz.ts:14-18`) are
the _same predicate_ — `groups.includes(PLATFORM_ADMIN_GROUP)` — so no session the OIDC callback can
mint can fail the second after passing the first. PoC `R1-04b` pins this and shows unauthenticated
requests 401 with zero D1 writes.

The branch becomes live when product-level RBAC lands, or for a stale session issued before
`PLATFORM_ADMIN_GROUP` was rotated (stateless 8h sessions are not revoked by rotation). The comment
at `api.ts:70-71` shows the D1-write-DoS hazard was correctly identified for the 401 path; the same
reasoning was not applied to the 403 path.

### Fix direction

Rate-limit the admin API generally (a `RateLimitDO` bucket keyed by `session.sub`), and dedupe
`access.denied` rows (one per actor+product per window).

---

## R1-05 — `handleMintAuth` renders D1 HTML unauthenticated with no CSP

|               |                                                                                                                           |
| ------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **Severity**  | **Medium** (latent **Critical**)                                                                                          |
| **File:line** | `packages/worker/src/edgeMint.ts:246-258`, sink at **`:254-257`**; route `router.ts:162-167`; dispatch `index.ts:116-117` |
| **PoC**       | ✅ passing — `R1-05a` (sink proven), `R1-05b` (reachability refuted)                                                      |

`handleMintAuth(db, product, mintId)` takes **no `Request`**: no bearer token, no cookie, no rate
limit, no method check. It returns `cfg.auth_page_template` from D1 verbatim as
`text/html; charset=utf-8` with **only** a content-type header. PoC `R1-05a` seeds
`<script>fetch("/manage/api/me",{credentials:"include"})</script>` and gets it back byte-identical,
with `content-security-policy`, `x-frame-options` and `x-content-type-options` all `null`.

Combined with R1-09, a populated `auth_page_template` is **unauthenticated stored XSS on the platform
origin ⇒ full platform-admin takeover** whenever a signed-in admin loads the URL — and it is a plain
`GET`, so an `<iframe>` or a link suffices. Note that `handleMintToken` immediately above correctly
demands a valid device token as a _"confused-deputy guard"_ (`edgeMint.ts:186-189`); the auth-page
sibling has no guard of any kind.

### Reachability — refuted today

There is **no application write path** for `auth_page_template`:

- `stmtInsertEdgeMint` (`repo.ts:589-604`) — the only writer, used by `linkRepo`, `resyncRepo`
  (`release/resync.ts:305-320`) and the GitHub webhook — hard-codes `NULL` in that column.
- There is no `authPage` field in the `.pkey/release` manifest schema (grep: zero hits for
  `authPage` across the repo).
- No admin API route touches the column (`admin/lib/shape.ts:194-197` only reads `id` and
  `signing_key_secret`).
- `resyncRepo` `DELETE`s and re-inserts every `edge_mint_config` row, wiping any out-of-band value.

PoC `R1-05b` pins all of this. Reaching the sink therefore requires direct D1 write access — already
game over. Rated Medium rather than Low because the column exists, is documented as intended for the
MusicKit-JS auth page (`edgeMint.ts:5-6`), and will eventually be wired up: the first manifest field
or admin endpoint that populates it silently ships a Critical.

### Fix direction

Delete the column + route, or — if it must stay — require the same device-token guard as
`handleMintToken`, serve it from a sandboxed origin, and attach a strict CSP
(`default-src 'none'; frame-ancestors 'none'`, explicit `script-src` allowlist, `nosniff`). Treat
"can write the template" as equivalent to "has script execution on the platform origin".

---

## R1-06 — `/manage/*` asset proxy: unauthenticated, escapes its prefix, strips the CSP

|               |                                                                                                                       |
| ------------- | --------------------------------------------------------------------------------------------------------------------- |
| **Severity**  | **Low**                                                                                                               |
| **File:line** | `packages/worker/src/admin/index.ts:41-63`, esp. **`:48-52`** and **`:60-62`**; same shape at `portal/index.ts:31-53` |
| **PoC**       | ✅ passing — `R1-06a`, `R1-06b`, `R1-06c`                                                                             |

`serveAdminAsset` runs **before any session check** (`admin/index.ts:89`) — by design, the SPA shell
must be public. Two issues:

1. **Prefix escape.** For any `cleanPath` containing a `.`, the code does `url.pathname = cleanPath`
   (`:51`). The WHATWG URL path parser normalises percent-encoded dot segments, so
   `GET /manage/%2e%2e/%2e%2e/index.html` resolves to `/index.html` and is fetched from ASSETS — the
   request has left `/manage` entirely. PoC `R1-06b`.
2. **CSP stripping.** The `if (url.pathname === "/manage.html")` branch (`:54`) is the only one that
   applies `appSecurityHeaders`. Because the escape changes the pathname, the response takes the
   `else` branch (`:60-62`) and ships with **only** `x-content-type-options: nosniff` — no CSP, no
   `X-Frame-Options`, no `referrer-policy`. PoC `R1-06b` asserts all three are `null`. PoC `R1-06c`
   confirms the SPA-shell fallback path _does_ get the CSP, so the gap is specific to dotted paths.

Impact today is limited: the ASSETS binding is `../admin/dist` (`wrangler.toml`), a public static
build, and Workers Static Assets resolves against a fixed manifest — there is no filesystem
traversal and no secret to reach. The finding is that a **user-controlled string is used as an asset
path**, and that the security-header decision is made on that same string. It becomes the delivery
vector for R1-09 if any HTML ever lands in the asset bundle.

### Fix direction

Constrain `cleanPath` to `^/[A-Za-z0-9._/-]+$` and resolve it explicitly as `/manage${cleanPath}`.
Apply `appSecurityHeaders` to **all** asset responses, deciding on `content-type` rather than on the
resolved pathname.

---

## R1-07 — Device-code "user confirmation" is self-servable by the flow's starter

|               |                                                                                                                      |
| ------------- | -------------------------------------------------------------------------------------------------------------------- |
| **Severity**  | **Medium** (license/identity takeover; likely overlaps the licensing lane)                                           |
| **File:line** | `packages/worker/src/oidc.ts:610-661` (self-confirm `:624-635`, framable page `:657-660`); poll at `oidc.ts:876-922` |
| **PoC**       | ✅ passing — `R1-07a` (self-confirm + authorize-URL disclosure), `R1-07b` (framable page)                            |

`handleAuthDeviceVerify` treats `?confirm=1` as the human-approval step, but it is an
unauthenticated `GET` with no CSRF token, no session and no binding to a human: **the party that
started the flow can call it themselves**. It then 302s to `record.authorizeUrl`, handing that URL to
the caller.

PoC `R1-07a` runs: `POST /djdl/auth/device/start {deviceId:"attacker-device"}` →
`GET /djdl/auth/device/verify?device_code=…&confirm=1` → `302 https://id.example/authorize?…`, with
`confirmedAt` written to KV and `deviceId` still the attacker's.

The attacker now holds an **IdP-hosted authorize link** for their own device flow, indistinguishable
from a legitimate sign-in link (it is on the IdP's own domain with a valid `client_id`, PKCE and
nonce). When a phished victim signs in, `handleAuthCallback` (`oidc.ts:770-782`) mints or locates a
license for the **victim's** identity and writes `flow.licenseId`; the attacker then polls
`POST /djdl/auth/device/poll {deviceCode, deviceId:"attacker-device"}` and receives a device token on
the victim's license (`oidc.ts:900-921` → `pollAuthFlow` → `authorizeAndMint`). The device-mismatch
check at `oidc.ts:903` compares against the attacker's own stored `deviceId`, so it does not help.

The `userCode` displayed on the page (`oidc.ts:650`) is **never verified anywhere** — it is
cosmetic, so the one control that normally makes device flows phishing-resistant is absent. The page
is additionally framable (no `X-Frame-Options`, no `frame-ancestors` — PoC `R1-07b`), so the same
result is reachable by clickjacking the "Continue to sign in" button.

This does not reach `/manage`, but it is "ability to mint license tokens bound to someone else's
identity", which is in-lane. Flagging probable overlap with the licensing lane.

### Fix direction

Require the user to type `userCode` and verify it; make confirmation a `POST` with a per-flow CSRF
token; never return `authorizeUrl` to the flow initiator; apply `appSecurityHeaders`
(`frame-ancestors 'none'`) to the page.

---

## R1-08 — Admin cookie has no `__Host-` prefix; first-match cookie parsing

|               |                                                                                                          |
| ------------- | -------------------------------------------------------------------------------------------------------- |
| **Severity**  | **Low**                                                                                                  |
| **File:line** | `packages/worker/src/admin/session.ts:178-185, 188-197`; `packages/worker/src/portal/session.ts:130-148` |
| **PoC**       | ✅ passing — `R1-08a`, `R1-08b`                                                                          |

`pkey_admin` is set with `Path=/manage; HttpOnly; Secure; SameSite=Strict` but **no cookie-name
prefix**, and `readSessionCookie` (`admin/session.ts:178-185`) returns the **first** `pkey_admin` in
the header.

Per RFC 6265 §5.4, browsers order cookies by **descending path length**. An attacker who controls any
sibling subdomain of the registrable domain (the worker runs at `key.plrs.im`, so anything under
`*.plrs.im`) — or who has XSS on one — can set
`pkey_admin=<attacker token>; Domain=plrs.im; Path=/manage/api`. That cookie has a longer path than
the legitimate host cookie, is therefore sent first, and wins. PoC `R1-08b` shows the worker reading
the first of two `pkey_admin` values. This is a second, XSS-free route to the R1-01 fixation outcome.

`__Host-` cannot be applied as-is (it requires `Path=/`), which is the tension to resolve.
`pkey_portal` (`Path=/`, `SameSite=Lax`) has the same gap and _can_ take `__Host-` directly.

### Fix direction

Rename to `__Host-pkey_admin` with `Path=/` (relying on `HttpOnly` + `SameSite` + CSRF rather than
path scoping), or at minimum reject requests presenting more than one `pkey_admin` cookie instead of
silently taking the first. Rename `pkey_portal` → `__Host-pkey_portal` unconditionally.

---

## R1-09 — Any same-origin XSS defeats the entire admin cookie hardening story

|               |                                                                                                                                                    |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Severity**  | **High** (architectural; the escalation path for R1-05/R1-06/R1-07)                                                                                |
| **File:line** | `packages/worker/src/admin/session.ts:1-19, 187-197`; `packages/worker/src/admin/api.ts:162-166`; `packages/worker/src/admin/handlers/me.ts:35-42` |
| **PoC**       | static — mechanism established by `R1-05a`, `R1-06b`, `R1-07b` all producing CSP-less HTML on the same origin                                      |

`admin/session.ts:8-18` argues the CSRF header is _"a value an attacker page cannot read (it's not in
a readable cookie, and the API is same-origin only)"_. That holds cross-origin — there are **no CORS
headers anywhere in the worker** (verified by grep) — but the **same-origin** case is unguarded, and
the platform serves plenty of non-admin HTML on the same origin.

A script at `https://key.plrs.im/<anything>` can do:

```js
const me = await (
  await fetch("/manage/api/me", { credentials: "same-origin" })
).json();
// -> {sub, name, email, csrf, platformAdmin, products}
await fetch("/manage/api/products/<slug>/secrets/GITHUB_TOKEN", {
  method: "PUT",
  credentials: "same-origin",
  headers: { "X-PKey-CSRF": me.csrf, "content-type": "application/json" },
  body: JSON.stringify({ value: "…" }),
});
```

`Path=/manage` matches the request path, `SameSite=Strict` is satisfied (same site), `HttpOnly` is
irrelevant (the script never reads the cookie — the browser attaches it), and `/api/me` hands over
the per-session CSRF token. From there every mutation is available: product create/delete, signing
key rotate/activate/revoke, sealed-secret writes, license and license-key minting, repo relink.

Every CSP-less HTML response on this origin is therefore a control-plane escalation primitive:

| Response                               | File:line                                       | CSP | XFO | nosniff |
| -------------------------------------- | ----------------------------------------------- | --- | --- | ------- |
| `handleMintAuth` (raw D1 HTML)         | `edgeMint.ts:254-257`                           | ❌  | ❌  | ❌      |
| device-verify page                     | `oidc.ts:657-660`                               | ❌  | ❌  | ❌      |
| "You're signed in" page                | `oidc.ts:817-820`                               | ❌  | ❌  | ❌      |
| admin sign-in `htmlError`              | `admin/auth.ts:138-143`                         | ❌  | ❌  | ❌      |
| ASSETS passthrough (non-`manage.html`) | `admin/index.ts:60-62`, `portal/index.ts:50-52` | ❌  | ❌  | ✅      |

By contrast `appSecurityHeaders` (`securityHeaders.ts:13-23`) is applied to the SPA shells and to
every JSON response — i.e. exactly the responses that could never have been injected into. The
protection is inverted relative to the risk.

(No live injection exists today: `admin/auth.ts:138` and `oidc.ts:817` interpolate only hard-coded
literals, and `oidc.ts:602-608` `escapeHtml` covers `& < > "` with every interpolation inside a
double-quoted attribute or a text node. The exposure is that these pages have **zero defense in
depth** if that ever changes.)

### Fix direction

Apply `appSecurityHeaders` to **every** HTML response the worker emits — make it the default in a
response wrapper rather than an opt-in. Separately, scope the admin cookie away from other content:
serve `/manage` from its own hostname, or (cheaper) assert `Origin`/`Sec-Fetch-Site` in
`handleAdminApi` alongside the CSRF check so a request initiated by a non-`/manage` page is rejected.

---

## Info-level notes

- **CSRF comparison is not constant-time.** `admin/api.ts:165` uses `presented !== session.csrf`;
  the session HMAC uses `safeEqual` but the CSRF token does not. Not practically exploitable; fix
  for consistency.
- **`safeEqual` is not truly constant-time** (`admin/session.ts:69-74`, `portal/session.ts:54-59`):
  the length check short-circuits and JS `charCodeAt` timing is not guaranteed. Standard practice;
  no practical attack against a 256-bit tag.
- **`oidc.ts` `safeReturnTo` does not exclude `/manage`** (`oidc.ts:205-215`), while the portal's
  version explicitly does (`portal/auth.ts:100`). So
  `GET /<product>/auth/start?return_to=https://key.plrs.im/manage/...` lands a signed-in user on an
  admin URL carrying a product browser-session cookie. No privilege is conferred (that cookie is
  `pkey_<slug>_session`, `Path=/<slug>`), but the asymmetry looks unintentional.
- **`platformOidcConfig` accepts undeclared `ADMIN_OIDC_*` aliases** (`platformOidc.ts:9-30`) via the
  `Env` index signature (`env.ts:33`). Not a vulnerability, but a stale or typo'd `ADMIN_OIDC_ISSUER`
  var silently becomes the admin IdP whenever the `PLATFORM_OIDC_*` vars are absent.
- **`handleKeys` (license keys) mints a key for an unvalidated `licenseId`**
  (`admin/handlers/keys.ts:46-82`): `insertKey` is called without confirming the license exists.
  Platform-admin-gated, so out of R1 scope; noted for the data-integrity lane.
- **Stateless 8h admin sessions cannot be revoked.** `admin/session.ts:16-18` accepts this trade
  explicitly, and `PLATFORM_ADMIN_GROUP` changes do not invalidate sessions already issued. Incident
  response has no lever short of rotating `ADMIN_SESSION_SECRET` — which, per R1-02, also invalidates
  every portal session whenever `PORTAL_SESSION_SECRET` is unset.

---

## REFUTED

| Hypothesis                                                       | Verdict                    | The guard that stops it                                                                                                                                                                                                                                  |
| ---------------------------------------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Portal cookie replays as an admin cookie                         | **Refuted**                | `admin/session.ts:169` — `!session.sub \|\| !Array.isArray(session.groups)`; the portal body has neither field. (Latent: see R1-02.) PoC `R1-02b`                                                                                                        |
| Admin cookie replays as a portal cookie                          | **Refuted**                | `portal/session.ts:125` — `!session.accountId`. PoC `R1-02c`                                                                                                                                                                                             |
| `lastIndexOf(".")` split is forgeable                            | **Refuted**                | Adding a segment changes the HMAC input; the attacker must forge a signature over the new body. PoC `R1-02e`                                                                                                                                             |
| JSON body manipulation via `name`/`email` at issue time          | **Refuted**                | `JSON.stringify` escapes `"`; no claim smuggling into the signed body. PoC `R1-02f`                                                                                                                                                                      |
| `groups` array injection via ID-token claim shape (`mapClaims`)  | **Refuted**                | `admin/auth.ts:75-77` requires `Array.isArray` and filters non-strings; anything else yields `[]`. PoC in `REFUTED hypotheses`                                                                                                                           |
| `exp` handling (string / missing / NaN)                          | **Refuted**                | `admin/session.ts:168`, `portal/session.ts:125-126` require `typeof exp === "number"` and `exp > now`                                                                                                                                                    |
| `PLATFORM_ADMIN_GROUP` unset or empty grants access              | **Refuted — fails closed** | `authz.ts:16` (`if (!group) return false`) and `authz.ts:35` (`env.PLATFORM_ADMIN_GROUP && …`). Empty string is falsy, so even `groups: [""]` grants nothing. PoC in `REFUTED hypotheses`                                                                |
| `/manage/api/products*` routes around the central CSRF check     | **Refuted**                | `router.ts:60-64` emits a distinct `Route` kind, but `index.ts:184-194` funnels `products` into the same `handleAdmin` → `handleAdminApi`, which session- and CSRF-gates before dispatch. PoC in `REFUTED hypotheses` (403 `csrf`)                       |
| Audit-write amplification is unauthenticated                     | **Refuted**                | `api.ts:154-155` 401s before any D1 write, and the login/product gates are the same predicate so the branch is unreachable today. PoC `R1-04b`                                                                                                           |
| `GET /manage/api/logout` is cross-site triggerable               | **Refuted (today)**        | Session gate runs first and `SameSite=Strict` withholds the cookie ⇒ 401. PoC `R1-03b`                                                                                                                                                                   |
| `auth_page_template` XSS is attacker-writable                    | **Refuted**                | `repo.ts:589-604` hard-codes `NULL`; no manifest field, no admin route; `resync` deletes+reinserts the table. PoC `R1-05b`                                                                                                                               |
| Product slug collides with the admin/portal cookie name          | **Refuted**                | `browserSession.ts:46-48` always appends `_session`; `pkey_admin_session ≠ pkey_admin`. PoC in `REFUTED hypotheses`                                                                                                                                      |
| Percent-encoded traversal reaches files outside the asset bundle | **Refuted**                | The WHATWG URL setter normalises `%2e%2e` before the fetch and Workers Static Assets resolves against a fixed manifest. The prefix escape is real (R1-06) but there is no filesystem traversal                                                           |
| Unauthenticated path to `PLATFORM_KEK` or a private signing key  | **Refuted**                | `keyvault.ts:67-83` (32-byte validation, throws when unset); `open()` fails closed with `product:kind:id` AAD; `handlers/products.ts:628-755` returns only `publicKey`; `openProductSecret` is reached only from device-token-gated or admin-gated paths |
| Missing `ADMIN_SESSION_SECRET` yields a guessable signing key    | **Refuted**                | `admin/session.ts:82-83` throws; both issue and verify fail closed (also covered by `admin.test.ts:718`)                                                                                                                                                 |
| GitHub webhook forgery gives an unauthenticated config write     | **Refuted**                | `githubWebhook.ts:106-124`: missing secret ⇒ 500; HMAC-SHA256 over the raw body, strict `^sha256=[0-9a-f]{64}$` header match, constant-time compare                                                                                                      |
| OIDC `nonce` replay / token injection at the admin callback      | **Refuted**                | `admin/auth.ts:126-129` rejects unconditionally on a missing or mismatched `nonce`; `jwtVerify` is pinned to `RS256/ES256/EdDSA` with `issuer` + `audience` bound                                                                                        |

---

## Remediation

Landed on branch `lewd-owl` by the control-plane remediation lane. Scope was
`securityHeaders.ts`, `http.ts`, `rateLimit.ts`, `rateLimitDo.ts`, `index.ts`, `router.ts`,
`browserSession.ts`, `edgeMint.ts`, `admin/{session,auth,authz,api,index}.ts`,
`portal/{session,auth,index}.ts`. Everything else is reported, not edited.

| ID            | Status                                     | Change                                                                            | Test                                                     |
| ------------- | ------------------------------------------ | --------------------------------------------------------------------------------- | -------------------------------------------------------- |
| R1-09 / R6-04 | **Fixed**                                  | Every HTML response on the origin now carries a CSP                               | `R1-01c`, `R1-05a`, `R1-06b`, `R1-07b`, `R9-11`, `R9-12` |
| R1-05         | **Fixed** (defence-in-depth)               | `handleMintAuth` serves the stored template under `default-src 'none'`            | `R1-05a`, `R9-11`                                        |
| R1-06         | **Fixed**                                  | Asset-proxy prefix escape closed; headers applied to every asset response         | `R1-06b`, `R1-06c`                                       |
| R1-08         | **Fixed**                                  | `__Host-` cookie prefix + duplicate-cookie rejection, both realms                 | `R1-08a`, `R1-08b`                                       |
| R1-02         | **Fixed**                                  | Explicit domain-separation tag inside the signed message                          | `R1-02a`, `R1-02d`                                       |
| R1-03         | **Fixed** (admin) / **Mitigated** (portal) | Admin logout is POST-only; portal `GET /logout` requires a same-origin navigation | `R1-03a`                                                 |
| R1-04         | **Fixed**                                  | Audit write on the 403 branch is budgeted; the admin API has a limiter at all     | `R1-04a`                                                 |
| Admin authz   | **Fixed**                                  | Per-product admin scaffolding deleted; three lying doc comments corrected         | `R1-04b`                                                 |
| R10-03        | **Fixed**                                  | Explicit, per-surface fail-open/fail-closed policy                                | `R10-03` (5 cases)                                       |
| R10-04b       | **Fixed**                                  | Alarm-based sweep reclaims elapsed counters                                       | `R10-04` (3 cases)                                       |
| R3-08         | **Fixed**                                  | `POST /<p>/session/license` rate-limited                                          | `R3-08`                                                  |

### R1-09 — CSP on every HTML response

`securityHeaders.ts` now exports three things instead of one:

- `appSecurityHeaders` — unchanged policy for the SPA shells and JSON APIs, plus HSTS.
- `staticHtmlSecurityHeaders` — a _stronger_ policy for server-rendered, script-free HTML:
  `default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self';
img-src 'self' data:; style-src 'unsafe-inline'`. `script-src` and `connect-src` fall back to
  `default-src 'none'`, so an injected `<script>` cannot execute _and_ an injected
  `fetch("/manage/api/me", {credentials:"same-origin"})` cannot connect — the exact primitive
  R1-09 describes. `style-src 'unsafe-inline'` is the single inline allowance, because these
  pages are styled with `style=` attributes; with everything else at `'none'` the residual risk
  is a CSS-only injection loading an image from `'self'`.
- `secureResponse(res)` — an **origin-wide backstop** applied to every response in
  `index.ts`. It adds HSTS unconditionally and supplies the static policy to any `text/html`
  response that did not set its own. This is what makes "no CSP-less HTML on this origin" a
  property of the dispatcher rather than a convention each handler must remember; a new HTML
  response added anywhere is hardened by default.

Applied directly at the two in-scope sinks (`edgeMint.ts` `handleMintAuth`, `admin/auth.ts`
`htmlError`) as well as through the backstop, so a direct handler call is safe too.
`Strict-Transport-Security: max-age=31536000; includeSubDomains` is now on every response;
`preload` is deliberately omitted as an operator decision.

### R1-06 — asset proxy

`isSafeAssetPath` (in `http.ts`) rejects any path containing `%`, so nothing that the WHATWG
URL parser could normalise into a dot segment ever reaches `url.pathname`; unsafe paths fall
through to the SPA shell. The header decision no longer depends on the resolved pathname —
`appSecurityHeaders` is applied to **all** asset responses on both the admin and portal
proxies.

### R1-08 — cookie shadowing

**`Path=/manage` could not be kept.** RFC 6265bis §4.1.3.2 requires a `__Host-` cookie to be
`Secure`, to carry no `Domain`, and to be `Path=/`; a browser rejects any `__Host-` cookie that
is not. The path scope was traded away because it was never a boundary: R1-09 established that
a same-origin script reaches `/manage/api/*` regardless of the cookie's path, and `Path` does
nothing at all against the sibling-subdomain writer that R1-08 is about. What remains is
`HttpOnly` + `Secure` + `SameSite=Strict` + the CSRF double-submit, **plus** a browser-enforced
guarantee that only `key.plrs.im` itself can have set the value — which is strictly more than
before.

Both `readSessionCookie` implementations now collect _every_ matching value and return `null`
unless exactly one distinct value is present. First-match-wins was the other half of the
finding. `pkey_portal` → `__Host-pkey_portal` (already `Path=/`, so no trade at all).

Both renames invalidate sessions issued before the deploy.

### R1-02 — domain separation

The admin realm signs `"pkey.admin.v1|" + body`; the portal realm signs
`"pkey.portal.v1|" + body`. The realms are now cryptographically distinct **regardless of
payload shape**, so the latent Critical (add `sub` + `groups` to `PortalSession` and the realms
collapse) is dead rather than deferred. `R1-02d` pins this in both directions and also asserts
that the old untagged signature now verifies in neither realm.

The `PORTAL_SESSION_SECRET ?? ADMIN_SESSION_SECRET` fallback is **kept**: `wrangler.toml`
documents it as supported, and removing it would 500 every portal session on deployments that
rely on it. It is now safe rather than merely lucky — a shared key is harmless once the signed
messages differ. Setting a distinct `PORTAL_SESSION_SECRET` is still preferred so the realms
can be rotated independently.

### R1-03 / R1-04

`GET /manage/api/logout` is now `405`; logout is `POST` and therefore runs through the CSRF
double-submit it previously routed around. The admin SPA already called it with `method: "POST"`
(`packages/admin/src/api.ts:586`), so there is no client change.

The portal's `GET /logout` is a different situation: the portal SPA signs out with a plain
`<a href="/logout">`, so a hard method check would break sign-out. `POST` is accepted
unconditionally; `GET` is accepted only for a genuine same-origin top-level navigation, checked
via the Fetch Metadata headers (`isSameOriginNavigation` in `http.ts`). That refuses both
CSRF shapes — `<img src="https://key.plrs.im/logout">` arrives with `Sec-Fetch-Dest: image`,
and a cross-site link with `Sec-Fetch-Site: cross-site`. Requests carrying no `Sec-Fetch-*` at
all are allowed through: the header is trustworthy when present, but its absence proves
nothing.

The admin API now has a rate limiter at all (`adminApi`, 600/min keyed by the verified
`session.sub`, fail-open), and the audited 403 branch has a much tighter one
(`adminAccessDenied`, 3 per actor+product per 5 min). The 403 is still returned on every
request; only the D1 write is budgeted, because the burst is the signal an operator needs, not
each request in it.

### Admin authz — per-product admin removed

Per the repo owner's decision, the scaffolding is gone rather than implemented.
`canAdminProduct(env, session)` and `hasAnyAdminGrant(env, groups)` no longer accept the
arguments they ignored — they were removable precisely because nothing read them, and a
signature that accepts an argument it discards invites callers to believe a check is happening.
Three doc comments that described a per-product gate which does not exist were corrected
(`admin/authz.ts` header, `admin/api.ts:8-14`, `admin/session.ts:1-5`). Dropping the
`_products` argument also removed a `listProducts` D1 read from every admin login.

### R10-03 — deliberate per-surface fail mode

`rateLimitOk` now wraps the DO call in `try`/`catch`, validates `res.ok` and the parsed shape,
and consults a bucket→policy table:

- **Fail closed** for anything that mints or exchanges a credential — `activate`, `token`,
  `enroll`, `mint`, `browserSessionLicense`, every OIDC leg, both interactive logins,
  `portalClaimKey`. An unlimited credential endpoint is a brute-force oracle; losing the
  limiter must not silently remove the only thing bounding guessing. This reads
  availability-hostile but barely is: the failure is transient and per-request, and the caller
  surfaces a **429** — the status that makes a client back off and retry — in place of the
  unhandled-exception **500** it replaces.
- **Fail open** for authenticated, non-credential surfaces (`adminApi`, `adminAccessDenied`,
  `portalDeviceDisconnect`, `portalDownloadToken`), where the limiter guards cost and noise
  rather than a secret and the request is already authenticated by something stronger.
- **Unknown buckets fail closed**, so a new credential route that forgets to register here
  degrades safely instead of opting into "unlimited".

This deliberately takes the opposite side from R10-dos.md's fix direction, which proposed
fail-open for licensing on availability grounds. Revisit with metrics if a DO incident ever
measurably locks out paying customers.

### R10-04b — bounded DO storage

`RateLimitDO` writes `expiresAt` alongside `{window, count}` and arms an `alarm()` on the write
path. The sweep deletes every counter whose window has elapsed — safe unconditionally, because
once a window is over the stored counter can never be read again — batches at 2000 keys, and
re-arms only while live counters remain, so an idle object stops waking up. Counters written
before this change carry no `expiresAt` and are collected on the first sweep. The false comment
claiming storage was "bounded by the active client set" is replaced by an accurate one.

**R10-04a (sharding) is NOT fixed** and is now documented in the file: `_admin` and `_portal`
are literal shard names, so interactive sign-in for the entire platform serializes through
exactly two Durable Objects. Fixing it means keying the shard as
`${product}:${bucket}:${hash(id) % N}`, which changes call sites in `oidc.ts`, `licensing.ts`
and `portal/api.ts` — outside this lane.

### Reported, not fixed

1. **`oidc.ts` — the two HTML pages still set no headers of their own.** The dispatcher
   backstop covers them in production, but they should set their own so a direct handler call
   is safe too. Exact change, for the OIDC owner:
   `import { staticHtmlSecurityHeaders } from "./securityHeaders.js"`, then at
   `oidc.ts:800-808` (device-authorization page) and `oidc.ts:1003-1006` ("You're signed in")
   replace the header object with
   `staticHtmlSecurityHeaders(new Headers({ "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }))`.
   The device page's `referrer-policy: no-referrer` is preserved by that helper. PoCs `R1-07b`
   and the third `R9-12` case assert both halves today: handler sets nothing, `secureResponse`
   supplies it.
2. **R5-05 — cross-tenant portal DoS** (`packages/worker/src/portal/api.ts:264-285`, data
   lane). `requireActionRateLimit` builds `id: \`${session.accountId}:${clientIp(req)}\``with
**no product dimension**, in the single global`\_portal` shard, and it is charged *before*
authorization (`handleDeviceDelete`limits at`:431`but reads ownership at`:440-448`;
`handleReleases`limits at`:545`and reads at`:555`). An account's budget spent on tenant A
429s tenants B/C/D, and it can be spent by a user who owns no license at all. Fix: put the
product in the id (`${product}:${accountId}:${ip}`), shard the DO by product for
   product-scoped actions, and move the charge after the ownership check (or add a separate,
   much cheaper pre-auth limiter).
3. **R12-04 — admin OIDC flow `state` is still a raw KV key name**
   (`packages/worker/src/admin/auth.ts:31,180,222,225`, `ADMIN_FLOW_PREFIX`). Left alone
   deliberately: the fix is a one-line `hashKey(state, env.KEY_HASH_PEPPER)` on write and read,
   but it also requires editing `test/attack/R8-oidc.test.ts:752`, which belongs to a lane that
   has already finished. Lower severity than the magic-link case in the same finding — the key
   alone is not sufficient, since the PKCE `verifier` lives in the _value_ — but it should be
   hashed for consistency with `browserSession.ts` and `kv.ts`, which both already hash. The
   portal magic-link and product OIDC/device-flow keys in the same table are the R12 lane's.
4. **`packages/admin/src/views/Settings.tsx:247-258` still shows an editable "Admin group"
   field that grants nothing** (SPA lane). With per-product admin removed, `products.admin_group`
   is now unambiguously dead as an authorization input; the field should go, or be labelled as
   metadata only.
5. **`packages/worker/src/admin/handlers/me.ts:19-24` filters the product list by
   `admin_group`** — the same fiction, one layer up. Since the login gate and the product gate
   are the same predicate, the `p.admin_group != null && session.groups.includes(...)` branch is
   unreachable dead code that makes `/api/me` look like it reports a per-product grant. It is
   outside this lane's file scope; it should collapse to "platform admin ⇒ all products".
6. **`packages/admin/src/portal/App.tsx:340`** should become a form POST to `/logout`. The
   worker accepts POST today; the Fetch Metadata guard is a compatibility bridge, not the
   destination.

---

## Integration remediation

The cross-lane backlog: every item here was found by one lane and lived in a file owned by
another, so none of them could be closed in place. Scope was everything in
`packages/worker/**` and `packages/admin/**` except `shared-catalog/**` and `configDoc.ts`.
Baseline at the start of this pass was 656 worker tests / typecheck clean; the tree finishes at
**667 worker tests and 134 admin tests, all green, both packages typechecking**.

| Item                                        | Status    | Change                                                                          | Test                                                           |
| ------------------------------------------- | --------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| R11-11 — `D1Db` fail-open seat count        | **Fixed** | `success === false` throws `D1QueryError`; the seat count refuses a missing row | `R11-09` (2 cases)                                             |
| R3-09 — sibling device eviction             | **Fixed** | PATCH/DELETE require `deviceId === valid.device.device_id`                      | `R3-09` (2 cases, PoC inverted)                                |
| R12-04 — admin OIDC `state` as a KV key     | **Fixed** | Key is `admin:flow:<hashKey(state, pepper)>`                                    | `R1-01a`, `R8-03` admin case                                   |
| R5-05 — cross-tenant portal DoS             | **Fixed** | Product in the bucket id **and** the DO shard; charged after authz              | `R5-03` (PoC inverted)                                         |
| R1-07b / R9-12 — OIDC HTML headers          | **Fixed** | Both pages call `staticHtmlSecurityHeaders` at the sink                         | `R1-07b`, `R8-02`, `R9-12`                                     |
| R11-06 — unguarded `JSON.parse`             | **Fixed** | `edgeMint` claims template + 5 KV flow records                                  | `edge-mint` corrupt-template case                              |
| R3-06 — admin paths ignored tier expiry     | **Fixed** | `tierExpiresAt()` shared by all four assign-a-tier paths                        | `R3-06` (4 cases)                                              |
| R3-05 — `enroll_hwid` re-freed              | **Fixed** | Binding is permanent; `/enroll` refuses a claimed row                           | `R3-03` re-enrol case (PoC inverted), 2 `enroll.test.ts` cases |
| Seats never reclaimed                       | **Fixed** | `SEAT_DORMANCY_SECONDS` on both the count and the ordinal map                   | `R11-03` dormancy case                                         |
| Dead `admin_group` in `/api/me`             | **Fixed** | Collapsed to "platform admin ⇒ all products"                                    | `admin.test.ts` (unchanged, still green)                       |
| SPA "Admin group" field                     | **Fixed** | Editable field removed; read-only views relabelled "metadata only"              | `products.test.tsx`, `views.test.tsx`                          |
| Portal sign-out via `<a href>`              | **Fixed** | Form POST to `/logout`                                                          | `App.test.tsx`                                                 |
| **[Ajv lane] A** — browserSession fail-open | **Fixed** | Catalog failure now 500s `catalog_unavailable`, matching `/config`              | `browserSession.test.ts` malformed-catalog case                |
| **[Ajv lane] B** — unscreened repo catalogs | **Fixed** | `compileAll()` in `linkRepo` and `resync`                                       | `linkRepo.test.ts` bad-catalog case                            |

### R11-11 — the seat count is the fail-open one

`D1Db.all/run/runChanges/batch` now raise on any result reporting `success: false`.
`@cloudflare/workers-types` declares `success` as the literal `true`, so the check is made
against a widened view rather than deleted to satisfy a type that asserts the bug away.

`first()` has **no** result envelope, so the seat count is made fail-closed at the caller
instead: `SELECT COUNT(*)` always returns exactly one row, so `countActiveDevices` treats "no
row" as a failed read and throws rather than returning the old `?? 0`. That `0` was the actual
fail-open — a swallowed D1 error read as "this licence has no devices" in the one query that
decides whether to grant a seat.

### R5-05 — product is both a dimension and a shard

`requireActionRateLimit` takes an optional `product`. When present it goes into the counter id
(`${product}:${accountId}:${ip}`) **and** becomes the DO shard, so a tenant's traffic can only
exhaust that tenant's budget in that tenant's shard. `product` must already be proven to exist
— it names a Durable Object, and an unvalidated caller-supplied slug would let anyone spawn
unbounded DO instances. `portalClaimKey` therefore keeps the account-wide budget and the
`_portal` shard: it derives its product from the submitted key, and for a brute-force guard on
the caller's own account one global budget is strictly stronger than one per product.

Both product-scoped charges moved after the ownership check (`getPortalLicense` for the device
disconnect, `hasLinkedProductLicense` for the download token), so a caller who owns nothing can
no longer spend a budget at all. This closes the id/authz halves of R5-05; it also removes the
`_portal` shard from R10-04a's list, though `_admin` remains a single global shard.

### R3-05 — the enrolment binding is now permanent

`claimEnrolledLicense` and the OIDC merge arm both stopped clearing `enroll_hwid`, so the
claimed or retired row goes on occupying `idx_licenses_enroll_hwid` — the only guard on "one
free licence per machine".

That alone would create a worse bug: `getLicenseByEnrollHwid` would then hand an **anonymous**
`/enroll` caller a licence that now carries somebody's identity and their tier. So
`locateOrMintLicense` returns the row only while it is still `origin = 'enroll'`, `sub IS
NULL`, `status = 'active'`; otherwise `/enroll` answers `403 enroll_claimed` ("sign in to use
it"). The same test applies on the lost-race re-read path.

Deploy note, carried from the licensing lane: existing `licenses.enroll_hwid` rows hold the old
`computeHwid` value while `/enroll` now submits `computeEnrollHwid`, so the first enrolment
after deploy mints one fresh licence per machine, once. `admin/repo.ts`'s PII erase still clears
the column deliberately — that is an operator action, not a claim.

### Seat reclamation

`SEAT_DORMANCY_SECONDS` (90 days) is applied to **both** halves, because they must agree or the
pre-count refuses an activation the seat map would have granted. Excluding dormant devices from
the free-ordinal search is not sufficient on its own: `idx_devices_seat` still holds their
ordinal, so the INSERT would collide and retry forever. `releaseDormantSeats` therefore nulls
`seat_no` for dormant rows before the claim. Nothing is deleted or deauthorized — a device that
returns simply re-claims a seat, or gets a clean `device_limit` error. The unfiltered
`countActiveDevices` overload is retained for admin/reporting views.

### Reported, not fixed

1. **`packages/admin/src/SchemaForm.tsx:66-70` is the last uncapped `new RegExp(schema.pattern)`
   in the repo** (note the path: `src/SchemaForm.tsx`, not `src/views/`). With
   `@polaris-key/catalog` now interpreting patterns on a Thompson/Pike NFA, the worker is
   linear-time, but the admin SPA still hands the raw `pattern` to the JavaScript engine, so a
   catastrophic pattern hangs the operator's browser tab. It is reachable from a
   webhook-triggered resync — although the new `compileAll()` screen on `linkRepo`/`resync`
   (item B) now rejects patterns the interpreter refuses before they can reach the DB, which
   removes the sync path as an injection route. Residual risk is a catalog installed before this
   change. Fix: route the check through the catalog package's compiled pattern instead of
   `new RegExp`. Out of scope for this pass (SPA).
2. **No `scheduled()` handler** — still the correct home for dormant-device cleanup
   (`releaseDeviceSeat` + `purgeDeviceData` on a proper deauthorize), audit retention (R11-09),
   and `purgeExpiredDownloadTokens`. The seat fix above reclaims _capacity_ without a cron;
   it does not retire the row. `index.ts` exports `fetch` only and `wrangler.toml` declares no
   `[triggers]`.
3. **`_admin` is still a single global DO shard** (R10-04a). Interactive admin sign-in for the
   whole platform serialises through one object. Unlike the portal case there is no product to
   shard on, so this wants the `hash(id) % N` scheme rather than a key change.
4. **`products.admin_group` is still a stored, manifest-settable column.** It is now labelled
   "metadata only" everywhere it is displayed and is no longer editable from the SPA, but it
   remains in the schema, in `ProductDetail`, and in the manifest contract. Dropping it is a
   migration plus a manifest-format change.
5. **Portal `GET /logout` is still accepted** for a same-origin navigation. The SPA now POSTs,
   so the GET arm is only a bridge for browsers holding a cached older bundle and can be deleted
   once those have aged out.
