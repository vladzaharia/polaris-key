---
title: "Native redirect"
description: "Sign a person in to a desktop or mobile app through the system browser: loopback, a registered scheme or a claimed HTTPS link, with a device code when none fits."
type: "concept"
lastReviewed: "2026-11-01"
sidebar:
  order: 4
---

A native app signs a person in through their system browser, never a web view. The app starts the sign-in, the browser shows the **Continue** card, and the browser returns to the app with a one-time code. The app trades the code for a device token, from the device that started it. Nothing secret appears in a URL.

It needs the product's Identity service on. The [web redirect](/docs/features/sign-in/web-redirect/) is for a browser app; this page is for an app that runs on the person's device.

## The three classes

The app returns to one of three kinds of address. The SDK picks the first that applies, from what the app registered and what the product allows.

| Class      | Returns to                              | Where                               |
| ---------- | --------------------------------------- | ----------------------------------- |
| `loopback` | `http://127.0.0.1:<port>/pkey/callback` | Desktop; the SDK listens on a port  |
| `scheme`   | `<scheme>:/pkey/callback`               | An app that registered the scheme   |
| `claimed`  | `https://<origin><claimed path>`        | An app the OS verified for the link |

When none applies, the start fails with `redirect-unavailable` before anything is sent. Offer the [device flow](/docs/features/sign-in/device-flow/) instead; the kit's **Use a code instead** does. A product whose Identity does not serve the pushed request also lands here.

The app does not send its redirect address on the query. It pushes the request first and opens `authorize` with the handle it gets back, so the address is checked against what the product registered before the browser opens. A native address sent straight to `authorize` is refused as `redirect_uri_mismatch`. A handle that is unknown, expired or already used shows `invalid_request_uri` and never redirects.

## Declare it

The product says which classes it accepts, in `.pkey/product` or in the console under **App sign-in → Native apps**.

```yaml title=".pkey/product.yaml"
web:
  origins: ["https://app.example"]
identity:
  redirectPaths: ["/auth/callback"]
  nativeRedirect:
    loopback: true
    schemes: ["com.example.app"]
    claimedPaths: ["/pkey/callback"]
```

- `loopback`: on by default. A desktop app returns to its own computer, so there is nothing to register. Set `false` to refuse it. This setting is security-widening, so changing it asks for a reason.
- `schemes`: up to 4 reverse-DNS names, such as `com.example.app`, with at least one dot. The redirect is the scheme plus `/pkey/callback`.
- `claimedPaths`: up to 8 paths on an origin in `web.origins`. They never overlap `redirectPaths`.

The product must list a scheme or path before an app can use it. [Settings](/docs/reference/settings/) lists the three keys.

## Start it

Each SDK starts the redirect channel with no `redirectUri`. The session has the page to open, `reopen` and `cancel`; the sign-in settles the same way as the others.

| SDK           | Start                                                                                  | Settles through                                              |
| ------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Node          | `identity.signIn.start({ channel: "redirect" })`                                       | `session.wait()`, or `session.handleRedirect(url)`           |
| Electron      | The same call in the main process; the renderer never sees the URL                     | The bridge's sign-in session                                 |
| React desktop | `usePolarisAuth().signIn.start({ channel: "redirect" })` over the bridge               | `session.wait()`                                             |
| Python        | `identity.sign_in.start(channel="redirect")`                                           | `session.wait()`, or `session.handle_redirect(url)`          |
| Swift         | `identity.signIn.start(SignInOptions(channel: .redirect))`                             | `session.wait()`, or `identity.signIn.handleRedirect(_:)`    |
| Kotlin        | `identity.signIn.start(SignInOptions(channel = SignInChannel.Redirect, native = ...))` | `session.wait()`, or `identity.signIn.handleRedirect(url)`   |
| Godot desktop | `identity.sign_in.start({ channel = "redirect" })`                                     | `session.wait()`, or `identity.sign_in.handle_redirect(url)` |

A browser app has no native redirect: React in a browser uses the [web redirect](/docs/features/sign-in/web-redirect/) with a `redirectUri`.

On a desktop the SDK binds the listener first, then pushes the request, then opens the browser. It answers only the one path, only on `127.0.0.1`, and closes after the first good callback, after 10 minutes or on `cancel`. The browser is then sent on to Polaris Locker's return page, and the app is told through `wait`.

`reopen()` is the app's **Open browser again**: it opens the same page, never a second request. `cancel()` ends the sign-in and closes the listener. A request lasts 10 minutes; after that `wait` answers `expired` and the app starts again.

The sign-in page names the device. Unless the app passes a `deviceName`, the SDK sends the computer's own name: the macOS computer name, Linux `PRETTY_HOSTNAME`, and "Windows PC" or "Windows laptop" for a generated Windows name. Pass an empty string to send none.

### Node

```ts
import { PolarisError, type PolarisKeyClient } from "@polaris-key/node";

export async function signInOnDesktop(
  client: PolarisKeyClient,
  signal: AbortSignal,
) {
  try {
    const session = await client.identity.signIn.start({
      channel: "redirect",
      deviceName: "Studio laptop",
    });
    // The browser is already open. Offer "Open browser again" and "Cancel":
    //   await session.reopen();   session.cancel();
    console.log(session.redirectClass, session.expiresAt);
    const outcome = await session.wait({ signal });
    return outcome.kind; // "signedIn", "choose", "cancelled" or "expired"
  } catch (e) {
    if (e instanceof PolarisError && e.code === "redirect-unavailable")
      return "use-a-code"; // start the device-code sign-in instead
    throw e;
  }
}
```

With a registered scheme, pass `registeredSchemes: ["com.example.app:/pkey/callback"]` (and `returnUri` for the **Return to** link on the done page). The listener is tried first; the scheme is used when none can be bound. Give the URL the OS delivers to `session.handleRedirect(url)`. `loopback: false` never binds a listener, and `openUrl` replaces the opener. A headless host (SSH, CI, Linux with no display) gets `redirect-unavailable` unless it passes `openUrl`.

In Electron the main process runs the flow and opens the browser through `shell.openExternal`.

### Python

```python
from typing import Optional

from polaris_key import PolarisError, PolarisKeyClient


def sign_in_on_desktop(client: PolarisKeyClient) -> Optional[str]:
    try:
        session = client.identity.sign_in.start(
            channel="redirect", device_name="Studio laptop"
        )
    except PolarisError as e:
        if e.code == "redirect-unavailable":
            return None  # start the device-code sign-in instead
        raise
    # The browser is already open: offer session.reopen() and session.cancel().
    outcome = session.wait(timeout=600)
    return outcome.kind  # "signed_in", "choose", "cancelled" or "expired"
```

The registered classes are `registered_schemes` and `registered_claimed`; `loopback=False`, `open_browser=False` and `return_uri` work as in Node.

### Swift

On iOS, iPadOS and visionOS the SDK runs `ASWebAuthenticationSession` with the scheme, or with the claimed HTTPS link on iOS 17.4 and later. It is not an ephemeral session, so the person's existing browser sign-in is used. Add the scheme to the app's Info.plist under `CFBundleURLTypes`; the SDK reads it, or you pass `registeredSchemes` in the start options' `native` value. Claimed links cannot be read at run time: pass `registeredClaimed: ["https://app.example/pkey/callback"]`. `session.reopen()` returns `false` once the request has lapsed.

On macOS the SDK listens on `127.0.0.1` and opens the browser with `NSWorkspace`. A sandboxed app, including a Mac App Store app, needs the `com.apple.security.network.server` entitlement to listen. Without it the SDK falls back to the registered scheme, and the system hands the URL to `onOpenURL`, which calls `identity.signIn.handleRedirect(_:)`. With neither, or in a headless session, the start fails with `redirect-unavailable`.

### Kotlin

On the JVM the SDK listens on the loopback address and opens the browser through the desktop. A host with no desktop browser passes an `opener`. Pass the native options as `native`; the registered scheme and claimed lists work as in Node.

On Android there is no listener. The SDK opens a Custom Tab, never a web view, and the OS brings the browser back through the scheme or the claimed link to `PKeyRedirectActivity`. The Auth Tab is planned; it needs a build-tool raise first.

```text
val redirect = AndroidRedirect(scheme = "com.example.app")
val browser = AndroidRedirectBrowser.create(
    activity, client.identity.signIn, redirect, issuerHost = "key.example.com",
)
val session = client.identity.signIn.start(
    SignInOptions(
        channel = SignInChannel.Redirect,
        opener = browser,
        native = redirect.options,
    ),
)
```

`issuerHost` is the host of the product's issuer. The browser opens only an HTTPS page on that host. See [Register on Android](#android).

In the Compose kit, pass `PolarisRedirect(redirect.options, browser)` as the `redirect` argument of `PolarisKeyGate`. Without it an Android app signs in with a code, because the kit cannot register a scheme itself; a television always uses the code.

### Godot

On Windows, macOS and Linux the SDK listens on `127.0.0.1` and opens the browser with `OS.shell_open`.

- With no `redirect_uri`, `sign_in.start` on a desktop starts the native flow. A caller that wants the web redirect must pass `redirect_uri`.
- A listener needs a frame driver. When the host node is in the tree the SDK attaches one. When it is not, `wait()` drives the listener, so call it.
- `loopback = true` is a test hook, not for apps.
- Mobile and web exports have no listener and the add-on registers no scheme, so the start answers `redirect-unavailable` unless the host registered one itself, passed `registered_schemes`, and hands each delivery to `handle_redirect(url)`.

## Register the scheme

A scheme is a promise to the OS, made in the app, matching `identity.nativeRedirect.schemes`.

### iOS and macOS

Add the scheme to Info.plist.

```xml
<key>CFBundleURLTypes</key>
<array>
  <dict>
    <key>CFBundleURLSchemes</key>
    <array><string>com.example.app</string></array>
  </dict>
</array>
```

### Android

`PKeyRedirectActivity` ships in the library, not exported and with no intent filter, so an app that does not use this exposes nothing. Merge in the filter for what you registered, with `manifestPlaceholders` filling the scheme or host.

```xml
<activity android:name="im.plrs.key.android.PKeyRedirectActivity"
    android:exported="true" tools:node="merge">
  <intent-filter>
    <action android:name="android.intent.action.VIEW" />
    <category android:name="android.intent.category.DEFAULT" />
    <category android:name="android.intent.category.BROWSABLE" />
    <data android:scheme="${pkeyRedirectScheme}" android:path="/pkey/callback" />
  </intent-filter>
  <intent-filter android:autoVerify="true">
    <action android:name="android.intent.action.VIEW" />
    <category android:name="android.intent.category.DEFAULT" />
    <category android:name="android.intent.category.BROWSABLE" />
    <data android:scheme="https" android:host="${pkeyRedirectHost}" android:path="/pkey/callback" />
  </intent-filter>
</activity>
```

The first filter is the scheme, the second is the claimed link (App Links). Keep only the one you use. A claimed link also needs the full link as the `claimedUri` of the `redirect` value above.

### Desktop

Loopback is the default and needs no registration. No desktop SDK registers a scheme for you: if you want one, register it in your installer, pass it as a registered scheme, and give the delivered URL to `handleRedirect`.

## Claimed HTTPS links

A claimed link needs the OS to trust your app with an address on your own origin, so you host two files there. Polaris Key hosts neither and never reads them.

`/.well-known/apple-app-site-association`, served as JSON with no redirect, with your team id and bundle id:

```json
{
  "applinks": {
    "details": [
      {
        "appIDs": ["ABCDE12345.com.example.app"],
        "components": [{ "/": "/pkey/callback" }]
      }
    ]
  },
  "webcredentials": { "apps": ["ABCDE12345.com.example.app"] }
}
```

`/.well-known/assetlinks.json`, with your package name and the SHA-256 of the Play app-signing certificate:

```json
[
  {
    "relation": ["delegate_permission/common.handle_all_urls"],
    "target": {
      "namespace": "android_app",
      "package_name": "com.example.app",
      "sha256_cert_fingerprints": ["AA:BB:…"]
    }
  }
]
```

Add the path to `claimedPaths` and the origin to `web.origins`, then pass the full address to the SDK as a registered claimed redirect.

## Errors

| Code                   | Where  | Meaning                                                                                |
| ---------------------- | ------ | -------------------------------------------------------------------------------------- |
| `redirect-unavailable` | Client | No class applies here, or the host is headless. Offer a code.                          |
| `invalid_request_uri`  | Wire   | The pushed request is unknown, expired or used. The browser shows a page; start again. |

Both are in the [error reference](/docs/reference/error-codes/). Other refusals come from the [token step](/docs/features/sign-in/web-redirect/#token): `invalid_grant`, `rate_limited`, `license_choice_required`.
