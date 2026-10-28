---
title: "Web redirect"
description: "Sign a person in to your web app through authorize and token: PKCE, the Continue card, and the browser device token."
type: "concept"
lastReviewed: "2026-10-17"
sidebar:
  order: 3
---

A web app sends the person's browser to Polaris Locker, the person confirms on the sign-in card, and the browser comes back with a one-time code. The app trades the code for a device token. The shape is OAuth 2.1's authorization code flow with PKCE. The token never appears in a URL.

It needs the product's Identity service on. With it off, `authorize` and `token` answer as an unknown route.

## Register where the app returns

A redirect URI is one of the product's `web.origins` plus one of its `identity.redirectPaths`, matched exactly. A query, a fragment, a wildcard or a prefix never matches.

```yaml title=".pkey/product.yaml"
web:
  origins: ["https://app.example"]
identity:
  redirectPaths: ["/auth/callback"]
```

## Authorize

Send the browser to `GET /<product>/identity/authorize`. Read the address from discovery's `identity.endpoints.authorize`.

| Parameter                                 | Value                                                                                            |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `response_type`                           | `code`                                                                                           |
| `client_id`                               | The product slug                                                                                 |
| `redirect_uri`                            | A registered URI                                                                                 |
| `state`                                   | 16 to 512 characters, checked by the app on return                                               |
| `code_challenge`, `code_challenge_method` | The S256 challenge of a verifier the app keeps. `plain` is refused                               |
| `scope`                                   | Any of `profile`, `email`, `cloudSync`. Absent means all the product grants. `openid` is refused |
| `login_hint`, `name_hint`, `purpose`      | Optional. They prefill the card and verify nothing. `purpose` is `signin` or `attach`            |

A bad `client_id` or `redirect_uri` shows an error page and never redirects. Any other error redirects to the registered URI with `error`, `state` and `iss`. Check `iss` against `identity.issuer` from discovery.

On success the person sees **Continue to _App_**. **Continue** sends the browser to the redirect URI with `code`, `state` and `iss`. **Cancel** sends it with `error=access_denied`.

## Token

Redeem the code within 60 seconds. It works once.

```http title="Request"
POST /<product>/identity/token
Content-Type: application/x-www-form-urlencoded
X-PKey-Device: <device id>

grant_type=authorization_code&client_id=<product>&code=<code>&code_verifier=<verifier>&redirect_uri=<uri>
```

```json title="Output"
{
  "access_token": "pkeyt_…",
  "token_type": "Bearer",
  "scope": "profile email",
  "schemaVersion": 1,
  "device": { "id": "…", "licenseId": "" },
  "license": null,
  "subject": "ps_…"
}
```

`access_token` is the device token the app already uses on every other route. `license` is `null` on a device with no license. `subject` is the person's identifier for this product.

A device that already holds a token sends it as `Authorization: Bearer` to keep its license; without it, a device that already runs on a license is refused with `license_choice_required`.

| Error                          | Meaning                                                                           |
| ------------------------------ | --------------------------------------------------------------------------------- |
| `invalid_request`              | Not a form, or a parameter is missing or repeated                                 |
| `invalid_client`               | `client_id` is not the product slug                                               |
| `invalid_grant`                | The code is unknown, used, expired, or does not match the verifier                |
| `unsupported_grant_type`       | Only `authorization_code` is served                                               |
| `license_choice_required`      | The person has licenses and none was chosen, or the device id already runs on one |
| `not_entitled`, `device_limit` | The chosen license refuses this device                                            |
| `rate_limited`                 | Wait `retryAfter` seconds                                                         |

A wrong verifier ends the code. Start again from `authorize`.

## Choose a license

When the account holds licenses for the product, the card asks which one this device runs on, and **Continue** needs the answer. A full license offers **Replace a device**: the person picks a device that signs out, and this one takes its place in the same step. With no license, and a product that grants one to everyone who signs in, **Continue** creates it once.

To run the choice in your own form instead, add `license_choice=app` to `authorize`. Send it only when discovery lists `choiceLicenses`, `choiceDevices`, `choiceComplete` and `choiceCancel`. The card skips the choice, and `token` answers a pending sign-in when one is due:

```json
{
  "status": "choose",
  "grant": "sg_…",
  "expiresIn": 300,
  "choices": { "state": "choose", "choices": [] }
}
```

The grant lives five minutes and answers only the device that redeemed the code. Send it in a JSON body, with the same `X-PKey-Device`, to the four routes:

| Route      | Body                 | Answer                        |
| ---------- | -------------------- | ----------------------------- |
| `licenses` | `grant`              | A fresh list of licenses      |
| `devices`  | `grant`, `licenseId` | The devices on a full license |
| `complete` | `grant`, `choice`    | The same body `token` answers |
| `cancel`   | `grant`              | `204`. Nothing is bound       |

A `choice` is `license` (with `replaceDeviceId` on a full license), `keep` (the device sends its own token), `create` or `key`. A key entered here counts as one key entry. A refusal you can fix, such as `device_limit`, leaves the grant open.

## From an SDK

Node, Python and React run this flow with `signIn.start({ channel: "redirect", redirectUri })` (Python: `sign_in.start(channel="redirect", redirect_uri=...)`). The SDK reads `authorize`, `token` and `iss` from discovery, builds the S256 challenge and `state`, and answers a session with `authorizeUrl`. Open that URL in a browser. When the browser lands on your redirect URI, pass the full URL to `complete(callbackUrl)`. The SDK checks `state` and `iss`, redeems the code and stores the device token.

| Outcome (Node) | Meaning                                                                     |
| -------------- | --------------------------------------------------------------------------- |
| `signedIn`     | The device holds the token. `subject`, `scope` and `licenseId` come back    |
| `choose`       | With `licenseChoice: "app"` and a choice due. Finish with `identity.choice` |
| `cancelled`    | The person pressed Cancel                                                   |

A session is single use: `complete` and `cancel` drop the PKCE verifier, and a replayed callback is refused without a request. A refusal throws under its own code (`invalid_grant`, `rate_limited`, `sign-in-failed`) and leaves the device token alone. React keeps the verifier in `sessionStorage` across the navigation, so call `usePolarisAuth().signIn.complete(callbackUrl)` on the page the browser returns to. The [Node](/docs/build/sdks/node/your-own-ui/#redirect-sign-in) and [Python](/docs/build/sdks/python/your-own-ui/#redirect-sign-in) pages have the code.
