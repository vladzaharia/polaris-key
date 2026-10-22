---
title: "Device flow"
description: "Sign in a client that can't receive a browser redirect: the start route, the user-code page, the explicit approval and the poll."
type: "concept"
lastReviewed: "2026-10-16"
sidebar:
  order: 4
---

The [browser flow](/docs/features/sign-in/oidc/) assumes the caller can receive a redirect. The device flow is for a client that can't: a CLI over SSH, a game on a TV, a container. The client shows a short code, a short URL and a QR code. The person opens the URL on any other device, completes sign-in there, and the client polls until a credential is ready.

Four routes under `/<product>/identity/auth/device` share the browser flow's PKCE machinery. The public shape is the OAuth device authorization grant (RFC 8628) in camelCase.

## Start

`POST /<product>/identity/auth/device/start` takes a device id from the body's `deviceId`, the `X-PKey-Device` header or a `device` query parameter, in that order. An optional `deviceName` is the label the sign-in page shows. The Worker normalizes it as every SDK does: controls become spaces or vanish, zero-width and bidi characters are removed, spaces collapse and 64 code points stay. It never rejects a label and echoes the stored one. The limit is 60 requests a minute per address.

```json title="Output"
{
  "status": "pending",
  "deviceCode": "<secret>",
  "userCode": "WDJB-MJHT",
  "verificationUri": "https://polaris.locker/device",
  "verificationUriComplete": "https://polaris.locker/device?user_code=WDJB-MJHT",
  "expiresIn": 600,
  "interval": 2,
  "pollUrl": "https://key.plrs.im/tidewater/identity/auth/device/poll",
  "deviceName": "Living room TV"
}
```

`deviceCode` is the bearer handle the client polls with. Treat it as a credential and never show it. `userCode` is eight letters from the consonant alphabet `BCDFGHJKLMNPQRSTVWXZ`, hyphenated after the fourth, generated independently of `deviceCode`. Neither URL contains the device code.

The client shows `userCode` large, renders `verificationUriComplete` as a QR code, shows `verificationUri` as the short URL, shows `deviceName` so the person can check the page is for this device, and polls `pollUrl` at `interval`.

## The user-code page

`GET` or `POST /<product>/identity/auth/device` is what both verification URLs point at. A `GET` with no `user_code` renders the entry form. A `GET` with `?user_code=` or a `POST` of the form renders the confirmation page: the product, the device label (never the device id) and the code. Input is forgiving about case, spaces and hyphens.

A `POST` with `csrf` confirms, and only when the request isn't cross-site, the posted CSRF token matches the one the render minted, and that token is deleted at once. On success the page stamps `confirmedAt` on the flow, stops resolving the user code and answers `303` to the provider's authorize URL with `Referrer-Policy: no-referrer` and `Cache-Control: no-store`. A cross-site request and an empty, wrong or reused token get the same `403`.

An unknown, expired, malformed or already-confirmed code re-renders the form with one generic line and status `404`, so a guesser learns nothing. The entry form names no product and tells the person to use only a code their own device shows. `GET` and `POST /<product>/identity/auth/device/verify` is retired: it answers the generic "Start again on your device" page and reads nothing. Confirming the code here approves nothing.

:::caution[A confirmation doesn't prove who started the flow]
The origin check and CSRF token stop a cross-site page from confirming someone else's flow. They don't stop a flow's own starter from reading the token and posting it back. The provider callback is bound to the browser that confirmed it, through a `__Host-` cookie, so a starter who sends the authorize URL to a victim gets no token.
:::

The person then signs in as in the browser flow, landing on `/identity/auth/callback`. The callback sets no cookie and activates nothing: it checks that the identity would be entitled, stores the verified identity on the flow and sends the browser to the approval page. The poll activates the identity after the approval. By default the device moves onto the signing-in identity's own license, or a new one from the group mapping or `oidcDefault` tier. Nothing claims, migrates or disables the license the device is already on, because the user code is public and whoever confirms need not own the device.

## Approve the sign-in

`GET` or `POST /<product>/identity/auth/device/approve` is the explicit step. Only the browser that confirmed the code and signed in reaches it, through its `__Host-` cookie; the URL carries nothing. The page shows the app and developer, the signed-in account, the device label, the code, when and from where the request started, and when it expires. The place is the edge's coarse guess, and a VPN can choose it, so the page also warns when it differs from where the person is. The device label is the starter's own text, never a trust signal.

**Sign in on {device}** sets a server-side marker, and the device's next poll is `ready`. **Deny** (and Cancel on the license chooser) makes the poll answer `error`, and nothing is signed in. A page token is single-use: a replayed, stale or foreign one changes nothing. The flow's own 600 seconds bound all of it.

Until the person approves, the poll answers `pending`: no identity is disclosed, no license is created and no token is minted. A flow that began before this step existed waits and then times out; the device shows a new code.

### The platform page

`GET https://polaris.locker/device` (and `/tv`, the same page with larger type for a TV browser) is the address a customer is told to visit, and the UI kits' fallback link for an app that can't build its product's URL. The console host answers both paths too, but customers are never sent there. The person types the code, and the Worker looks it up across all products and answers `302` to `/<product>/identity/auth/device?user_code=` on the API host (`key.plrs.im`): the customer host redirects to the product's own device page, so the confirm step, the identity-provider leg and the callback are served there, not on `polaris.locker`. That page owns every later state, so a product with Identity off or a disabled product still redirects.

Codes are unique among live flows: if a drawn code is already held, the Worker draws another. An unknown, expired or malformed code re-renders the form with "That code didn't match or has expired. Check it and try again." and names no product. Lookups are limited to 30 a minute per network. The pages are `no-store` and send no referrer.

## Poll

`POST /<product>/identity/auth/device/poll` takes `{ "deviceCode": "<secret>", "deviceId": "<id>" }`. The `deviceId` must equal the one given at start, else `401`, so a stolen code can't be redeemed by another device. The advertised `interval` is enforced: a second poll inside it gets `429` with `{ "status": "slow_down", "interval": 2 }`.

| Status    | Meaning                                                                                                                                            |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pending` | The person hasn't confirmed, signed in or approved yet                                                                                             |
| `confirm` | See below: the identity is waiting for the device's decision                                                                                       |
| `ready`   | Carries `token` (a device token, never a cookie), `schemaVersion` and `identity`                                                                   |
| `error`   | The sign-in did not complete. With `reason: "access_denied"` a person refused; without `reason` it failed after approval and the cause is not said |
| `timeout` | The code expired or is stale                                                                                                                       |

Every SDK maps the two `error` shapes to two codes:

| Poll answer                            | Code             | What the app does                                                                             |
| -------------------------------------- | ---------------- | --------------------------------------------------------------------------------------------- |
| `error` with `reason: "access_denied"` | `sign-in-denied` | A person pressed Deny, **Not you?** or Cancel. Say so, and offer a new code only if they ask. |
| `error` without `reason`               | `sign-in-failed` | The sign-in failed after approval. Offer a new code at once; the cause is not said.           |

If the sign-in was approved but the Worker could not finish it yet, the poll answers `503` with `{ "error": "unavailable" }` and a `Retry-After`. Keep polling at the usual interval: the Worker retries up to four times over at least 30 seconds, and the next successful poll is `ready`. Every SDK treats a `5xx` on the poll this way. If the retries run out the poll answers `error` without `reason` (`sign-in-failed`).

A refusal stays refused until the code lapses, then the poll answers `timeout`. A client treats an unknown `reason` as absent. The UI kits' sign-in handoff shows a refusal as **denied** and a bare `error` as **failed**. An app that checked only `sign-in-denied` for every failure must now check `sign-in-failed` as well. Builds shipped before this split ignore `reason` and report both as `sign-in-denied`.

Show `identity` (`name`, and `email` only when the provider verified it): if someone else approved the flow, this is where the player sees the device is now on a stranger's account. The flow record is deleted the moment a poll returns `ready` or `timeout`, so a token is handed out once. Minting runs the same seat authorization as activation.

## Attach is retired

Attaching a device's anonymous license to the account was an opt-in the device-code holder made. The person approving a sign-in is never told that the starter's license and devices would join their account, so a device-code flow never attaches. A poll that sends `"confirmIdentity": true` is still answered `confirm` with `identity`, but `attachable` is always `false`, and `"attachLicense": true` is read as `false`: the device signs in on the identity's own license and nothing is claimed or merged. The fields stay so deployed SDKs keep working.

## Lifetime and limits

A device code lives 600 seconds. After that every surface answers `timeout`. All routes are limited per client address, and the poll carries a second budget keyed on the device code.

| Route          | Per address    | Per flow      |
| -------------- | -------------- | ------------- |
| `start`        | 60 per minute  | None          |
| User-code page | 30 per minute  | None          |
| `verify`       | 60 per minute  | None          |
| `poll`         | 120 per minute | 40 per minute |

The user-code page budget is per network (an IPv4 address or an IPv6 /64). There is deliberately no product-wide budget on it, because one attacker could lock every player out. What bounds blind guessing is the code space, 20⁸ codes, against a 600-second life. A guess that lands can only sign a stranger's device in to the guesser's own account. It never yields a token or touches the device's existing license. A refusal is `429 rate_limited` or `429 slow_down`, never a silent drop.

## From an SDK

Node, Python, Swift, Kotlin and Godot drive this flow. In Node, `client.identity.beginSignIn()` returns the user code and both URLs, `waitForSignIn()` polls at `interval`, honors `slow_down` and stops at `expiresIn`, and `pollSignIn()` makes one poll for a host that paces itself. Python names them `begin_sign_in`, `wait_for_sign_in` and `poll_sign_in`. See [Node](/docs/build/sdks/node/), [Python](/docs/build/sdks/python/) and [Swift](/docs/build/sdks/swift/).

## Next steps

- [Product sign-in provider](/docs/features/sign-in/oidc/): the shared PKCE and mint step.
- [Browser sessions](/docs/features/sign-in/sessions/): the cookie-issuing counterpart.
- [Add sign-in to your app](/docs/features/sign-in/add-sign-in/).
