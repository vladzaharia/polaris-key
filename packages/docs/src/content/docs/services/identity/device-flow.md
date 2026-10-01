---
title: "The device-code flow"
description: "Sign-in for a client that cannot receive a browser redirect: the device-code start route, the RFC 8628 user-code page, and the poll."
sidebar:
  order: 3
---

The browser PKCE flow in [Product OIDC](/docs/services/identity/oidc/) assumes the caller can
receive a redirect — either directly, or by capturing one from a loopback. The device-code flow
is for the client that cannot: a CLI running over SSH, inside a container, a game on a TV or a
console, or any other environment with no browser of its own. It shows the human a short code, a
short URL and a QR code; the human opens the URL on _any_ other device (usually a phone), types or
scans the code, and completes sign-in there, and the original client polls until a credential is
ready.

Four routes, all under `/<product>/identity/auth/device`, sharing the same PKCE machinery
[Product OIDC](/docs/services/identity/oidc/) describes — the same `state`/`nonce`/PKCE flow
record, the same token exchange, the same ID-token verification. What is specific to this flow is
the human-confirmation step in the middle and the polling contract around it. The public shape —
a secret device code, an independent human-readable user code, a verification URL, and a poll —
is the OAuth device-authorization grant (RFC 8628), spelled in camelCase.

## `POST /identity/auth/device/start`

Begins the flow. The caller supplies a device id — from a JSON body field `deviceId`, the
`X-PKey-Device` header, or a `device` query parameter, checked in that order — and an optional
`deviceName`, trimmed and capped at 120 characters for display on the confirmation page.
Rate-limited to 60 requests per minute per IP.

The response:

```json
{
  "status": "pending",
  "deviceCode": "…",
  "userCode": "WDJB-MJHT",
  "verificationUri": "https://…/<product>/identity/auth/device",
  "verificationUriComplete": "https://…/<product>/identity/auth/device?user_code=WDJB-MJHT",
  "expiresIn": 600,
  "interval": 2,
  "pollUrl": "https://…/<product>/identity/auth/device/poll"
}
```

`deviceCode` is the bearer handle the client polls with — treat it like a credential, and never
show it. `userCode` is for the human: eight characters from RFC 8628 §6.1's consonant alphabet
`BCDFGHJKLMNPQRSTVWXZ` (no vowels, so no accidental words; no digits, so no `0`/`O` or `1`/`I`),
hyphenated after the fourth, and generated **independently** of `deviceCode` — knowing one tells
you nothing about the other.

What a client does with the response:

- Show `userCode` large.
- Render `verificationUriComplete` as a QR code, and open it (or offer it as the link) where the
  platform can open a browser. It is the entry page with the code filled in, so a scan skips the
  typing.
- Show `verificationUri` as the short URL to type on a phone. It is the entry page alone.
- Poll `pollUrl` at `interval` (below).

A client that opens `verificationUri` rather than `verificationUriComplete` still works, but the
human has to type the code (RFC 8628 §3.3.1). Neither URL contains the device code.

## `GET`/`POST /identity/auth/device`

The user-code page — what `verificationUri` and `verificationUriComplete` point at.

**`GET` without `user_code`** renders the entry form: one text field, posted back to the same
URL.

**`GET` with `?user_code=`** (the QR-code path), or a **`POST` of the entry form**, looks the code
up and renders the confirmation page: the product, the device label (the `deviceName` given at
start, else "Unnamed device" — never the device id) and the user code, with one button. Input is forgiving — case does not
matter, and spaces and hyphens are ignored, so `wdjb mjht` finds `WDJB-MJHT` — but anything
outside the alphabet, or not eight characters, is simply not a code. Rendering mints a fresh
single-use CSRF token into the stored record and changes nothing else about the flow. The
confirmation form posts `user_code` and `csrf` back to this route; the device code never appears
in the URL, the page or the form.

**`POST` with `csrf`** confirms, and only when three things hold: the request must not be
cross-site; the posted CSRF token must match the one the render minted; and that token is
deleted immediately after, so it cannot be replayed. "Not cross-site" is decided by
`Sec-Fetch-Site` when the browser sends it (only `same-origin` passes); without it, an `Origin`
header naming another origin is refused, while an absent `Origin` or `Origin: null` passes to the
token check — `null` is what a browser sends on a same-origin form POST from a page served with
`Referrer-Policy: no-referrer`, as this one is. On success it stamps `confirmedAt` on the flow —
which is what the poll below requires before it will ever return a token — deletes the user-code
index, so the code stops resolving here, and answers with a `303` redirect straight to the IdP's
authorize URL, carrying `Referrer-Policy: no-referrer` and `Cache-Control: no-store` so the
`state`/`nonce` in that URL never leak through a Referer header or a shared cache. A cross-site
request, and an empty, wrong or reused token, all get the same `403`. The same check applies to
the entry form's `POST`.

An unknown, expired, malformed or already-confirmed code re-renders the entry form with one
generic line — "That code is not valid or has expired." — and status `404`. The page never says which, so a guesser learns
nothing from the difference. Every page here is script-free HTML under the static-page security
headers, `Cache-Control: no-store` and `Referrer-Policy: no-referrer`; the confirmation page's
`form-action` also allows the IdP's origin, because a browser applies `form-action` to the
redirect the confirmation `POST` answers with.

## `GET`/`POST /identity/auth/device/verify`

The same confirmation page, addressed by the device code instead:
`/identity/auth/device/verify?device_code=…`. `/device/start` no longer hands this URL out; it
stays, unchanged, for flows that were in flight when the user-code page shipped and for any client
that builds the URL itself. **`GET`** renders the confirmation page (and mints the CSRF token);
**`POST`** confirms, under exactly the rules above. Because its URL carries the device code, a new
client should not use it.

From here the human completes sign-in exactly as in the browser flow, landing on
`/identity/auth/callback` — see [Product OIDC](/docs/services/identity/oidc/) for what that
route does. Because this flow never carries a `return_to`, the callback does not set a session
cookie. It does not activate anything either: it checks that the identity would be entitled
(answering the browser `403` at once if not), stores the verified identity on the flow record and
stops. The poll below activates it.

By default that activation is exactly what an ordinary sign-in for the signing-in identity gets:
its own license, or a new one under the product's group mapping or `oidcDefault` tier. Nothing
claims, migrates or disables the license the polling device is already on. That includes an
anonymous enrolled license, which stays anonymous and active. The reason is that the user code is
public, so whoever confirms the flow need not be the device's owner. Merging the device's license
at the callback let a user-code holder take it over. When the device redeems the flow, the device
moves onto the signed-in identity's license.

Attaching the device's anonymous license to the account is an explicit opt-in that only the
device can make, after the player has seen the signed-in identity on the device and accepted it.
See "Attaching the device's anonymous license" below.

:::caution[Why the split matters]
This page used to be a single `GET` that accepted `?confirm=1` and completed the flow right
there — which meant an `<img src>` or a link preview could confirm a sign-in with no user
interaction at all, and the redirect it produced disclosed `state` and `nonce` directly to
whoever triggered it. Making `GET` pure rendering and requiring an explicit, origin-checked,
CSRF-bearing `POST` for the mutation is the fix (`docs/security/findings/R8-oidc.md`, finding
`R8-02`).
:::

:::caution[What confirmation does not protect]
The origin check and the CSRF token stop a cross-site page from confirming _someone else's_ flow.
They do not stop a flow's own starter: anyone can start a flow, open this page for their own user
code, read the token and post it back — no browser needed, since a request with no `Origin` passes
— and be handed the IdP authorize URL. Sent to a victim who signs in there, that URL binds the
victim's license to the starter's device, and the victim never sees this page. This is an open
residual (`R1-07`, rooted in `R8-03`: the IdP callback is not bound to the browser that
confirmed), written up in the security threat model under "Remote phishing".
:::

## `POST /identity/auth/device/poll`

The client's half of the exchange. Body: `{ "deviceCode": "…", "deviceId": "…" }` (the field may
also be spelled `state` for a raw flow state, but a caller that started at `/device/start` always
has `deviceCode`). The `deviceId` must equal the one `/device/start` was called with, or the
response is `401 unauthorized` — a stolen or guessed device code cannot be redeemed by a
different device identity than the one that opened the flow.

The advertised `interval` (2 seconds) is enforced server-side, not merely suggested: a second
poll inside that window gets `429` with `{ "status": "slow_down", "interval": 2 }` rather than
being served. Before confirmation, the answer is `{ "status": "pending" }`. Once the human has
confirmed _and_ the OIDC callback has completed, the response becomes:

```json
{
  "status": "ready",
  "token": "pkeyt_…",
  "schemaVersion": 1,
  "identity": { "name": "Ada", "email": "ada@example.com" }
}
```

— a per-device bearer token, not a session cookie; this flow never produces one. `identity` names
who the device is now signed in as (`email` only when the IdP verified it). A client should show
it: if someone else confirmed the flow with the user code and signed in as themselves, this is
where the player sees that the device is now on a stranger's account. The underlying
flow record is deleted the moment a poll returns `ready` or `timeout`, so a token is only ever
handed out once. An IdP failure or a stale/expired code answers `{ "status": "error" }` or
`{ "status": "timeout" }` — the same generic shapes throughout this service, deliberately: a
poller must not be able to learn _why_ a flow failed, only that it did.

Minting the token at `ready` runs through the same seat-authorization step activation and the
browser session both use — the same device can only hold one seat's worth of authorization
regardless of which of the three paths it came through, because all three bind to one shared
computation rather than three copies of it.

## Attaching the device's anonymous license

A device that enrolled anonymously already holds a license of its own. A player who now signs in
may want that license (its devices, its overrides) to become their account's, rather than leaving
it behind. The poll offers this as a two-step opt-in, and only to the party holding the device
code:

1. While polling, the device sends `"confirmIdentity": true` and its current device token as
   `Authorization: Bearer pkeyt_…`. Once the player has signed in, the answer is not `ready` but:

   ```json
   {
     "status": "confirm",
     "identity": { "name": "Ada", "email": "ada@example.com" },
     "attachable": true
   }
   ```

   Nothing has been minted or merged. `attachable` says whether the bearer is a live token of the
   device the flow was started for, on an anonymous (`origin = enroll`, no subject), usable
   enrolled license. It is also `false` if the attach would take the identity's license past its
   device limit, counting every authorized device on the anonymous license (including devices
   not seen for months, which come along too) plus, when the identity already has a license, that
   license's seat-holding devices. The limit is the one the license will have after sign-in
   rewrites it onto the identity's mapped tier and provisioned overrides, not the tier it is on
   now. It is always
   `false` when the identity's tier has fingerprint mode `strict`: a device-code poll presents no
   fingerprint, so the mint would be refused, and the attach is never committed for a mint that
   cannot succeed.

2. The device shows the identity. After the player accepts it **on the device**, the next poll
   sends `"attachLicense": true` with the same bearer (or `false` to sign in without attaching).
   With `true`, an identity that has no license yet takes the anonymous license over in place
   (`"attached": "claimed"`, with every device already on it); an identity that already has a
   usable license gets every device on the anonymous license moved onto it and the anonymous
   license retired (`"attached": "migrated"`). Then `ready` as usual.

A decision sent before the device was shown the identity, or `attachLicense: true` with nothing
attachable, is answered with `confirm` again and changes nothing. The decision poll counts
against the `interval` like any other. A user-code holder cannot reach any of this: the only
surface that completes a device-code flow is this one, and it needs the device code.

The device-code holder is whoever started the flow, so the decision is only as good as the
binding between the device and the person who signed in. Until the browser that confirms a flow
is bound to its callback (the open R1-07), a starter who phishes the authorize URL to someone
else also makes this decision for them; see "Remote phishing" in `docs/security/THREAT-MODEL.md`.

## Lifetime and rate limits

A device code lives for 600 seconds (10 minutes) from `/device/start`, matching the `expiresIn`
it advertises — after that, every surface below answers `{ "status": "timeout" }` rather than
resurrecting it. All three routes are rate-limited per client IP, and the two polling-adjacent
ones carry a _second_ budget keyed on the device code itself, so a single flow cannot be hammered
from a botnet even if the per-IP budget is spread across many addresses:

| Route                       | Per-IP budget | Per-flow budget |
| --------------------------- | ------------- | --------------- |
| `POST /device/start`        | 60 / 60s      | —               |
| `GET`/`POST /device`        | 30 / 60s ¹    | —               |
| `GET`/`POST /device/verify` | 60 / 60s      | —               |
| `POST /device/poll`         | 120 / 60s     | 40 / 60s        |

¹ Per client _network_ rather than per address: an IPv4 address, or an IPv6 /64. One IPv6 host
is routed a whole /64, so a per-address budget on the one route that guards a guessable code
would be free to rotate around. The other routes still key on the full address.

The user code carries its own index for the same 600 seconds, and it is deleted with the flow
when a poll returns `ready` or `timeout`. There is deliberately no product-wide budget on the
user-code page: one attacker could exhaust it and lock every player out of sign-in. The
per-network budget (30 guesses a minute per IPv4 address or IPv6 /64) slows a single host, but
an attacker with many networks — an IPv6 /48, a botnet — is limited only by the product's one
rate-limit object. What actually bounds blind guessing is the code space — 20⁸ ≈ 2.6 × 10¹⁰
codes — against a 600-second lifetime. A guess that lands can only confirm someone else's flow
and sign it in to the guesser's own account, which pulls a stranger's device onto the guesser's
own license. It never yields a device token, and it never touches the license that device was
already on. The security threat model works the numbers.

Every one of these is a refusal, `429 rate_limited` (or, for the poll interval specifically,
`429 slow_down`) — never a silent drop, so a well-behaved client can tell "back off" from "the
network ate my request."

## Where this flow is used

Use it wherever a client cannot receive a browser redirect at all — a headless CLI, a build
agent, a device with no embedded or system browser reachable from the process doing the polling.
A device-code flow completes only on `/identity/auth/device/poll`, with the device code: the
`state`-keyed `/identity/auth/poll` in [Product OIDC](/docs/services/identity/oidc/) refuses it,
because the user code is public by design and the confirmation page hands its holder the
authorize URL, which carries `state`. What a user-code holder can and cannot do is set out in
the security threat model.

### From an SDK

The Node, Python and Swift SDKs drive this flow for you: `client.identity.beginSignIn()`
(`begin_sign_in` in Python) returns the user code and both verification URIs, and
`waitForSignIn()` polls at `interval`, honours `slow_down`, stops at `expiresIn` or when the
caller cancels, and on `ready` stores the device token and runs the same sync activation does.
`pollSignIn()` makes a single poll for a host that paces itself. The
[Node](/docs/build/sdks/node/), [Python](/docs/build/sdks/python/) and
[Swift](/docs/build/sdks/swift/) pages have the details; `conformance/transcripts/devicecode-*.json`
pin the conversation every SDK replays.

:::note[Changed: the user code is independent]
`userCode` used to be the first eight characters of `deviceCode`, case-folded, and
`verificationUri` embedded the whole device code, so there was no page a human could type a code
into. Both were documented residuals of `R8-02` in `docs/security/findings/R8-oidc.md`; the
user-code page closes them. The `XXXX-XXXX` shape is unchanged.
:::

## See also

- [Product OIDC](/docs/services/identity/oidc/) — the PKCE mechanics, provider selection, and
  license minting this flow shares.
- [Browser sessions](/docs/services/identity/sessions/) — the cookie-issuing counterpart, for a
  client that _can_ hold a session.
- `docs/security/findings/R8-oidc.md` — `R8-01` (device-id binding on the poll surfaces) and
  `R8-02` (the confirmation hardening and the independent user code) in full.
- [Public route table](/docs/reference/routes/) — every route with its owning service.
