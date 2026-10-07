---
title: "Customer portal"
description: "The root-level, cross-tenant self-service account surface: sign-in, licenses, devices, and gated release downloads."
sidebar:
  order: 5
---

The customer portal is a self-service account surface: sign in once, see every license you hold
across **every product** on the deployment, claim more by key, manage your own devices, and
download gated releases you're entitled to. It is implemented entirely inside Identity — its
code lives in `services/identity/portal/`, and its six tables are Identity's (see
[Identity](/docs/services/identity/)) — but its routes are not product-scoped like the rest of
this section.

## Why the routes are root-level

`/login`, `/callback`, `/logout`, `/magic/verify`, `/api/*` (the login card's `/api/signin/*`
included), `/download/<token>`, `/media/<product>/<asset>` and `/media/avatar/<asset>` are reserved
ahead of every product slug and dispatched from the composition root, not from this service's
product-scoped sub-router. That is a consequence of what the portal _is_: one account can hold
licenses for several products at once, so there is no single `<product>` to hang these paths
under without inventing one and defeating the point of a cross-tenant view.

A platform route whose implementation lives inside one service is not a contradiction — it is the
same shape manifest ingest already takes elsewhere: a platform-owned pipeline dispatching into
service-owned rows. What moved into `services/identity/portal/` is the code; the routes stayed
exactly where they were.

## The Identity flag does not gate the portal

The portal is a platform concern: it runs for every product, whether or not that product has the
Identity service turned on. A product with Identity off has no `/identity/*` routes, but its
customers still see its licenses in the portal, can claim them by key and can manage their
devices. What decides that is the product's portal settings (below), never `services_json`'s
`identity` flag. The one service flag the portal does read is Release's: release downloads need
both `releasesEnabled` and the Release service on.

## Signing in

The login card on key.plrs.im is the only place a Polaris Key account's credentials are entered,
for the portal and, through the passthrough, for every app. It is identifier-first: the email
first, then the methods. Its Worker half lives in `services/identity/card/`; the card's screens
are the portal SPA's.

| Route                                   | What it does                                                                |
| --------------------------------------- | --------------------------------------------------------------------------- |
| `GET /login`                            | Begins platform OIDC and 302s to the IdP.                                   |
| `GET /callback`                         | The OIDC redirect URI: exchanges the code, verifies the ID token, signs in. |
| `POST /api/signin/email/start`          | Emails a 6-digit code and a magic link, bound to this browser.              |
| `POST /api/signin/email/verify`         | Redeems the code in the browser that asked.                                 |
| `POST /api/signin/email/resend`         | Sends a new code and link for this browser's sign-in.                       |
| `GET /magic/verify`                     | The magic link's landing page. Consumes nothing.                            |
| `POST /magic/verify`                    | The landing page's button: signs in here, or confirms the asking browser.   |
| `POST /api/signin/flow`                 | The asking browser's poll after the link was confirmed on another device.   |
| `GET`/`POST /api/signin/confirm-email`  | The email gate: the required first-provider-sign-in interstitial.           |
| `POST /api/signin/confirm-email/verify` | The gate's code, for a typed or unverified address.                         |
| `POST /api/signin/confirm-email/join`   | Takes the join offer, once both identities are proven.                      |
| `POST /api/signin/confirm-email/cancel` | Abandons the sign-in.                                                       |
| `GET /api/signin/confirm-email/picture` | The provider's picture, proxied for the gate.                               |
| `POST /api/signin/passkey/options`      | A passkey challenge, bound to this browser.                                 |
| `POST /api/signin/passkey/verify`       | Signs in with the passkey's answer to that challenge, once.                 |
| `POST /logout`                          | Ends this browser's session, server-side too.                               |

`POST /api/magic/start` is the older name of the email start and runs the same handler.

**OIDC.** `/login` uses the same `platformOidcConfig` a `platform`-provider product uses (see
[Product OIDC](/docs/services/identity/oidc/)) — the portal and every platform-issuer product
share one IdP client and one trust boundary. The console has its own client (`ADMIN_OIDC_*`),
so operators and customers do not share one. Rate-limited to 20 requests per minute per IP; PKCE,
`state`, and `nonce` follow the same shape as the product flow, with the redirect URI fixed to
`<origin>/callback` rather than a product-scoped path.

**Email code and magic link.** `POST /api/signin/email/start` takes `{ "email": "…",
"turnstileToken"?: "…", "returnTo"?: "…" }`. It opens a flow bound to this browser (a 10-minute
`__Host-pkey_signin` cookie naming a record in the Worker's atomic single-use store) and, when
every limit passes, sends one email carrying a 6-digit code and a link to
`/magic/verify?token=…`. The answer is the same bytes for a known address, an unknown one, a
locked-out or over-limit recipient and a suppressed one; only a deploy that cannot send mail at
all answers `503 email_unavailable`. The limits are I-02's, in the platform scope: 8 starts a
minute and 10 sends an hour per client address, 30 an hour per network, 5 an hour and 20 a day per
recipient. A code lives 10 minutes and dies after 5 wrong attempts; 10 wrong attempts in an hour
lock the recipient out of new codes for 15 minutes, silently. When the deploy sets
`TURNSTILE_SECRET_KEY`, the start verifies a Cloudflare Turnstile token first and fails closed;
`GET /api/capabilities` hands the card the public `turnstileSiteKey`. The answer is
`{ "ok": true, "expiresIn": 600, "codeLength": 6, "resendIn": 60 }`.

**Send a new code.** `POST /api/signin/email/resend` takes no body. It retires this browser's
flow and opens a new one for the same address and `returnTo`, mailing a new code and link under
the same limits and answering the start's bytes whether or not mail went out; the previous code
and link stop working, and of two racing resends (a double click) one mails. It asks for no new
Turnstile token, because the flow passed one, so it is bounded instead: it waits 60 seconds after
the last code (`429 rate_limited` with `retryAfter`), it shares the start's 8 a minute per client
address (also with `retryAfter`), and one flow sends at most 5 emails, its start included
(`429 rate_limited` without `retryAfter`: no more codes for this sign-in, the latest still
works). A browser without a live flow gets `400 signin_expired`, and the card goes back to the
email step. The card's countdown reads `resendIn` from the start's and the resend's answer. A
resend whose send then fails (`503 email_unavailable` from the mail provider) has already retired
the previous code and link, so the person starts again.

The link's landing page consumes nothing, so a mail scanner or a link prefetcher cannot burn it;
its button `POST`s the token back. In the browser that asked, that signs in. Anywhere else the
page says "Confirm sign-in, requested at <time> from <place>", and confirming only marks the
asking browser's flow confirmed: that browser picks it up from `POST /api/signin/flow` and signs
in there. A link opened on another device never signs that device in. A code and the link
complete one flow once.

**The email gate.** A provider front door (Apple, Google and Steam, later the platform
identities and the passthrough) hands its verified identity and the profile the provider sent to
`beginProviderSignIn`. On an identity's first sign-in, while its account has no confirmed email,
or when a product's terms version is not yet accepted, that opens the gate (a 15-minute
`__Host-pkey_gate` cookie) and redirects to the card's step. No account row and no session exist
until it passes, and an app's sign-in request is handed back only with the pass, so no app token
can be issued before it. The email is prefilled from the provider (an Apple private-relay address
included) and can be switched to a typed one. An address the provider vouches for passes
without a code: Apple's verified address (a private-relay one included), or a Google address with
`email_verified: true` that is `@gmail.com` or `@googlemail.com`, or whose domain the token's `hd`
claim names (a Workspace account). A typed address, or a provider address outside that rule, gets
a 6-digit code under the same limits. Steam and other
providers with no email start with an empty field. The confirmed address becomes the account's
primary email and an email sign-in method. When a product requires terms, the gate does not pass
until that version is ticked; acceptances are kept per account, product and version. A new
version asks again and is recorded beside the earlier ones, which are never overwritten; a merge
carries them to the surviving account, and deleting the account or the product erases them.

If the confirmed address belongs to another account, the gate answers `409 email_in_use` and
offers "Join with your existing Polaris Key account". It never joins silently and never by email
match alone: the person proves that account too, in the same browser, by signing in to it with any
of its methods (a fresh session, five minutes), or by the gate's code when the address is an
active email sign-in method there. A new identity is then linked to that account; an identity that
already had its own account is merged into it under the account rules (the email's account
survives, and each product gets `subject.merged`). Declining means choosing a different email.

**Profile import.** The gate shows what the provider sent (Google's name, picture and locale;
Apple's name on first consent; Steam's persona name and avatar) for adjustment. The first
provider fills the account's profile; a value nobody chose follows that provider on later
sign-ins; a name typed in the gate sticks, and so does every choice made in Account → Profile
(below). Pictures are fetched server-side through the Worker's one guarded fetcher, from the
providers' hosts only (https, every redirect hop re-checked, 5 s, at most 2 MiB, PNG, JPEG, WebP
or GIF by their magic numbers). They are then decoded and re-encoded by the Cloudflare Images
binding into WebP and PNG at 256 and 96 px (square, one frame, metadata discarded; the original
is never kept) and stored in R2 under `avatars/<asset>/`, where `<asset>` is a hash of the account
and the picture, peppered with `KEY_HASH_PEPPER` (a plain SHA-256 when a deployment has no
pepper): the same picture is stored once per account, and the id names nobody. They are served same-origin at `/media/avatar/<asset>` (`-96` for the small one; `.webp`
or `.png` to name a format, otherwise `Accept` decides), only when the stored bytes are the type
the name says, with `nosniff` and a sandboxing policy, so the portal's CSP keeps `img-src 'self'`.
Without the Images binding nothing is copied and the account shows initials. A picture nothing
uses any more is deleted at once when it is replaced, and a nightly sweep removes what is left
after a day (a disconnected method's copy, an upload never saved); account deletion removes every
picture the account owns or uses.

After the first sign-in the answer carries `nudge: true` once, for the "add another way to sign
in" card; it comes back after 30 days while the account still has a single sign-in method. The
card's **Add a passkey** row reads `GET /api/me/passkeys` (`canAdd`, below): right after a sign-in
the session is fresh enough to add one at once.

**Passkeys.** A passkey is an account sign-in method on key.plrs.im (the relying party is the
console host, `CONSOLE_ORIGIN`; a ceremony is served only on that origin), platform-level and
independent of any product's Identity toggle. `POST /api/signin/passkey/options` answers WebAuthn
request options for a discoverable credential (no credential list, so the challenge names no
account and the card can offer passkeys in the email field's autofill) with user verification
required, and binds the 32-byte challenge to this browser with a 5-minute `__Host-pkey_passkey`
cookie naming a record in the single-use store. `POST /api/signin/passkey/verify { "response": … }`
takes `PublicKeyCredential.toJSON()` from `navigator.credentials.get`. It consumes the challenge
first, so an answer verifies at most once and a failed try needs a new challenge, then checks the
exact origin (`https://key.plrs.im`), the RP id hash, user presence and verification, the user
handle the passkey was created under, the signature, and the signature counter (one that did not
advance while non-zero is refused as a possible cloned authenticator, and recorded). A passkey
signs in only to the account it was added to and never creates one. Every failure answers the same
`401 unauthorized`; `unknownCredential: true` says only that no account holds that credential id,
so the card can ask the browser to forget it. Both routes share 30 requests a minute per client
address. In app passthrough a passkey sign-in only opens the account session; the app consent
(`Continue to <App>`) still follows the first time.

Passkeys enrol only after the account's email is verified (so a passkey is never its only way
back in), under one random account-level WebAuthn user handle (32 bytes, minted on first use,
never the account id), so an authenticator keeps one "Polaris Key" entry. Each passkey is also a
sign-in method in the account's methods (`kind: passkey`), so the never-orphan guard, step-up,
audit and notices apply to it like any other method.

Every return URL (`returnTo`) must be same-origin and may not target `/manage`, so a magic link,
a provider return or an OIDC return cannot pivot a visitor into the admin console.

**Logout** prefers `POST`, unconditionally accepted. A bare `GET` is tolerated only as a
compatibility bridge for a browser holding a stale bundle, and only when the request is a
genuine same-origin top-level navigation — not a cross-site `<img>` or link. The unconditional
`GET` this replaced was a logout-CSRF: the cookie is `SameSite=Lax`, which is a defense against a
class of cross-site request, not a substitute for a real token
(the R1 audit findings, `R1-03`).

## The session cookie

`__Host-pkey_portal`, `Path=/`, `HttpOnly`, `Secure`, `SameSite=Lax`, 14-day `Max-Age`. Unlike
the product browser-session cookie in [Browser sessions](/docs/services/identity/sessions/), this
one carries the `__Host-` prefix — the only mechanism that stops a sibling subdomain from
planting a `Domain=`-scoped cookie of the same name that a browser would prefer over the real one
(`R1-08`).

The cookie's value is a signed token — a base64url JSON body plus an HMAC-SHA256 signature —
verified on every request. The signing key may, in practice, be the _same_ raw secret the admin
console's session cookie uses (`PORTAL_SESSION_SECRET`, falling back to `ADMIN_SESSION_SECRET`
when unset); what keeps the two realms from being interchangeable is a domain-separation tag mixed
into the signed material before the signature is computed, so a token signed for one realm never
verifies in the other even when the underlying key is shared (`R1-02`).

The token also names a server-side session: a row of `account_sessions`, keyed by the peppered
hash of a random id the token carries. The row is the authority. A cookie is accepted only while
its row exists, is not revoked and has not expired, and belongs to the account the cookie resolves
to (after a merge, the survivor: the merge moved the rows). That is what makes sessions listable
and revocable, and "sign out everywhere" real. A cookie signed before server-side sessions existed
names no row and is refused, so each visitor signs in once after that deploy.

The browser sends a host-only `Path=/` cookie to every path on the host, product routes included.
So the rule "never readable or settable by product routes" is enforced by the dispatcher: a
product route gets the request with the account realm's cookies removed (the session, the sign-in
flow and the gate cookie), and any `Set-Cookie` it returns for them is dropped.

## The portal API surface

Everything under `/api/*` except `capabilities`, `magic/start`, the login card's `signin/*` and
the new device's half of [signing in with another device](#signing-in-with-another-device)
(`device-login/start` and the poll) requires the session cookie (`401 unauthorized` otherwise),
and every mutating method additionally requires the `X-PKey-Portal-CSRF` header to match the
session's CSRF value (`403` otherwise).

- **`GET /api/capabilities?product=<slug>`** — pre-auth. With `product`, answers for that one
  product; without it, answers the platform-wide aggregate (used only by the root login page,
  which has no product context yet). Each is evaluated independently per row rather than folded
  across every tenant, so one product's settings can no longer flip another's (`R5-06`):

  ```json
  {
    "auth": { "oidc": true, "magic": true, "passkey": true },
    "turnstileSiteKey": null,
    "modules": { "licensing": true, "claim": true, "releases": true }
  }
  ```

  `turnstileSiteKey` is the public Cloudflare Turnstile site key the card renders on the email
  start, or `null` when the deploy has Turnstile off. `auth.passkey` is true while the portal is on
  anywhere: passkeys are an account method, never a product's.

- **`GET /api/me`** — account summary (`id`, `name`, `email`, and `avatarUrl`, the picture in
  use as a same-origin URL or `null`) plus the CSRF token, after folding in any newly-provable
  license links.
- **`GET /api/me/profile`** — Account → Profile: the display name and picture, where each came
  from (`{"kind": "provider", "linkId", "provider"}`, `typed`, `upload` or `initials`) and
  whether it was chosen explicitly (`explicitName`, `explicitPicture`), the locale, and
  `sources`, what each sign-in method supplied (its name and picture: the editor's chips and
  tiles). **`PATCH /api/me/profile`** makes explicit choices, which later sign-ins never
  overwrite: `name` (typed) or `nameFrom` (a method's id), and `picture` as `"initials"`,
  `{"from": <method id>}` or `{"upload": <asset>}`. It answers the updated profile. Refusals use registered codes with a `reason` naming
  the case: `400 bad_request` (`invalid_name`, `no_name`, `no_picture`, or a malformed body) and
  `404 not_found` (`unknown_source`, `unknown_upload`).
  **`POST /api/me/profile/picture`** takes the raw bytes of a PNG or JPEG (the bytes decide), at
  most 5 MB, re-encodes them like a provider's picture and answers `201 {"upload": {asset, url,
url96}}`; it does not change the profile until a `PATCH` puts it to use. An unused upload is kept
  for a day, at most three per account. Uploads are limited to 10 an hour per account (`429`);
  other refusals are `413 body_too_large`, `415 bad_request` (`reason: unsupported_type`),
  `422 bad_request` (`reason: unreadable_image`), and `503 unavailable` without the Images
  binding. Both mutations need the CSRF header.
- **`GET /api/sessions`** — the account's live sessions, newest first, each with when it started
  and was last seen, its browser and operating system (`browser`, a coarse label such as
  "Firefox on Windows"), how the person signed in (`methods`) and whether it is this
  browser's (`current`). **`DELETE /api/sessions/<id>`** ends one; **`POST
/api/sessions/sign-out-everywhere`** ends every one, this browser's included, and clears its
  cookie. It also drops every device's binding to the account through Core's clearing hook,
  releasing a seat only where the sign-in itself bound the device.
- **`GET /api/me/passkeys`** — the account's passkeys, oldest first: the credential `id`, its
  sign-in method's `methodId`, when it was added and last used, its `transports`, whether it is
  `synced` across the person's devices, the authenticator's `aaguid` and the browser it was added
  from (`addedFrom`, a coarse label). `canAdd` is false with a `reason` until the account has a
  verified primary email (`email_unverified`) or once it holds 20 passkeys (`limit`).
  **`POST /api/me/passkeys/options`** starts adding one: refused with `403 forbidden` and that
  `reason`, or with `401 step_up_required` without a sign-in in the last 5 minutes; otherwise
  WebAuthn creation options under the account's user handle, the primary email as the user name,
  resident key and user verification required, no attestation, EdDSA, ES256 or RS256, and the
  account's passkeys excluded, with the challenge bound to this session for 5 minutes.
  **`POST /api/me/passkeys { "response": … }`** takes `navigator.credentials.create`'s
  `toJSON()`, consumes the challenge, re-checks the email rule and the step-up, verifies the
  attestation (origin, RP id hash, user presence and verification, an allowed key, any attestation
  statement sent) and stores the passkey and its sign-in method in one batch; a credential id
  another account holds is refused (`409 link_conflict`) and never overwritten.
  **`DELETE /api/me/passkeys/<id>`** removes one under the same step-up; removing the account's
  last way to sign in is refused (`409 last_link`). Adding and removing are audited and emailed
  to every verified address, and share 10 changes a minute per account.
- **`GET /api/me/methods`** — Account → Sign-in methods: every method (`id`, `kind`, `group` of
  `accounts`, `email` or `passkeys`, the connected identity as `display`, when it was connected and
  last used, and `canRemove` with a `reason`: `last_link` for the only method, `only_email` for the
  only address while it is the primary), the addresses and passkeys in their own shapes, Apple,
  Google and Steam always (`providers`, with `connected` and whether this deploy has them),
  `hideMyEmail` for an Apple relay primary address, and `stepUp` (whether this session signed in
  within 5 minutes). No account id or provider subject is in it.
  **`POST /api/me/methods/<kind>/start`** connects one, with a sign-in in the last 5 minutes
  (`401 step_up_required` otherwise). `google`, `apple` and `steam` answer `{redirect}` for the
  browser to open; the provider comes back to its registered sign-in callback, which links the
  identity to this account without signing anyone in (a method another account holds is refused,
  `link_conflict`; the provider's email claim is narrowed exactly as at sign-in, and an address
  another account uses is never stored as verified) and lands on
  `/#/account/methods?connected=<provider>` or `?error=<code>&method=<provider>`. `email` takes
  `{email}` and sends a code, with the same answer whatever the address;
  **`POST /api/me/methods/email/verify {code}`** then connects it (`409 link_conflict` when another
  account uses it, known only once proven), making it the primary email of an account that had
  none. `passkey` answers the passkey registration challenge above.
  **`DELETE /api/me/methods/<id>`** disconnects one under the same step-up; the last method is
  refused (`409 last_link`) and so is the only address while it is the primary (`403 forbidden`,
  `reason: only_email`); removing the primary while another address exists makes the oldest other
  one primary. Every change is audited and emailed to every verified address (an email method is
  named generically, and a removed address is told too); changes share 10 a minute per account.
- **Link an existing account** (`/api/me/link`) — joins two accounts only with proof of both in one
  browser. **`POST /api/me/link/start`** (a sign-in in the last 5 minutes) records this account's
  proof in a 15-minute `__Host-pkey_link` flow; the person signs in to the other account on the
  login card by any of its methods, and **`GET /api/me/link`** then shows both accounts (how each
  was proven, what each holds), the result, and `canJoin` with a `reason` (`sign_in_other`,
  `step_up_required`, `merge_pending`). **`POST /api/me/link/confirm {keep?}`** joins them when both
  proofs are under 5 minutes old and both sessions are live, keeping the account linked in
  (`other`, the default) or the started one; it is refused while either account could still undo
  a join of its own (`403 forbidden`, `reason: merge_pending`), uses up the flow (two racing
  confirms merge once), and is audited and emailed to both with the undo window. An account's
  details show on the join screen only while its proof's session is live; signing out clears the
  flow. **`POST /api/me/link/cancel`** forgets the flow. `GET /api/me/link`
  also lists `undoable` joins, and **`POST /api/me/link/undo {merge}`** (a fresh sign-in to the kept
  account) separates the two again within 72 hours: the joined account's methods still on the kept
  account (one disconnected since stays disconnected), its licences, sessions and the rest go back;
  a licence that goes back revokes the registry tokens the kept account minted on it meanwhile;
  developers keep the alias they were told about, and the joined account gets a fresh pairwise
  subject where its old one became an alias (`404 not_found` once undone or past 72 hours,
  `409 last_link` when an account would be left with no way to sign in).
- **`DELETE /api/me`** — the account holder erases their own account. Deletes every email,
  identity, and license-link row plus the account row itself in one atomic batch, then writes a
  single tombstone audit entry naming only the opaque `acct_…` id — nothing that still identifies
  the person. Rate-limited to 5 attempts on the account's own budget; the notice email is sent
  **before** the delete, because afterward there is no address left to send it to
  (the R11 audit findings, `R11-09`). Licenses themselves are **not** deleted — they
  are the product's records, and the portal account is only a view onto them.
- **`GET /api/licenses`** / **`GET /api/licenses/<product>/<licenseId>`** — every license linked
  to the account, across every product, with visible entitlements folded in; detail adds keys and
  devices. Each license says how it reached the person as `origin`, which the license card words
  as its **License source**: `key` (a key the person added to a license nobody was named for,
  "Key ending …"), `store-key` (a key with an active store purchase, "Steam key ending …"),
  `store` (a store purchase and no key, "From Steam"), `developer` (a license the developer
  assigned to an email, even though it has a key, "From Little Fern"), or `signin` (issued by
  signing in, "From signing in"). `originStore` names the store for the two store origins.
  `removable` says whether **Remove from my library** is offered: only for a license its key can
  bring back (an active license key, on a product that lets a key add a license here).
- **`DELETE /api/licenses/<product>/<licenseId>`** — **Remove from my library**. The license
  leaves the account: it keeps its email, so it waits for an account that verifies that address
  (with no email it floats again, and anyone with the key can add it). An auto-attach block keeps
  it out of _this_ account: no later visit, sign-in or verification adds it back; only adding its
  key again does, and that lifts the block. The account's package tokens for it are revoked; its
  devices keep running and keep their seats, and the ones this account signed in on lose Cloud
  Sync for it. Audited (`account.license.detach`, `account.license.auto_attach_block`).
  Only a `removable` license: any other (a sign-in license, a Discover claim, a keyless store or
  developer license, or any license while the product turns key claims off) answers `409
not_removable` with `reason` `no_active_key` or `key_claim_off`, and nothing is written.
  Ownership first, then 10 per minute in that product's shard; `404` for a license that is not in
  the account and on a product whose portal is off.
- **`GET /api/library`** — the account's library: one entry per product it holds a license for
  (portal-enabled products only), with the product's presentation from its `.pkey/distribution`
  root `listing` (name, developer, tint, website, support links; the product name and nulls
  without one), the status of its best license (`suspended`, `expired`, `device_limit`,
  `expires_soon` within 14 days, `active`, first match wins), that license's seats
  (`deviceLimit` as activation enforces it, `activeSeatCount`, `dormantCount`), how many licenses
  it holds and when it was added. Art is only ever a same-origin `/media/…` URL. `discoverCount`
  is how many offers `GET /api/discover` has, for the Discover count in the nav; a product the
  account already holds is never offered or counted, so it never names one `products` lists.
- **`GET /api/discover`** — the products the account could add for free right now: every product
  whose license policy would auto-issue to it on the product's first sign-in, evaluated by that
  same policy function without issuing anything. A product qualifies through its `oidcDefault`
  auto-issue rule (`reason: "free_with_account"`) or a `groupRoleMap` group the account holds at
  the platform IdP (`reason: "group:<group>"`, from the `groups` claim of the account's last portal
  sign-in). Each offer carries the presentation, the newest release's `platforms`, what the
  account would get (`offer`: `tier`, `tierLabel`, `deviceLimit`, `expiresAt`, `expiryDays`) and
  its `reason`, which is always present. Only products that run License, sign in through the
  platform issuer with auto-linking on, and have the portal on and are not unlisted are
  considered, and none while the deployment's `storefront.polarisKey.enabled` is off;
  purchase-only and operator-issued products, and products the account already holds, never
  appear. An account that has only ever signed in by email link has no platform identity and is
  offered nothing. A group member of a product that also auto-issues sees the group's offer: the
  policy grants the group's tier, and that is what the claim would mint.
- **`POST /api/discover/<product>/claim`** — "Add to library". Re-evaluates the offer and mints
  the license through the sign-in's own auto-issue path, so it has exactly the tier, limits and
  entitlements a first sign-in would give; links it to the account and audits it
  (`portal.discover.claim`, and `license.create` in the product's activity, both with
  `source: discover`). Idempotent per account and product: a repeat or a double submit answers the
  same license with `added: false`. `409 not_eligible` when the product is not, or no longer,
  offered (an unknown product included). Shares the activate preview's rate bucket.
- **`GET /api/products/<product>`** — one of those products: the presentation, `services` (each
  service's own toggle), the status, and every linked license best first with its seats,
  entitlements and authorized devices, each marked `dormant` once it is past the 90-day dormancy
  window (a dormant device holds no seat), and its `purchase`: where it came from (`source` is
  `store` while a verified store purchase is active on it, else `developer`, `sign_in` or
  `free`), the stores, and each store grant with its state and dates. A grant names its flag only
  when the developer shows that flag in the portal; no purchase key is ever returned. The facts
  are License's, read through its `licenseProvenance` descriptor hook, so `purchase` is `null`
  while License is off. The product also carries `returnTo` (`{ origins, schemes }`): where the
  focused flows (`#/p/<product>/free-device` and `#/p/<product>/download`) may send the person
  back to with `?return=` — the product's exact `web.origins`; app schemes are always empty until
  the manifest can declare them, so a scheme return ends on the product page. `404` for a product
  the account holds nothing for.
- **`GET /media/<product>/<asset>`** — public, no session: the product's `icon` or `header` art
  from its listing, fetched by the Worker and served from this origin, because the portal's CSP is
  `img-src 'self' data:`. Only `https` sources on GitHub-hosted names (`github.com`,
  `*.githubusercontent.com`), at most three redirects each re-checked, at most 1 MB (icon) or
  5 MB (header), and only PNG, JPEG, WebP or GIF by their bytes; the answer carries the sniffed
  type, `nosniff` and a `default-src 'none'; sandbox` policy. Every refusal is the same `404`.
  With the URL's current `?v=` the answer is immutable for a year, otherwise cached for five
  minutes.
- **`DELETE /api/licenses/<product>/<licenseId>/devices/<deviceId>`** — disconnect one of the
  account's own devices. Ownership is checked _before_ the rate-limit charge is spent, so a
  caller who owns nothing on that product cannot spend a budget at all, and the budget it does
  spend is scoped to that one product rather than shared platform-wide (`R5-05`).
- **`PATCH /api/licenses/<product>/<licenseId>/devices/<deviceId>`** — rename one of the
  account's own devices: `{ "label": "Studio PC" }`, or `null` / `""` to clear the name. Plain text
  only: at most 64 characters after trimming, no control or format characters (so no
  bidirectional overrides). Ownership first, then 30 per minute in that product's shard; audited
  as `portal.device.rename`.
- **`POST /api/licenses/<product>/<licenseId>/keys`** — "Get a new key". Only for products whose
  operator turned on `keyReissueEnabled` (otherwise `404`, the same answer as a license that is not
  yours; the license detail says which with `canGetNewKey`). The sign-in must be at most 5 minutes
  old, otherwise `401 { "error": "step_up_required", "maxAgeSeconds": 300 }` and the customer signs
  in again. Every active key of the license is revoked and the new one inserted in one batch;
  the response (`201`, `no-store`) carries the raw key once, `{ key, revokedKeys, createdAt }`,
  and it is never readable again. Devices already activated keep working; the old key only stops
  activating new ones. 5 per hour in the product's shard; the account and the license's own email
  get a notice.
- **`POST /api/activate/preview`** — what adding a key would do, before it is added. Takes
  `{ "key": "pkey_…" }`; a string that is not exactly `pkey_<slug>_` plus 22 base64url characters
  is a `422`. Otherwise `200` with a `verdict`:

  | `verdict`        | Also carries                                                                               | Meaning                                                                                                                        |
  | ---------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
  | `addable`        | `license` (tier, label, status, expiry, device limit), `platforms`, `devices`, `cloudSync` | The key can be added. `devices` counts the devices it is already on (they come with it); `cloudSync` says the product runs it. |
  | `already_yours`  | the same, plus `license.id`                                                                | Already in this account.                                                                                                       |
  | `license_owned`  | nothing else                                                                               | In another account; a license never moves by its key (named `owned_elsewhere` until I-05).                                     |
  | `email_mismatch` | `maskedEmail` (`m•••@proton.me`)                                                           | Carries an email this account has not verified, and the product needs it.                                                      |
  | `portal_off`     | nothing else                                                                               | The product manages this license elsewhere (portal or key claim switched off).                                                 |
  | `unknown`        | nothing else                                                                               | No such key (or it was replaced), or no such product.                                                                          |

  Every answer carries `product` (`null` for `unknown`, so a guessed key never reveals whether a
  product exists; otherwise `slug`, `name`, `branding`; `developerName`, `iconUrl` and
  `headerUrl` are reserved for the library presentation) and `keyEntries`: the license's
  [key entries](/docs/services/license/activation/#key-entries-identity-products)
  `{ used, limit }` for `addable` and `already_yours` on a product with Identity on, else `null`.
  Nothing is written, so previewing never counts. A refusal never names the other account or the
  license.

- **`POST /api/key/preview`** — the same question asked **signed out**, for the login card's
  "Have a license key?" (SIGN-IN.md §3.9; WIRE-CONTRACT-V4 §12.2 rule 8). Takes
  `{ "key": "pkey_…" }` with no session and no CSRF header, and answers
  `{ product, verdict, license, keyEntries, upgrade }`:
  - `verdict` is `addable`, `license_owned` (the license is in an account; never whose) or
    `portal_off`. `email_mismatch` stays a signed-in verdict.
  - `license` is `{ tierName, term }` (`term` is `perpetual` or the end in epoch seconds), `null`
    on `portal_off`.
  - `keyEntries` is `{ used, limit }` on a product with Identity on, else `null`.
  - `upgrade` is `forced` exactly when a new device would be refused `key_entry_limit` (an
    addable, usable license at its limit, with the platform's key-entry refusals on), else
    `skippable`: the card then shows no **Continue without an account**.

  It never answers an email, a masked email, a license id, devices or an account, and it writes
  nothing. `422` for a string that is not a license key, `401` for an unknown key, and `429` past
  10 previews per minute per client network (charged before any lookup).

- **`POST /api/claim/license-key`** — link a license by presenting a typed `pkey_…` key. It acts
  on the same evaluation as the preview, so the two never disagree: `401` for an unknown key,
  `404` when the product's portal or key claim is off, `403 license_owned` (a `409 owned_elsewhere` until I-05), and
  `403 email_mismatch` with `maskedEmail`; a license already yours answers `200` without writing or
  emailing again. A new link emails the account and, when it is a different address, the
  license's own email. The preview and the claim share one budget: 10 per minute per account. On
  a product with Identity on, a new link records one `portal` key entry (never for a license
  already yours, never refused at the limit: adding the key to an account is the way past it), and
  the answer carries `keyEntries`.
- **`GET /api/releases`** and **`POST /api/releases/<product>/<releaseId>/artifacts/<artifactId>/token`**
  — the downloads surface, gated by _three_ independent things at once: the portal's own
  `releasesEnabled` toggle, whether the product runs the Release service at all
  (`services_json`), and — for a `licensed`-access artifact — whether the account holds a usable
  license for that product. Minting a token is refused up front when nothing can hand a browser
  the bytes, so nothing is ever minted that could only fail later: a `public` file redirects to
  Distribution's bytes host, which serves every location (R2, and GitHub through the Release
  installation token, so a private repository's files too); any other file to its stored
  GitHub-storage URL, and only when the repository is public (a private one answers an
  anonymous browser with 404), or, when it has no GitHub-storage URL, to the bytes host with a
  short-lived download ticket (below) when the deployment has tickets configured and the file a
  recorded SHA-256. An account with no linked license for the product gets the same `404` for
  every refusal; an owner is told why: `404 file_not_found` (the release or file is gone),
  `403 license_inactive` or `403 not_entitled`, and `409 not_hosted` (nothing here serves it
  yet), the same reasons the downloads view gives per file. Path segments are percent-decoded
  once, so an id such as `file:App-1.0.dmg` matches whether or not the client encoded it. The
  listing itself omits `signature` and `checksum` artifacts (`.sig` and `.sha256` sidecars): they
  are verification material, not downloads. As shipped, a download therefore needs a signed-in
  account **and** a license for the product linked to it (a usable one for `licensed` access);
  there is no anonymous path, and the redirect target is always the bytes host or a
  GitHub-storage host.
- **`GET /api/products/<product>/downloads[?channel=<channel>]`** — one product's downloads and
  store links, shaped for the product page's "Get it" section. Answered only for an account with
  a license for the product linked to it, behind the same three gates as `GET /api/releases`
  (every refusal is `404`), and rate-limited per account in the product's own shard. It returns
  the visitor's `detected` platform (from the User-Agent and the low-entropy client hints only),
  the `recommended` files for that platform, every platform's files in its newest release, the
  platform-free `extras`, and every store outlet (`kind`, `platforms`, `label`, `url`,
  `deepLink`, `command`, `activateUrl`, `live`, `version`; `activateUrl` is Steam's key-activation
  page, for a held Steam key). A universal build is recommended alone and flagged `universal`; otherwise
  every arch is, Apple silicon first on a Mac and the detected arch first when the browser said.
  Each file carries `canDownload` and, when false, a `reason`: `license_inactive` (no usable
  license), `not_entitled` (the license's channels or update window do not reach the release) or
  `not_hosted` (covered, but nothing here can hand the bytes to a browser: no bytes-host copy
  and no GitHub storage URL in a public repository, or a licensed file on a deployment without
  download tickets or with no recorded SHA-256). When the newest release is not
  covered, the recommendation falls back to the newest one that is (`latest: false`). The
  product facts come from Distribution's `customerDownloads` hook, read through Core; whether the
  account may download is the same decision the token mint makes, so every file marked
  `canDownload` is one the mint answers. A product with Distribution off answers
  `available: false` with empty lists; `?channel=` names another channel (default `stable`).
- **`GET /download/<token>`** — redeems a minted token. Every one of those checks is run again
  here, at redemption, not assumed to still hold from mint time — portal enabled, releases
  enabled, account active, license still linked, licensed access still held — and the token is
  spent with a single conditional `UPDATE … WHERE used_at IS NULL`, so two concurrent redemptions
  of the same token cannot both win; exactly one sees the row change. The redirect goes, for a
  `public` file, to its bytes-host URL, otherwise to the artifact's GitHub storage URL when the
  repository is public. Any other non-public file
  (held on R2, or in a private repository the bytes host streams) goes to its canonical bytes-host URL with a **download ticket** appended
  (`https://dl.plrs.im/<product>/distribution/files/<releaseId>/<name>?ticket=…`): minted only
  here, after every check, bound to that one file by name and SHA-256, valid for 120 seconds and
  reusable inside them, so `Range`, resume and `HEAD` work. The bytes host accepts it in place of
  a device token and still serves the file as a private, sandboxed attachment; an invalid or
  expired ticket gets the same answer as no credential. Device trust policy does not apply to a
  portal download (a browser cannot attest), so a product that enforces attested delivery is
  served here exactly as its GitHub-hosted files are. Tickets need the Worker secret
  `DOWNLOAD_TICKET_KEY`; without it such files read `not_hosted` and nothing is minted. See
  the R6 audit findings' `R6-12` for the redirect allowlist, and
  the R9 audit findings' `R9-05b` (the redemption used to be read-then-write, not
  compare-and-swap) for the atomic single-use fix.
- **`POST /api/products/<product>/email-download`** — `{ "platform": "macos" }` (one of
  `macos`, `ios`, `android`, `windows`, `linux`, `web`). Emails the account's own address a link
  to that product's download for that platform, so someone browsing on a phone can pick it up on
  their computer. The link is the signed-in app's `#/p/<product>/download?platform=…` route, never
  a download token, so a forwarded email opens a sign-in and nothing more. It needs a license for
  the product linked to the account, portal release downloads on and the Release service on
  (otherwise `404`, the same answer as an unknown product). It answers `422` for an unknown
  platform, `503 email_unavailable` without an `EMAIL` binding, and `202` when sent. Limited
  to 5 an hour per account and product; the bucket fails closed.

## Signing in with another device

A device that is not signed in can be signed in by approving it from one that is (PX-W14):

| Route                            | Who                    | What it does                                                    |
| -------------------------------- | ---------------------- | --------------------------------------------------------------- |
| `POST /api/device-login/start`   | the new device         | Creates a request: a code, a QR code and a poll handle.         |
| `GET /api/device-login/<id>`     | the new device         | Polls; once approved, the answer signs this browser in.         |
| `POST /api/device-login/lookup`  | the signed-in approver | Shows what is asking (`{ code }`), before deciding. Reads only. |
| `POST /api/device-login/approve` | the signed-in approver | `{ code, decision: "approve" \| "deny" }`: the decision.        |

**Start.** Answers `201` with `id` (the poll handle, never shown), `code` (8 letters, `WDJB-MJHT`,
from RFC 8628's consonant alphabet, case and hyphens ignored on input), `qr` (an SVG `data:` URI
of `approveUrl`, the signed-in app's `#/account/approve?code=`), `expiresIn` (300) and `interval`
(3). It records the asking browser and OS (from the User-Agent, "Chrome on macOS") and its coarse
place from Cloudflare's edge geolocation (city, region, country), and sets an `HttpOnly`,
`SameSite=Strict` cookie, `__Host-pkey_device_login`, that binds the request to this browser. 10
starts per client network per 10 minutes; `404 auth_method_disabled` while the portal is off.

**Poll.** Needs the binding cookie; without it, with the wrong one, for an unknown or expired
request, or after the answer was already given, it is `410 expired`. Otherwise `pending` (with
`expiresIn` and `interval`), `denied`, or `approved` with the session cookie set. The answer to a
decision is taken in one atomic step, so exactly one poll is signed in.

**Lookup and approve.** Both need the session and the CSRF header and share 10 calls a minute per
account, which bounds guessing at codes. `lookup` returns the device, its place, when it asked,
the time left, the approver's own country, `newLocation` and `stepUpRequired`. `approve` takes an
explicit `decision`; anything else is a `422`, so nothing approves a request by default.
Approving a request from another country than the approver's, or from an unknown place, needs a
sign-in no older than 5 minutes, otherwise `401 { "error": "step_up_required", "maxAgeSeconds":
300 }` and the code stays live (the refusal is audited, `portal.device_login.step_up_required`).
An approval is not a sign-in: the new device's session carries the approver's sign-in time, so it
is never fresh enough for a step-up (approving another device elsewhere, changing sign-in
methods, getting a new key) until its holder signs in on it. A decision spends the code atomically (two racing approvals: one
lands, the other is `410`), is audited (`portal.device_login.approve` or `.deny`, and
`portal.login.device` when the new device signs in), and an approval sends the "A new device
signed in" notice to every verified address.

Requests and codes live in the Worker's atomic single-use store for 5 minutes.

## The Activate license link

`https://key.plrs.im/activate` opens the Library with the Activate license modal. The key, when
the link carries one, goes in the **fragment**:

```text
https://key.plrs.im/activate#key=pkey_mossgarden_Q7xZr2Lk9vT3mN8pB1cY4w
https://key.plrs.im/activate?product=mossgarden#key=pkey_mossgarden_Q7xZr2Lk9vT3mN8pB1cY4w
```

A browser never sends a fragment to a server, so the key is in no request, no Worker or edge log
and no `Referer`. Never write the key as a query parameter (`?key=`): a query is part of every
request log that records a URL. `product=` is optional context ("Mossgarden sent you here"), and a
link with no key opens the modal with an empty field. The Worker never builds a link with a key in
it (`manageUrl` on a refusal carries none); the SDKs' manage-link helpers (client-core's
`withManageKey` and its ports) add `#key=`, and only to an `/activate` link.

The page reads the key, then removes the fragment from the address bar and the history entry with
`history.replaceState` before it does anything else. Signed out, the login card runs first and the
modal opens after sign-in; the key stays in the tab and is left out of every sign-in's return URL.

A refusal's `manageUrl` and the SDK helpers may add more to the query. The portal keeps these and
drops anything else:

| Parameter          | What it does                                                                                                                                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `product=<slug>`   | Names the app that sent the person, with why: by default its key-entry refusal ("This key has no entries left in Mossgarden…").                                                                               |
| `next=free-device` | After the key is added (or if it is already in the library), opens the free-device flow for that license. The Worker sends it on `device_limit` for a floating license.                                       |
| `for=<label>`      | The device the free-device flow makes room for (at most 64 characters).                                                                                                                                       |
| `return=<url>`     | Where to go after the add: the login card on this origin (`/signin?request=…`), or an origin or app scheme the product declares (Done then offers **Back to Mossgarden**). Any other value is never followed. |

None of these may carry the key: a `for=` or `return=` that holds one is dropped.

**Links already sent.** The first version of the link was `/activate?key=…`. The portal still
reads it, and drops the query the same way. The Worker answers that request with the ordinary,
uncached portal page (`Referrer-Policy: no-referrer`); it does not redirect, which could not unlog
the request and would only send the key back in a `Location` header, and it fetches the page
without the query, so the key goes no further. That one request is still in the platform's
request logs; see the threat model's "Key-bearing deep links" for the residuals.

## Emails

Every email is from **Polaris Key** (`PORTAL_EMAIL_FROM`, default `Polaris Key <noreply@plrs.im>`)
and calls the service "Polaris Key", never "the portal". It names the product and the device by
their names, not their slugs or ids, and links to the exact section of the signed-in app:

| Email                 | Subject (example)                                  | Links to                           | Goes to                |
| --------------------- | -------------------------------------------------- | ---------------------------------- | ---------------------- |
| Sign-in code and link | Your Polaris Key code: 123456                      | `/magic/verify?token=…`            | the address typed      |
| Email confirmation    | Confirm your email for Polaris Key                 | nothing (a code only)              | the address confirmed  |
| License added by key  | Mossgarden is in your library                      | `#/p/<product>`                    | the session's address  |
| Download link         | Download Mossgarden for macOS                      | `#/p/<product>/download?platform=` | the account's address  |
| Device removed        | Studio PC was removed from Tidewater Studio        | `#/p/<product>/devices`            | every verified address |
| New device signed in  | A new device signed in to your Polaris Key account | `#/account/sessions`               | every verified address |
| Account deleted       | Your Polaris Key account has been deleted          | nothing                            | every verified address |

The security notices (a device removed, and the sign-in method and new-device templates the
identity-linking work sends) carry "Wasn't you? Secure your account" and go to **every verified
email on the account**, one message per address. No link but the sign-in link carries a token.
Each message has a plain-text part and a branded HTML part (table layout, inline colours, a dark
palette for clients that honour `prefers-color-scheme`).

## Per-product portal settings

`portal_product_settings`, edited at `GET`/`PATCH /manage/api/products/<slug>/identity/portal`.
Five plain booleans, all defaulting **on** for a product that has never written a settings row:
`portalEnabled`, `oidcEnabled`, `magicEnabled`, `licenseKeyClaimEnabled`, `releasesEnabled`.

Two more default **off** (PX-W5, migration `0064`):

- `keyReissueEnabled` — customers may replace a license's key from the portal ("Get a new key").
- `claimByKey` — a license that carries an email may be added by anyone holding its key. Off is
  the S-16 safety default: such a license joins only an account that verified that email. A
  license already in an account never moves by its key either way.

`discoverEnabled` defaults **on** (PX-W10, migration `0071`): the product may be offered on
Discover to accounts its auto-issue policy covers. Turning it off hides the offer without
changing the policy, which keeps issuing on the product's own sign-in.

`autoLinkEnabled` is **tri-state**, not boolean — `true`/`false` is an explicit operator
override; `null` ("auto") derives from the product's _own_ OIDC provider: on for a
`platform`-issuer product, **off** for a `custom`-issuer one. A tenant-controlled IdP's `email`
and `sub` claims are outside the platform's trust boundary, so a tenant that stands up its own
IdP is opted out of auto-linking automatically, by the same default rule, rather than by an
operator remembering to flip a switch.

This is what decides whether a _verified_ email or OIDC subject may silently fold a product's
license into the account requesting it — verified in two senses at once: only email addresses
the portal itself proved (a magic link it sent, or an `email_verified: true` claim from the
**platform** issuer specifically) can drive a link at all, and only a platform-issuer subject may
match a license's `sub`, so subjects minted by mutually untrusted custom IdPs can never collide
across products (the R5 audit findings, `R5-01` and `R5-02`).

A portal account's OIDC identities are keyed by the issuer that minted the subject (the
configured platform issuer URL, without a trailing slash), not by a provider kind, so a second issuer's subjects can never
land in the platform issuer's namespace. Rows written before migration `0059` carried the literal
`oidc`; the Worker re-keys them to the platform issuer at the next portal OIDC sign-in. The
migration still accepts that literal on insert, so a Worker version from before it (still serving
mid-deploy, or rolled back to) keeps signing new users in; those rows are re-keyed the same way.

**In the console**, these settings are **Identity → Portal**. The sign-in methods and modules
are read-only while the portal switch is off, and **Release downloads** is read-only while the
product's Release service is off. The page saves the five switches and the linking choice in one
`PATCH`; it never sends `branding`, which it shows as a read-out. **Offer on Discover** (the Discover section) saves
with them.

### Polaris Key listing

Four more fields hold the product's listing in the Polaris Key library (PS-02, migration `0085`).
They are the settings `storefront.polarisKey.listed`, `.audience`, `.offerPaths` and
`.groupLabels`, all operator-owned (no manifest field sets them):

| Field              | Values                                                                                                      | Default    |
| ------------------ | ----------------------------------------------------------------------------------------------------------- | ---------- |
| `storeListed`      | `auto`, `listed`, `unlisted`                                                                                | `auto`     |
| `storeAudience`    | `eligible`, `everyone`                                                                                      | `eligible` |
| `storeOfferPaths`  | `null` (every way) or a list of `group`, `auto_issue`, `open`, `store_owned`, `product_idp`, `email_domain` | `null`     |
| `storeGroupLabels` | an object of group name to label (at most 40 characters, at most 100 groups)                                | `{}`       |

- **`auto`** is today's Discover: the product is offered where auto-issue or a mapped group would
  give it to the person. **`unlisted`** hides it in the portal while every policy, sign-in and
  auto-issue keeps working. **`listed`** lets the other ways to obtain the product list it as well,
  as those ways are built. The first besides the two above is **`open`**: License is off for the
  product and every download is `public` or `authenticated`, so there is nothing to license. The
  storefront evaluates it now; Discover lists and adds it once the storefront's portal API ships
  (until then Discover shows the auto-issue and group offers only).
- **`storeOfferPaths`** narrows which ways count, in `auto` as in `listed`; Discover's claim
  follows it, so a way that is not offered cannot be added.
- **The deployment switch** `storefront.polarisKey.enabled` (platform scope, on by default) hides
  every listing on the deployment when off; licenses, sign-in and auto-issue keep working. A stored
  value other than `on` reads as off (a cleared value is the default, on).
- **`discoverEnabled`** and `storeListed` stay in step: `discoverEnabled: false` reads as
  `unlisted`, setting `storeListed` sets `discoverEnabled` to match, and turning Discover back on
  returns an `unlisted` product to `auto`. Products that had Discover off were moved to
  `unlisted` by the migration.
- **Widening the audience to `everyone`** shows the product to every signed-in person, the one
  exception to never revealing a product a person cannot get. The `PATCH` needs
  `"confirm": "storefront.polarisKey.audience"`, or it answers `400` with
  `reason: "confirm_required"`.
- **A change to any of the four** writes a `storefront.polarisKey.update` activity row naming what
  changed, beside `portal.settings.update`.
- **In the console** they are edited on Distribution → Storefronts →
  [Polaris Key](/docs/admin/polaris-key-storefront/), which also shows the readiness checklist,
  who sees the product, a persona preview and the storefront's analytics.

## Supported browsers

The portal's UI is built on Tailwind CSS v4, whose generated styles rely on modern CSS
(cascade layers, `@property`, `color-mix()`). The floor is **Safari 16.4+, Chrome 111+ (and
Chromium-based Edge 111+), and Firefox 128+**. An older browser still reaches every route, but
the page renders largely unstyled. Point a customer on an older browser at an update before
debugging anything else.

## See also

- [Product OIDC](/docs/services/identity/oidc/) — the platform provider `/login` shares, and how
  a `custom` per-product provider sits outside auto-linking entirely.
- [Browser sessions](/docs/services/identity/sessions/) — the product-scoped session cookie this
  page's cookie is deliberately not the same as.
- the R5 audit findings — the full cross-tenant linking analysis this page's
  auto-link section summarizes, plus `R5-05`/`R5-06` (rate-limit and capability scoping).
- the R1 audit findings — `R1-02`/`R1-03`/`R1-08`, the session-cookie and
  logout hardening.
- the R9 audit findings and the R6 audit findings — `R9-05b` and `R6-12`, the
  download-token redemption and redirect allowlist.
- the R11 audit findings — `R11-09` (account erasure) and `R11-05` (download-token
  retention).
- [Public route table](/docs/reference/routes/) — every _product-scoped_ wire route. The
  portal's root-level paths on this page are not part of that table; they are platform routes,
  not per-product API surface.
