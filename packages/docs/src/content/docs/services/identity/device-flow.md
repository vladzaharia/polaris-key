---
title: "The device-code flow"
description: "Sign-in for a client that cannot receive a browser redirect: the device-code start, verify, and poll routes."
sidebar:
  order: 3
---

The browser PKCE flow in [Product OIDC](/docs/services/identity/oidc/) assumes the caller can
receive a redirect — either directly, or by capturing one from a loopback. The device-code flow
is for the client that cannot: a CLI running over SSH, inside a container, or in any other
environment with no browser of its own. It shows the human a short code and a URL, the human
completes sign-in on _any_ other device, and the original client polls until a credential is
ready.

Three routes, all under `/<product>/identity/auth/device`, sharing the same PKCE machinery
[Product OIDC](/docs/services/identity/oidc/) describes — the same `state`/`nonce`/PKCE flow
record, the same token exchange, the same ID-token verification. What is specific to this flow is
the human-confirmation step in the middle and the polling contract around it. The public shape —
a device code, a short human-readable user code, a verification URL, and a poll — is loosely the
OAuth device-authorization-grant pattern, with one deliberate difference called out below.

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
  "userCode": "ABCD-1234",
  "verificationUri": "https://…/<product>/identity/auth/device/verify?device_code=…",
  "verificationUriComplete": "https://…/<product>/identity/auth/device/verify?device_code=…",
  "expiresIn": 600,
  "interval": 2,
  "pollUrl": "https://…/<product>/identity/auth/device/poll"
}
```

`deviceCode` is the bearer handle the client polls with — treat it like a credential.
`userCode` is display-only: it is the first 8 characters of `deviceCode`, uppercased and
hyphenated after the fourth character, meant to be read aloud or typed by a human, not used by
the polling client itself.

## `GET`/`POST /identity/auth/device/verify`

The confirmation page a human visits at `verificationUri`.

**`GET`** is side-effect free: it looks up the device code, mints a fresh CSRF token into the
stored record, and renders an HTML page showing the user code, the device label, and the product
slug, with a form that posts the CSRF token back. Nothing about the flow changes state on this
request.

**`POST`** confirms it, and only when three things hold: the request's `Origin` header, if
present, must match this origin; the posted CSRF token must match the one the `GET` minted; and
that token is deleted immediately after, so it cannot be replayed. On success, it stamps
`confirmedAt` on the flow — which is what the poll routes below require before they will ever
return a token — and answers with a `303` redirect straight to the IdP's authorize URL, carrying
`Referrer-Policy: no-referrer` and `Cache-Control: no-store` so the `state`/`nonce` in that URL
never leak through a Referer header or a shared cache.

From here the human completes sign-in exactly as in the browser flow, landing on
`/identity/auth/callback` — see [Product OIDC](/docs/services/identity/oidc/) for what that
route does. Because this flow never carries a `return_to`, the callback does not set a session
cookie; it leaves the minted license on the flow record for the poll below to pick up.

:::caution[Why the split matters]
This page used to be a single `GET` that accepted `?confirm=1` and completed the flow right
there — which meant an `<img src>` or a link preview could confirm a sign-in with no user
interaction at all, and the redirect it produced disclosed `state` and `nonce` directly to
whoever triggered it. Making `GET` pure rendering and requiring an explicit, origin-checked,
CSRF-bearing `POST` for the mutation is the fix (`docs/security/findings/R8-oidc.md`, finding
`R8-02`).
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
{ "status": "ready", "token": "pkeyt_…", "schemaVersion": 1 }
```

— a per-device bearer token, not a session cookie; this flow never produces one. The underlying
flow record is deleted the moment a poll returns `ready` or `timeout`, so a token is only ever
handed out once. An IdP failure or a stale/expired code answers `{ "status": "error" }` or
`{ "status": "timeout" }` — the same generic shapes throughout this service, deliberately: a
poller must not be able to learn _why_ a flow failed, only that it did.

Minting the token at `ready` runs through the same seat-authorization step activation and the
browser session both use — the same device can only hold one seat's worth of authorization
regardless of which of the three paths it came through, because all three bind to one shared
computation rather than three copies of it.

## Lifetime and rate limits

A device code lives for 600 seconds (10 minutes) from `/device/start`, matching the `expiresIn`
it advertises — after that, every surface below answers `{ "status": "timeout" }` rather than
resurrecting it. All three routes are rate-limited per client IP, and the two polling-adjacent
ones carry a _second_ budget keyed on the device code itself, so a single flow cannot be hammered
from a botnet even if the per-IP budget is spread across many addresses:

| Route                       | Per-IP budget | Per-flow budget |
| --------------------------- | ------------- | --------------- |
| `POST /device/start`        | 60 / 60s      | —               |
| `GET`/`POST /device/verify` | 60 / 60s      | —               |
| `POST /device/poll`         | 120 / 60s     | 40 / 60s        |

Every one of these is a refusal, `429 rate_limited` (or, for the poll interval specifically,
`429 slow_down`) — never a silent drop, so a well-behaved client can tell "back off" from "the
network ate my request."

## Where this flow is used

Use it wherever a client cannot receive a browser redirect at all — a headless CLI, a build
agent, a device with no embedded or system browser reachable from the process doing the polling.
A client that _can_ open (or already captured a redirect into) a local browser is better served
by the loopback `/identity/auth/poll` surface in
[Product OIDC](/docs/services/identity/oidc/), which skips the human-facing confirmation page
entirely.

:::note[Known, accepted residuals]
Two details are deliberate trade-offs rather than oversights, per `R8-oidc.md`'s `R8-02`
write-up: `userCode` stays a case-folded prefix of `deviceCode` rather than an independently
generated code (making it a product-shape change, not a patch — its remaining entropy is far too
large to brute-force), and the verification page does not yet carry the full
`content-security-policy` / `x-frame-options` / `x-content-type-options` bundle other HTML
responses do (tracked alongside two other lanes' findings so the header policy lands once,
centrally).
:::

## See also

- [Product OIDC](/docs/services/identity/oidc/) — the PKCE mechanics, provider selection, and
  license minting this flow shares.
- [Browser sessions](/docs/services/identity/sessions/) — the cookie-issuing counterpart, for a
  client that _can_ hold a session.
- `docs/security/findings/R8-oidc.md` — `R8-01` (device-id binding on the poll surfaces) and
  `R8-02` (this page's confirmation hardening) in full.
- [Public route table](/docs/reference/routes/) — every route with its owning service.
