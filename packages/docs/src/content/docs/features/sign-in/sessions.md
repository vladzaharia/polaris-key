---
title: "Browser sessions"
description: "How a web page holds a sign-in: a device token in the page, verified documents, and sign-out. Cookie sessions are removed."
type: "concept"
lastReviewed: "2026-11-09"
sidebar:
  order: 5
---

A web page signs in the way a native app does. It holds a `pkeyt_` device token and sends it as a bearer on the routes your product lists under `web.origins`. The Worker sets no cookie for it, and a page reads none.

The cookie session this page used to describe is removed: its session, key and logout routes under `identity/` answer `404`. A page that sets the React SDK's auth option to the cookie value gets `invalid-options` naming bearer mode. See [Upgrade to 0.9](/docs/build/upgrade-to-0-9/) for the replacement of each name.

## What the page holds

The React SDK and the elements keep the token in the page's IndexedDB, with a random device id and the verified documents. It needs `trust.pinnedKeys`: every license and config document is verified in the page before it is used, so a token alone grants nothing.

Without the pins the page makes no request and reports `invalid-options` as its identity error.

## Signing in

`signIn.start({ channel: "redirect", redirectUri })` takes the person to Polaris Locker and back to your page with a code the SDK redeems for a token. `signIn.start({ channel: "device-code" })` shows a code to enter on another device. A license key goes through `license.activateWithKey`. See [Web redirect](/docs/features/sign-in/web-redirect/) and [Device flow](/docs/features/sign-in/device-flow/).

## Signing out

`signOut()` releases the device on the server when the product runs Identity, forgets the key ring and wipes the token from the page. The next visit starts signed out until a person signs in again.

## Registration under Identity

A product with Identity on and License off derives the `requires-identity` registration policy. `POST /<product>/devices/register` refuses every caller under it, because the session cookie was the only credential it accepted. The device token comes from signing in.

## Next steps

- [Build a web app](/docs/build/web-apps/): which origins and routes a page may call.
- [Device flow](/docs/features/sign-in/device-flow/): the token-issuing flow a page can show.
- [Activation](/docs/features/licensing/activation/): the device-limit authorization a key shares.
