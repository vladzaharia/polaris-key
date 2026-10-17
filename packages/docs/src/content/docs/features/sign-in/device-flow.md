---
title: "Device flow"
description: "Sign in a client that can't receive a browser redirect: the start route, the user-code page, the poll and attaching the device's anonymous license."
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
  "verificationUri": "https://key.plrs.im/tidewater/identity/auth/device",
  "verificationUriComplete": "https://key.plrs.im/tidewater/identity/auth/device?user_code=WDJB-MJHT",
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

An unknown, expired, malformed or already-confirmed code re-renders the form with one generic line and status `404`, so a guesser learns nothing. `GET` and `POST /<product>/identity/auth/device/verify` is the same page addressed by device code. Start no longer hands it out, because its URL carries the device code.

:::caution[A confirmation doesn't prove who started the flow]
The origin check and CSRF token stop a cross-site page from confirming someone else's flow. They don't stop a flow's own starter from reading the token and posting it back. The provider callback is bound to the browser that confirmed it, through a `__Host-` cookie, so a starter who sends the authorize URL to a victim gets no token. See the threat model's "Remote phishing".
:::

The person then signs in as in the browser flow, landing on `/identity/auth/callback`. The callback sets no cookie and activates nothing: it checks that the identity would be entitled, stores the verified identity on the flow and stops. The poll activates it. By default the device moves onto the signing-in identity's own license, or a new one from the group mapping or `oidcDefault` tier. Nothing claims, migrates or disables the license the device is already on, because the user code is public and whoever confirms need not own the device.

## Poll

`POST /<product>/identity/auth/device/poll` takes `{ "deviceCode": "<secret>", "deviceId": "<id>" }`. The `deviceId` must equal the one given at start, else `401`, so a stolen code can't be redeemed by another device. The advertised `interval` is enforced: a second poll inside it gets `429` with `{ "status": "slow_down", "interval": 2 }`.

| Status    | Meaning                                                                          |
| --------- | -------------------------------------------------------------------------------- |
| `pending` | The person hasn't confirmed, or the callback hasn't finished                     |
| `confirm` | See below: the identity is waiting for the device's decision                     |
| `ready`   | Carries `token` (a device token, never a cookie), `schemaVersion` and `identity` |
| `error`   | The provider failed. The same generic shape for every cause                      |
| `timeout` | The code expired or is stale                                                     |

Show `identity` (`name`, and `email` only when the provider verified it): if someone else confirmed the flow, this is where the player sees the device is now on a stranger's account. The flow record is deleted the moment a poll returns `ready` or `timeout`, so a token is handed out once. Minting runs the same seat authorization as activation.

## Attach the device's anonymous license

A device that enrolled anonymously holds a license of its own. Attaching makes it the account's. It is a two-step opt-in that only the party holding the device code can make.

1. While polling, the device sends `"confirmIdentity": true` and its device token as `Authorization: Bearer`. After sign-in the answer is `confirm` with `identity` and `attachable`. Nothing has been minted or merged.
2. After the player accepts the identity on the device, the next poll sends `"attachLicense": true` (or `false` to sign in without attaching). An identity with no license takes the anonymous one over in place (`"attached": "claimed"`). An identity with a license gets the anonymous license's devices moved onto it and the anonymous one retired (`"attached": "migrated"`). Then `ready`.

`attachable` is true when the bearer is a live token of the device the flow started for, on an anonymous usable enrolled license. It is false when the attach would pass the identity's device limit (counting every authorized device on the anonymous license, dormant ones included) or when the tier the mint would run on has fingerprint mode `strict`, because a device poll presents no fingerprint. A decision sent before the device saw the identity, or `attachLicense: true` with nothing attachable, is answered `confirm` again and changes nothing.

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
